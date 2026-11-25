/**
 * Unified Device Code OAuth Flows
 * Supports:
 * - qwen-code: Qwen Code (chat.qwen.ai RFC 8628 + PKCE)
 * - kimi-code: Kimi Code (auth.kimi.com RFC 8628)
 * - opencode-oauth: OpenCode Zen Console (opencode.ai/console RFC 8628 + org resolution)
 * - kilo: Kilo Gateway (api.kilo.ai/api/device-auth/codes)
 * - kiro: Kiro / Amazon Q (AWS SSO OIDC Builder ID device flow)
 */

import crypto from 'crypto';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export const QWEN_OAUTH = {
    clientId: process.env.QWEN_OAUTH_CLIENT_ID || 'f0304373b74a44d2b584a3fb70ca9e56',
    scope: 'openid profile email model.completion',
    deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
    tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
};

export const KIMI_OAUTH = {
    clientId: process.env.KIMI_OAUTH_CLIENT_ID || '17e5f671-d194-4dfb-9706-5516cb48c098',
    host: (process.env.KIMI_CODE_OAUTH_HOST || 'https://auth.kimi.com').replace(/\/+$/, ''),
    defaultBaseUrl: 'https://api.kimi.com/coding/v1'
};

export const OPENCODE_OAUTH = {
    clientId: 'opencode-cli',
    consoleOrigin: 'https://opencode.ai/console',
    defaultBaseUrl: 'https://opencode.ai/inference/openai/v1',
    userAgent: 'opencode/1.18.31'
};

export const KILO_OAUTH = {
    apiBase: (process.env.KILO_API_URL || 'https://api.kilo.ai').replace(/\/+$/, ''),
    gatewayBase: (process.env.KILO_AI_GATEWAY_URL || 'https://ai-gateway.kilo.ai/api/v1').replace(/\/+$/, '')
};

export const KIRO_OAUTH = {
    region: 'us-east-1',
    startUrl: 'https://view.awsapps.com/start',
    clientName: 'Kiro IDE',
    clientType: 'public',
    scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist'
    ],
    grantTypes: [DEVICE_GRANT_TYPE, 'refresh_token'],
    builderIdProfileArn: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
};

function normalizeQwenBaseUrl(resourceUrl) {
    if (!resourceUrl || typeof resourceUrl !== 'string') return QWEN_OAUTH.defaultBaseUrl;
    let url = resourceUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    url = url.replace(/\/+$/, '');
    return url.endsWith('/v1') ? url : `${url}/v1`;
}

/**
 * Start a device-code flow for any supported device-code provider.
 * Returns normalized `{ deviceCode, userCode, verificationUri, expiresIn, interval, meta }`.
 */
export async function startDeviceCodeFlow(providerId) {
    if (providerId === 'qwen-code') {
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        const res = await fetch(QWEN_OAUTH.deviceCodeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: QWEN_OAUTH.clientId,
                scope: QWEN_OAUTH.scope,
                code_challenge: challenge,
                code_challenge_method: 'S256'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.device_code) {
            throw new Error(data.error_description || `Qwen device auth failed (${res.status})`);
        }
        return {
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri: data.verification_uri_complete || data.verification_uri,
            expiresIn: data.expires_in || 600,
            interval: data.interval || 3,
            meta: { verifier }
        };
    }

    if (providerId === 'kimi-code') {
        const res = await fetch(`${KIMI_OAUTH.host}/api/oauth/device_authorization`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ client_id: KIMI_OAUTH.clientId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.device_code) {
            throw new Error(data.error_description || `Kimi Code device auth failed (${res.status})`);
        }
        return {
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri: data.verification_uri_complete || data.verification_uri,
            expiresIn: data.expires_in || 900,
            interval: data.interval || 5,
            meta: {}
        };
    }

    if (providerId === 'opencode-oauth') {
        const res = await fetch(`${OPENCODE_OAUTH.consoleOrigin}/auth/device/code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': OPENCODE_OAUTH.userAgent },
            body: JSON.stringify({ client_id: OPENCODE_OAUTH.clientId })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.device_code) {
            throw new Error(data.error_description || `OpenCode Console device auth failed (${res.status})`);
        }
        const rawUri = data.verification_uri_complete || data.verification_uri || '/console/device';
        const verificationUri = new URL(rawUri, `${OPENCODE_OAUTH.consoleOrigin}/`).href;
        return {
            deviceCode: data.device_code,
            userCode: data.user_code,
            verificationUri,
            expiresIn: data.expires_in || 900,
            interval: data.interval || 5,
            meta: {}
        };
    }

    if (providerId === 'kilo') {
        const res = await fetch(`${KILO_OAUTH.apiBase}/api/device-auth/codes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.code) {
            throw new Error(data.error || `Kilo device auth failed (${res.status})`);
        }
        return {
            deviceCode: data.code,
            userCode: data.code,
            verificationUri: data.verificationUrl,
            expiresIn: data.expiresIn || 600,
            interval: 3,
            meta: {}
        };
    }

    if (providerId === 'kiro') {
        const region = KIRO_OAUTH.region;
        const regRes = await fetch(`https://oidc.${region}.amazonaws.com/client/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientName: KIRO_OAUTH.clientName,
                clientType: KIRO_OAUTH.clientType,
                scopes: KIRO_OAUTH.scopes,
                grantTypes: KIRO_OAUTH.grantTypes,
                issuerUrl: KIRO_OAUTH.startUrl
            })
        });
        const reg = await regRes.json().catch(() => ({}));
        if (!regRes.ok || !reg.clientId || !reg.clientSecret) {
            throw new Error(reg.message || `Kiro AWS OIDC registerClient failed (${regRes.status})`);
        }

        const devRes = await fetch(`https://oidc.${region}.amazonaws.com/device_authorization`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: reg.clientId,
                clientSecret: reg.clientSecret,
                startUrl: KIRO_OAUTH.startUrl
            })
        });
        const dev = await devRes.json().catch(() => ({}));
        if (!devRes.ok || !dev.deviceCode) {
            throw new Error(dev.message || `Kiro device authorization failed (${devRes.status})`);
        }
        return {
            deviceCode: dev.deviceCode,
            userCode: dev.userCode,
            verificationUri: dev.verificationUriComplete || dev.verificationUri,
            expiresIn: dev.expiresIn || 600,
            interval: dev.interval || 5,
            meta: {
                clientId: reg.clientId,
                clientSecret: reg.clientSecret,
                region
            }
        };
    }

    throw new Error(`Unsupported device-code provider: ${providerId}`);
}

