/**
 * Credentials Management
 *
 * Handles OAuth token handling and project discovery.
 */

import {
    ANTIGRAVITY_DB_PATH,
    TOKEN_REFRESH_INTERVAL_MS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    CLIENT_METADATA,
    DEFAULT_PROJECT_ID
} from '../constants.js';
import { refreshAccessToken, parseRefreshParts, formatRefreshParts } from '../auth/oauth.js';
import { getAuthStatus } from '../auth/database.js';
import { logger } from '../utils/logger.js';
import { isNetworkError, throttledFetch } from '../utils/helpers.js';
import { onboardUser, getDefaultTierId } from './onboarding.js';
import { parseTierId } from '../cloudcode/model-api.js';
import { getAccountProvider } from '../providers/registry.js';
import { refreshCodexAccessToken } from '../providers/auth/openai-codex-oauth.js';
import { exchangeCopilotSessionToken } from '../providers/auth/github-copilot-oauth.js';
import { refreshClaudeToken } from '../providers/auth/claude-oauth.js';
import { refreshGeminiCliToken } from '../providers/auth/gemini-cli-oauth.js';
import { refreshDeviceCodeToken } from '../providers/auth/device-oauth.js';

// Track accounts currently fetching subscription to avoid duplicate calls
const subscriptionFetchInProgress = new Set();

/**
 * Fetch subscription tier and save it (blocking)
 * Used when we have a cached project but missing subscription data
 *
 * @param {string} token - OAuth access token
 * @param {Object} account - Account object
 * @param {Function} [onSave] - Callback to save account changes
 */
async function fetchAndSaveSubscription(token, account, onSave) {
    // Avoid duplicate fetches for the same account
    if (subscriptionFetchInProgress.has(account.email)) {
        return;
    }
    subscriptionFetchInProgress.add(account.email);

    try {
        // Call discoverProject just to get subscription info
        const { subscription } = await discoverProject(token, account.projectId);
        if (subscription && subscription.tier !== 'unknown') {
            account.subscription = subscription;
            if (onSave) {
                await onSave();
            }
            logger.info(`[AccountManager] Updated subscription tier for ${account.email}: ${subscription.tier}`);
        }
    } catch (e) {
        logger.debug(`[AccountManager] Subscription fetch failed for ${account.email}: ${e.message}`);
    } finally {
        subscriptionFetchInProgress.delete(account.email);
    }
}

/**
 * Get OAuth token for an account
 *
 * @param {Object} account - Account object with email and credentials
 * @param {Map} tokenCache - Token cache map
 * @param {Function} onInvalid - Callback when account is invalid (email, reason)
 * @param {Function} onSave - Callback to save changes
 * @returns {Promise<string>} OAuth access token
 * @throws {Error} If token refresh fails
 */
