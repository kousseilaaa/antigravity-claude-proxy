/**
 * Google Gemini CLI OAuth 2.0 PKCE Flow
 * Uses the official Gemini CLI installed-app OAuth client for separate Gemini quota
 * via Google Cloud Code Assist / Gemini API.
 */

import crypto from 'crypto';
import http from 'http';

export const GEMINI_CLI_OAUTH_CONFIG = {
    clientId: process.env.GEMINI_CLI_OAUTH_CLIENT_ID || '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET || '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',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json',
    callbackPort: 51122,
    callbackPath: '/oauth2callback',
    scopes: [
        'https://www.googleapis.com/auth/cloud-platform',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
    ]
};

export function generateGeminiCliPKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    return { verifier, challenge, state };
}

export function getGeminiCliAuthorizationUrl(port = GEMINI_CLI_OAUTH_CONFIG.callbackPort) {
    const { verifier, challenge, state } = generateGeminiCliPKCE();
    const redirectUri = `http://localhost:${port}${GEMINI_CLI_OAUTH_CONFIG.callbackPath}`;
    const params = new URLSearchParams({
        client_id: GEMINI_CLI_OAUTH_CONFIG.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GEMINI_CLI_OAUTH_CONFIG.scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state
    });

    return {
        url: `${GEMINI_CLI_OAUTH_CONFIG.authUrl}?${params.toString()}`,
        verifier,
        state,
        redirectUri
    };
}

export function startGeminiCliCallbackServer(expectedState, port = GEMINI_CLI_OAUTH_CONFIG.callbackPort, timeoutMs = 180000) {
    let server = null;
    let timeoutHandle = null;

    const promise = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            try {
                const reqUrl = new URL(req.url, `http://localhost:${port}`);
                if (reqUrl.pathname !== GEMINI_CLI_OAUTH_CONFIG.callbackPath) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }

                const error = reqUrl.searchParams.get('error');
                if (error) {
                    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h2>Gemini CLI OAuth Failed</h2><p>${error}</p>`);
                    cleanup();
                    reject(new Error(`Gemini CLI OAuth error: ${error}`));
                    return;
                }

                const code = reqUrl.searchParams.get('code');
                const state = reqUrl.searchParams.get('state');
                if (!code) {
                    res.writeHead(400);
                    res.end('Missing code');
                    return;
                }
                if (expectedState && state !== expectedState) {
                    res.writeHead(400);
                    res.end('State mismatch');
                    cleanup();
                    reject(new Error('Gemini CLI OAuth state mismatch'));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!DOCTYPE html><html><body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="color:#60a5fa">Gemini CLI Connected</h2><p>You can close this window and return to the proxy.</p><script>setTimeout(()=>window.close(),1500)</script></div></body></html>`);
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
            reject(new Error(`Failed to bind Gemini CLI callback server on port ${port}: ${err.message}`));
        });

        server.listen(port, '127.0.0.1', () => {
            timeoutHandle = setTimeout(() => {
                cleanup();
                reject(new Error('Gemini CLI OAuth callback timed out'));
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

export async function exchangeGeminiCliCode(code, verifier, redirectUri) {
    const res = await fetch(GEMINI_CLI_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GEMINI_CLI_OAUTH_CONFIG.clientId,
            client_secret: GEMINI_CLI_OAUTH_CONFIG.clientSecret,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini CLI token exchange failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('No access_token in Gemini CLI token response');
    }

    let email = `gemini-cli-${Date.now()}`;
    try {
        const userRes = await fetch(GEMINI_CLI_OAUTH_CONFIG.userInfoUrl, {
            headers: { Authorization: `Bearer ${data.access_token}` }
        });
        if (userRes.ok) {
            const user = await userRes.json();
            if (user.email) email = user.email;
        }
    } catch { /* fallback */ }

    return {
        email,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || null,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
}

export async function refreshGeminiCliToken(refreshToken) {
    const res = await fetch(GEMINI_CLI_OAUTH_CONFIG.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: GEMINI_CLI_OAUTH_CONFIG.clientId,
            client_secret: GEMINI_CLI_OAUTH_CONFIG.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Gemini CLI token refresh failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!data.access_token) {
        throw new Error('No access_token in Gemini CLI refresh response');
    }

    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    };
}
