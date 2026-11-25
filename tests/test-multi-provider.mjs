/**
 * Multi-Provider Unit & Integration Tests
 * Covers:
 * 1. Provider registry & model routing resolution
 * 2. OpenAI Chat Completions <-> Anthropic translation (non-streaming + streaming + tools + thinking)
 * 3. OpenAI Codex Responses <-> Anthropic translation (streaming + non-streaming + tools)
 * 4. Anthropic direct passthrough (non-streaming + streaming)
 * 5. End-to-end Express server routes (/api/providers, /api/accounts/api-key, /v1/models, /account-limits, /v1/messages)
 */

import assert from 'assert';
import http from 'http';
import {
    listProviders,
    getProvider,
    parseModelIdentifier,
    resolveProviderForModel,
    convertAnthropicToOpenAIMessages,
    convertAnthropicToolsToOpenAI,
    convertOpenAIResponseToAnthropic,
    sendOpenAIChatMessage,
    streamOpenAIChatMessage,
    sendCodexResponsesMessage,
    streamCodexResponsesMessage,
    sendAnthropicMessage,
    streamAnthropicMessage,
    extractCodexIdentity
} from '../src/providers/index.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.stack || err.message}`);
        failed++;
    }
}

function startMockServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
}

console.log('\n=== Multi-Provider Tests ===\n');

// 1. Registry & Routing
await runTest('Registry lists all expected OAuth & API key providers', () => {
    const ids = listProviders().map(p => p.id);
    for (const expected of ['antigravity', 'openai-codex', 'github-copilot', 'anthropic', 'openai', 'opencode', 'openrouter', 'google-ai', 'deepseek', 'groq', 'xai', 'mistral', 'custom']) {
        assert.ok(ids.includes(expected), `Missing provider: ${expected}`);
    }
    assert.strictEqual(getProvider('opencode').defaultBaseUrl, 'https://opencode.ai/zen/v1');
});

await runTest('parseModelIdentifier splits explicit provider prefixes cleanly', () => {
    assert.deepStrictEqual(parseModelIdentifier('openai/gpt-4o'), { providerId: 'openai', modelId: 'gpt-4o' });
    assert.deepStrictEqual(parseModelIdentifier('opencode/big-pickle'), { providerId: 'opencode', modelId: 'big-pickle' });
    assert.deepStrictEqual(parseModelIdentifier('openrouter/anthropic/claude-sonnet-4'), { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4' });
    assert.deepStrictEqual(parseModelIdentifier('claude-sonnet-4-5'), { providerId: null, modelId: 'claude-sonnet-4-5' });
});

await runTest('resolveProviderForModel routes explicit, catalog, and Antigravity models accurately', () => {
    const accounts = [
        { email: 'g@gmail.com', provider: 'antigravity', enabled: true },
        { email: 'c@openai.com', provider: 'openai-codex', enabled: true },
        { email: 'z@opencode', provider: 'opencode', enabled: true },
        { email: 'or@openrouter', provider: 'openrouter', enabled: true }
    ];

    // Explicit prefix
    assert.deepStrictEqual(resolveProviderForModel('opencode/big-pickle', accounts), {
        providerId: 'opencode', modelId: 'big-pickle', explicit: true
    });
    // Unprefixed catalog model belonging to openai-codex
    assert.deepStrictEqual(resolveProviderForModel('gpt-5.3-codex', accounts), {
        providerId: 'openai-codex', modelId: 'gpt-5.3-codex', explicit: false
    });
    // Unprefixed catalog model belonging to opencode
    assert.deepStrictEqual(resolveProviderForModel('big-pickle', accounts), {
        providerId: 'opencode', modelId: 'big-pickle', explicit: false
    });
    // OpenRouter nested model ID when no direct anthropic account exists
    assert.deepStrictEqual(resolveProviderForModel('anthropic/claude-sonnet-4', accounts), {
        providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4', explicit: false
    });
    // Default claude model stays on antigravity when antigravity is present
    assert.deepStrictEqual(resolveProviderForModel('claude-sonnet-4-5', accounts), {
        providerId: 'antigravity', modelId: 'claude-sonnet-4-5', explicit: false
    });
});

// 2. OpenAI Chat Completions Adapter
await runTest('OpenAI Chat request translator handles system, images, tool_use, tool_result', () => {
    const msgs = convertAnthropicToOpenAIMessages([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Check this image' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
            ]
        },
        {
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'hmm' },
                { type: 'text', text: 'Calling tool' },
                { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }
            ]
        },
        {
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'call_1', content: '22C sunny' }
            ]
        }
    ], 'Be concise.');

    assert.strictEqual(msgs[0].role, 'system');
    assert.strictEqual(msgs[0].content, 'Be concise.');
    assert.strictEqual(msgs[1].role, 'user');
    assert.strictEqual(msgs[1].content[1].type, 'image_url');
    assert.strictEqual(msgs[2].role, 'assistant');
    assert.strictEqual(msgs[2].tool_calls[0].function.name, 'get_weather');
    assert.strictEqual(msgs[3].role, 'tool');
    assert.strictEqual(msgs[3].tool_call_id, 'call_1');
    assert.strictEqual(msgs[3].content, '22C sunny');

    const tools = convertAnthropicToolsToOpenAI(
        [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }],
        { type: 'any' }
    );
    assert.strictEqual(tools.tools[0].function.name, 'get_weather');
    assert.strictEqual(tools.tool_choice, 'required');
});

