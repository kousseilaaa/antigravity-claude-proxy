/**
 * OpenAI Chat Completions Adapter
 * Translates Anthropic Messages API requests <-> OpenAI Chat Completions API
 * (non-streaming and streaming SSE, including tools, vision, and reasoning blocks).
 *
 * Used by: OpenAI API, OpenCode Zen, OpenRouter, GitHub Copilot, Google AI Studio,
 * DeepSeek, Groq, xAI, Mistral, and Custom OpenAI-compatible endpoints.
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

/**
 * Convert Anthropic system prompt (string or block array) to plain text
 */
function extractSystemText(system) {
    if (!system) return null;
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .filter(b => b && b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n\n');
    }
    return null;
}

/**
 * Convert Anthropic content blocks to OpenAI chat messages
 * @param {Array} messages - Anthropic messages array
 * @param {string|Array} [system] - Anthropic system prompt
 * @returns {Array} OpenAI messages array
 */
export function convertAnthropicToOpenAIMessages(messages = [], system = null) {
    const out = [];
    const sysText = extractSystemText(system);
    if (sysText) {
        out.push({ role: 'system', content: sysText });
    }

    for (const msg of messages) {
        if (!msg || !msg.role) continue;

        if (typeof msg.content === 'string') {
            out.push({ role: msg.role, content: msg.content });
            continue;
        }

        if (!Array.isArray(msg.content)) {
            out.push({ role: msg.role, content: '' });
            continue;
        }

        if (msg.role === 'user') {
            // Separate tool_result blocks (which become role: "tool" messages) from user content
            const toolResults = [];
            const contentParts = [];

            for (const block of msg.content) {
                if (!block) continue;
                if (block.type === 'tool_result') {
                    let resultText = '';
                    if (typeof block.content === 'string') {
                        resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                        resultText = block.content
                            .map(c => (c.type === 'text' ? c.text : JSON.stringify(c)))
                            .join('\n');
                    } else if (block.content != null) {
                        resultText = JSON.stringify(block.content);
                    }
                    toolResults.push({
                        role: 'tool',
                        tool_call_id: block.tool_use_id,
                        content: resultText
                    });
                } else if (block.type === 'text') {
                    contentParts.push({ type: 'text', text: block.text || '' });
                } else if (block.type === 'image' && block.source) {
                    const url = block.source.type === 'base64'
                        ? `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`
                        : block.source.url;
                    if (url) {
                        contentParts.push({ type: 'image_url', image_url: { url } });
                    }
                }
            }

            // Emit tool results first (must immediately follow assistant tool_calls)
            for (const tr of toolResults) {
                out.push(tr);
            }

            if (contentParts.length > 0) {
                if (contentParts.every(p => p.type === 'text')) {
                    out.push({ role: 'user', content: contentParts.map(p => p.text).join('\n') });
                } else {
                    out.push({ role: 'user', content: contentParts });
                }
            }
        } else if (msg.role === 'assistant') {
            const textParts = [];
            const toolCalls = [];

            for (const block of msg.content) {
                if (!block) continue;
                if (block.type === 'text' && block.text) {
                    textParts.push(block.text);
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id || `call_${crypto.randomBytes(6).toString('hex')}`,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: typeof block.input === 'string'
                                ? block.input
                                : JSON.stringify(block.input || {})
                        }
                    });
                }
                // thinking / redacted_thinking blocks are omitted from OpenAI assistant history
            }

            const assistantMsg = {
                role: 'assistant',
                content: textParts.length > 0 ? textParts.join('\n') : (toolCalls.length > 0 ? null : '')
            };
            if (toolCalls.length > 0) {
                assistantMsg.tool_calls = toolCalls;
            }
            out.push(assistantMsg);
        }
    }

    return out;
}

/**
 * Convert Anthropic tools & tool_choice to OpenAI format
 */
export function convertAnthropicToolsToOpenAI(tools, toolChoice) {
    const result = {};
    if (Array.isArray(tools) && tools.length > 0) {
        result.tools = tools.map(t => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description || '',
                parameters: t.input_schema || { type: 'object', properties: {} }
            }
        }));
    }

    if (toolChoice) {
        if (toolChoice.type === 'auto') {
            result.tool_choice = 'auto';
        } else if (toolChoice.type === 'any') {
            result.tool_choice = 'required';
        } else if (toolChoice.type === 'none') {
            result.tool_choice = 'none';
        } else if (toolChoice.type === 'tool' && toolChoice.name) {
            result.tool_choice = {
                type: 'function',
                function: { name: toolChoice.name }
            };
        }
    }
    return result;
}

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 */
export function mapOpenAIFinishReason(finishReason) {
    switch (finishReason) {
        case 'stop': return 'end_turn';
        case 'length': return 'max_tokens';
        case 'tool_calls':
        case 'function_call': return 'tool_use';
        case 'content_filter': return 'end_turn';
        default: return 'end_turn';
    }
}

