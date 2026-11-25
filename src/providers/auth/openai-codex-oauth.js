/**
 * OpenAI Codex (ChatGPT) OAuth with PKCE
 * Connects ChatGPT Plus/Pro/Team accounts using OpenAI's official OAuth PKCE flow
 * (same flow used by Codex CLI / OpenCode / pi-ai).
 */

import crypto from 'crypto';
import http from 'http';
import { logger } from '../../utils/logger.js';

export const OPENAI_CODEX_OAUTH = {
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    callbackPort: parseInt(process.env.OPENAI_OAUTH_CALLBACK_PORT || '1455', 10),
    callbackPath: '/auth/callback',
    scopes: 'openid profile email offline_access',
    originator: 'codex_cli_rs'
};

export function getCodexRedirectUri() {
    return `http://localhost:${OPENAI_CODEX_OAUTH.callbackPort}${OPENAI_CODEX_OAUTH.callbackPath}`;
}

/**
 * Generate PKCE code verifier and S256 challenge
 */
function generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

/**
 * Decode JWT payload without verifying signature (to extract email & chatgpt_account_id)
 * @param {string} token
 * @returns {Object|null}
 */
export function decodeJwtPayload(token) {
    try {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length < 2) return null;
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

/**
 * Extract ChatGPT account ID and email from OpenAI OAuth JWT tokens
 * @param {string} accessToken
 * @param {string} [idToken]
 * @returns {{ email: string, chatgptAccountId: string|null }}
 */
export function extractCodexIdentity(accessToken, idToken = null) {
    const accessPayload = decodeJwtPayload(accessToken) || {};
    const idPayload = decodeJwtPayload(idToken) || {};

    const authClaim = accessPayload['https://api.openai.com/auth'] || idPayload['https://api.openai.com/auth'] || {};
    const profileClaim = accessPayload['https://api.openai.com/profile'] || idPayload['https://api.openai.com/profile'] || {};

    const email = idPayload.email || profileClaim.email || accessPayload.email || `codex-${crypto.randomBytes(3).toString('hex')}@openai`;
    const chatgptAccountId = authClaim.chatgpt_account_id || null;

    return { email, chatgptAccountId };
}

/**
 * Generate OpenAI Codex OAuth authorization URL
 * @returns {{ url: string, verifier: string, state: string }}
 */
export function getCodexAuthorizationUrl() {
    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
        response_type: 'code',
        client_id: OPENAI_CODEX_OAUTH.clientId,
        redirect_uri: getCodexRedirectUri(),
        scope: OPENAI_CODEX_OAUTH.scopes,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: OPENAI_CODEX_OAUTH.originator
    });

    return {
        url: `${OPENAI_CODEX_OAUTH.authUrl}?${params.toString()}`,
        verifier,
        state
    };
}

/**
 * Extract authorization code from pasted callback URL or raw code
 * @param {string} input
 * @returns {{ code: string, state: string|null }}
 */
export function extractCodexCodeFromInput(input) {
    if (!input || typeof input !== 'string') {
        throw new Error('No input provided');
    }
    const trimmed = input.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const parsed = new URL(trimmed);
        const error = parsed.searchParams.get('error');
        if (error) {
            throw new Error(`OAuth error: ${error} ${parsed.searchParams.get('error_description') || ''}`.trim());
        }
        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        if (!code) {
            throw new Error('No authorization code found in callback URL');
        }
        return { code, state };
    }
    return { code: trimmed, state: null };
}

/**
 * Start a local callback server on port 1455 to receive OpenAI OAuth redirect
 * @param {string} expectedState
 * @param {number} [timeoutMs=180000]
 * @returns {{ promise: Promise<string>, abort: () => void }}
 */
