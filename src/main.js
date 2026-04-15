import { Actor, log } from 'apify';
import { PhantomBusterClient } from './phantombuster.js';
import { validateInput, transformResults } from './utils.js';

await Actor.init();

try {
    const input = await Actor.getInput();
    log.info('Actor started with input validation...');

    // ─── 1. VALIDATE INPUT ────────────────────────────────────────────────────
    const {
        linkedinEmail,
        linkedinPassword,
        salesNavigatorUrl,
        phantomBusterApiKey,
        maxResults = 100,
        timeoutMinutes = 10,
    } = validateInput(input);

    log.info('Input validated. Initialising PhantomBuster client...');

    // ─── 2. INITIALISE CLIENT ─────────────────────────────────────────────────
    const pb = new PhantomBusterClient(phantomBusterApiKey, {
        timeoutMs: timeoutMinutes * 60 * 1000,
    });

    let agentId = null;

    try {
        // ─── 3. CREATE PHANTOM ────────────────────────────────────────────────
        log.info('Step 1/5 — Creating PhantomBuster phantom...');
        agentId = await pb.createPhantom({
            name: `apify-sales-nav-${Date.now()}`,
            script: 'Sales-Navigator-Search-Export',
        });
        log.info(`Phantom created: agentId=${agentId}`);

        // ─── 4. LAUNCH PHANTOM ────────────────────────────────────────────────
        log.info('Step 2/5 — Launching phantom with credentials...');
        const containerId = await pb.launchPhantom(agentId, {
            sessionCookie: await pb.getLinkedInSessionCookie(linkedinEmail, linkedinPassword, agentId),
            salesNavigatorUrl,
            numberOfResultsPerLaunch: maxResults,
            csvName: `apify_results_${Date.now()}`,
        });
        log.info(`Phantom launched: containerId=${containerId}`);

        // ─── 5. POLL FOR COMPLETION ───────────────────────────────────────────
        log.info('Step 3/5 — Polling for completion (this may take several minutes)...');
        const containerResult = await pb.pollUntilComplete(agentId, containerId);
        log.info('Phantom execution completed.');

        // ─── 6. FETCH RESULTS ─────────────────────────────────────────────────
        log.info('Step 4/5 — Fetching results from PhantomBuster...');
        const rawResults = await pb.fetchResults(agentId, containerResult);

        if (!rawResults || rawResults.length === 0) {
            log.warning('No results returned from PhantomBuster.');
            await Actor.pushData([{ status: 'no_results', message: 'PhantomBuster returned 0 results.' }]);
        } else {
            log.info(`Fetched ${rawResults.length} raw results. Transforming...`);
            const transformed = transformResults(rawResults);
            await Actor.pushData(transformed);
            log.info(`Pushed ${transformed.length} records to Apify dataset.`);
        }
    } finally {
        // ─── 7. CLEANUP (always runs) ─────────────────────────────────────────
        if (agentId) {
            log.info('Step 5/5 — Cleaning up: deleting phantom...');
            try {
                await pb.deletePhantom(agentId);
                log.info(`Phantom ${agentId} deleted successfully.`);
            } catch (cleanupErr) {
                log.warning(`Failed to delete phantom ${agentId}: ${cleanupErr.message}`);
            }
        }
    }

    log.info('Actor finished successfully.');
} catch (err) {
    log.error(`Actor failed: ${err.message}`);
    await Actor.pushData([{ status: 'error', error: err.message, stack: err.stack }]);
    throw err;
} finally {
    await Actor.exit();
}
