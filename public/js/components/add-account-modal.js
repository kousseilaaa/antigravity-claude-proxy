/**
 * Add Account Modal Component (Multi-Provider: OAuth + Device Code + API Keys)
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    // Provider catalog loaded from /api/providers
    providers: [],
    activeCategory: 'oauth', // 'oauth' | 'api-key'
    selectedProviderId: 'antigravity',

    // Google Antigravity manual mode
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,

    // Generic OAuth PKCE (non-antigravity) state
    oauthAuthUrl: '',
    oauthAuthState: '',
    oauthCallbackInput: '',
    oauthPolling: false,
    oauthPollTimer: null,

    // Generic OAuth-manual (code#state paste) state
    oauthManualAuthUrl: '',
    oauthManualState: '',
    oauthManualCallbackInput: '',

    // Generic Device Code state
    deviceSessionId: '',
    deviceUserCode: '',
    deviceVerificationUri: '',
    devicePolling: false,
    devicePollTimer: null,
    deviceStatusMsg: '',

    // API Key form state
    apiKeyForm: {
        apiKey: '',
        label: '',
        baseUrl: '',
        protocol: 'openai-chat',
        customModels: '',
        testBeforeSave: true
    },

    init() {
        this.loadProviders();
    },

    async loadProviders() {
        try {
            const password = Alpine.store('global').webuiPassword;
            const { response, newPassword } = await window.utils.request('/api/providers', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok' && Array.isArray(data.providers)) {
                this.providers = data.providers;
            }
        } catch (e) {
            console.warn('[AddAccountModal] Failed to load providers:', e);
        }
    },

    get oauthProviders() {
        return this.providers.filter(p => p.category === 'oauth');
    },

    get apiKeyProviders() {
        return this.providers.filter(p => p.category === 'api-key');
    },

    get selectedProvider() {
        return this.providers.find(p => p.id === this.selectedProviderId) || null;
    },

    selectCategory(category) {
        this.activeCategory = category;
        this.stopPolling();
        if (category === 'oauth') {
            this.selectedProviderId = 'antigravity';
        } else {
            const firstApi = this.apiKeyProviders[0];
            this.selectProvider(firstApi ? firstApi.id : 'anthropic');
        }
    },

    selectProvider(providerId) {
        this.selectedProviderId = providerId;
        this.stopPolling();
        const provider = this.providers.find(p => p.id === providerId);
        if (provider && provider.category === 'api-key') {
            this.apiKeyForm.baseUrl = provider.defaultBaseUrl || '';
            this.apiKeyForm.protocol = provider.protocol || 'openai-chat';
        }
    },

    stopPolling() {
        if (this.oauthPollTimer) {
            clearInterval(this.oauthPollTimer);
            this.oauthPollTimer = null;
        }
        this.oauthPolling = false;
        if (this.devicePollTimer) {
            clearInterval(this.devicePollTimer);
            this.devicePollTimer = null;
        }
        this.devicePolling = false;
    },

    resetState() {
        this.stopPolling();
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        this.oauthAuthUrl = '';
        this.oauthAuthState = '';
        this.oauthCallbackInput = '';
        this.oauthManualAuthUrl = '';
        this.oauthManualState = '';
        this.oauthManualCallbackInput = '';
        this.deviceSessionId = '';
        this.deviceUserCode = '';
        this.deviceVerificationUri = '';
        this.deviceStatusMsg = '';
        this.apiKeyForm = {
            apiKey: '',
            label: '',
            baseUrl: this.selectedProvider?.defaultBaseUrl || '',
            protocol: this.selectedProvider?.protocol || 'openai-chat',
            customModels: '',
            testBeforeSave: true
        };
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    async copyText(text, toastMsg) {
        if (!text) return;
        await navigator.clipboard.writeText(text);
        Alpine.store('global').showToast(toastMsg || Alpine.store('global').t('linkCopied'), 'success');
    },

    async copyLink() {
        await this.copyText(this.authUrl);
    },

    // --- Google Antigravity Manual OAuth ---
    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const { response, newPassword } = await window.utils.request('/api/auth/url', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    // --- Generic OAuth PKCE (openai-codex, gemini-cli, openrouter-oauth) ---
    // Starts local callback server, opens popup, polls account list until new account appears.
    async startGenericOAuth() {
        const provider = this.selectedProvider;
        if (!provider) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const initialCount = (Alpine.store('data').accounts || []).length;
            const { response, newPassword } = await window.utils.request(
                `/api/auth/provider/${provider.id}/url`, {}, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status !== 'ok') {
                throw new Error(data.error || `Failed to start ${provider.name} OAuth`);
            }

            this.oauthAuthUrl = data.authUrl;
            this.oauthAuthState = data.state;

            if (!data.manualCodeRequired) {
                // Auto-callback mode: open popup, poll account list
                window.open(data.authUrl, `${provider.id}_oauth`, 'width=600,height=720,scrollbars=yes');
                store.showToast(`Complete ${provider.name} login in the opened window...`, 'info');

                this.oauthPolling = true;
                let ticks = 0;
                this.oauthPollTimer = setInterval(async () => {
                    ticks++;
                    if (ticks > 40) {
                        this.stopPolling();
                        return;
                    }
                    await Alpine.store('data').fetchData();
                    const currentAccounts = Alpine.store('data').accounts || [];
                    if (currentAccounts.length > initialCount) {
                        this.stopPolling();
                        store.showToast(`${provider.name} account connected!`, 'success');
                        document.getElementById('add_account_modal').close();
                        this.resetState();
                    }
                }, 3000);
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    async completeGenericOAuth() {
        const provider = this.selectedProvider;
        if (!this.oauthCallbackInput || !this.oauthAuthState || !provider) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                `/api/auth/provider/${provider.id}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callbackInput: this.oauthCallbackInput,
                        state: this.oauthAuthState
                    })
                }, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(data.message || `${provider.name} account connected!`, 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || 'Authentication failed', 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    // --- Generic OAuth-Manual (anthropic-oauth: code#state paste) ---
    async startOAuthManual() {
        const provider = this.selectedProvider;
        if (!provider) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                `/api/auth/provider/${provider.id}/url`, {}, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status !== 'ok') {
                throw new Error(data.error || `Failed to start ${provider.name} OAuth`);
            }
            this.oauthManualAuthUrl = data.authUrl;
            this.oauthManualState = data.state;
            // Open auth URL in new tab; user copies back code#state
            window.open(data.authUrl, '_blank', 'noopener,noreferrer');
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    async completeOAuthManual() {
        const provider = this.selectedProvider;
        if (!this.oauthManualCallbackInput || !this.oauthManualState || !provider) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                `/api/auth/provider/${provider.id}/complete`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callbackInput: this.oauthManualCallbackInput,
                        state: this.oauthManualState
                    })
                }, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(data.message || `${provider.name} account connected!`, 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || 'Authentication failed', 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    // --- Generic Device Code (github-copilot, qwen-code, kimi-code, opencode-oauth, kilo, kiro) ---
    async startDeviceAuth() {
        const provider = this.selectedProvider;
        if (!provider) return;
        this.submitting = true;
        this.deviceStatusMsg = '';
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request(
                `/api/auth/provider/${provider.id}/device/start`, {
                    method: 'POST'
                }, store.webuiPassword
            );
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status !== 'ok') {
                throw new Error(data.error || `Failed to start ${provider.name} device flow`);
            }

            this.deviceSessionId = data.sessionId;
            this.deviceUserCode = data.userCode;
            this.deviceVerificationUri = data.verificationUri;
            this.deviceStatusMsg = `Waiting for ${provider.name} authorization...`;
            this.devicePolling = true;

            const intervalMs = Math.max(5000, (data.interval || 5) * 1000);
            this.devicePollTimer = setInterval(async () => {
                try {
                    const { response: pollRes } = await window.utils.request(
                        `/api/auth/provider/${provider.id}/device/poll`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: this.deviceSessionId })
                        }, store.webuiPassword
                    );
                    const pollData = await pollRes.json();
                    if (pollData.status === 'ok') {
                        this.stopPolling();
                        store.showToast(pollData.message || `${provider.name} connected!`, 'success');
                        Alpine.store('data').fetchData();
                        document.getElementById('add_account_modal').close();
                        this.resetState();
                    } else if (pollData.status === 'slow_down') {
                        // Backend already handles interval; just show info
                        this.deviceStatusMsg = `Waiting for ${provider.name} authorization...`;
                    } else if (pollData.status === 'pending') {
                        this.deviceStatusMsg = `Waiting for ${provider.name} authorization...`;
                    } else {
                        // expired or error
                        this.stopPolling();
                        this.deviceStatusMsg = pollData.error || 'Authorization expired. Please try again.';
                    }
                } catch (err) {
                    console.warn('[DevicePoll] error:', err);
                }
            }, intervalMs);
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    // --- API Key Account Submission ---
    async submitApiKeyAccount() {
        const provider = this.selectedProvider;
        if (!provider) return;
        if (!this.apiKeyForm.apiKey && provider.id !== 'custom') {
            Alpine.store('global').showToast('API key is required', 'error');
            return;
        }
        if (provider.id === 'custom' && !this.apiKeyForm.baseUrl) {
            Alpine.store('global').showToast('Base URL is required for Custom Provider', 'error');
            return;
        }

        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/accounts/api-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: provider.id,
                    apiKey: this.apiKeyForm.apiKey,
                    label: this.apiKeyForm.label,
                    baseUrl: this.apiKeyForm.baseUrl || undefined,
                    protocol: provider.allowProtocolChoice ? this.apiKeyForm.protocol : undefined,
                    customModels: this.apiKeyForm.customModels,
                    test: this.apiKeyForm.testBeforeSave
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(data.message || `${provider.name} account added!`, 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || 'Failed to add account', 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    }
});
