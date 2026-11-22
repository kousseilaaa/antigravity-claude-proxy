/**
 * Model API for Cloud Code
 *
 * Handles model listing and quota retrieval from the Cloud Code API.
 */

import {
    ANTIGRAVITY_ENDPOINT_FALLBACKS,
    ANTIGRAVITY_HEADERS,
    LOAD_CODE_ASSIST_ENDPOINTS,
    LOAD_CODE_ASSIST_HEADERS,
    CLIENT_METADATA,
    getModelFamily,
    MODEL_VALIDATION_CACHE_TTL_MS
} from '../constants.js';
import { logger } from '../utils/logger.js';
import { throttledFetch } from '../utils/helpers.js';
import { recordModels } from './model-registry.js';

// Model validation cache
const modelCache = {
    validModels: new Set(),
    fetchedTokens: new Set(),
    lastFetched: 0,
    fetchPromise: null  // Prevents concurrent fetches
};

/**
 * Check if a model is supported (Claude or Gemini, by name or backend provider)
 * @param {string} modelId - Model ID to check
 * @returns {boolean} True if model is supported
 */
function isSupportedModel(modelId) {
    const family = getModelFamily(modelId);
    return family === 'claude' || family === 'gemini';
}

/**
 * Whether a model id is an old Gemini generation (version below 3.5),
 * hidden from the /v1/models listing in favor of the current line. Claude
 * ids aren't versioned this way and are unaffected.
 * @param {string} modelId
 * @returns {boolean}
 */
function isOldGemini(modelId) {
    // 'gemini-pro-agent' carries no version number in its id at all - it's
    // an unversioned duplicate alias of gemini-3.1-pro-high, so it's always
    // old regardless of what the version regex below would say.
    if (modelId === 'gemini-pro-agent') return true;

    const match = modelId.match(/^gemini-(\d+(?:\.\d+)?)/);
    return !!match && parseFloat(match[1]) < 3.5;
}

/**
 * Whether a model id is a backend placeholder for a model the account can't
 * use (e.g. 'gemini-4-argon-disabled' on free-tier accounts), hidden from the
 * /v1/models listing since requests to it can't succeed.
 * @param {string} modelId
 * @returns {boolean}
 */
function isDisabledPlaceholder(modelId) {
    return modelId.endsWith('-disabled');
}

/**
 * List available models in Anthropic API format
 * Fetches models dynamically from the Cloud Code API
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{object: string, data: Array<{id: string, object: string, created: number, owned_by: string, description: string}>}>} List of available models
 */
export async function listModels(token) {
    const data = await fetchAvailableModels(token);
    if (!data || !data.models) {
        return { object: 'list', data: [] };
    }

    recordModels(data);
    const supportedEntries = Object.entries(data.models).filter(([modelId]) => isSupportedModel(modelId));

    // Warm the model validation cache with every supported id, unfiltered -
    // isValidModel() (the actual request-time gate) must keep accepting an
    // id a client already has configured even if it's hidden from the
    // listing below.
    const now = Date.now();
    if (now - modelCache.lastFetched >= MODEL_VALIDATION_CACHE_TTL_MS) {
        modelCache.validModels = new Set();
        modelCache.fetchedTokens = new Set();
    }
    for (const [modelId] of supportedEntries) {
        modelCache.validModels.add(modelId);
    }
    if (token) modelCache.fetchedTokens.add(token);
    modelCache.lastFetched = now;

    const modelList = supportedEntries
        .filter(([modelId]) => !isOldGemini(modelId) && !isDisabledPlaceholder(modelId))
        .map(([modelId, modelData]) => ({
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'anthropic',
            description: modelData.displayName || modelId
        }));

    return {
        object: 'list',
        data: modelList
    };
}

/**
 * Fetch available models with quota info from Cloud Code API
 * Returns model quotas including remaining fraction and reset time
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Raw response from fetchAvailableModels API
 */
