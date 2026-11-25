/**
 * Anthropic Claude Pro/Max OAuth 2.0 PKCE Flow
 * Uses the Claude Code public OAuth client (hosted callback: console.anthropic.com/oauth/code/callback).
 * User signs in on claude.ai, copies the displayed `code#state` string, and pastes it back.
 */

import crypto from 'crypto';

export const CLAUDE_OAUTH_CONFIG = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://console.anthropic.com/v1/oauth/token',
    redirectUri: 'https://console.anthropic.com/oauth/code/callback',
    scopes: 'user:profile user:inference'
};

export const CLAUDE_OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20,claude-code-20250219';

/**
 * Generate PKCE verifier/challenge and CSRF state
 */
export function generateClaudePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    return { verifier, challenge, state };
}

/**
 * Build Claude Pro/Max authorization URL
 */
export function getClaudeAuthorizationUrl() {
    const { verifier, challenge, state } = generateClaudePKCE();
    const params = new URLSearchParams({
        code: 'true',
        client_id: CLAUDE_OAUTH_CONFIG.clientId,
        response_type: 'code',
        redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
        scope: CLAUDE_OAUTH_CONFIG.scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
    });

    return {
        url: `${CLAUDE_OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state
    };
}

/**
 * Parse pasted `code#state` or callback URL from console.anthropic.com/oauth/code/callback
 */
export function parseClaudeCodeInput(input) {
    const trimmed = String(input || '').trim();
    if (!trimmed) {
        throw new Error('Authorization code is required');
    }

    // Handle full callback URL if pasted
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const parsed = new URL(trimmed);
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state') || (parsed.hash ? parsed.hash.replace(/^#/, '') : null);
        if (!code) throw new Error('No authorization code found in callback URL');
        return { code, state };
    }

    // Standard Claude hosted callback format: `<code_part>#<state_part>`
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx !== -1) {
        const code = trimmed.slice(0, hashIdx).trim();
        const state = trimmed.slice(hashIdx + 1).trim();
        if (!code) throw new Error('Invalid code#state format');
        return { code, state };
    }

    return { code: trimmed, state: null };
}

/**
 * Exchange authorization code for Claude OAuth access + refresh tokens
 */
export async function exchangeClaudeCode(code, verifier, state) {
    const res = await fetch(CLAUDE_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code,
            state,
            client_id: CLAUDE_OAUTH_CONFIG.clientId,
            redirect_uri: CLAUDE_OAUTH_CONFIG.redirectUri,
            code_verifier: verifier
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Claude OAuth token exchange failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('No access_token in Claude OAuth response');
    }

    const email = data.account?.email_address || data.organization?.name || `claude-${Date.now()}`;
    return {
        email,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: Date.now() + (data.expires_in || 28800) * 1000,
        accountUuid: data.account?.uuid || null,
        orgUuid: data.organization?.uuid || null
    };
}

/**
 * Refresh Claude OAuth token (note: Claude rotates refresh tokens on every refresh)
 */
export async function refreshClaudeToken(refreshToken) {
    const res = await fetch(CLAUDE_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: CLAUDE_OAUTH_CONFIG.clientId
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Claude OAuth token refresh failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('No access_token in Claude OAuth refresh response');
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + (data.expires_in || 28800) * 1000
    };
}
