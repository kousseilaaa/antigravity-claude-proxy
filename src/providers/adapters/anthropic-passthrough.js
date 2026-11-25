/**
 * Anthropic Direct Passthrough Adapter
 * Sends Anthropic Messages API requests directly to Anthropic (or any Anthropic-compatible endpoint)
 * and streams/returns native Anthropic responses.
 */

import { logger } from '../../utils/logger.js';
import { CLAUDE_OAUTH_SYSTEM_PREFIX, CLAUDE_OAUTH_BETA_HEADER } from '../auth/claude-oauth.js';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Build headers for Anthropic API
 */
function buildHeaders(apiKey, extraHeaders = {}, authMode = 'api-key') {
    if (authMode === 'bearer') {
        const betaBase = extraHeaders['anthropic-beta'];
        const beta = betaBase
            ? `${betaBase},${CLAUDE_OAUTH_BETA_HEADER}`
            : CLAUDE_OAUTH_BETA_HEADER;
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'anthropic-version': ANTHROPIC_VERSION,
            ...extraHeaders,
            'anthropic-beta': beta
        };
    }
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...extraHeaders
    };
}

/**
 * Ensure the system prompt starts with CLAUDE_OAUTH_SYSTEM_PREFIX for Claude Code OAuth.
 */
function applyOAuthSystemPrefix(body) {
    const sys = body.system;
    if (!sys) {
        body.system = CLAUDE_OAUTH_SYSTEM_PREFIX;
    } else if (typeof sys === 'string') {
        if (!sys.startsWith(CLAUDE_OAUTH_SYSTEM_PREFIX)) {
            body.system = `${CLAUDE_OAUTH_SYSTEM_PREFIX}\n\n${sys}`;
        }
    } else if (Array.isArray(sys)) {
        const first = sys.find(b => b.type === 'text');
        if (!first || !first.text.startsWith(CLAUDE_OAUTH_SYSTEM_PREFIX)) {
            body.system = [{ type: 'text', text: CLAUDE_OAUTH_SYSTEM_PREFIX }, ...sys];
        }
    }
}

/**
 * Build clean Anthropic request payload
 */
function buildPayload(anthropicRequest, modelId, stream) {
    const payload = {
        model: modelId,
        messages: anthropicRequest.messages,
        max_tokens: anthropicRequest.max_tokens || 4096,
        stream: !!stream
    };
    if (anthropicRequest.system !== undefined) payload.system = anthropicRequest.system;
    if (anthropicRequest.tools?.length) payload.tools = anthropicRequest.tools;
    if (anthropicRequest.tool_choice !== undefined) payload.tool_choice = anthropicRequest.tool_choice;
    if (anthropicRequest.thinking !== undefined) payload.thinking = anthropicRequest.thinking;
    if (anthropicRequest.temperature !== undefined) payload.temperature = anthropicRequest.temperature;
    if (anthropicRequest.top_p !== undefined) payload.top_p = anthropicRequest.top_p;
    if (anthropicRequest.top_k !== undefined) payload.top_k = anthropicRequest.top_k;
    if (anthropicRequest.stop_sequences?.length) payload.stop_sequences = anthropicRequest.stop_sequences;
    return payload;
}

/**
 * Send non-streaming message to Anthropic API
 */
export async function sendAnthropicMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {}, authMode = 'api-key' }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = buildPayload(anthropicRequest, modelId, false);
    if (authMode === 'bearer') applyOAuthSystemPrefix(body);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders, authMode),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Anthropic API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    return await response.json();
}

/**
 * Stream Anthropic SSE events directly from an Anthropic-compatible endpoint
 */
export async function* streamAnthropicMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {}, authMode = 'api-key' }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = buildPayload(anthropicRequest, modelId, true);
    if (authMode === 'bearer') applyOAuthSystemPrefix(body);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders, authMode),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Anthropic API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data:')) continue;
                const dataStr = trimmed.slice(5).trim();
                if (!dataStr || dataStr === '[DONE]') continue;
                try {
                    const event = JSON.parse(dataStr);
                    if (event && event.type) {
                        yield event;
                    }
                } catch (e) {
                    logger.debug(`[AnthropicAdapter] Failed to parse SSE chunk: ${e.message}`);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

export default {
    sendAnthropicMessage,
    streamAnthropicMessage
};
