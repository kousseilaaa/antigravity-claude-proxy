/**
 * Multi-Provider Dispatcher
 * Routes Anthropic Messages API requests to the appropriate provider account
 * (Antigravity, OpenAI Codex, GitHub Copilot, Anthropic API, OpenAI API, OpenCode Zen,
 * OpenRouter, Google AI Studio, DeepSeek, Groq, xAI, Mistral, Custom),
 * discovers models across all providers, and tests account connectivity.
 */

import {
    PROTOCOLS,
    PROVIDERS,
    DEFAULT_PROVIDER,
    getProvider,
    getAccountProvider,
    isAntigravityAccount,
    parseModelIdentifier,
    getAccountBaseUrl,
    getAccountProtocol
} from './registry.js';
import { sendAnthropicMessage, streamAnthropicMessage } from './adapters/anthropic-passthrough.js';
import { sendOpenAIChatMessage, streamOpenAIChatMessage } from './adapters/openai-chat.js';
import { sendCodexResponsesMessage, streamCodexResponsesMessage } from './adapters/openai-responses.js';
import { COPILOT_HEADERS } from './auth/github-copilot-oauth.js';
import { logger } from '../utils/logger.js';

/**
 * Determine which provider should handle a requested model string.
 * Resolution order:
 *   1. Explicit "<provider>/<model>" prefix (e.g. "opencode/big-pickle", "openai/gpt-4o", "openai-codex/gpt-5.3-codex")
 *   2. Exact match against a non-Antigravity account's customModels or cached quota.models
 *   3. Exact match against a configured non-Antigravity provider's defaultModels catalog
 *      (only if Antigravity does not own that model or no Antigravity accounts exist)
 *   4. Default to 'antigravity' if any Antigravity account is configured, otherwise the first available provider
 *
 * @param {string} requestedModel
 * @param {Array<Object>} availableAccounts
 * @returns {{ providerId: string, modelId: string, explicit: boolean }}
 */
export function resolveProviderForModel(requestedModel, availableAccounts = []) {
    const { providerId: explicitProvider, modelId: strippedModel } = parseModelIdentifier(requestedModel);

    // 1. Explicit provider prefix (e.g. "openai/gpt-4o", "openrouter/anthropic/claude-sonnet-4")
    if (explicitProvider) {
        // Check if we actually have an account for this explicit provider
        const hasAccount = availableAccounts.some(a => getAccountProvider(a) === explicitProvider);
        if (hasAccount) {
            return { providerId: explicitProvider, modelId: strippedModel, explicit: true };
        }
        // Special case: OpenRouter model IDs look like "anthropic/claude-sonnet-4" or "openai/gpt-4.1"
        // If no direct account exists for the prefix, check if an OpenRouter account is configured
        const hasOpenRouter = availableAccounts.some(a => getAccountProvider(a) === 'openrouter');
        if (hasOpenRouter && explicitProvider !== 'openrouter') {
            return { providerId: 'openrouter', modelId: requestedModel, explicit: false };
        }
        return { providerId: explicitProvider, modelId: strippedModel, explicit: true };
    }

    const enabledProviders = new Set(availableAccounts.map(a => getAccountProvider(a)));
    const hasAntigravity = enabledProviders.has(DEFAULT_PROVIDER);

    // 2. Check customModels or cached models on non-Antigravity accounts
    for (const acc of availableAccounts) {
        const pid = getAccountProvider(acc);
        if (pid === DEFAULT_PROVIDER) continue;
        if (Array.isArray(acc.customModels) && acc.customModels.includes(requestedModel)) {
            return { providerId: pid, modelId: requestedModel, explicit: false };
        }
        if (acc.quota?.models && Object.prototype.hasOwnProperty.call(acc.quota.models, requestedModel)) {
            // If Antigravity also has this model (claude-*/gemini-*), prefer Antigravity unless no Antigravity account
            const isAntigravityFamily = requestedModel.startsWith('claude-') || requestedModel.startsWith('gemini-');
            if (!hasAntigravity || !isAntigravityFamily) {
                return { providerId: pid, modelId: requestedModel, explicit: false };
            }
        }
    }

    // 3. Check defaultModels catalog of configured non-Antigravity providers
    for (const pid of enabledProviders) {
        if (pid === DEFAULT_PROVIDER) continue;
        const provider = getProvider(pid);
        if (provider?.defaultModels?.some(m => m.id === requestedModel)) {
            // Prefer Antigravity for claude/gemini models if Antigravity is present
            const isAntigravityFamily = requestedModel.startsWith('claude-') || requestedModel.startsWith('gemini-');
            if (!hasAntigravity || !isAntigravityFamily) {
                return { providerId: pid, modelId: requestedModel, explicit: false };
            }
        }
    }

    // 4. Default: Antigravity if present, else first available provider
    if (hasAntigravity) {
        return { providerId: DEFAULT_PROVIDER, modelId: requestedModel, explicit: false };
    }
    const firstProvider = availableAccounts[0] ? getAccountProvider(availableAccounts[0]) : DEFAULT_PROVIDER;
    return { providerId: firstProvider, modelId: requestedModel, explicit: false };
}

