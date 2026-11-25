/**
 * OpenAI Codex Responses API Adapter
 * Translates Anthropic Messages API <-> OpenAI Responses API
 * used by ChatGPT Plus/Pro/Team OAuth accounts (https://chatgpt.com/backend-api/codex/responses).
 */

import crypto from 'crypto';
import { logger } from '../../utils/logger.js';

function extractSystemText(system) {
    if (!system) return 'You are a helpful AI coding assistant.';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        const text = system
            .filter(b => b && b.type === 'text' && b.text)
            .map(b => b.text)
            .join('\n\n');
        return text || 'You are a helpful AI coding assistant.';
    }
    return 'You are a helpful AI coding assistant.';
}

/**
 * Convert Anthropic messages to OpenAI Responses `input` items
 */
export function convertAnthropicToResponsesInput(messages = []) {
    const input = [];

    for (const msg of messages) {
        if (!msg || !msg.role) continue;

        if (typeof msg.content === 'string') {
            input.push({
                type: 'message',
                role: msg.role,
                content: [{ type: msg.role === 'assistant' ? 'output_text' : 'input_text', text: msg.content }]
            });
            continue;
        }

        if (!Array.isArray(msg.content)) continue;

        if (msg.role === 'user') {
            const parts = [];
            for (const block of msg.content) {
                if (!block) continue;
                if (block.type === 'tool_result') {
                    let outputText = '';
                    if (typeof block.content === 'string') {
                        outputText = block.content;
                    } else if (Array.isArray(block.content)) {
                        outputText = block.content.map(c => (c.type === 'text' ? c.text : JSON.stringify(c))).join('\n');
                    } else if (block.content != null) {
                        outputText = JSON.stringify(block.content);
                    }
                    input.push({
                        type: 'function_call_output',
                        call_id: block.tool_use_id,
                        output: outputText
                    });
                } else if (block.type === 'text') {
                    parts.push({ type: 'input_text', text: block.text || '' });
                } else if (block.type === 'image' && block.source) {
                    const url = block.source.type === 'base64'
                        ? `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`
                        : block.source.url;
                    if (url) {
                        parts.push({ type: 'input_image', image_url: url });
                    }
                }
            }
            if (parts.length > 0) {
                input.push({ type: 'message', role: 'user', content: parts });
            }
        } else if (msg.role === 'assistant') {
            const textParts = [];
            const functionCalls = [];
            for (const block of msg.content) {
                if (!block) continue;
                if (block.type === 'text' && block.text) {
                    textParts.push({ type: 'output_text', text: block.text });
                } else if (block.type === 'tool_use') {
                    functionCalls.push({
                        type: 'function_call',
                        call_id: block.id || `call_${crypto.randomBytes(6).toString('hex')}`,
                        name: block.name,
                        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
                    });
                }
            }
            if (textParts.length > 0) {
                input.push({ type: 'message', role: 'assistant', content: textParts });
            }
            for (const fc of functionCalls) {
                input.push(fc);
            }
        }
    }

    return input;
}

/**
 * Build OpenAI Codex Responses request body
 */
export function buildCodexResponsesRequest(anthropicRequest, modelId) {
    const payload = {
        model: modelId,
        instructions: extractSystemText(anthropicRequest.system),
        input: convertAnthropicToResponsesInput(anthropicRequest.messages),
        store: false,
        stream: true
    };

    if (Array.isArray(anthropicRequest.tools) && anthropicRequest.tools.length > 0) {
        payload.tools = anthropicRequest.tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} }
        }));
        payload.tool_choice = 'auto';
    }

    if (anthropicRequest.thinking) {
        payload.reasoning = { effort: 'medium', summary: 'auto' };
    }

    return payload;
}

function buildCodexHeaders(accessToken, chatgptAccountId = null) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'text/event-stream',
        'originator': 'codex_cli_rs'
    };
    if (chatgptAccountId) {
        headers['ChatGPT-Account-Id'] = chatgptAccountId;
    }
    return headers;
}

/**
 * Stream OpenAI Codex Responses SSE and yield Anthropic SSE events
 */