export function startCodexCallbackServer(expectedState, timeoutMs = 180000) {
    let server = null;
    let timeoutId = null;
    let settled = false;
    let rejectPromise = null;

    const cleanup = () => {
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        if (server) {
            try { server.close(); } catch { /* ignore */ }
            server = null;
        }
    };

    const promise = new Promise((resolve, reject) => {
        rejectPromise = reject;

        server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${OPENAI_CODEX_OAUTH.callbackPort}`);
            if (url.pathname !== OPENAI_CODEX_OAUTH.callbackPath) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="font-family:sans-serif;background:#111;color:#fff;padding:40px;text-align:center;">
                    <h2>OpenAI Authentication Failed</h2><p>${error}</p></body></html>`);
                if (!settled) {
                    settled = true;
                    cleanup();
                    reject(new Error(`OpenAI OAuth error: ${error}`));
                }
                return;
            }

            if (expectedState && state !== expectedState) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body>State mismatch</body></html>');
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body>Missing authorization code</body></html>');
                return;
            }

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:48px;text-align:center;">
                <h2 style="color:#34d399;">OpenAI Codex Connected!</h2>
                <p>You can close this window and return to Antigravity Proxy.</p>
                <script>setTimeout(() => window.close(), 1500);</script>
            </body></html>`);

            if (!settled) {
                settled = true;
                cleanup();
                resolve(code);
            }
        });

        server.on('error', (err) => {
            if (!settled) {
                settled = true;
                cleanup();
                reject(new Error(`Failed to start OpenAI OAuth callback server on port ${OPENAI_CODEX_OAUTH.callbackPort}: ${err.message}`));
            }
        });

        server.listen(OPENAI_CODEX_OAUTH.callbackPort, '127.0.0.1', () => {
            logger.info(`[OpenAI-Codex OAuth] Callback server listening on http://localhost:${OPENAI_CODEX_OAUTH.callbackPort}${OPENAI_CODEX_OAUTH.callbackPath}`);
        });

        timeoutId = setTimeout(() => {
            if (!settled) {
                settled = true;
                cleanup();
                reject(new Error('OpenAI OAuth callback timed out'));
            }
        }, timeoutMs);
    });

    const abort = () => {
        if (!settled) {
            settled = true;
            cleanup();
            if (rejectPromise) {
                rejectPromise(new Error('OAuth callback server aborted'));
            }
        }
    };

    return { promise, abort };
}

/**
 * Exchange authorization code for OpenAI Codex tokens
 * @param {string} code
 * @param {string} verifier
 */
export async function exchangeCodexCode(code, verifier) {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CODEX_OAUTH.clientId,
        code,
        code_verifier: verifier,
        redirect_uri: getCodexRedirectUri()
    });

    const response = await fetch(OPENAI_CODEX_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI token exchange failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.access_token) {
        throw new Error('No access_token returned from OpenAI');
    }

    const { email, chatgptAccountId } = extractCodexIdentity(data.access_token, data.id_token);
    const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);

    return {
        email,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt,
        chatgptAccountId
    };
}

/**
 * Refresh an OpenAI Codex access token using its refresh token
 * @param {string} refreshToken
 */
export async function refreshCodexAccessToken(refreshToken) {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: OPENAI_CODEX_OAUTH.clientId,
        refresh_token: refreshToken
    });

    const response = await fetch(OPENAI_CODEX_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI token refresh failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.access_token) {
        throw new Error('No access_token returned on OpenAI refresh');
    }

    const { email, chatgptAccountId } = extractCodexIdentity(data.access_token, data.id_token);
    const expiresAt = Date.now() + ((data.expires_in || 3600) * 1000);

    return {
        email,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt,
        chatgptAccountId
    };
}

export default {
    OPENAI_CODEX_OAUTH,
    getCodexRedirectUri,
    decodeJwtPayload,
    extractCodexIdentity,
    getCodexAuthorizationUrl,
    extractCodexCodeFromInput,
    startCodexCallbackServer,
    exchangeCodexCode,
    refreshCodexAccessToken
};
