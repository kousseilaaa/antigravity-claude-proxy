import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    expandHomePath,
    readAgentsFile,
    resolveModelSystemPrompt,
    appendSystemPrompt
} from '../src/utils/system-prompt-injector.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-prompt-test-'));
const agentsPath = path.join(tmpDir, 'AGENTS.md');
fs.writeFileSync(agentsPath, '# Global Rules\nAlways be concise.', 'utf8');

try {
    // 1. Optional / no-op when unconfigured
    assert.equal(resolveModelSystemPrompt({}, { requestedModel: 'claude-sonnet-4-5', resolvedModel: 'claude-sonnet-4-5' }), null);
    assert.equal(resolveModelSystemPrompt({ 'claude-sonnet-4-5': { pinned: true } }, { resolvedModel: 'claude-sonnet-4-5' }), null);

    // 2. Disabled toggle is a no-op
    assert.equal(
        resolveModelSystemPrompt(
            { 'claude-sonnet-4-5': { systemPrompt: 'Ignore this', agentsFilePath: agentsPath, systemPromptEnabled: false } },
            { resolvedModel: 'claude-sonnet-4-5' }
        ),
        null
    );

    // 3. Reads AGENTS.md and appends inline systemPrompt
    const combined = resolveModelSystemPrompt(
        {
            'claude-opus-4-5-thinking': {
                agentsFilePath: agentsPath,
                systemPrompt: 'Extra rule'
            }
        },
        { requestedModel: 'opus', resolvedModel: 'claude-opus-4-5-thinking' }
    );
    assert.equal(combined.sourceModel, 'claude-opus-4-5-thinking');
    assert.equal(combined.text, '# Global Rules\nAlways be concise.\n\nExtra rule');

    // 4. Missing file does not throw
    const missingOnly = resolveModelSystemPrompt(
        { 'gemini-3-pro': { agentsFilePath: path.join(tmpDir, 'missing.md') } },
        { resolvedModel: 'gemini-3-pro' }
    );
    assert.equal(missingOnly, null);

    // 5. appendSystemPrompt preserves cache_control prefix blocks
    const existingBlocks = [
        { type: 'text', text: 'Harness prompt', cache_control: { type: 'ephemeral' } }
    ];
    const appended = appendSystemPrompt(existingBlocks, 'Injected AGENTS.md');
    assert.equal(appended.length, 2);
    assert.deepEqual(appended[0], existingBlocks[0]);
    assert.deepEqual(appended[1], { type: 'text', text: 'Injected AGENTS.md' });

    // No-op preserves exact reference
    assert.equal(appendSystemPrompt(existingBlocks, null), existingBlocks);

    // String system becomes 2-block array
    assert.deepEqual(appendSystemPrompt('Base system', 'Injected'), [
        { type: 'text', text: 'Base system' },
        { type: 'text', text: 'Injected' }
    ]);

    // Empty system becomes plain string
    assert.equal(appendSystemPrompt(undefined, 'Injected'), 'Injected');

    // 6. Home path expansion
    assert.equal(expandHomePath('~/AGENTS.md'), path.join(os.homedir(), 'AGENTS.md'));
    assert.ok(readAgentsFile(agentsPath).content.includes('# Global Rules'));

    console.log('All system-prompt-injector tests passed!');
} finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
}
