import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';

/**
 * Expand a leading ~/ or ~\ to the user's home directory.
 * @param {string} filePath
 * @returns {string}
 */
export function expandHomePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return '';
    const trimmed = filePath.trim();
    if (trimmed === '~') return os.homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return trimmed;
}

/**
 * Read an AGENTS.md (or prompt) file from disk if configured.
 * Returns null if path is empty or unreadable (logs a warning on read error).
 *
 * @param {string} filePath
 * @returns {{ content: string | null, error?: string, resolvedPath?: string }}
 */
export function readAgentsFile(filePath) {
    const resolvedPath = expandHomePath(filePath);
    if (!resolvedPath) return { content: null };

    try {
        const content = fs.readFileSync(resolvedPath, 'utf8').trim();
        return { content: content || null, resolvedPath };
    } catch (err) {
        logger.warn(`[SystemPrompt] Failed to read agents file "${resolvedPath}": ${err.message}`);
        return { content: null, error: err.message, resolvedPath };
    }
}

function hasPromptConfig(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.systemPromptEnabled === false) return false;
    const hasText = typeof entry.systemPrompt === 'string' && entry.systemPrompt.trim().length > 0;
    const hasFile = typeof entry.agentsFilePath === 'string' && entry.agentsFilePath.trim().length > 0;
    return hasText || hasFile;
}

/**
 * Resolve the optional per-model system prompt / AGENTS.md text for a request.
 * Checks resolvedModel first, then falls back to requestedModel (e.g. an alias).
 * Returns null when nothing is configured or enabled.
 *
 * @param {Record<string, Object>} modelMapping
 * @param {{ requestedModel?: string, resolvedModel?: string }} models
 * @returns {{ text: string, sourceModel: string } | null}
 */
export function resolveModelSystemPrompt(modelMapping, { requestedModel, resolvedModel } = {}) {
    if (!modelMapping || typeof modelMapping !== 'object') return null;

    let sourceModel = null;
    let entry = null;

    if (resolvedModel && hasPromptConfig(modelMapping[resolvedModel])) {
        sourceModel = resolvedModel;
        entry = modelMapping[resolvedModel];
    } else if (requestedModel && requestedModel !== resolvedModel && hasPromptConfig(modelMapping[requestedModel])) {
        sourceModel = requestedModel;
        entry = modelMapping[requestedModel];
    }

    if (!entry) return null;

    const parts = [];

    if (typeof entry.agentsFilePath === 'string' && entry.agentsFilePath.trim()) {
        const { content } = readAgentsFile(entry.agentsFilePath);
        if (content) parts.push(content);
    }

    if (typeof entry.systemPrompt === 'string' && entry.systemPrompt.trim()) {
        parts.push(entry.systemPrompt.trim());
    }

    if (parts.length === 0) return null;

    return {
        text: parts.join('\n\n'),
        sourceModel
    };
}

/**
 * Append injected text to the end of an Anthropic `system` field without
 * disturbing existing `cache_control` breakpoints on prefix blocks.
 *
 * @param {string | Array<Object> | undefined} existingSystem
 * @param {string | null | undefined} injectedText
 * @returns {string | Array<Object> | undefined}
 */
export function appendSystemPrompt(existingSystem, injectedText) {
    if (!injectedText) return existingSystem;

    if (Array.isArray(existingSystem)) {
        return [...existingSystem, { type: 'text', text: injectedText }];
    }

    if (typeof existingSystem === 'string' && existingSystem.trim().length > 0) {
        return [
            { type: 'text', text: existingSystem },
            { type: 'text', text: injectedText }
        ];
    }

    return injectedText;
}