export async function getTokenForAccount(account, tokenCache, onInvalid, onSave) {
    const providerId = getAccountProvider(account);

    // Direct API key providers don't need OAuth caching/refresh
    if (providerId !== 'antigravity' && (account.source === 'api-key' || (account.source === 'manual' && account.apiKey))) {
        return account.apiKey || '';
    }

    // Check cache first (respect per-token expiresAt if available, else default TTL)
    const cached = tokenCache.get(account.email);
    if (cached) {
        if (cached.expiresAt) {
            if (Date.now() < cached.expiresAt - 60000) {
                return cached.token;
            }
        } else if ((Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
            return cached.token;
        }
    }

    // OpenAI Codex (ChatGPT OAuth)
    if (providerId === 'openai-codex') {
        if (account.accessToken && account.expiresAt && Date.now() < account.expiresAt - 60000) {
            tokenCache.set(account.email, {
                token: account.accessToken,
                extractedAt: Date.now(),
                expiresAt: account.expiresAt
            });
            return account.accessToken;
        }
        if (!account.refreshToken) {
            if (account.accessToken) return account.accessToken;
            throw new Error(`AUTH_INVALID: ${account.email}: Missing OpenAI Codex refresh token`);
        }
        try {
            const refreshed = await refreshCodexAccessToken(account.refreshToken);
            account.accessToken = refreshed.accessToken;
            account.refreshToken = refreshed.refreshToken;
            account.expiresAt = refreshed.expiresAt;
            account.extra = { ...(account.extra || {}), chatgptAccountId: refreshed.chatgptAccountId || account.extra?.chatgptAccountId };
            if (account.isInvalid) {
                account.isInvalid = false;
                account.invalidReason = null;
            }
            if (onSave) await onSave();
            tokenCache.set(account.email, {
                token: refreshed.accessToken,
                extractedAt: Date.now(),
                expiresAt: refreshed.expiresAt
            });
            logger.success(`[AccountManager] Refreshed OpenAI Codex token for: ${account.email}`);
            return refreshed.accessToken;
        } catch (error) {
            if (isNetworkError(error)) {
                throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
            }
            if (onInvalid) onInvalid(account.email, error.message);
            throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
        }
    }

    // GitHub Copilot (exchange GitHub OAuth token for short-lived Copilot session token)
    if (providerId === 'github-copilot') {
        const githubToken = account.refreshToken || account.apiKey;
        if (!githubToken) {
            throw new Error(`AUTH_INVALID: ${account.email}: Missing GitHub OAuth token`);
        }
        try {
            const session = await exchangeCopilotSessionToken(githubToken);
            account.extra = { ...(account.extra || {}), copilotBaseUrl: session.baseUrl };
            if (account.isInvalid) {
                account.isInvalid = false;
                account.invalidReason = null;
                if (onSave) await onSave();
            }
            tokenCache.set(account.email, {
                token: session.token,
                extractedAt: Date.now(),
                expiresAt: session.expiresAt
            });
            return session.token;
        } catch (error) {
            if (isNetworkError(error)) {
                throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
            }
            if (onInvalid) onInvalid(account.email, error.message);
            throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
        }
    }

    // OpenRouter OAuth (exchanges for API key on completion — stored as apiKey or accessToken)
    if (providerId === 'openrouter-oauth') {
        const token = account.apiKey || account.accessToken;
        if (!token) {
            throw new Error(`AUTH_INVALID: ${account.email}: Missing OpenRouter API key`);
        }
        tokenCache.set(account.email, { token, extractedAt: Date.now() });
        return token;
    }

    // Kilo (long-lived token, no refresh needed)
    if (providerId === 'kilo') {
        const token = account.accessToken || account.apiKey;
        if (!token) {
            throw new Error(`AUTH_INVALID: ${account.email}: Missing Kilo access token`);
        }
        tokenCache.set(account.email, { token, extractedAt: Date.now() });
        return token;
    }

    // OAuth providers that use refresh tokens: anthropic-oauth, gemini-cli, qwen-code, kimi-code, opencode-oauth, kiro
    const REFRESHABLE_PROVIDERS = {
        'anthropic-oauth': { refresher: (rt, meta) => refreshClaudeToken(rt), label: 'Claude OAuth' },
        'gemini-cli':      { refresher: (rt, meta) => refreshGeminiCliToken(rt), label: 'Gemini CLI' },
        'qwen-code':       { refresher: (rt, meta) => refreshDeviceCodeToken('qwen-code', rt, meta), label: 'Qwen Code' },
        'kimi-code':       { refresher: (rt, meta) => refreshDeviceCodeToken('kimi-code', rt, meta), label: 'Kimi Code' },
        'opencode-oauth':  { refresher: (rt, meta) => refreshDeviceCodeToken('opencode-oauth', rt, meta), label: 'OpenCode OAuth' },
        kiro:              { refresher: (rt, meta) => refreshDeviceCodeToken('kiro', rt, meta), label: 'Kiro' }
    };
    if (REFRESHABLE_PROVIDERS[providerId]) {
        const { refresher, label } = REFRESHABLE_PROVIDERS[providerId];
        // Return cached/stored token if still valid
        if (account.accessToken && account.expiresAt && Date.now() < account.expiresAt - 60000) {
            tokenCache.set(account.email, {
                token: account.accessToken,
                extractedAt: Date.now(),
                expiresAt: account.expiresAt
            });
            return account.accessToken;
        }
        if (!account.refreshToken) {
            if (account.accessToken) return account.accessToken;
            throw new Error(`AUTH_INVALID: ${account.email}: Missing ${label} refresh token`);
        }
        try {
            const refreshed = await refresher(account.refreshToken, account.extra?.oauthMeta);
            account.accessToken = refreshed.accessToken;
            account.refreshToken = refreshed.refreshToken ?? account.refreshToken;
            account.expiresAt = refreshed.expiresAt;
            if (refreshed.baseUrl) {
                account.baseUrl = refreshed.baseUrl;
            }
            if (account.isInvalid) {
                account.isInvalid = false;
                account.invalidReason = null;
            }
            if (onSave) await onSave();
            tokenCache.set(account.email, {
                token: refreshed.accessToken,
                extractedAt: Date.now(),
                expiresAt: refreshed.expiresAt
            });
            logger.success(`[AccountManager] Refreshed ${label} token for: ${account.email}`);
            return refreshed.accessToken;
        } catch (error) {
            if (isNetworkError(error)) {
                throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
            }
            if (onInvalid) onInvalid(account.email, error.message);
            throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
        }
    }


    // Default: Antigravity (Google OAuth / manual / local database)
    let token;

    if (account.source === 'oauth' && account.refreshToken) {
        // OAuth account - use refresh token to get new access token
        try {
            const tokens = await refreshAccessToken(account.refreshToken);
            token = tokens.accessToken;
            // Clear invalid flag on success
            if (account.isInvalid) {
                account.isInvalid = false;
                account.invalidReason = null;
                if (onSave) await onSave();
            }
            logger.success(`[AccountManager] Refreshed OAuth token for: ${account.email}`);
        } catch (error) {
            // Check if it's a transient network error
            if (isNetworkError(error)) {
                logger.warn(`[AccountManager] Failed to refresh token for ${account.email} due to network error: ${error.message}`);
                // Do NOT mark as invalid, just throw so caller knows it failed
                throw new Error(`AUTH_NETWORK_ERROR: ${error.message}`);
            }

            logger.error(`[AccountManager] Failed to refresh token for ${account.email}:`, error.message);
            // Mark account as invalid (credentials need re-auth)
            if (onInvalid) onInvalid(account.email, error.message);
            throw new Error(`AUTH_INVALID: ${account.email}: ${error.message}`);
        }
    } else if (account.source === 'manual' && account.apiKey) {
        token = account.apiKey;
    } else {
        // Extract from database
        const dbPath = account.dbPath || ANTIGRAVITY_DB_PATH;
        const authData = getAuthStatus(dbPath);
        token = authData.apiKey;
    }

    // Cache the token
    tokenCache.set(account.email, {
        token,
        extractedAt: Date.now()
    });

    return token;
}

/**
 * Get project ID for an account
 * Aligned with opencode-antigravity-auth: parses refresh token for stored project IDs
 *
 * @param {Object} account - Account object
 * @param {string} token - OAuth access token
 * @param {Map} projectCache - Project cache map
 * @param {Function} [onSave] - Callback to save account changes
 * @returns {Promise<string>} Project ID
 */
export async function getProjectForAccount(account, token, projectCache, onSave = null) {
    // Check cache first
    const cached = projectCache.get(account.email);
    if (cached) {
        return cached;
    }

    // Parse refresh token to get stored project IDs (aligned with opencode-antigravity-auth)
    const parts = account.refreshToken ? parseRefreshParts(account.refreshToken) : { refreshToken: null, projectId: undefined, managedProjectId: undefined };

    // If we have a managedProjectId in the refresh token, use it
    if (parts.managedProjectId) {
        projectCache.set(account.email, parts.managedProjectId);
        // If subscription is missing/unknown, fetch it now (blocking)
        if (!account.subscription || account.subscription.tier === 'unknown') {
            await fetchAndSaveSubscription(token, account, onSave);
        }
        return parts.managedProjectId;
    }

    // Legacy: check account.projectId for backward compatibility
    if (account.projectId) {
        projectCache.set(account.email, account.projectId);
        // If subscription is missing/unknown, fetch it now (blocking)
        if (!account.subscription || account.subscription.tier === 'unknown') {
            await fetchAndSaveSubscription(token, account, onSave);
        }
        return account.projectId;
    }

    // Discover managed project, passing projectId for metadata.duetProject
    // Reference: opencode-antigravity-auth - discoverProject handles fallback internally
    const { project, subscription } = await discoverProject(token, parts.projectId);

    // Store managedProjectId back in refresh token (if we got a real project)
    if (project && project !== DEFAULT_PROJECT_ID) {
        let needsSave = false;

        if (account.refreshToken) {
            // OAuth accounts: encode in refresh token
            account.refreshToken = formatRefreshParts({
                refreshToken: parts.refreshToken,
                projectId: parts.projectId,
                managedProjectId: project,
            });
            needsSave = true;
        } else if (account.source === 'database' || account.source === 'manual') {
            // Database/manual accounts: store in projectId field
            account.projectId = project;
            needsSave = true;
        }

        // Save subscription tier if discovered
        if (subscription) {
            account.subscription = subscription;
            needsSave = true;
        }

        // Trigger save to persist the updated project and subscription
        if (needsSave && onSave) {
            try {
                await onSave();
            } catch (e) {
                logger.warn(`[AccountManager] Failed to save updated project: ${e.message}`);
            }
        }
    } else if (subscription) {
        // Even if no project discovered, save subscription if we got it
        account.subscription = subscription;
        if (onSave) {
            try {
                await onSave();
            } catch (e) {
                logger.warn(`[AccountManager] Failed to save subscription: ${e.message}`);
            }
        }
    }

    projectCache.set(account.email, project);
    return project;
}

/**
 * Discover project ID via Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID from refresh token (for metadata.duetProject)
 * @returns {Promise<{project: string, subscription: {tier: string, projectId: string|null, detectedAt: string}|null}>} Project and subscription info
 */
export async function discoverProject(token, projectId = undefined) {
    let lastError = null;
    let gotSuccessfulResponse = false;
    let loadCodeAssistData = null;

    const metadata = { ...CLIENT_METADATA };
    if (projectId) {
        metadata.duetProject = projectId;
    }

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const response = await throttledFetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    ...LOAD_CODE_ASSIST_HEADERS
                },
                body: JSON.stringify({ metadata, mode: 1 })
            });

            if (!response.ok) {
                const errorText = await response.text();
                lastError = `${response.status} - ${errorText}`;
                logger.debug(`[AccountManager] loadCodeAssist failed at ${endpoint}: ${lastError}`);
                continue;
            }

            const data = await response.json();
            gotSuccessfulResponse = true;
            loadCodeAssistData = data;

            logger.debug(`[AccountManager] loadCodeAssist response from ${endpoint}:`, JSON.stringify(data));

            // Extract subscription tier from response
            const subscription = extractSubscriptionFromResponse(data);

            if (typeof data.cloudaicompanionProject === 'string') {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject}`);
                return { project: data.cloudaicompanionProject, subscription };
            }
            if (data.cloudaicompanionProject?.id) {
                logger.success(`[AccountManager] Discovered project: ${data.cloudaicompanionProject.id}`);
                return { project: data.cloudaicompanionProject.id, subscription };
            }

            // No project found - log tier data and try to onboard the user
            logger.info(`[AccountManager] No project in loadCodeAssist response, attempting onboardUser...`);
            logger.debug(`[AccountManager] Tier data for onboarding: paidTier=${JSON.stringify(data.paidTier)}, currentTier=${JSON.stringify(data.currentTier)}, allowedTiers=${JSON.stringify(data.allowedTiers?.map(t => ({ id: t?.id, isDefault: t?.isDefault })))}`);
            break;
        } catch (error) {
            lastError = error.message;
            logger.debug(`[AccountManager] loadCodeAssist error at ${endpoint}:`, error.message);
        }
    }

    // If we got a successful response but no project, try onboarding
    if (gotSuccessfulResponse && loadCodeAssistData) {
        // Only use allowedTiers for onboarding (matching opencode-antigravity-auth and oauth.js)
        // Note: paidTier (g1-pro-tier, g1-ultra-tier) is NOT valid for onboardUser API
        // The paidTier is used for subscription detection only, not for onboarding
        const tierId = getDefaultTierId(loadCodeAssistData.allowedTiers) || 'free-tier';
        logger.info(`[AccountManager] Onboarding user with tier: ${tierId}`);

        // Pass projectId for metadata.duetProject (without fallback, matching reference)
        // Reference: opencode-antigravity-auth passes parts.projectId (not fallback) to onboardManagedProject
        const onboardedProject = await onboardUser(
            token,
            tierId,
            projectId  // Original projectId without fallback
        );
        if (onboardedProject) {
            logger.success(`[AccountManager] Successfully onboarded, project: ${onboardedProject}`);
            const subscription = extractSubscriptionFromResponse(loadCodeAssistData);
            return { project: onboardedProject, subscription };
        }

        logger.warn(`[AccountManager] Onboarding failed - account may not work correctly`);
    }

    // Only warn if all endpoints failed with errors (not just missing project)
    if (!gotSuccessfulResponse) {
        logger.warn(`[AccountManager] loadCodeAssist failed for all endpoints: ${lastError}`);
    }

    // Fallback: use projectId if available, otherwise use default
    // Reference: opencode-antigravity-auth/src/plugin/project.ts
    if (projectId) {
        return { project: projectId, subscription: null };
    }
    return { project: DEFAULT_PROJECT_ID, subscription: null };
}

/**
 * Extract subscription tier from loadCodeAssist response
 *
 * @param {Object} data - loadCodeAssist response data
 * @returns {{tier: string, projectId: string|null, detectedAt: string}|null} Subscription info
 */
function extractSubscriptionFromResponse(data) {
    if (!data) return null;

    // Priority: paidTier > currentTier (consistent with model-api.js)
    let tier = 'free';
    let cloudProject = null;

    if (data.paidTier?.id) {
        tier = parseTierId(data.paidTier.id);
    } else if (data.currentTier?.id) {
        tier = parseTierId(data.currentTier.id);
    }

    // Get project ID
    if (typeof data.cloudaicompanionProject === 'string') {
        cloudProject = data.cloudaicompanionProject;
    } else if (data.cloudaicompanionProject?.id) {
        cloudProject = data.cloudaicompanionProject.id;
    }

    return {
        tier,
        projectId: cloudProject,
        detectedAt: new Date().toISOString()
    };
}

/**
 * Clear project cache for an account
 *
 * @param {Map} projectCache - Project cache map
 * @param {string|null} email - Email to clear cache for, or null to clear all
 */
export function clearProjectCache(projectCache, email = null) {
    if (email) {
        projectCache.delete(email);
    } else {
        projectCache.clear();
    }
}

/**
 * Clear token cache for an account
 *
 * @param {Map} tokenCache - Token cache map
 * @param {string|null} email - Email to clear cache for, or null to clear all
 */
export function clearTokenCache(tokenCache, email = null) {
    if (email) {
        tokenCache.delete(email);
    } else {
        tokenCache.clear();
    }
}