export async function* streamCodexResponsesMessage({ baseUrl, accessToken, chatgptAccountId, modelId, anthropicRequest }) {
    const clean = (baseUrl || 'https://chatgpt.com/backend-api/codex').replace(/\/+$/, '');
    const url = clean.endsWith('/responses') ? clean : `${clean}/responses`;
    const body = buildCodexResponsesRequest(anthropicRequest, modelId);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildCodexHeaders(accessToken, chatgptAccountId),
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`OpenAI Codex API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
    let messageStarted = false;
    let nextBlockIndex = 0;
    let activeTextBlockIndex = null;
    let activeThinkingBlockIndex = null;
    const itemToToolBlock = new Map(); // item_id -> { blockIndex, id, name }
    let hasToolUse = false;
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

                let evt;
                try {
                    evt = JSON.parse(dataStr);
                } catch (e) {
                    logger.debug(`[CodexResponsesAdapter] Unparseable SSE event: ${e.message}`);
                    continue;
                }

                const type = evt.type;
                if (type === 'response.reasoning_summary_text.delta' && evt.delta) {
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
                        delta: { type: 'thinking_delta', thinking: evt.delta }
                    };
                } else if (type === 'response.output_text.delta' && evt.delta) {
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
                        delta: { type: 'text_delta', text: evt.delta }
                    };
                } else if (type === 'response.output_item.added' && evt.item?.type === 'function_call') {
                    yield* ensureMessageStart();
                    yield* closeThinkingIfOpen();
                    yield* closeTextIfOpen();
                    hasToolUse = true;
                    const blockIndex = nextBlockIndex++;
                    const callId = evt.item.call_id || evt.item.id || `toolu_${crypto.randomBytes(6).toString('hex')}`;
                    const itemKey = evt.item.id || callId;
                    itemToToolBlock.set(itemKey, { blockIndex, id: callId, name: evt.item.name || '' });
                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'tool_use',
                            id: callId,
                            name: evt.item.name || '',
                            input: {}
                        }
                    };
                } else if (type === 'response.function_call_arguments.delta' && evt.delta) {
                    const blockInfo = itemToToolBlock.get(evt.item_id);
                    if (blockInfo) {
                        yield {
                            type: 'content_block_delta',
                            index: blockInfo.blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: evt.delta
                            }
                        };
                    }
                } else if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
                    const itemKey = evt.item.id || evt.item.call_id;
                    const blockInfo = itemToToolBlock.get(itemKey);
                    if (blockInfo) {
                        yield { type: 'content_block_stop', index: blockInfo.blockIndex };
                        itemToToolBlock.delete(itemKey);
                    }
                } else if (type === 'response.completed' && evt.response?.usage) {
                    usage.input_tokens = evt.response.usage.input_tokens || 0;
                    usage.output_tokens = evt.response.usage.output_tokens || 0;
                } else if (type === 'error' || type === 'response.failed') {
                    const msg = evt.error?.message || evt.response?.error?.message || 'OpenAI Codex request failed';
                    throw new Error(msg);
                }
            }
        }
    } finally {
        reader.releaseLock();
    }

    yield* ensureMessageStart();
    yield* closeThinkingIfOpen();
    yield* closeTextIfOpen();
    for (const blockInfo of itemToToolBlock.values()) {
        yield { type: 'content_block_stop', index: blockInfo.blockIndex };
    }

    yield {
        type: 'message_delta',
        delta: {
            stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
            stop_sequence: null
        },
        usage: { output_tokens: usage.output_tokens }
    };
    yield { type: 'message_stop' };
}

/**
 * Non-streaming wrapper around Codex Responses API (Codex backend requires stream: true)
 */
export async function sendCodexResponsesMessage(params) {
    let message = null;
    const blocks = [];
    const partialJsonByIndex = new Map();

    for await (const evt of streamCodexResponsesMessage(params)) {
        if (evt.type === 'message_start') {
            message = { ...evt.message, content: [] };
        } else if (evt.type === 'content_block_start') {
            blocks[evt.index] = { ...evt.content_block };
            if (evt.content_block.type === 'tool_use') {
                partialJsonByIndex.set(evt.index, '');
            }
        } else if (evt.type === 'content_block_delta') {
            const block = blocks[evt.index];
            if (!block) continue;
            if (evt.delta.type === 'text_delta') {
                block.text = (block.text || '') + evt.delta.text;
            } else if (evt.delta.type === 'thinking_delta') {
                block.thinking = (block.thinking || '') + evt.delta.thinking;
            } else if (evt.delta.type === 'input_json_delta') {
                partialJsonByIndex.set(evt.index, (partialJsonByIndex.get(evt.index) || '') + evt.delta.partial_json);
            }
        } else if (evt.type === 'content_block_stop') {
            const block = blocks[evt.index];
            if (block && block.type === 'tool_use') {
                const raw = partialJsonByIndex.get(evt.index) || '{}';
                try {
                    block.input = JSON.parse(raw);
                } catch {
                    block.input = { raw };
                }
            }
        } else if (evt.type === 'message_delta' && message) {
            message.stop_reason = evt.delta.stop_reason;
            message.usage = { ...message.usage, ...evt.usage };
        }
    }

    if (!message) {
        return {
            id: `msg_${crypto.randomBytes(8).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            model: params.modelId,
            content: [{ type: 'text', text: '' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        };
    }

    message.content = blocks.filter(Boolean);
    if (message.content.length === 0) {
        message.content.push({ type: 'text', text: '' });
    }
    return message;
}

export default {
    convertAnthropicToResponsesInput,
    buildCodexResponsesRequest,
    streamCodexResponsesMessage,
    sendCodexResponsesMessage
};
