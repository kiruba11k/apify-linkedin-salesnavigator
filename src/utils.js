/**
 * Validates and normalises Actor input.
 * Throws a descriptive error on missing / invalid fields.
 *
 * @param {object|null} input
 * @returns Validated + normalised input object
 */
export function validateInput(input) {
    if (!input || typeof input !== 'object') {
        throw new Error('No input provided. Please configure the Actor with the required fields.');
    }

    const errors = [];

    // ── Required fields ───────────────────────────────────────────────────────
    if (!input.linkedinEmail?.trim()) {
        errors.push('linkedinEmail is required.');
    }

    if (!input.linkedinPassword?.trim()) {
        errors.push('linkedinPassword is required.');
    }

    if (!input.salesNavigatorUrl?.trim()) {
        errors.push('salesNavigatorUrl is required.');
    } else if (!isValidUrl(input.salesNavigatorUrl)) {
        errors.push('salesNavigatorUrl must be a valid URL.');
    } else if (!isSalesNavigatorUrl(input.salesNavigatorUrl)) {
        errors.push(
            'salesNavigatorUrl must be a LinkedIn Sales Navigator URL ' +
            '(should contain "linkedin.com/sales/").'
        );
    }

    if (!input.phantomBusterApiKey?.trim()) {
        errors.push('phantomBusterApiKey is required.');
    }

    if (errors.length > 0) {
        throw new Error(`Invalid input:\n  - ${errors.join('\n  - ')}`);
    }

    // ── Optional fields with defaults ────────────────────────────────────────
    const maxResults = parseInt(input.maxResults ?? 100, 10);
    if (isNaN(maxResults) || maxResults < 1 || maxResults > 2500) {
        throw new Error('maxResults must be a number between 1 and 2500.');
    }

    const timeoutMinutes = parseInt(input.timeoutMinutes ?? 10, 10);
    if (isNaN(timeoutMinutes) || timeoutMinutes < 2 || timeoutMinutes > 60) {
        throw new Error('timeoutMinutes must be between 2 and 60.');
    }

    return {
        linkedinEmail:      input.linkedinEmail.trim(),
        linkedinPassword:   input.linkedinPassword.trim(),
        salesNavigatorUrl:  input.salesNavigatorUrl.trim(),
        phantomBusterApiKey: input.phantomBusterApiKey.trim(),
        maxResults,
        timeoutMinutes,
    };
}

/**
 * Normalises raw PhantomBuster results into a clean, consistent schema.
 * PhantomBuster field names vary by phantom version; this resolves aliases.
 *
 * @param {Array<object>} rawItems
 * @returns {Array<object>}
 */
export function transformResults(rawItems) {
    if (!Array.isArray(rawItems)) return [];

    return rawItems
        .filter(Boolean)
        .map((item, index) => ({
            // ── Identity ──────────────────────────────────────────────────────
            index,
            profileUrl:       coalesce(item, 'profileUrl', 'linkedinUrl', 'url'),
            firstName:        coalesce(item, 'firstName',  'first_name', 'given_name'),
            lastName:         coalesce(item, 'lastName',   'last_name',  'family_name'),
            fullName:         coalesce(item, 'fullName',   'name',       'displayName'),

            // ── Professional ──────────────────────────────────────────────────
            headline:         coalesce(item, 'headline',   'title'),
            currentJob:       coalesce(item, 'currentJob', 'currentPosition', 'position'),
            company:          coalesce(item, 'company',    'currentCompany',  'employer'),
            companyUrl:       coalesce(item, 'companyUrl', 'currentCompanyUrl'),
            location:         coalesce(item, 'location',   'region',    'geoLocation'),
            industry:         coalesce(item, 'industry'),
            seniority:        coalesce(item, 'seniority',  'seniorityLevel'),

            // ── Contact ───────────────────────────────────────────────────────
            email:            coalesce(item, 'email',      'emailAddress'),
            phone:            coalesce(item, 'phone',      'phoneNumber'),
            website:          coalesce(item, 'website',    'companyWebsite'),

            // ── Sales Navigator ───────────────────────────────────────────────
            connectionDegree: coalesce(item, 'connectionDegree', 'degree'),
            sharedConnections:coalesce(item, 'sharedConnections'),
            openToWork:       coalesce(item, 'openToWork',       'openLink'),

            // ── Meta ──────────────────────────────────────────────────────────
            scrapedAt:        new Date().toISOString(),
            rawData:          item, // preserve original for debugging
        }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

function isValidUrl(str) {
    try {
        new URL(str);
        return true;
    } catch (_) {
        return false;
    }
}

function isSalesNavigatorUrl(str) {
    return str.includes('linkedin.com/sales/');
}

/**
 * Returns the first non-empty value found among the given keys on obj.
 */
function coalesce(obj, ...keys) {
    for (const key of keys) {
        const val = obj[key];
        if (val !== undefined && val !== null && val !== '') {
            return val;
        }
    }
    return null;
}