/**
 * Fetch available models for a non-Antigravity account
 * Falls back gracefully to the provider's defaultModels + account.customModels.
 * @param {Object} account
 * @param {import('../account-manager/index.js').default} accountManager
 * @returns {Promise<Array<{ id: string, object: string, owned_by: string, provider: string, description?: string }>>}
 */
export async function listProviderModels(account, accountManager) {
    const providerId = getAccountProvider(account);
    const provider = getProvider(providerId);
    if (!provider) return [];

    const modelsMap = new Map();
    const addModel = (id, name) => {
        if (!id || modelsMap.has(id)) return;
        modelsMap.set(id, {
            id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: providerId,
            provider: providerId,
            description: name || id
        });
    };

    // Include custom models first
    if (Array.isArray(account.customModels)) {
        for (const m of account.customModels) {
            if (typeof m === 'string' && m.trim()) {
                addModel(m.trim(), `${m.trim()} (${provider.shortName})`);
            }
        }
    }

    // Attempt live /models fetch when provider supports it
    const baseUrl = getAccountBaseUrl(account);
    const modelsUrl = provider.modelsEndpoint || (baseUrl && providerId === 'custom' ? `${baseUrl}/models` : null);

    if (modelsUrl) {
        try {
            const token = await accountManager.getTokenForAccount(account);
            const headers = { 'Accept': 'application/json', ...(provider.extraHeaders || {}) };

            if (providerId === 'anthropic') {
                headers['x-api-key'] = token;
                headers['anthropic-version'] = '2023-06-01';
            } else if (providerId === 'github-copilot') {
                headers['Authorization'] = `Bearer ${token}`;
                Object.assign(headers, COPILOT_HEADERS);
            } else if (providerId === 'openai-codex') {
                headers['Authorization'] = `Bearer ${token}`;
                headers['originator'] = 'codex_cli_rs';
                headers['User-Agent'] = 'codex_cli_rs/1.0.0';
                if (account.extra?.chatgptAccountId) {
                    headers['chatgpt-account-id'] = account.extra.chatgptAccountId;
                }
            } else if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const res = await fetch(modelsUrl, { headers, signal: controller.signal });
                if (res.ok) {
                    const data = await res.json();
                    const list = Array.isArray(data?.data)
                        ? data.data
                        : (Array.isArray(data?.models) ? data.models : (Array.isArray(data) ? data : []));
                    for (const item of list) {
                        if (!item) continue;
                        // Skip hidden internal models returned by Codex (/backend-api/codex/models)
                        if (item.visibility === 'hide') continue;
                        const id = item.id || item.slug;
                        if (id) {
                            addModel(id, item.display_name || item.name || id);
                        }
                    }
                }
            } finally {
                clearTimeout(timer);
            }
        } catch (err) {
            logger.debug(`[Provider:${providerId}] Live model discovery failed for ${account.email}: ${err.message}`);
        }
    }

    // Add default catalog models as fallback / supplement
    if (modelsMap.size === 0 && Array.isArray(provider.defaultModels)) {
        for (const m of provider.defaultModels) {
            addModel(m.id, m.name);
        }
    }

    return Array.from(modelsMap.values());
}