/**
 * Poll a device-code session once.
 * Returns `{ status: 'pending' | 'slow_down' | 'complete', accountData? }`.
 */
export async function pollDeviceCodeFlow(providerId, deviceCode, meta = {}) {
    if (providerId === 'qwen-code') {
        const res = await fetch(QWEN_OAUTH.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                grant_type: DEVICE_GRANT_TYPE,
                client_id: QWEN_OAUTH.clientId,
                device_code: deviceCode,
                code_verifier: meta.verifier || ''
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            const baseUrl = normalizeQwenBaseUrl(data.resource_url);
            return {
                status: 'complete',
                accountData: {
                    email: `qwen-${Date.now().toString(36)}`,
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token || null,
                    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
                    baseUrl
                }
            };
        }
        if (data.error === 'authorization_pending') return { status: 'pending' };
        if (data.error === 'slow_down') return { status: 'slow_down', interval: 7 };
        throw new Error(data.error_description || data.error || `Qwen token poll failed (${res.status})`);
    }

    if (providerId === 'kimi-code') {
        const res = await fetch(`${KIMI_OAUTH.host}/api/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: KIMI_OAUTH.clientId,
                device_code: deviceCode,
                grant_type: DEVICE_GRANT_TYPE
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            return {
                status: 'complete',
                accountData: {
                    email: `kimi-${Date.now().toString(36)}`,
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token || null,
                    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
                    baseUrl: KIMI_OAUTH.defaultBaseUrl
                }
            };
        }
        if (data.error === 'authorization_pending') return { status: 'pending' };
        if (data.error === 'slow_down') return { status: 'slow_down', interval: data.interval || 10 };
        throw new Error(data.error_description || data.error || `Kimi Code token poll failed (${res.status})`);
    }

    if (providerId === 'opencode-oauth') {
        const res = await fetch(`${OPENCODE_OAUTH.consoleOrigin}/auth/device/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': OPENCODE_OAUTH.userAgent },
            body: JSON.stringify({
                client_id: OPENCODE_OAUTH.clientId,
                grant_type: DEVICE_GRANT_TYPE,
                device_code: deviceCode
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.access_token) {
            // Resolve OpenCode Console workspace (orgId) and inference base URL
            let orgId = null;
            let orgName = null;
            let baseUrl = OPENCODE_OAUTH.defaultBaseUrl;
            try {
                const orgsRes = await fetch(`${OPENCODE_OAUTH.consoleOrigin}/api/orgs`, {
                    headers: {
                        Authorization: `Bearer ${data.access_token}`,
                        'User-Agent': OPENCODE_OAUTH.userAgent
                    }
                });
                if (orgsRes.ok) {
                    const orgsPayload = await orgsRes.json();
                    const orgs = Array.isArray(orgsPayload) ? orgsPayload : (orgsPayload?.orgs || []);
                    if (orgs.length > 0) {
                        const sorted = [...orgs].sort((a, b) =>
                            String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id))
                        );
                        orgId = sorted[0].id;
                        orgName = sorted[0].name || sorted[0].id;
                    }
                }
                if (orgId) {
                    const cfgRes = await fetch(`${OPENCODE_OAUTH.consoleOrigin}/api/config`, {
                        headers: {
                            Authorization: `Bearer ${data.access_token}`,
                            'x-opencode-org-id': orgId,
                            'x-org-id': orgId,
                            'User-Agent': OPENCODE_OAUTH.userAgent
                        }
                    });
                    if (cfgRes.ok) {
                        const cfg = await cfgRes.json();
                        const apiUrl = cfg?.config?.provider?.opencode?.api;
                        if (typeof apiUrl === 'string' && apiUrl.trim()) {
                            baseUrl = apiUrl.trim();
                        }
                    }
                }
            } catch { /* fallback to defaultBaseUrl */ }

            return {
                status: 'complete',
                accountData: {
                    email: orgName ? `${orgName}` : `opencode-${Date.now().toString(36)}`,
                    accessToken: data.access_token,
                    refreshToken: data.refresh_token || null,
                    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
                    baseUrl,
                    orgId
                }
            };
        }
        if (data.error === 'authorization_pending') return { status: 'pending' };
        if (data.error === 'slow_down') return { status: 'slow_down', interval: 10 };
        throw new Error(data.error_description || data.error || `OpenCode Console poll failed (${res.status})`);
    }

    if (providerId === 'kilo') {
        const res = await fetch(`${KILO_OAUTH.apiBase}/api/device-auth/codes/${encodeURIComponent(deviceCode)}`);
        if (res.status === 202) return { status: 'pending' };
        if (res.status === 403) throw new Error('Kilo authorization denied by user');
        if (res.status === 410) throw new Error('Kilo authorization code expired');
        if (!res.ok) throw new Error(`Kilo device poll failed (${res.status})`);

        const data = await res.json();
        if (data.status === 'pending') return { status: 'pending' };
        if (data.status === 'denied') throw new Error('Kilo authorization denied by user');
        if (data.status === 'expired') throw new Error('Kilo authorization code expired');
        if (data.status === 'approved' && data.token) {
            return {
                status: 'complete',
                accountData: {
                    email: data.userEmail || `kilo-${Date.now().toString(36)}`,
                    accessToken: data.token,
                    refreshToken: null,
                    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
                    baseUrl: KILO_OAUTH.gatewayBase
                }
            };
        }
        return { status: 'pending' };
    }

    if (providerId === 'kiro') {
        const region = meta.region || KIRO_OAUTH.region;
        const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: meta.clientId,
                clientSecret: meta.clientSecret,
                deviceCode,
                grantType: DEVICE_GRANT_TYPE
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.accessToken) {
            return {
                status: 'complete',
                accountData: {
                    email: `kiro-${Date.now().toString(36)}`,
                    accessToken: data.accessToken,
                    refreshToken: data.refreshToken || null,
                    expiresAt: Date.now() + (data.expiresIn || 3600) * 1000,
                    oauthMeta: {
                        clientId: meta.clientId,
                        clientSecret: meta.clientSecret,
                        region,
                        profileArn: KIRO_OAUTH.builderIdProfileArn
                    }
                }
            };
        }
        if (data.error === 'authorization_pending') return { status: 'pending' };
        if (data.error === 'slow_down') return { status: 'slow_down', interval: 10 };
        throw new Error(data.error_description || data.error || `Kiro token poll failed (${res.status})`);
    }

    throw new Error(`Unsupported device-code provider: ${providerId}`);
}