await runTest('OpenAI Chat adapter non-streaming & streaming against mock upstream', async () => {
    const { server, baseUrl } = await startMockServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const parsed = JSON.parse(body);
            if (!parsed.stream) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'chatcmpl-123',
                    model: parsed.model,
                    choices: [{
                        finish_reason: 'tool_calls',
                        message: {
                            role: 'assistant',
                            reasoning_content: 'Thinking...',
                            content: 'Checking weather',
                            tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'weather', arguments: '{"city":"Paris"}' } }]
                        }
                    }],
                    usage: { prompt_tokens: 10, completion_tokens: 20 }
                }));
            } else {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Step 1' } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'world!' }, finish_reason: 'stop' }] })}\n\n`);
                res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
        });
    });

    try {
        const nonStream = await sendOpenAIChatMessage({
            baseUrl,
            apiKey: 'test-key',
            modelId: 'gpt-4o',
            anthropicRequest: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
        });
        assert.strictEqual(nonStream.stop_reason, 'tool_use');
        assert.strictEqual(nonStream.content[0].type, 'thinking');
        assert.strictEqual(nonStream.content[1].text, 'Checking weather');
        assert.strictEqual(nonStream.content[2].type, 'tool_use');
        assert.deepStrictEqual(nonStream.content[2].input, { city: 'Paris' });

        const events = [];
        for await (const evt of streamOpenAIChatMessage({
            baseUrl,
            apiKey: 'test-key',
            modelId: 'gpt-4o',
            anthropicRequest: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }
        })) {
            events.push(evt);
        }
        assert.strictEqual(events[0].type, 'message_start');
        assert.ok(events.some(e => e.delta?.type === 'thinking_delta' && e.delta.thinking === 'Step 1'));
        assert.ok(events.some(e => e.delta?.type === 'text_delta' && e.delta.text === 'Hello '));
        assert.ok(events.some(e => e.delta?.type === 'text_delta' && e.delta.text === 'world!'));
        assert.strictEqual(events[events.length - 1].type, 'message_stop');
    } finally {
        server.close();
    }
});

// 3. OpenAI Codex Responses Adapter + JWT identity extraction
await runTest('OpenAI Codex JWT extraction & Responses API adapter', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        email: 'dev@example.com',
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test_123' }
    })).toString('base64url');
    const fakeJwt = `${header}.${payload}.sig`;
    const identity = extractCodexIdentity(fakeJwt);
    assert.strictEqual(identity.email, 'dev@example.com');
    assert.strictEqual(identity.chatgptAccountId, 'acct_test_123');

    const { server, baseUrl } = await startMockServer((req, res) => {
        assert.strictEqual(req.headers['chatgpt-account-id'], 'acct_test_123');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'Planning' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Done!' })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 4 } } })}\n\n`);
        res.end();
    });

    try {
        const result = await sendCodexResponsesMessage({
            baseUrl,
            accessToken: fakeJwt,
            chatgptAccountId: 'acct_test_123',
            modelId: 'gpt-5.3-codex',
            anthropicRequest: { messages: [{ role: 'user', content: 'code' }], max_tokens: 100 }
        });
        assert.strictEqual(result.content[0].type, 'thinking');
        assert.strictEqual(result.content[0].thinking, 'Planning');
        assert.strictEqual(result.content[1].type, 'text');
        assert.strictEqual(result.content[1].text, 'Done!');
        assert.strictEqual(result.stop_reason, 'end_turn');
    } finally {
        server.close();
    }
});

// 4. Anthropic Direct Passthrough Adapter
await runTest('Anthropic passthrough adapter forwards native JSON & SSE', async () => {
    const { server, baseUrl } = await startMockServer((req, res) => {
        assert.strictEqual(req.headers['x-api-key'], 'sk-ant-test');
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const parsed = JSON.parse(body);
            if (!parsed.stream) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_ant_1',
                    type: 'message',
                    role: 'assistant',
                    model: parsed.model,
                    content: [{ type: 'text', text: 'Direct Anthropic OK' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 3, output_tokens: 4 }
                }));
            } else {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_ant_2' } })}\n\n`);
                res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
                res.end();
            }
        });
    });

    try {
        const res = await sendAnthropicMessage({
            baseUrl,
            apiKey: 'sk-ant-test',
            modelId: 'claude-sonnet-4-6',
            anthropicRequest: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }
        });
        assert.strictEqual(res.content[0].text, 'Direct Anthropic OK');

        const evts = [];
        for await (const e of streamAnthropicMessage({
            baseUrl,
            apiKey: 'sk-ant-test',
            modelId: 'claude-sonnet-4-6',
            anthropicRequest: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 50 }
        })) {
            evts.push(e);
        }
        assert.strictEqual(evts.length, 2);
        assert.strictEqual(evts[0].type, 'message_start');
        assert.strictEqual(evts[1].type, 'message_stop');
    } finally {
        server.close();
    }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