/**
 * Format a rate-limit window duration in seconds to a compact human label (e.g. "5h", "7d", "30d").
 */
function formatWindowLabel(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return 'quota';
    const days = Math.round(seconds / 86400);
    if (days >= 1) return `${days}d`;
    const hours = Math.round(seconds / 3600);
    if (hours >= 1) return `${hours}h`;
    return `${Math.max(1, Math.round(seconds / 60))}m`;
}

/**
 * Fetch live quota/usage information for a non-Antigravity provider account.
 * Supports:
 *  - openai-codex: https://chatgpt.com/backend-api/wham/usage (primary/secondary rate_limit windows + plan_type)
 *  - github-copilot: https://api.github.com/copilot_internal/user (quota_snapshots + copilot_plan)
 *  - openrouter: https://openrouter.ai/api/v1/auth/key (credit limit & remaining)
 *  - all other providers: derives status from active account.modelRateLimits
 *
 * @param {Object} account
 * @param {import('../account-manager/index.js').default} accountManager
 * @returns {Promise<{ tier: string, windows: Array<{ label: string, remainingFraction: number, resetTime: string|null }>, quotas: Record<string, { remainingFraction: number, resetTime: string|null }> }>}
 */
export async function fetchProviderQuota(account, accountManager) {
    const providerId = getAccountProvider(account);
    const provider = getProvider(providerId);
    let tier = provider?.shortName?.toLowerCase() || providerId;
    let remainingFraction = 1;
    let resetTime = null;
    const windows = [];

    const models = await listProviderModels(account, accountManager);

    try {
        const token = await accountManager.getTokenForAccount(account);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
            if (providerId === 'openai-codex' && token) {
                const headers = {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                    'originator': 'codex_cli_rs',
                    'User-Agent': 'codex_cli_rs/1.0.0'
                };
                if (account.extra?.chatgptAccountId) {
                    headers['chatgpt-account-id'] = account.extra.chatgptAccountId;
                }
                const res = await fetch('https://chatgpt.com/backend-api/wham/usage', {
                    headers,
                    signal: controller.signal
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data.plan_type) tier = String(data.plan_type).toLowerCase();
                    const rl = data.rate_limit || {};
                    const rawWindows = [rl.primary_window, rl.secondary_window].filter(Boolean);
                    for (const w of rawWindows) {
                        if (typeof w.used_percent !== 'number') continue;
                        const rem = Math.max(0, Math.min(1, (100 - w.used_percent) / 100));
                        const rIso = typeof w.reset_at === 'number'
                            ? new Date(w.reset_at * 1000).toISOString()
                            : (typeof w.reset_after_seconds === 'number'
                                ? new Date(Date.now() + w.reset_after_seconds * 1000).toISOString()
                                : null);
                        windows.push({
                            label: formatWindowLabel(w.limit_window_seconds),
                            remainingFraction: rem,
                            resetTime: rIso
                        });
                    }
                    if (windows.length > 0) {
                        const worst = windows.reduce((a, b) => (b.remainingFraction < a.remainingFraction ? b : a));
                        remainingFraction = worst.remainingFraction;
                        resetTime = worst.resetTime;
                    } else if (rl.limit_reached) {
                        remainingFraction = 0;
                    }
                }
            } else if (providerId === 'github-copilot') {
                const ghToken = account.refreshToken || account.apiKey;
                if (ghToken) {
                    const res = await fetch('https://api.github.com/copilot_internal/user', {
                        headers: {
                            'Authorization': `token ${ghToken}`,
                            'Accept': 'application/json',
                            'User-Agent': 'GithubCopilot/1.155.0'
                        },
                        signal: controller.signal
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data.copilot_plan) tier = String(data.copilot_plan).toLowerCase();
                        const snap = data.quota_snapshots?.premium_interactions || data.quota_snapshots?.chat;
                        const rIso = data.quota_reset_date ? new Date(data.quota_reset_date).toISOString() : null;
                        if (snap && typeof snap.percent_remaining === 'number') {
                            remainingFraction = Math.max(0, Math.min(1, snap.percent_remaining / 100));
                            resetTime = rIso;
                            windows.push({ label: 'monthly', remainingFraction, resetTime });
                        }
                    }
                }
            } else if (providerId === 'openrouter' && token) {
                const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
                    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                    signal: controller.signal
                });
                if (res.ok) {
                    const json = await res.json();
                    const d = json?.data || {};
                    if (typeof d.limit === 'number' && d.limit > 0 && typeof d.limit_remaining === 'number') {
                        remainingFraction = Math.max(0, Math.min(1, d.limit_remaining / d.limit));
                        windows.push({ label: 'credits', remainingFraction, resetTime: null });
                    }
                }
            }
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        logger.debug(`[Provider:${providerId}] Live quota fetch failed for ${account.email}: ${err.message}`);
    }

    const now = Date.now();
    const quotas = {};
    for (const m of models) {
        const rl = account.modelRateLimits?.[m.id];
        if (rl && rl.isRateLimited && rl.resetTime > now) {
            quotas[m.id] = { remainingFraction: 0, resetTime: new Date(rl.resetTime).toISOString() };
        } else {
            quotas[m.id] = { remainingFraction, resetTime };
        }
    }

    return { tier, windows, quotas };
}

