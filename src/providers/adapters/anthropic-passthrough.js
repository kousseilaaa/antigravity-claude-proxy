/**
 * Anthropic Direct Passthrough Adapter
 * Sends Anthropic Messages API requests directly to Anthropic (or any Anthropic-compatible endpoint)
 * and streams/returns native Anthropic responses.
 */

import { logger } from '../../utils/logger.js';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * Build headers for Anthropic API
 */
function buildHeaders(apiKey, extraHeaders = {}) {
    return {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...extraHeaders
    };
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
export async function sendAnthropicMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {} }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = buildPayload(anthropicRequest, modelId, false);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
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
export async function* streamAnthropicMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {} }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = buildPayload(anthropicRequest, modelId, true);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
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