/**
 * Build OpenAI Chat Completions request body from Anthropic request
 */
export function buildOpenAIChatRequest(anthropicRequest, modelId, stream = false) {
    const messages = convertAnthropicToOpenAIMessages(anthropicRequest.messages, anthropicRequest.system);
    const { tools, tool_choice } = convertAnthropicToolsToOpenAI(anthropicRequest.tools, anthropicRequest.tool_choice);

    const payload = {
        model: modelId,
        messages,
        stream: !!stream
    };

    if (anthropicRequest.max_tokens) {
        payload.max_tokens = anthropicRequest.max_tokens;
    }
    if (anthropicRequest.temperature !== undefined) {
        payload.temperature = anthropicRequest.temperature;
    }
    if (anthropicRequest.top_p !== undefined) {
        payload.top_p = anthropicRequest.top_p;
    }
    if (anthropicRequest.stop_sequences?.length) {
        payload.stop = anthropicRequest.stop_sequences;
    }
    if (tools) {
        payload.tools = tools;
    }
    if (tool_choice !== undefined) {
        payload.tool_choice = tool_choice;
    }
    if (stream) {
        payload.stream_options = { include_usage: true };
    }

    return payload;
}

/**
 * Convert OpenAI non-streaming chat completion response to Anthropic Message format
 */
export function convertOpenAIResponseToAnthropic(openaiResponse, modelId) {
    const choice = openaiResponse.choices?.[0];
    const message = choice?.message || {};
    const content = [];

    const reasoning = message.reasoning_content || message.reasoning;
    if (reasoning) {
        content.push({ type: 'thinking', thinking: reasoning });
    }

    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
        for (const tc of message.tool_calls) {
            let input = {};
            try {
                input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
            } catch {
                input = { raw: tc.function?.arguments || '' };
            }
            content.push({
                type: 'tool_use',
                id: tc.id || `toolu_${crypto.randomBytes(6).toString('hex')}`,
                name: tc.function?.name || 'unknown',
                input
            });
        }
    }

    if (content.length === 0) {
        content.push({ type: 'text', text: '' });
    }

    return {
        id: openaiResponse.id || `msg_${crypto.randomBytes(8).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model: modelId || openaiResponse.model,
        content,
        stop_reason: mapOpenAIFinishReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResponse.usage?.prompt_tokens || 0,
            output_tokens: openaiResponse.usage?.completion_tokens || 0
        }
    };
}

/**
 * Resolve Chat Completions URL from baseUrl
 */
function resolveChatUrl(baseUrl) {
    const clean = baseUrl.replace(/\/+$/, '');
    if (clean.endsWith('/chat/completions')) return clean;
    return `${clean}/chat/completions`;
}

/**
 * Build auth + provider headers
 */
function buildHeaders(apiKey, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders
    };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

/**
 * Send non-streaming message via OpenAI Chat Completions API
 */
export async function sendOpenAIChatMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {} }) {
    const url = resolveChatUrl(baseUrl);
    const body = buildOpenAIChatRequest(anthropicRequest, modelId, false);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`OpenAI-compatible API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    const data = await response.json();
    return convertOpenAIResponseToAnthropic(data, modelId);
}

/**
 * Stream OpenAI Chat Completions SSE and yield Anthropic SSE events
 */