/**
 * Test connectivity for a non-Antigravity account
 * @param {Object} account
 * @param {import('../account-manager/index.js').default} accountManager
 * @returns {Promise<{ ok: boolean, modelCount: number, error?: string }>}
 */
export async function testProviderAccount(account, accountManager) {
    const providerId = getAccountProvider(account);
    const provider = getProvider(providerId);
    if (!provider) {
        return { ok: false, modelCount: 0, error: `Unknown provider: ${providerId}` };
    }

    try {
        const token = await accountManager.getTokenForAccount(account);
        if (!token && providerId !== 'custom') {
            return { ok: false, modelCount: 0, error: 'Missing API key or access token' };
        }

        const models = await listProviderModels(account, accountManager);
        return { ok: true, modelCount: models.length };
    } catch (err) {
        return { ok: false, modelCount: 0, error: err.message };
    }
}

/**
 * Execute a non-streaming request against a non-Antigravity provider with multi-account failover
 */
export async function sendProviderMessage(providerId, modelId, anthropicRequest, accountManager) {
    const candidates = accountManager.getAvailableAccounts(modelId, providerId);
    if (candidates.length === 0) {
        throw new Error(`No available accounts for provider "${providerId}"`);
    }

    let lastError = null;
    for (const account of candidates) {
        try {
            const token = await accountManager.getTokenForAccount(account);
            const protocol = getAccountProtocol(account);
            const baseUrl = getAccountBaseUrl(account);
            const provider = getProvider(providerId);
            const extraHeaders = {
                ...(provider?.extraHeaders || {}),
                ...(providerId === 'github-copilot' ? COPILOT_HEADERS : {})
            };

            let result;
            if (protocol === PROTOCOLS.ANTHROPIC) {
                result = await sendAnthropicMessage({ baseUrl, apiKey: token, modelId, anthropicRequest, extraHeaders });
            } else if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
                result = await sendCodexResponsesMessage({
                    baseUrl,
                    accessToken: token,
                    chatgptAccountId: account.extra?.chatgptAccountId || null,
                    modelId,
                    anthropicRequest
                });
            } else {
                const effectiveBaseUrl = providerId === 'github-copilot'
                    ? (account.extra?.copilotBaseUrl || baseUrl)
                    : baseUrl;
                result = await sendOpenAIChatMessage({
                    baseUrl: effectiveBaseUrl,
                    apiKey: token,
                    modelId,
                    anthropicRequest,
                    extraHeaders
                });
            }

            accountManager.notifySuccess(account, modelId);
            account.lastUsed = Date.now();
            return result;
        } catch (err) {
            lastError = err;
            logger.warn(`[Provider:${providerId}] Request failed on ${account.email}: ${err.message}`);
            if (err.status === 429) {
                accountManager.markRateLimited(account.email, 60000, modelId);
                accountManager.notifyRateLimit(account, modelId);
            } else if (err.status === 401 || err.status === 403) {
                accountManager.clearTokenCache(account.email);
                accountManager.notifyFailure(account, modelId);
            } else {
                accountManager.notifyFailure(account, modelId);
            }
        }
    }

    throw lastError || new Error(`All accounts failed for provider "${providerId}"`);
}