export async function fetchAvailableModels(token, projectId = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
    };

    // Include project ID in body for accurate quota info (per Quotio implementation)
    const body = projectId ? { project: projectId } : {};

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const url = `${endpoint}/v1internal:fetchAvailableModels`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                logger.warn(`[CloudCode] fetchAvailableModels error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            return await response.json();
        } catch (error) {
            logger.warn(`[CloudCode] fetchAvailableModels failed at ${endpoint}:`, error.message);
        }
    }

    throw new Error('Failed to fetch available models from all endpoints');
}

/**
 * Get model quotas for an account
 * Extracts quota info (remaining fraction and reset time) for each model
 *
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID for accurate quota info
 * @returns {Promise<Object>} Map of modelId -> { remainingFraction, resetTime }
 */
export async function getModelQuotas(token, projectId = null) {
    const data = await fetchAvailableModels(token, projectId);
    if (!data || !data.models) return {};
    recordModels(data);

    const quotas = {};
    for (const [modelId, modelData] of Object.entries(data.models)) {
        // Only include Claude and Gemini models
        if (!isSupportedModel(modelId)) continue;

        if (modelData.quotaInfo) {
            quotas[modelId] = {
                // When remainingFraction is missing but resetTime is present, quota is exhausted (0%)
                remainingFraction: modelData.quotaInfo.remainingFraction ?? (modelData.quotaInfo.resetTime ? 0 : null),
                resetTime: modelData.quotaInfo.resetTime ?? null
            };
        }
    }

    return quotas;
}

/**
 * Parse tier ID string to determine subscription level
 * @param {string} tierId - The tier ID from the API
 * @returns {'free' | 'pro' | 'ultra' | 'unknown'} The subscription tier
 */
export function parseTierId(tierId) {
    if (!tierId) return 'unknown';
    const lower = tierId.toLowerCase();

    if (lower.includes('ultra')) {
        return 'ultra';
    }
    if (lower === 'standard-tier') {
        // standard-tier = "Gemini Code Assist" (paid, project-based)
        return 'pro';
    }
    if (lower.includes('pro') || lower.includes('premium')) {
        return 'pro';
    }
    if (lower === 'free-tier' || lower.includes('free')) {
        return 'free';
    }
    return 'unknown';
}

/**
 * Get subscription tier for an account
 * Calls loadCodeAssist API to discover project ID and subscription tier
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{tier: string, projectId: string|null}>} Subscription tier (free/pro/ultra) and project ID
 */
export async function getSubscriptionTier(token) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...LOAD_CODE_ASSIST_HEADERS
    };

    for (const endpoint of LOAD_CODE_ASSIST_ENDPOINTS) {
        try {
            const url = `${endpoint}/v1internal:loadCodeAssist`;
            const response = await throttledFetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                logger.warn(`[CloudCode] loadCodeAssist error at ${endpoint}: ${response.status}`);
                // Detect permanent ToS ban — no point trying other endpoints
                if (response.status === 403) {
                    const lower = (errorText || '').toLowerCase();
                    if (lower.includes('has been disabled') && lower.includes('violation of terms of service')) {
                        throw new Error(`ACCOUNT_BANNED: ${errorText}`);
                    }
                }
                continue;
            }

            const data = await response.json();

            // Debug: Log all tier-related fields from the response
            logger.debug(`[CloudCode] loadCodeAssist tier data: paidTier=${JSON.stringify(data.paidTier)}, currentTier=${JSON.stringify(data.currentTier)}, allowedTiers=${JSON.stringify(data.allowedTiers?.map(t => ({ id: t?.id, isDefault: t?.isDefault })))}`);

            // Extract project ID
            let projectId = null;
            if (typeof data.cloudaicompanionProject === 'string') {
                projectId = data.cloudaicompanionProject;
            } else if (data.cloudaicompanionProject?.id) {
                projectId = data.cloudaicompanionProject.id;
            }

            // Extract subscription tier
            // Priority: paidTier > currentTier > allowedTiers
            // - paidTier.id: "g1-pro-tier", "g1-ultra-tier" (Google One subscription)
            // - currentTier.id: "standard-tier" (pro), "free-tier" (free)
            // - allowedTiers: fallback when currentTier is missing
            // Note: paidTier is sometimes missing from the response even for Pro accounts
            let tier = 'unknown';
            let tierId = null;
            let tierSource = null;

            // 1. Check paidTier first (Google One AI subscription - most reliable)
            if (data.paidTier?.id) {
                tierId = data.paidTier.id;
                tier = parseTierId(tierId);
                tierSource = 'paidTier';
            }

            // 2. Fall back to currentTier if paidTier didn't give us a tier
            if (tier === 'unknown' && data.currentTier?.id) {
                tierId = data.currentTier.id;
                tier = parseTierId(tierId);
                tierSource = 'currentTier';
            }

            // 3. Fall back to allowedTiers (find the default or first non-free tier)
            if (tier === 'unknown' && Array.isArray(data.allowedTiers) && data.allowedTiers.length > 0) {
                // First look for the default tier
                let defaultTier = data.allowedTiers.find(t => t?.isDefault);
                if (!defaultTier) {
                    defaultTier = data.allowedTiers[0];
                }
                if (defaultTier?.id) {
                    tierId = defaultTier.id;
                    tier = parseTierId(tierId);
                    tierSource = 'allowedTiers';
                }
            }

            logger.debug(`[CloudCode] Subscription detected: ${tier} (tierId: ${tierId}, source: ${tierSource}), Project: ${projectId}`);

            return { tier, projectId };
        } catch (error) {
            logger.warn(`[CloudCode] loadCodeAssist failed at ${endpoint}:`, error.message);
        }
    }

    // Fallback: return default values if all endpoints fail
    logger.warn('[CloudCode] Failed to detect subscription tier from all endpoints. Defaulting to free.');
    return { tier: 'free', projectId: null };
}

/**
 * Populate the model validation cache
 * @param {string} token - OAuth access token
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<void>}
 */
async function populateModelCache(token, projectId = null, forceForToken = false) {
    const now = Date.now();
    const isFresh = modelCache.validModels.size > 0 && (now - modelCache.lastFetched) < MODEL_VALIDATION_CACHE_TTL_MS;

    // Check if cache is fresh (and already includes this token if forced)
    if (isFresh && (!forceForToken || modelCache.fetchedTokens.has(token))) {
        return;
    }

    // If already fetching, wait for it
    if (modelCache.fetchPromise) {
        await modelCache.fetchPromise;
        if (!forceForToken || modelCache.fetchedTokens.has(token)) {
            return;
        }
    }

    // Start fetch
    modelCache.fetchPromise = (async () => {
        try {
            const data = await fetchAvailableModels(token, projectId);
            if (data && data.models) {
                recordModels(data);
                const validIds = Object.keys(data.models).filter(modelId => isSupportedModel(modelId));
                const fetchTime = Date.now();
                if (fetchTime - modelCache.lastFetched >= MODEL_VALIDATION_CACHE_TTL_MS) {
                    modelCache.validModels = new Set();
                    modelCache.fetchedTokens = new Set();
                }
                for (const id of validIds) {
                    modelCache.validModels.add(id);
                }
                if (token) modelCache.fetchedTokens.add(token);
                modelCache.lastFetched = fetchTime;
                logger.debug(`[CloudCode] Model cache populated with ${modelCache.validModels.size} models`);
            }
        } catch (error) {
            logger.warn(`[CloudCode] Failed to populate model cache: ${error.message}`);
            // Don't throw - validation should degrade gracefully
        } finally {
            modelCache.fetchPromise = null;
        }
    })();

    await modelCache.fetchPromise;
}

/**
 * Check if a model ID is valid (exists in the available models list)
 * Uses a cached model list with TTL-based refresh
 * @param {string} modelId - Model ID to validate
 * @param {string} token - OAuth access token for cache population
 * @param {string} [projectId] - Optional project ID
 * @returns {Promise<boolean>} True if model is valid
 */
export async function isValidModel(modelId, token, projectId = null) {
    try {
        // Populate cache if needed
        await populateModelCache(token, projectId, false);

        if (modelCache.validModels.has(modelId)) {
            return true;
        }

        // Cache may have been populated by an account with a smaller model catalog;
        // refresh once with this account's token and union into the cache.
        if (token && !modelCache.fetchedTokens.has(token)) {
            await populateModelCache(token, projectId, true);
        }

        // If cache is populated, validate against it
        if (modelCache.validModels.size > 0) {
            return modelCache.validModels.has(modelId);
        }

        // Cache empty (fetch failed) - fail open, let API validate
        return true;
    } catch (error) {
        logger.debug(`[CloudCode] Model validation error: ${error.message}`);
        // Fail open - let the API validate
        return true;
    }
}

const EFFORT_SUFFIX_RE = /^(.*)-(low|medium|high|xhigh)$/;

/**
 * Return the current set of cached valid model IDs.
 * @returns {Set<string>}
 */
export function getCachedModelIds() {
    return modelCache.validModels;
}

/**
 * Add canonical effort-routed aliases (e.g. "gemini-4-neon", "claude-opus-5-5")
 * to a merged /v1/models map whenever at least 2 effort variants exist.
 * @param {Map<string, Object>} mergedById
 */
export function addCanonicalEffortAliases(mergedById) {
    const groups = new Map();
    for (const [id, model] of mergedById.entries()) {
        const match = id.match(EFFORT_SUFFIX_RE);
        if (!match) continue;
        const [, base, suffix] = match;
        if (!groups.has(base)) groups.set(base, new Map());
        groups.get(base).set(suffix, model);
    }

    for (const [base, variants] of groups.entries()) {
        if (variants.size < 2 || mergedById.has(base)) continue;
        const sample = variants.get('medium') || variants.get('high') || variants.get('low') || variants.get('xhigh');
        const baseDesc = (sample?.description || base).replace(/\s*\((low|medium|high|xhigh)\)\s*$/i, '').trim();
        mergedById.set(base, {
            id: base,
            object: 'model',
            created: sample?.created || Math.floor(Date.now() / 1000),
            owned_by: sample?.owned_by || 'anthropic',
            description: `${baseDesc} (Auto Effort)`
        });
    }
}

/**
 * Map Anthropic thinking / output_config.effort parameters to a preferred
 * ordered list of backend effort suffixes.
 * @param {Object} [thinking]
 * @param {Object} [outputConfig]
 * @returns {string[]}
 */
function getEffortPreference(thinking, outputConfig) {
    const explicitEffort = typeof outputConfig?.effort === 'string'
        ? outputConfig.effort.toLowerCase()
        : null;

    if (explicitEffort === 'low' || explicitEffort === 'minimal') {
        return ['low', 'medium', 'high', 'xhigh'];
    }
    if (explicitEffort === 'medium') {
        return ['medium', 'high', 'low', 'xhigh'];
    }
    if (explicitEffort === 'high') {
        return ['high', 'xhigh', 'medium', 'low'];
    }
    if (explicitEffort === 'max' || explicitEffort === 'xhigh') {
        return ['xhigh', 'high', 'medium', 'low'];
    }

    if (thinking?.type === 'disabled') {
        return ['low', 'medium', 'high', 'xhigh'];
    }

    const budget = thinking?.budget_tokens;
    if (typeof budget === 'number') {
        if (budget <= 2048) return ['low', 'medium', 'high', 'xhigh'];
        if (budget <= 8192) return ['medium', 'high', 'low', 'xhigh'];
        if (budget <= 16384) return ['high', 'xhigh', 'medium', 'low'];
        return ['xhigh', 'high', 'medium', 'low'];
    }

    return ['medium', 'high', 'low', 'xhigh'];
}

/**
 * Resolve a canonical effort alias (e.g. "gemini-4-neon") to the matching
 * concrete backend model (e.g. "gemini-4-neon-high") based on thinking effort.
 * Explicit concrete model IDs are returned unchanged.
 * @param {string} modelId
 * @param {Object} [thinking]
 * @param {Object} [outputConfig]
 * @param {Set<string>} availableIds
 * @returns {string}
 */
export function resolveEffortModel(modelId, thinking, outputConfig, availableIds) {
    if (!modelId || !availableIds || availableIds.size === 0) return modelId;
    if (availableIds.has(modelId)) return modelId;

    const preference = getEffortPreference(thinking, outputConfig);
    for (const suffix of preference) {
        const candidate = `${modelId}-${suffix}`;
        if (availableIds.has(candidate)) {
            return candidate;
        }
    }

    return modelId;
}
