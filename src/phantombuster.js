import { log } from 'apify';
import axios from 'axios';

const PB_BASE_URL = 'https://api.phantombuster.com/api/v2';

// ── PhantomBuster phantom IDs for common scripts ─────────────────────────────
// These are the official Phantom script IDs available in the PhantomBuster store.
const PHANTOM_SCRIPTS = {
  'Sales-Navigator-Search-Export': '6988', 
  'LinkedIn-Search-Export': '3149', 
};

// ── Polling configuration ─────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 30_000; // 30 seconds between polls
const MAX_POLL_ATTEMPTS = 40;     // 40 × 30s = 20 minutes max

export class PhantomBusterClient {
    /**
     * @param {string} apiKey - PhantomBuster API key
     */
    constructor(apiKey) {
        if (!apiKey) throw new Error('PhantomBuster API key is required.');
        this.apiKey  = apiKey;
        this.http = axios.create({
            baseURL: PB_BASE_URL,
            headers: {
                'X-Phantombuster-Key': this.apiKey,
                'Content-Type': 'application/json',
            },
            timeout: 30_000, // 30s per HTTP call
        });

        // Attach response interceptor for unified error handling
        this.http.interceptors.response.use(
            (res) => res,
            (err) => {
                const status  = err.response?.status;
                const message = err.response?.data?.message ?? err.message;
                throw new Error(`PhantomBuster API error [${status}]: ${message}`);
            }
        );
    }

    // ── 1. CREATE PHANTOM ─────────────────────────────────────────────────────
    /**
     * Creates a new phantom agent and returns its ID.
     * @param {object} options
     * @param {string} options.name   - Name for this agent instance
     * @param {string} options.script - Script key from PHANTOM_SCRIPTS
     * @returns {Promise<string>} agentId
     */
    async createPhantom({ name, script }) {
        const scriptId = PHANTOM_SCRIPTS[script];
        if (!scriptId) {
            throw new Error(
                `Unknown phantom script "${script}". ` +
                `Available: ${Object.keys(PHANTOM_SCRIPTS).join(', ')}`
            );
        }

        const payload = {
            name,
            script: scriptId,
            // Disable auto-launch and repeating schedule — we control execution
            repeatedLaunch: false,
            autoSave: false,
        };

        const { data } = await this.http.post('/agents/save', payload);

        const agentId = data?.id ?? data?.agentId;
        if (!agentId) {
            throw new Error('PhantomBuster did not return an agentId on create.');
        }
        return String(agentId);
    }

    // ── 2. GET LINKEDIN SESSION COOKIE VIA PHANTOM ───────────────────────────
    /**
     * Uses PhantomBuster's built-in LinkedIn cookie fetcher to obtain
     * a session cookie from email + password. This keeps credentials
     * off your own infrastructure.
     *
     * @param {string} email
     * @param {string} password
     * @param {string} agentId - The agent that will use the cookie
     * @returns {Promise<string>} LinkedIn li_at session cookie value
     */
    async getLinkedInSessionCookie(email, password, agentId) {
        log.info('Retrieving LinkedIn session cookie via PhantomBuster...');

        // Step A: Create a transient LinkedIn Session Cookie phantom
        const cookieAgentId = await this.createPhantom({
            name: `apify-linkedin-login-${Date.now()}`,
            script: 'LinkedIn-Search-Export', // reuse same family; login helper is universal
        });

        let sessionCookie = null;

        try {
            // Step B: Launch with just login credentials
            const loginContainerId = await this._launchAgent(cookieAgentId, {
                action: 'getSessionCookie',
                sessionCookieMode: 'email-password',
                linkedinLogin: email,
                linkedinPassword: password,
            });

            // Step C: Poll for cookie result (shorter timeout: 3 min)
            const result = await this._pollContainer(
                cookieAgentId,
                loginContainerId,
                { maxAttempts: 12, intervalMs: 15_000 }
            );

            sessionCookie = result?.output?.sessionCookie
                         ?? result?.resultObject?.sessionCookie;

            if (!sessionCookie) {
                throw new Error(
                    'LinkedIn session cookie not found in PhantomBuster response. ' +
                    'Check credentials or 2FA settings.'
                );
            }

            log.info('Session cookie obtained successfully.');
        } finally {
            // Always clean up the login agent
            await this.deletePhantom(cookieAgentId).catch((e) =>
                log.warning(`Could not delete login agent ${cookieAgentId}: ${e.message}`)
            );
        }

        return sessionCookie;
    }

    // ── 3. LAUNCH PHANTOM ─────────────────────────────────────────────────────
    /**
     * Configures and launches the main scraping phantom.
     * @param {string} agentId
     * @param {object} args          - Phantom-specific arguments
     * @returns {Promise<string>}    containerId (tracks this execution)
     */
    async launchPhantom(agentId, args) {
        const containerId = await this._launchAgent(agentId, args);
        return containerId;
    }

    // ── 4. POLL UNTIL COMPLETE ────────────────────────────────────────────────
    /**
     * Polls PhantomBuster until the container reaches a terminal state.
     * @param {string} agentId
     * @param {string} containerId
     * @returns {Promise<object>} The final container result object
     */
    async pollUntilComplete(agentId, containerId) {
        return this._pollContainer(agentId, containerId, {
            maxAttempts: MAX_POLL_ATTEMPTS,
            intervalMs: POLL_INTERVAL_MS,
        });
    }

