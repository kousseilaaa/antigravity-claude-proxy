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

    // OpenAI Codex OAuth state
    codexAuthUrl: '',
    codexAuthState: '',
    codexCallbackInput: '',
    codexPolling: false,
    codexPollTimer: null,

    // GitHub Copilot Device Code state
    copilotDeviceCode: '',
    copilotUserCode: '',
    copilotVerificationUri: '',
    copilotPolling: false,
    copilotPollTimer: null,
    copilotStatusMsg: '',

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
        if (this.codexPollTimer) {
            clearInterval(this.codexPollTimer);
            this.codexPollTimer = null;
        }
        this.codexPolling = false;
        if (this.copilotPollTimer) {
            clearInterval(this.copilotPollTimer);
            this.copilotPollTimer = null;
        }
        this.copilotPolling = false;
    },

    resetState() {
        this.stopPolling();
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        this.codexAuthUrl = '';
        this.codexAuthState = '';
        this.codexCallbackInput = '';
        this.copilotDeviceCode = '';
        this.copilotUserCode = '';
        this.copilotVerificationUri = '';
        this.copilotStatusMsg = '';
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

    // --- OpenAI Codex (ChatGPT) OAuth ---
    async startCodexOAuth() {
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const initialCount = (Alpine.store('data').accounts || []).length;
            const { response, newPassword } = await window.utils.request('/api/auth/openai-codex/url', {}, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status !== 'ok') {
                throw new Error(data.error || 'Failed to start OpenAI Codex OAuth');
            }

            this.codexAuthUrl = data.url;
            this.codexAuthState = data.state;
            window.open(data.url, 'openai_codex_oauth', 'width=600,height=720,scrollbars=yes');
            store.showToast('Complete OpenAI login in the opened window...', 'info');

            // Poll account list until new account appears (max 2 minutes)
            this.codexPolling = true;
            let ticks = 0;
            this.codexPollTimer = setInterval(async () => {
                ticks++;
                if (ticks > 40) {
                    this.stopPolling();
                    return;
                }
                await Alpine.store('data').fetchData();
                const currentAccounts = Alpine.store('data').accounts || [];
                if (currentAccounts.length > initialCount) {
                    this.stopPolling();
                    store.showToast('OpenAI Codex account connected!', 'success');
                    document.getElementById('add_account_modal').close();
                    this.resetState();
                }
            }, 3000);
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    },

    async completeCodexManualAuth() {
        if (!this.codexCallbackInput || !this.codexAuthState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/auth/openai-codex/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callbackInput: this.codexCallbackInput,
                    state: this.codexAuthState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(data.message || 'OpenAI Codex account connected!', 'success');
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

    // --- GitHub Copilot Device Flow ---
    async startCopilotAuth() {
        this.submitting = true;
        this.copilotStatusMsg = '';
        try {
            const store = Alpine.store('global');
            const { response, newPassword } = await window.utils.request('/api/auth/github-copilot/start', {
                method: 'POST'
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status !== 'ok') {
                throw new Error(data.error || 'Failed to start GitHub Copilot login');
            }

            this.copilotDeviceCode = data.deviceCode;
            this.copilotUserCode = data.userCode;
            this.copilotVerificationUri = data.verificationUri;
            this.copilotStatusMsg = 'Waiting for GitHub authorization...';
            this.copilotPolling = true;

            const intervalMs = Math.max(5000, (data.interval || 5) * 1000);
            this.copilotPollTimer = setInterval(async () => {
                try {
                    const { response: pollRes } = await window.utils.request('/api/auth/github-copilot/poll', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ deviceCode: this.copilotDeviceCode })
                    }, store.webuiPassword);
                    const pollData = await pollRes.json();
                    if (pollData.status === 'complete') {
                        this.stopPolling();
                        store.showToast(pollData.message || 'GitHub Copilot connected!', 'success');
                        Alpine.store('data').fetchData();
                        document.getElementById('add_account_modal').close();
                        this.resetState();
                    } else if (pollData.status === 'expired') {
                        this.stopPolling();
                        this.copilotStatusMsg = 'Device code expired. Please try again.';
                    }
                } catch (err) {
                    console.warn('[CopilotPoll] error:', err);
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
