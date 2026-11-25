/**
 * OpenRouter OAuth 2.0 PKCE Flow
 * Official docs: https://openrouter.ai/docs/guides/overview/auth/oauth
 * Exchanges the authorization code for a user-controlled OpenRouter API key.
 */

import crypto from 'crypto';
import http from 'http';

export const OPENROUTER_OAUTH_CONFIG = {
    authUrl: 'https://openrouter.ai/auth',
    exchangeUrl: 'https://openrouter.ai/api/v1/auth/keys',
    keyInfoUrl: 'https://openrouter.ai/api/v1/auth/key',
    callbackPort: 51123,
    callbackPath: '/callback'
};

export function generateOpenRouterPKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return { verifier, challenge, state };
}

export function getOpenRouterAuthorizationUrl(port = OPENROUTER_OAUTH_CONFIG.callbackPort) {
    const { verifier, challenge, state } = generateOpenRouterPKCE();
    const callbackUrl = `http://localhost:${port}${OPENROUTER_OAUTH_CONFIG.callbackPath}`;
    const params = new URLSearchParams({
        callback_url: callbackUrl,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
    });

    return {
        url: `${OPENROUTER_OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state,
        redirectUri: callbackUrl
    };
}

export function startOpenRouterCallbackServer(expectedState, port = OPENROUTER_OAUTH_CONFIG.callbackPort, timeoutMs = 180000) {
    let server = null;
    let timeoutHandle = null;

    const promise = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            try {
                const reqUrl = new URL(req.url, `http://localhost:${port}`);
                if (reqUrl.pathname !== OPENROUTER_OAUTH_CONFIG.callbackPath) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }

                const code = reqUrl.searchParams.get('code');
                const state = reqUrl.searchParams.get('state');
                if (!code) {
                    res.writeHead(400);
                    res.end('Missing authorization code');
                    return;
                }
                if (expectedState && state && state !== expectedState) {
                    res.writeHead(400);
                    res.end('State mismatch');
                    cleanup();
                    reject(new Error('OpenRouter OAuth state mismatch'));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#818cf8">OpenRouter Connected</h2><p>You can close this window and return to the proxy.</p><script>setTimeout(()=>window.close(),1500)</script></div></body></html>`);
                cleanup();
                resolve(code);
            } catch (err) {
                cleanup();
                reject(err);
            }
        });

        const cleanup = () => {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }
            if (server) {
                try { server.close(); } catch { /* ignore */ }
                server = null;
            }
        };

        server.on('error', (err) => {
            cleanup();
            reject(new Error(`Failed to bind OpenRouter callback server on port ${port}: ${err.message}`));
        });

        server.listen(port, '127.0.0.1', () => {
            timeoutHandle = setTimeout(() => {
                cleanup();
                reject(new Error('OpenRouter OAuth callback timed out'));
            }, timeoutMs);
        });
    });

    return {
        promise,
        abort: () => {
            clearTimeout(timeoutHandle);
            if (server) {
                try { server.close(); } catch { /* ignore */ }
                server = null;
            }
        }
    };
}

export async function exchangeOpenRouterCode(code, verifier) {
    const res = await fetch(OPENROUTER_OAUTH_CONFIG.exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            code,
            code_verifier: verifier,
            code_challenge_method: 'S256'
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenRouter OAuth key exchange failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data.key) {
        throw new Error('No key returned in OpenRouter OAuth response');
    }

    let label = `openrouter-${Date.now().toString(36)}`;
    try {
        const infoRes = await fetch(OPENROUTER_OAUTH_CONFIG.keyInfoUrl, {
            headers: { Authorization: `Bearer ${data.key}` }
        });
        if (infoRes.ok) {
            const info = await infoRes.json();
            if (info?.data?.label) {
                label = info.data.label;
            }
        }
    } catch { /* fallback */ }

    return {
        email: label,
        apiKey: data.key
    };
}