    // ── 5. FETCH RESULTS ──────────────────────────────────────────────────────
    /**
     * Fetches the result data from a completed container.
     * PhantomBuster stores results as JSON in the container's resultObject
     * or as a CSV/JSON file in S3 (referenced by outputFiles).
     *
     * @param {string} agentId
     * @param {object} containerResult - Result from pollUntilComplete
     * @returns {Promise<Array<object>>}
     */
    async fetchResults(agentId, containerResult) {
        // ── Path A: inline resultObject (small payloads) ──────────────────────
        if (containerResult?.resultObject) {
            let parsed = containerResult.resultObject;
            if (typeof parsed === 'string') {
                try { parsed = JSON.parse(parsed); } catch (_) {}
            }
            if (Array.isArray(parsed)) return parsed;
            if (parsed?.data && Array.isArray(parsed.data)) return parsed.data;
        }

        // ── Path B: output CSV/JSON file URL ──────────────────────────────────
        const outputUrl = containerResult?.outputFiles?.[0]?.url
                       ?? containerResult?.s3Folder?.url;

        if (outputUrl) {
            log.info(`Downloading results from: ${outputUrl}`);
            const { data } = await axios.get(outputUrl, { timeout: 60_000 });

            if (typeof data === 'string') {
                // Try CSV parse
                return this._parseCsv(data);
            }
            if (Array.isArray(data)) return data;
            if (data?.data && Array.isArray(data.data)) return data.data;
        }

        // ── Path C: fetch directly from agent output endpoint ─────────────────
        log.info('Fetching results via agent output endpoint...');
        const { data } = await this.http.get(`/agents/${agentId}/output`, {
            params: { mode: 'json', withoutDuplicates: false },
        });

        if (Array.isArray(data)) return data;
        if (data?.data && Array.isArray(data.data)) return data.data;
        if (data?.items && Array.isArray(data.items)) return data.items;

        log.warning('Could not parse results — returning raw payload.');
        return [data];
    }

    // ── 6. DELETE PHANTOM ─────────────────────────────────────────────────────
    /**
     * Permanently deletes a phantom agent from PhantomBuster.
     * @param {string} agentId
     */
    async deletePhantom(agentId) {
        await this.http.delete(`/agents/${agentId}`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Launches an agent with the given arguments.
     * @private
     */
    async _launchAgent(agentId, args) {
        const payload = {
            id: agentId,
            arguments: JSON.stringify(args),
            saveArguments: false,
        };

        const { data } = await this.http.post('/agents/launch', payload);

        const containerId = data?.containerId ?? data?.id;
        if (!containerId) {
            throw new Error(`PhantomBuster launch did not return a containerId for agent ${agentId}.`);
        }
        return String(containerId);
    }

    /**
     * Polls a container until it reaches a terminal state.
     * Terminal states: finished, error, killed, stopped
     * @private
     */
    async _pollContainer(agentId, containerId, { maxAttempts, intervalMs }) {
        const TERMINAL_STATES = new Set(['finished', 'error', 'killed', 'stopped']);
        let attempt = 0;

        while (attempt < maxAttempts) {
            attempt++;

            const { data } = await this.http.get(`/containers/${containerId}`, {
                params: { withoutDuplicates: false },
            }).catch(async () => {
                // Fallback: check via agent status
                return this.http.get(`/agents/${agentId}`, {
                    params: { withContainers: false },
                });
            });

            const status = (data?.status ?? data?.lastEndMessage ?? '').toLowerCase();
            log.info(`Poll ${attempt}/${maxAttempts} — status: "${status}"`);

            if (TERMINAL_STATES.has(status)) {
                if (status === 'error') {
                    const errMsg = data?.lastEndMessage ?? data?.error ?? 'Unknown error';
                    throw new Error(`PhantomBuster execution failed: ${errMsg}`);
                }
                return data;
            }

            // Not done — wait before next poll
            if (attempt < maxAttempts) {
                log.info(`Waiting ${intervalMs / 1000}s before next poll...`);
                await new Promise((r) => setTimeout(r, intervalMs));
            }
        }

        throw new Error(
            `PhantomBuster execution timed out after ${maxAttempts} polls ` +
            `(${(maxAttempts * intervalMs) / 60_000} minutes).`
        );
    }

    /**
     * Minimal CSV to JSON parser (handles quoted fields).
     * @private
     */
    _parseCsv(raw) {
        const lines = raw.trim().split('\n');
        if (lines.length < 2) return [];

        const headers = this._parseCsvLine(lines[0]);
        const results  = [];

        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const values = this._parseCsvLine(lines[i]);
            const row    = {};
            headers.forEach((h, idx) => {
                row[h] = values[idx] ?? '';
            });
            results.push(row);
        }
        return results;
    }

    _parseCsvLine(line) {
        const result  = [];
        let current   = '';
        let inQuotes  = false;

        for (let i = 0; i < line.length; i++) {
            const ch   = line[i];
            const next = line[i + 1];

            if (ch === '"' && inQuotes && next === '"') {
                current += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = !inQuotes;
            } else if (ch === ',' && !inQuotes) {
                result.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        result.push(current.trim());
        return result;
    }
}
