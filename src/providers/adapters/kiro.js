/**
 * Kiro / Amazon Q AWS Builder ID Adapter
 * Converts Anthropic Messages API requests into Kiro's conversationState format,
 * and decodes responses from the AWS binary EventStream protocol.
 *
 * Endpoint: POST https://runtime.<region>.kiro.dev/generateAssistantResponse
 * Protocol: AWS binary EventStream (application/vnd.amazon.eventstream)
 */

import { logger } from '../../utils/logger.js';

const DEFAULT_REGION = 'us-east-1';
const USER_AGENT = 'KiroIDE-1.1.70';

// ---------------------------------------------------------------------------
// Conversation state builder
// ---------------------------------------------------------------------------

/**
 * Map a single Anthropic content item to a plain text string.
 */
function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('');
    }
    return '';
}

/**
 * Convert an Anthropic system prompt to a plain string (strips array blocks).
 */
function systemToText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (Array.isArray(system)) {
        return system
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n\n');
    }
    return '';
}

/**
 * Build Kiro's `conversationState` payload from an Anthropic request.
 *
 * Kiro history alternates userInputMessage / assistantResponseMessage.
 * The last user turn becomes `currentMessage`; prior turns become `history`.
 */
function buildConversationState({ anthropicRequest, modelId, profileArn }) {
    const messages = anthropicRequest.messages ?? [];
    const systemText = systemToText(anthropicRequest.system);

    // Split off the last user message as `currentMessage`
    const historyMessages = messages.slice(0, -1);
    const lastMessage = messages[messages.length - 1];

    const history = historyMessages.map(msg => {
        if (msg.role === 'user') {
            return {
                userInputMessage: {
                    content: contentToText(msg.content),
                    modelId,
                    origin: 'AI_EDITOR'
                }
            };
        }
        // assistant
        return {
            assistantResponseMessage: {
                content: contentToText(msg.content),
                toolUse: []
            }
        };
    });

    const currentUserContent = lastMessage ? contentToText(lastMessage.content) : '';
    // Prepend system prompt to the current user message if present
    const fullContent = systemText
        ? `${systemText}\n\n${currentUserContent}`
        : currentUserContent;

    const conversationState = {
        conversationId: generateConversationId(),
        currentMessage: {
            userInputMessage: {
                content: fullContent,
                modelId,
                origin: 'AI_EDITOR'
            }
        },
        history,
        chatTriggerType: 'MANUAL'
    };

    if (profileArn) {
        conversationState.profileArn = profileArn;
    }

    return conversationState;
}

function generateConversationId() {
    // Simple UUID v4 without external deps
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

// ---------------------------------------------------------------------------
// AWS binary EventStream decoder
// ---------------------------------------------------------------------------

/**
 * Frame layout (all big-endian):
 *   [0-3]   totalLength   uint32  (includes all fields + trailing CRC)
 *   [4-7]   headersLength uint32
 *   [8-11]  preludeCRC    uint32
 *   [12 .. 12+headersLength-1]  headers (variable)
 *   [12+headersLength .. totalLength-5]  payload
 *   [totalLength-4 .. totalLength-1]    messageCRC uint32
 *
 * Header encoding:
 *   nameLength uint8, name utf8[nameLength],
 *   valueType  uint8  (7 = string),
 *   valueLength uint16, value utf8[valueLength]
 */

/**
 * Attempt to decode one complete EventStream frame from `buf` starting at `offset`.
 * Returns `{ frame, consumed }` where consumed is the number of bytes used,
 * or `null` if not enough data yet.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ frame: { headers: Record<string,string>, payload: object|string }, consumed: number } | null}
 */
export function decodeAwsEventStreamFrame(buf, offset = 0) {
    // Need at least 12 bytes for the prelude
    if (buf.length - offset < 12) return null;

    const totalLength = buf.readUInt32BE(offset);
    if (buf.length - offset < totalLength) return null;  // frame incomplete

    const headersLength = buf.readUInt32BE(offset + 4);
    // preludeCRC at offset+8 — we skip CRC validation for speed

    const headersStart = offset + 12;
    const headersEnd = headersStart + headersLength;
    const payloadEnd = offset + totalLength - 4; // 4-byte trailing message CRC

    // Decode headers
    const headers = {};
    let pos = headersStart;
    while (pos < headersEnd) {
        const nameLen = buf.readUInt8(pos);
        pos += 1;
        const name = buf.toString('utf8', pos, pos + nameLen);
        pos += nameLen;
        const valueType = buf.readUInt8(pos);
        pos += 1;
        if (valueType === 7) {
            // string
            const valueLen = buf.readUInt16BE(pos);
            pos += 2;
            headers[name] = buf.toString('utf8', pos, pos + valueLen);
            pos += valueLen;
        } else {
            // Skip unknown types — read their length prefix (uint16) and skip
            const valueLen = buf.readUInt16BE(pos);
            pos += 2 + valueLen;
        }
    }

    // Decode payload (JSON)
    const payloadBuf = buf.slice(headersEnd, payloadEnd);
    let payload;
    try {
        payload = JSON.parse(payloadBuf.toString('utf8'));
    } catch {
        payload = payloadBuf.toString('utf8');
    }

    return { frame: { headers, payload }, consumed: totalLength };
}

/**
 * Generator that yields decoded EventStream frames from a ReadableStream of Uint8Array chunks.
 * Handles frames split across arbitrary TCP chunk boundaries.
 *
 * @param {ReadableStream} stream
 */
async function* decodeAwsEventStreamChunks(stream) {
    const reader = stream.getReader();
    let pending = Buffer.alloc(0);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = Buffer.from(value);
            pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

            let offset = 0;
            while (offset < pending.length) {
                const result = decodeAwsEventStreamFrame(pending, offset);
                if (!result) break;
                yield result.frame;
                offset += result.consumed;
            }

            // Keep unprocessed bytes
            pending = offset > 0 ? pending.slice(offset) : pending;
        }
    } finally {
        reader.releaseLock();
    }
}

