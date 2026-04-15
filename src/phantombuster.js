import { log } from 'apify';
import axios from 'axios';

const PB_BASE_URL = 'https://api.phantombuster.com/api/v2';

/**
 * ── PhantomBuster script identifiers ─────────────────────────────────────────
 * Using the official slugs is often more reliable than hardcoded numeric IDs 
 * which change based on the version of the phantom.
 */
const PHANTOM_SCRIPTS = {
    'Sales-Navigator-Search-Export': 'sales-navigator-search-export',
    'LinkedIn-Search-Export':        'linkedin-search-export',
};

// ── Polling configuration ─────────────────────────────────────────────────────
const POLL_INTERVAL_MS  = 30_000; 
const MAX_POLL_ATTEMPTS = 40;     

export class PhantomBusterClient {
    constructor(apiKey) {
        if (!apiKey) throw new Error('PhantomBuster API key is required.');
        this.apiKey = apiKey;
        this.http = axios.create({
            baseURL: PB_BASE_URL,
            headers: {
                'X-Phantombuster-Key': this.apiKey,
                'Content-Type': 'application/json',
            },
            timeout: 30_000,
        });

        // Improved interceptor to catch the ACTUAL error message from PB
        this.http.interceptors.response.use(
            (res) => res,
            (err) => {
                const status = err.response?.status;
                const pbMessage = err.response?.data?.message || err.response?.data?.error;
                const message = pbMessage ? `${pbMessage}` : err.message;
                throw new Error(`PhantomBuster API error [${status}]: ${message}`);
            }
        );
    }

    // ── 1. CREATE PHANTOM ─────────────────────────────────────────────────────
    async createPhantom({ name, script }) {
        const scriptId = PHANTOM_SCRIPTS[script];
        if (!scriptId) {
            throw new Error(`Unknown phantom script "${script}".`);
        }

        const payload = {
            name,
            script: scriptId,
            arguments: "{}", // PB often requires this as a stringified empty object
            repeatedLaunch: false,
            autoSave: true,
        };

        const { data } = await this.http.post('/agents/save', payload);

        // PB API returns 'id' or 'agentId'
        const agentId = data?.id || data?.agentId;
        if (!agentId) {
            throw new Error('PhantomBuster did not return an agentId on create.');
        }
        return String(agentId);
    }

    // ── 2. GET LINKEDIN SESSION COOKIE ───────────────────────────────────────
    async getLinkedInSessionCookie(email, password) {
        log.info('Obtaining LinkedIn session cookie via PhantomBuster helper...');
        
        // This helper uses the basic LinkedIn Export script just to snag a cookie
        const cookieAgentId = await this.createPhantom({
            name: `login-helper-${Date.now()}`,
            script: 'LinkedIn-Search-Export',
        });

        try {
            const loginContainerId = await this._launchAgent(cookieAgentId, {
                linkedinLogin: email,
                linkedinPassword: password,
                // Tells the script to just return the cookie and stop
                action: 'getSessionCookie' 
            });

            const result = await this._pollContainer(cookieAgentId, loginContainerId, { 
                maxAttempts: 15, 
                intervalMs: 15_000 
            });

            const sessionCookie = result?.resultObject?.sessionCookie || result?.output?.sessionCookie;

            if (!sessionCookie) {
                throw new Error('Failed to retrieve session cookie. Check LinkedIn credentials.');
            }

            return sessionCookie;
        } finally {
            await this.deletePhantom(cookieAgentId).catch(() => {});
        }
    }

    // ── 3. LAUNCH PHANTOM ─────────────────────────────────────────────────────
    async launchPhantom(agentId, args) {
        return await this._launchAgent(agentId, args);
    }

    // ── 4. POLL UNTIL COMPLETE ────────────────────────────────────────────────
    async pollUntilComplete(agentId, containerId) {
        return this._pollContainer(agentId, containerId, {
            maxAttempts: MAX_POLL_ATTEMPTS,
            intervalMs: POLL_INTERVAL_MS,
        });
    }

    // ── 5. FETCH RESULTS ──────────────────────────────────────────────────────
    async fetchResults(agentId, containerResult) {
        // Try to get resultObject first
        if (containerResult?.resultObject) {
            const res = containerResult.resultObject;
            const parsed = typeof res === 'string' ? JSON.parse(res) : res;
            if (Array.isArray(parsed)) return parsed;
        }

        // Fallback to S3 file download
        const outputUrl = containerResult?.outputFiles?.[0]?.url;
        if (outputUrl) {
            log.info(`Downloading results from PB storage...`);
            const { data } = await axios.get(outputUrl);
            return typeof data === 'string' ? this._parseCsv(data) : data;
        }

        return [];
    }

    // ── 6. DELETE PHANTOM ─────────────────────────────────────────────────────
    async deletePhantom(agentId) {
        await this.http.delete(`/agents/${agentId}`);
    }

    // ── PRIVATE HELPERS ──────────────────────────────────────────────────────
    async _launchAgent(agentId, args) {
        const payload = {
            id: agentId,
            arguments: JSON.stringify(args),
            saveArguments: true,
        };

        const { data } = await this.http.post('/agents/launch', payload);
        const containerId = data?.containerId || data?.id;
        
        if (!containerId) throw new Error(`Launch failed for agent ${agentId}`);
        return String(containerId);
    }

    async _pollContainer(agentId, containerId, { maxAttempts, intervalMs }) {
        const TERMINAL = new Set(['finished', 'error', 'killed', 'stopped']);
        
        for (let i = 0; i < maxAttempts; i++) {
            const { data } = await this.http.get(`/containers/${containerId}`);
            const status = (data?.status || '').toLowerCase();

            log.info(`Phantom status: ${status} (Attempt ${i + 1}/${maxAttempts})`);

            if (TERMINAL.has(status)) {
                if (status === 'error') throw new Error(`Phantom error: ${data.lastEndMessage}`);
                return data;
            }
            await new Promise(r => setTimeout(r, intervalMs));
        }
        throw new Error('PhantomBuster polling timed out.');
    }

    _parseCsv(raw) {
        const lines = raw.trim().split('\n');
        if (lines.length < 2) return [];
        const headers = lines[0].split(',');
        return lines.slice(1).map(line => {
            const values = line.split(',');
            return headers.reduce((obj, h, i) => ({ ...obj, [h.trim()]: values[i]?.trim() }), {});
        });
    }
}