export async function* streamOpenAIChatMessage({ baseUrl, apiKey, modelId, anthropicRequest, extraHeaders = {} }) {
    const url = resolveChatUrl(baseUrl);
    const body = buildOpenAIChatRequest(anthropicRequest, modelId, true);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiKey, extraHeaders),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`OpenAI-compatible API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    let messageStarted = false;
    let nextBlockIndex = 0;
    let activeTextBlockIndex = null;
    let activeThinkingBlockIndex = null;
    // Map OpenAI tool_call index -> { blockIndex, id, name }
    const activeToolBlocks = new Map();
    let finishReason = null;
    let usage = { input_tokens: 0, output_tokens: 0 };

    const ensureMessageStart = function* () {
        if (!messageStarted) {
            messageStarted = true;
            yield {
                type: 'message_start',
                message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    model: modelId,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            };
        }
    };

    const closeThinkingIfOpen = function* () {
        if (activeThinkingBlockIndex !== null) {
            yield { type: 'content_block_stop', index: activeThinkingBlockIndex };
            activeThinkingBlockIndex = null;
        }
    };

    const closeTextIfOpen = function* () {
        if (activeTextBlockIndex !== null) {
            yield { type: 'content_block_stop', index: activeTextBlockIndex };
            activeTextBlockIndex = null;
        }
    };

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

                let chunk;
                try {
                    chunk = JSON.parse(dataStr);
                } catch (e) {
                    logger.debug(`[OpenAIChatAdapter] Skipping unparseable chunk: ${e.message}`);
                    continue;
                }

                if (chunk.usage) {
                    usage.input_tokens = chunk.usage.prompt_tokens || usage.input_tokens;
                    usage.output_tokens = chunk.usage.completion_tokens || usage.output_tokens;
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const delta = choice.delta || {};
                if (choice.finish_reason) {
                    finishReason = choice.finish_reason;
                }

                // Reasoning / thinking delta (DeepSeek R1, OpenRouter, etc.)
                const reasoningDelta = delta.reasoning_content || delta.reasoning;
                if (reasoningDelta) {
                    yield* ensureMessageStart();
                    if (activeThinkingBlockIndex === null) {
                        activeThinkingBlockIndex = nextBlockIndex++;
                        yield {
                            type: 'content_block_start',
                            index: activeThinkingBlockIndex,
                            content_block: { type: 'thinking', thinking: '' }
                        };
                    }
                    yield {
                        type: 'content_block_delta',
                        index: activeThinkingBlockIndex,
                        delta: { type: 'thinking_delta', thinking: reasoningDelta }
                    };
                }

                // Text delta
                if (delta.content) {
                    yield* ensureMessageStart();
                    yield* closeThinkingIfOpen();
                    if (activeTextBlockIndex === null) {
                        activeTextBlockIndex = nextBlockIndex++;
                        yield {
                            type: 'content_block_start',
                            index: activeTextBlockIndex,
                            content_block: { type: 'text', text: '' }
                        };
                    }
                    yield {
                        type: 'content_block_delta',
                        index: activeTextBlockIndex,
                        delta: { type: 'text_delta', text: delta.content }
                    };
                }

                // Tool call deltas
                if (Array.isArray(delta.tool_calls)) {
                    yield* ensureMessageStart();
                    yield* closeThinkingIfOpen();
                    yield* closeTextIfOpen();

                    for (const tc of delta.tool_calls) {
                        const tcIndex = tc.index ?? 0;
                        let blockInfo = activeToolBlocks.get(tcIndex);
                        if (!blockInfo) {
                            const blockIndex = nextBlockIndex++;
                            blockInfo = {
                                blockIndex,
                                id: tc.id || `toolu_${crypto.randomBytes(6).toString('hex')}`,
                                name: tc.function?.name || ''
                            };
                            activeToolBlocks.set(tcIndex, blockInfo);
                            yield {
                                type: 'content_block_start',
                                index: blockIndex,
                                content_block: {
                                    type: 'tool_use',
                                    id: blockInfo.id,
                                    name: blockInfo.name,
                                    input: {}
                                }
                            };
                        }
                        if (tc.function?.arguments) {
                            yield {
                                type: 'content_block_delta',
                                index: blockInfo.blockIndex,
                                delta: {
                                    type: 'input_json_delta',
                                    partial_json: tc.function.arguments
                                }
                            };
                        }
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    // Close all open blocks and finish message
    yield* ensureMessageStart();
    yield* closeThinkingIfOpen();
    yield* closeTextIfOpen();
    for (const blockInfo of activeToolBlocks.values()) {
        yield { type: 'content_block_stop', index: blockInfo.blockIndex };
    }

    yield {
        type: 'message_delta',
        delta: {
            stop_reason: mapOpenAIFinishReason(finishReason),
            stop_sequence: null
        },
        usage: { output_tokens: usage.output_tokens }
    };
    yield { type: 'message_stop' };
}

export default {
    convertAnthropicToOpenAIMessages,
    convertAnthropicToolsToOpenAI,
    mapOpenAIFinishReason,
    buildOpenAIChatRequest,
    convertOpenAIResponseToAnthropic,
    sendOpenAIChatMessage,
    streamOpenAIChatMessage
};