// ---------------------------------------------------------------------------
// Response extraction
// ---------------------------------------------------------------------------

/**
 * Extract text delta from a Kiro EventStream frame.
 * Kiro emits frames with `:event-type` = `assistantResponseEvent`.
 * Payload shape: `{ content: string }` for text deltas.
 */
function extractTextDelta(frame) {
    const eventType = frame.headers[':event-type'];
    if (eventType !== 'assistantResponseEvent') return null;
    if (typeof frame.payload !== 'object' || frame.payload === null) return null;
    const content = frame.payload.content;
    if (typeof content !== 'string') return null;
    return content;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildKiroHeaders(accessToken) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.amazon.eventstream',
        'User-Agent': USER_AGENT
    };
}

function resolveEndpoint(baseUrl, region) {
    if (baseUrl) return `${baseUrl.replace(/\/+$/, '')}/generateAssistantResponse`;
    return `https://runtime.${region || DEFAULT_REGION}.kiro.dev/generateAssistantResponse`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a non-streaming Kiro request and aggregate the full response into an
 * Anthropic Message object.
 *
 * @param {{ baseUrl?: string, accessToken: string, modelId: string, anthropicRequest: object, profileArn?: string, region?: string }}
 * @returns {Promise<object>} Anthropic Message
 */
export async function sendKiroMessage({ baseUrl, accessToken, modelId, anthropicRequest, profileArn, region }) {
    const url = resolveEndpoint(baseUrl, region);
    const conversationState = buildConversationState({ anthropicRequest, modelId, profileArn });

    logger.debug(`[KiroAdapter] POST ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildKiroHeaders(accessToken),
        body: JSON.stringify({ conversationState })
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Kiro API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    let fullText = '';
    for await (const frame of decodeAwsEventStreamChunks(response.body)) {
        const delta = extractTextDelta(frame);
        if (delta !== null) fullText += delta;
    }

    // Build a synthetic Anthropic Message object
    return {
        id: `msg_kiro_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: fullText }],
        model: modelId,
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
    };
}

/**
 * Stream Kiro responses, emitting standard Anthropic SSE events.
 *
 * Yields events: message_start, content_block_start, content_block_delta (per frame),
 * content_block_stop, message_delta, message_stop.
 *
 * @param {{ baseUrl?: string, accessToken: string, modelId: string, anthropicRequest: object, profileArn?: string, region?: string }}
 */
export async function* streamKiroMessage({ baseUrl, accessToken, modelId, anthropicRequest, profileArn, region }) {
    const url = resolveEndpoint(baseUrl, region);
    const conversationState = buildConversationState({ anthropicRequest, modelId, profileArn });

    logger.debug(`[KiroAdapter] POST (stream) ${url}`);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildKiroHeaders(accessToken),
        body: JSON.stringify({ conversationState })
    });

    if (!response.ok) {
        const text = await response.text();
        const err = new Error(`Kiro API error (${response.status}): ${text}`);
        err.status = response.status;
        throw err;
    }

    const messageId = `msg_kiro_${Date.now()}`;

    yield {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: modelId,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
        }
    };

    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };

    let outputTokens = 0;

    for await (const frame of decodeAwsEventStreamChunks(response.body)) {
        const delta = extractTextDelta(frame);
        if (delta !== null && delta.length > 0) {
            outputTokens += 1; // approximate; Kiro doesn't report token counts per delta
            yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: delta }
            };
        }
    }

    yield { type: 'content_block_stop', index: 0 };

    yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens }
    };

    yield { type: 'message_stop' };
}

export default {
    sendKiroMessage,
    streamKiroMessage,
    decodeAwsEventStreamFrame
};
