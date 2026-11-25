/**
 * Provider Registry
 * Defines all supported AI providers (OAuth accounts & API key providers),
 * their protocols, base URLs, model discovery, and default model catalogs.
 */

export const AUTH_TYPES = {
    OAUTH: 'oauth',
    OAUTH_MANUAL: 'oauth-manual',
    DEVICE_CODE: 'device-code',
    API_KEY: 'api-key'
};

export const PROTOCOLS = {
    ANTIGRAVITY: 'antigravity',
    ANTHROPIC: 'anthropic',
    OPENAI_CHAT: 'openai-chat',
    OPENAI_RESPONSES: 'openai-responses',
    KIRO: 'kiro'
};

export const PROVIDERS = {
    antigravity: {
        id: 'antigravity',
        name: 'Google Antigravity',
        shortName: 'Antigravity',
        category: 'oauth',
        authType: AUTH_TYPES.OAUTH,
        protocol: PROTOCOLS.ANTIGRAVITY,
        description: 'Google Cloud Code / Antigravity OAuth account (Claude & Gemini models)',
        badgeColor: 'purple',
        defaultBaseUrl: null,
        modelsEndpoint: null,
        defaultModels: []
    },
    'openai-codex': {
        id: 'openai-codex',
        name: 'OpenAI Codex (ChatGPT)',
        shortName: 'OpenAI Codex',
        category: 'oauth',
        authType: AUTH_TYPES.OAUTH,
        protocol: PROTOCOLS.OPENAI_RESPONSES,
        description: 'Connect your ChatGPT Plus/Pro/Team account via OpenAI OAuth',
        badgeColor: 'emerald',
        defaultBaseUrl: 'https://chatgpt.com/backend-api/codex',
        modelsEndpoint: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
        defaultModels: [
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
            { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' },
            { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
            { id: 'gpt-5.2', name: 'GPT-5.2' },
            { id: 'gpt-5.1', name: 'GPT-5.1' }
        ]
    },
    'github-copilot': {
        id: 'github-copilot',
        name: 'GitHub Copilot',
        shortName: 'Copilot',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect your GitHub Copilot subscription via Device Code OAuth',
        badgeColor: 'sky',
        defaultBaseUrl: 'https://api.githubcopilot.com',
        modelsEndpoint: 'https://api.githubcopilot.com/models',
        defaultModels: [
            { id: 'gpt-4o', name: 'GPT-4o (Copilot)' },
            { id: 'gpt-4.1', name: 'GPT-4.1 (Copilot)' },
            { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (Copilot)' },
            { id: 'claude-3.7-sonnet', name: 'Claude 3.7 Sonnet (Copilot)' },
            { id: 'claude-sonnet-4', name: 'Claude Sonnet 4 (Copilot)' },
            { id: 'o3-mini', name: 'o3-mini (Copilot)' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Copilot)' }
        ]
    },
    anthropic: {
        id: 'anthropic',
        name: 'Anthropic API',
        shortName: 'Anthropic',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.ANTHROPIC,
        description: 'Official Anthropic Messages API using an API key (sk-ant-...)',
        badgeColor: 'amber',
        defaultBaseUrl: 'https://api.anthropic.com',
        modelsEndpoint: 'https://api.anthropic.com/v1/models',
        keyPlaceholder: 'sk-ant-api03-...',
        defaultModels: [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
            { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }
        ]
    },
    openai: {
        id: 'openai',
        name: 'OpenAI API',
        shortName: 'OpenAI',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Official OpenAI API using an API key (sk-...)',
        badgeColor: 'green',
        defaultBaseUrl: 'https://api.openai.com/v1',
        modelsEndpoint: 'https://api.openai.com/v1/models',
        keyPlaceholder: 'sk-proj-...',
        defaultModels: [
            { id: 'gpt-5', name: 'GPT-5' },
            { id: 'gpt-4.1', name: 'GPT-4.1' },
            { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
            { id: 'gpt-4o', name: 'GPT-4o' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
            { id: 'o3', name: 'o3' },
            { id: 'o4-mini', name: 'o4-mini' }
        ]
    },
    opencode: {
        id: 'opencode',
        name: 'OpenCode Zen',
        shortName: 'OpenCode',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'OpenCode Zen gateway API key (curated coding & free models)',
        badgeColor: 'cyan',
        defaultBaseUrl: 'https://opencode.ai/zen/v1',
        modelsEndpoint: 'https://opencode.ai/zen/v1/models',
        keyPlaceholder: 'sk-...',
        defaultModels: [
            { id: 'big-pickle', name: 'Big Pickle (OpenCode)' },
            { id: 'glm-4.7-free', name: 'GLM-4.7 Free (OpenCode)' },
            { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free (OpenCode)' },
            { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free (OpenCode)' },
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (OpenCode)' },
            { id: 'claude-opus-4-5', name: 'Claude Opus 4.5 (OpenCode)' },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (OpenCode)' },
            { id: 'qwen3-coder', name: 'Qwen3 Coder (OpenCode)' }
        ]
    },
    openrouter: {
        id: 'openrouter',
        name: 'OpenRouter',
        shortName: 'OpenRouter',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Unified API for 200+ models across Anthropic, OpenAI, Google, Meta, etc.',
        badgeColor: 'indigo',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        modelsEndpoint: 'https://openrouter.ai/api/v1/models',
        keyPlaceholder: 'sk-or-v1-...',
        extraHeaders: {
            'HTTP-Referer': 'https://github.com/kousseilaaa/antigravity-claude-proxy',
            'X-Title': 'Antigravity Multi-Provider Proxy'
        },
        defaultModels: [
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OpenRouter)' },
            { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4 (OpenRouter)' },
            { id: 'openai/gpt-4.1', name: 'GPT-4.1 (OpenRouter)' },
            { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OpenRouter)' },
            { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (OpenRouter)' },
            { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder (OpenRouter)' }
        ]
    },
    'google-ai': {
        id: 'google-ai',
        name: 'Google AI Studio (Gemini)',
        shortName: 'Google AI',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Google AI Studio Gemini API using an API key (AIza...)',
        badgeColor: 'blue',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        keyPlaceholder: 'AIzaSy...',
        defaultModels: [
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
        ]
    },
    deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        shortName: 'DeepSeek',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'DeepSeek Chat & Reasoner (R1) API',
        badgeColor: 'blue',
        defaultBaseUrl: 'https://api.deepseek.com/v1',
        modelsEndpoint: 'https://api.deepseek.com/v1/models',
        keyPlaceholder: 'sk-...',
        defaultModels: [
            { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)' },
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)' }
        ]
    },
    groq: {
        id: 'groq',
        name: 'Groq',
        shortName: 'Groq',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Ultra-fast inference for Llama, Qwen, and DeepSeek models',
        badgeColor: 'orange',
        defaultBaseUrl: 'https://api.groq.com/openai/v1',
        modelsEndpoint: 'https://api.groq.com/openai/v1/models',
        keyPlaceholder: 'gsk_...',
        defaultModels: [
            { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile' },
            { id: 'qwen-qwq-32b', name: 'Qwen QwQ 32B' },
            { id: 'deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B' }
        ]
    },
    xai: {
        id: 'xai',
        name: 'xAI (Grok)',
        shortName: 'xAI',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'xAI Grok models API',
        badgeColor: 'slate',
        defaultBaseUrl: 'https://api.x.ai/v1',
        modelsEndpoint: 'https://api.x.ai/v1/models',
        keyPlaceholder: 'xai-...',
        defaultModels: [
            { id: 'grok-3', name: 'Grok 3' },
            { id: 'grok-3-mini', name: 'Grok 3 Mini' },
            { id: 'grok-code-fast-1', name: 'Grok Code Fast 1' }
        ]
    },
    mistral: {
        id: 'mistral',
        name: 'Mistral AI',
        shortName: 'Mistral',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Mistral, Codestral, and Devstral models API',
        badgeColor: 'amber',
        defaultBaseUrl: 'https://api.mistral.ai/v1',
        modelsEndpoint: 'https://api.mistral.ai/v1/models',
        keyPlaceholder: '...',
        defaultModels: [
            { id: 'mistral-large-latest', name: 'Mistral Large' },
            { id: 'codestral-latest', name: 'Codestral' },
            { id: 'devstral-small-latest', name: 'Devstral Small' }
        ]
    },
    custom: {
        id: 'custom',
        name: 'Custom Provider',
        shortName: 'Custom',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Any OpenAI-compatible or Anthropic-compatible endpoint (Ollama, vLLM, LM Studio, LiteLLM, etc.)',
        badgeColor: 'gray',
        defaultBaseUrl: 'http://localhost:11434/v1',
        modelsEndpoint: null,
        keyPlaceholder: 'sk-... (optional for local)',
        allowCustomBaseUrl: true,
        allowProtocolChoice: true,
        defaultModels: []
    },
    'anthropic-oauth': {
        id: 'anthropic-oauth',
        name: 'Claude Pro/Max (OAuth)',
        shortName: 'Claude OAuth',
        category: 'oauth',
        authType: AUTH_TYPES.OAUTH_MANUAL,
        protocol: PROTOCOLS.ANTHROPIC,
        description: 'Connect your Claude Pro/Max account via OAuth PKCE (hosted callback, paste code)',
        badgeColor: 'amber',
        defaultBaseUrl: 'https://api.anthropic.com',
        modelsEndpoint: 'https://api.anthropic.com/v1/models',
        defaultModels: [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
            { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
            { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
            { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet' },
            { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' }
        ]
    },
    'gemini-cli': {
        id: 'gemini-cli',
        name: 'Gemini CLI (Google)',
        shortName: 'Gemini CLI',
        category: 'oauth',
        authType: AUTH_TYPES.OAUTH,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect via Google Gemini CLI OAuth PKCE (auto browser callback)',
        badgeColor: 'blue',
        defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        modelsEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
        defaultModels: [
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
            { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
            { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' }
        ]
    },
    'qwen-code': {
        id: 'qwen-code',
        name: 'Qwen Code (Alibaba)',
        shortName: 'Qwen Code',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect your Alibaba Qwen Code account via Device Code + PKCE',
        badgeColor: 'violet',
        defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        modelsEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
        defaultModels: [
            { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' },
            { id: 'qwen3-coder', name: 'Qwen3 Coder' },
            { id: 'qwen3-235b-a22b', name: 'Qwen3 235B A22B' },
            { id: 'qwen-max', name: 'Qwen Max' },
            { id: 'qwen-plus', name: 'Qwen Plus' }
        ]
    },
    'openrouter-oauth': {
        id: 'openrouter-oauth',
        name: 'OpenRouter (OAuth)',
        shortName: 'OpenRouter OAuth',
        category: 'oauth',
        authType: AUTH_TYPES.OAUTH,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect via OpenRouter OAuth PKCE (exchanges for API key on success)',
        badgeColor: 'indigo',
        defaultBaseUrl: 'https://openrouter.ai/api/v1',
        modelsEndpoint: 'https://openrouter.ai/api/v1/models',
        defaultModels: [
            { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OpenRouter)' },
            { id: 'anthropic/claude-opus-4', name: 'Claude Opus 4 (OpenRouter)' },
            { id: 'openai/gpt-4.1', name: 'GPT-4.1 (OpenRouter)' },
            { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OpenRouter)' },
            { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (OpenRouter)' },
            { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder (OpenRouter)' }
        ]
    },
    'kimi-code': {
        id: 'kimi-code',
        name: 'Kimi Code (Moonshot)',
        shortName: 'Kimi Code',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect your Kimi Code account via Device Code OAuth',
        badgeColor: 'sky',
        defaultBaseUrl: 'https://api.kimi.com/coding/v1',
        modelsEndpoint: 'https://api.kimi.com/coding/v1/models',
        defaultModels: [
            { id: 'kimi-k2.5', name: 'Kimi K2.5' },
            { id: 'kimi-k1.5-long', name: 'Kimi K1.5 Long' },
            { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K' }
        ]
    },
    'opencode-oauth': {
        id: 'opencode-oauth',
        name: 'OpenCode Zen (OAuth)',
        shortName: 'OpenCode OAuth',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect your OpenCode Zen account via Device Code OAuth (Console)',
        badgeColor: 'cyan',
        defaultBaseUrl: 'https://opencode.ai/inference/openai/v1',
        modelsEndpoint: 'https://opencode.ai/inference/openai/v1/models',
        defaultModels: [
            { id: 'big-pickle', name: 'Big Pickle (OpenCode)' },
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (OpenCode)' },
            { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex (OpenCode)' },
            { id: 'qwen3-coder', name: 'Qwen3 Coder (OpenCode)' },
            { id: 'glm-4.7-free', name: 'GLM-4.7 Free (OpenCode)' }
        ]
    },
    kilo: {
        id: 'kilo',
        name: 'Kilo Code (Gateway)',
        shortName: 'Kilo',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Connect via Kilo Code Gateway Device Auth (long-lived token)',
        badgeColor: 'orange',
        defaultBaseUrl: 'https://ai-gateway.kilo.ai/api/v1',
        modelsEndpoint: 'https://ai-gateway.kilo.ai/api/v1/models',
        defaultModels: [
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Kilo)' },
            { id: 'claude-opus-4', name: 'Claude Opus 4 (Kilo)' },
            { id: 'gpt-4.1', name: 'GPT-4.1 (Kilo)' },
            { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Kilo)' }
        ]
    },
    kiro: {
        id: 'kiro',
        name: 'Kiro (Amazon Q)',
        shortName: 'Kiro',
        category: 'oauth',
        authType: AUTH_TYPES.DEVICE_CODE,
        protocol: PROTOCOLS.KIRO,
        description: 'Connect via Kiro / Amazon Q AWS Builder ID Device Code OAuth',
        badgeColor: 'rose',
        defaultBaseUrl: 'https://runtime.us-east-1.kiro.dev',
        modelsEndpoint: null,
        defaultModels: [
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5 (Kiro)' },
            { id: 'claude-opus-4', name: 'Claude Opus 4 (Kiro)' }
        ]
    },
    minimax: {
        id: 'minimax',
        name: 'MiniMax',
        shortName: 'MiniMax',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'MiniMax M-series multimodal models API',
        badgeColor: 'fuchsia',
        defaultBaseUrl: 'https://api.minimax.io/v1',
        modelsEndpoint: 'https://api.minimax.io/v1/models',
        keyPlaceholder: 'eyJ...',
        defaultModels: [
            { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
            { id: 'MiniMax-M1', name: 'MiniMax M1' }
        ]
    },
    zai: {
        id: 'zai',
        name: 'Z.AI (GLM)',
        shortName: 'Z.AI',
        category: 'api-key',
        authType: AUTH_TYPES.API_KEY,
        protocol: PROTOCOLS.OPENAI_CHAT,
        description: 'Z.AI GLM models API (Zhipu AI)',
        badgeColor: 'teal',
        defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
        modelsEndpoint: 'https://api.z.ai/api/paas/v4/models',
        keyPlaceholder: '...',
        defaultModels: [
            { id: 'glm-4.7', name: 'GLM-4.7' },
            { id: 'glm-4.6', name: 'GLM-4.6' }
        ]
    }
};

export const DEFAULT_PROVIDER = 'antigravity';

/**
 * Get provider definition by ID (defaults to antigravity if omitted)
 * @param {string} [providerId]
 * @returns {Object|null}
 */
export function getProvider(providerId) {
    if (!providerId) return PROVIDERS[DEFAULT_PROVIDER];
    return PROVIDERS[providerId] || null;
}

/**
 * Resolve effective provider ID for an account object
 * @param {Object} account
 * @returns {string}
 */
export function getAccountProvider(account) {
    return account?.provider || DEFAULT_PROVIDER;
}

/**
 * Check if an account is a Google Antigravity account
 * @param {Object} account
 * @returns {boolean}
 */
export function isAntigravityAccount(account) {
    return getAccountProvider(account) === DEFAULT_PROVIDER;
}

/**
 * List all provider definitions for UI/CLI
 * @returns {Array<Object>}
 */
export function listProviders() {
    return Object.values(PROVIDERS);
}

/**
 * Parse a model string that may optionally have a provider prefix (e.g. "openai/gpt-4o").
 * Note: OpenRouter model IDs like "anthropic/claude-sonnet-4" are only split if the prefix
 * matches a known provider ID AND the user explicitly has an account for that provider, OR
 * if the prefix is explicitly "openrouter/..." etc.
 *
 * @param {string} modelString
 * @returns {{ providerId: string|null, modelId: string }}
 */
export function parseModelIdentifier(modelString) {
    if (!modelString || typeof modelString !== 'string') {
        return { providerId: null, modelId: modelString || '' };
    }
    const slashIndex = modelString.indexOf('/');
    if (slashIndex > 0) {
        const prefix = modelString.slice(0, slashIndex).toLowerCase();
        if (PROVIDERS[prefix]) {
            return {
                providerId: prefix,
                modelId: modelString.slice(slashIndex + 1)
            };
        }
    }
    return { providerId: null, modelId: modelString };
}

/**
 * Get the effective base URL for an account
 * @param {Object} account
 * @returns {string|null}
 */
export function getAccountBaseUrl(account) {
    if (account?.baseUrl) {
        return account.baseUrl.replace(/\/+$/, '');
    }
    const provider = getProvider(getAccountProvider(account));
    return provider?.defaultBaseUrl ? provider.defaultBaseUrl.replace(/\/+$/, '') : null;
}

/**
 * Get the effective protocol for an account
 * @param {Object} account
 * @returns {string}
 */
export function getAccountProtocol(account) {
    if (account?.protocol && Object.values(PROTOCOLS).includes(account.protocol)) {
        return account.protocol;
    }
    const provider = getProvider(getAccountProvider(account));
    return provider?.protocol || PROTOCOLS.ANTIGRAVITY;
}

/**
 * Build a provider-scoped unique account identifier so the same email can be
 * connected across multiple providers simultaneously without colliding in
 * accounts.json, tokenCache, rate-limits, trackers, or WebUI routes.
 *
 * - For 'antigravity' (default): preserves raw email for full backwards compatibility.
 * - For all other providers: prefixes with `<providerId>:` if not already prefixed.
 *
 * @param {string} providerId
 * @param {string} email
 * @returns {string}
 */
export function normalizeAccountEmail(providerId, email) {
    const cleanProvider = providerId || DEFAULT_PROVIDER;
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail) return cleanEmail;
    if (cleanProvider === DEFAULT_PROVIDER) return cleanEmail;
    const prefix = `${cleanProvider}:`;
    return cleanEmail.startsWith(prefix) ? cleanEmail : `${prefix}${cleanEmail}`;
}

/**
 * Strip the `<providerId>:` prefix from an account identifier for human display.
 * @param {string} email
 * @param {string|null} [providerId]
 * @returns {string}
 */
export function stripProviderPrefix(email, providerId = null) {
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail) return cleanEmail;
    if (providerId && providerId !== DEFAULT_PROVIDER) {
        const prefix = `${providerId}:`;
        if (cleanEmail.startsWith(prefix)) return cleanEmail.slice(prefix.length);
    }
    const idx = cleanEmail.indexOf(':');
    if (idx > 0 && PROVIDERS[cleanEmail.slice(0, idx)]) {
        return cleanEmail.slice(idx + 1);
    }
    return cleanEmail;
}

export default {
    AUTH_TYPES,
    PROTOCOLS,
    PROVIDERS,
    DEFAULT_PROVIDER,
    getProvider,
    getAccountProvider,
    isAntigravityAccount,
    listProviders,
    parseModelIdentifier,
    getAccountBaseUrl,
    getAccountProtocol,
    normalizeAccountEmail,
    stripProviderPrefix
};
