/**
 * GitHub Copilot OAuth Device Flow & Session Token Exchange
 * Connects GitHub Copilot subscriptions using GitHub's OAuth Device Flow.
 */

import { logger } from '../../utils/logger.js';

export const GITHUB_COPILOT_OAUTH = {
    clientId: 'Iv1.b507a08c87ecfe98',
    deviceCodeUrl: 'https://github.com/login/device/code',
    accessTokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    copilotTokenUrl: 'https://api.github.com/copilot_internal/v2/token',
    scopes: 'read:user'
};

export const COPILOT_HEADERS = {
    'User-Agent': 'GithubCopilot/1.155.0',
    'Editor-Version': 'vscode/1.96.2',
    'Editor-Plugin-Version': 'copilot-chat/0.24.0',
    'Openai-Organization': 'github-copilot',
    'Copilot-Integration-Id': 'vscode-chat'
};

/**
 * Start GitHub Device Code OAuth flow
 * @returns {Promise<{ deviceCode: string, userCode: string, verificationUri: string, expiresIn: number, interval: number }>}
 */
export async function startCopilotDeviceFlow() {
    const response = await fetch(GITHUB_COPILOT_OAUTH.deviceCodeUrl, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': COPILOT_HEADERS['User-Agent']
        },
        body: JSON.stringify({
            client_id: GITHUB_COPILOT_OAUTH.clientId,
            scope: GITHUB_COPILOT_OAUTH.scopes
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub device flow failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.device_code || !data.user_code) {
        throw new Error(`Invalid device flow response: ${JSON.stringify(data)}`);
    }

    return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri || 'https://github.com/login/device',
        expiresIn: data.expires_in || 900,
        interval: data.interval || 5
    };
}

/**
 * Poll GitHub once for device code authorization completion
 * @param {string} deviceCode
 * @returns {Promise<{ status: 'pending'|'slow_down'|'expired'|'complete', accessToken?: string, interval?: number }>}
 */
export async function pollCopilotDeviceFlowOnce(deviceCode) {
    const response = await fetch(GITHUB_COPILOT_OAUTH.accessTokenUrl, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': COPILOT_HEADERS['User-Agent']
        },
        body: JSON.stringify({
            client_id: GITHUB_COPILOT_OAUTH.clientId,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub device poll failed (${response.status}): ${text}`);
    }

    const data = await response.json();

    if (data.access_token) {
        return { status: 'complete', accessToken: data.access_token };
    }
    if (data.error === 'authorization_pending') {
        return { status: 'pending' };
    }
    if (data.error === 'slow_down') {
        return { status: 'slow_down', interval: (data.interval || 10) };
    }
    if (data.error === 'expired_token' || data.error === 'access_denied') {
        return { status: 'expired', error: data.error_description || data.error };
    }

    throw new Error(data.error_description || data.error || 'Unknown GitHub OAuth error');
}

/**
 * Fetch GitHub username/email using a GitHub OAuth token
 * @param {string} githubToken
 * @returns {Promise<{ email: string, login: string }>}
 */
export async function getGitHubUser(githubToken) {
    const response = await fetch(GITHUB_COPILOT_OAUTH.userUrl, {
        headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': COPILOT_HEADERS['User-Agent']
        }
    });

    if (!response.ok) {
        return { email: 'copilot@github', login: 'github-user' };
    }

    const data = await response.json();
    const login = data.login || 'github-user';
    const email = data.email || `${login}@github-copilot`;
    return { email, login };
}

/**
 * Exchange a GitHub OAuth token for a short-lived GitHub Copilot API session token
 * @param {string} githubToken
 * @returns {Promise<{ token: string, expiresAt: number, endpoints?: Object }>}
 */
export async function exchangeCopilotSessionToken(githubToken) {
    const response = await fetch(GITHUB_COPILOT_OAUTH.copilotTokenUrl, {
        headers: {
            'Authorization': `token ${githubToken}`,
            'Accept': 'application/json',
            ...COPILOT_HEADERS
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`GitHub Copilot token exchange failed (${response.status}): ${text}`);
    }

    const data = await response.json();
    if (!data.token) {
        throw new Error('No Copilot session token returned by GitHub');
    }

    const expiresAt = data.expires_at ? data.expires_at * 1000 : Date.now() + 25 * 60 * 1000;
    logger.debug(`[GitHub-Copilot] Obtained session token, expires at ${new Date(expiresAt).toISOString()}`);

    return {
        token: data.token,
        expiresAt,
        baseUrl: data.endpoints?.api || 'https://api.githubcopilot.com'
    };
}

export default {
    GITHUB_COPILOT_OAUTH,
    COPILOT_HEADERS,
    startCopilotDeviceFlow,
    pollCopilotDeviceFlowOnce,
    getGitHubUser,
    exchangeCopilotSessionToken
};