/**
 * Refresh access token for device-code OAuth providers
 */
export async function refreshDeviceCodeToken(providerId, refreshToken, oauthMeta = {}) {
    if (providerId === 'qwen-code') {
        const res = await fetch(QWEN_OAUTH.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: QWEN_OAUTH.clientId,
                refresh_token: refreshToken
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
            throw new Error(data.error_description || `Qwen token refresh failed (${res.status})`);
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            baseUrl: data.resource_url ? normalizeQwenBaseUrl(data.resource_url) : undefined
        };
    }

    if (providerId === 'kimi-code') {
        const res = await fetch(`${KIMI_OAUTH.host}/api/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                client_id: KIMI_OAUTH.clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
            throw new Error(data.error_description || `Kimi Code token refresh failed (${res.status})`);
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000
        };
    }

    if (providerId === 'opencode-oauth') {
        const res = await fetch(`${OPENCODE_OAUTH.consoleOrigin}/auth/device/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': OPENCODE_OAUTH.userAgent },
            body: JSON.stringify({
                client_id: OPENCODE_OAUTH.clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
            throw new Error(data.error_description || `OpenCode Console token refresh failed (${res.status})`);
        }
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000
        };
    }

    if (providerId === 'kiro') {
        const region = oauthMeta?.region || KIRO_OAUTH.region;
        const res = await fetch(`https://oidc.${region}.amazonaws.com/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clientId: oauthMeta?.clientId,
                clientSecret: oauthMeta?.clientSecret,
                refreshToken,
                grantType: 'refresh_token'
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.accessToken) {
            throw new Error(data.error_description || `Kiro token refresh failed (${res.status})`);
        }
        return {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken || refreshToken,
            expiresAt: Date.now() + (data.expiresIn || 3600) * 1000
        };
    }

    throw new Error(`Token refresh not supported for provider: ${providerId}`);
}