/**
 * Execute a streaming request against a non-Antigravity provider with multi-account failover
 */
export async function* streamProviderMessage(providerId, modelId, anthropicRequest, accountManager) {
    const candidates = accountManager.getAvailableAccounts(modelId, providerId);
    if (candidates.length === 0) {
        throw new Error(`No available accounts for provider "${providerId}"`);
    }

    let lastError = null;
    for (const account of candidates) {
        let yieldedAny = false;
        try {
            const token = await accountManager.getTokenForAccount(account);
            const protocol = getAccountProtocol(account);
            const baseUrl = getAccountBaseUrl(account);
            const provider = getProvider(providerId);
            const extraHeaders = {
                ...(provider?.extraHeaders || {}),
                ...(providerId === 'github-copilot' ? COPILOT_HEADERS : {})
            };

            let stream;
            if (protocol === PROTOCOLS.ANTHROPIC) {
                stream = streamAnthropicMessage({ baseUrl, apiKey: token, modelId, anthropicRequest, extraHeaders });
            } else if (protocol === PROTOCOLS.OPENAI_RESPONSES) {
                stream = streamCodexResponsesMessage({
                    baseUrl,
                    accessToken: token,
                    chatgptAccountId: account.extra?.chatgptAccountId || null,
                    modelId,
                    anthropicRequest
                });
            } else {
                const effectiveBaseUrl = providerId === 'github-copilot'
                    ? (account.extra?.copilotBaseUrl || baseUrl)
                    : baseUrl;
                stream = streamOpenAIChatMessage({
                    baseUrl: effectiveBaseUrl,
                    apiKey: token,
                    modelId,
                    anthropicRequest,
                    extraHeaders
                });
            }

            for await (const event of stream) {
                yieldedAny = true;
                yield event;
            }

            accountManager.notifySuccess(account, modelId);
            account.lastUsed = Date.now();
            return;
        } catch (err) {
            lastError = err;
            logger.warn(`[Provider:${providerId}] Stream failed on ${account.email}: ${err.message}`);
            if (err.status === 429) {
                accountManager.markRateLimited(account.email, 60000, modelId);
                accountManager.notifyRateLimit(account, modelId);
            } else if (err.status === 401 || err.status === 403) {
                accountManager.clearTokenCache(account.email);
                accountManager.notifyFailure(account, modelId);
            } else {
                accountManager.notifyFailure(account, modelId);
            }
            // If we already sent SSE events to the client, cannot failover cleanly
            if (yieldedAny) {
                throw err;
            }
        }
    }

    throw lastError || new Error(`All accounts failed for provider "${providerId}"`);
}

export default {
    resolveProviderForModel,
    listProviderModels,
    testProviderAccount,
    sendProviderMessage,
    streamProviderMessage
};
