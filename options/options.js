import Logger from '../logger.js';

const OPENAI_API_KEY_KEY = 'subtext_openai_api_key';

function maskApiKey(key) {
    if (!key || key.length < 8) return key;
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

document.addEventListener('DOMContentLoaded', async () => {
    const statusEl = document.getElementById('status');
    const clearCacheBtn = document.getElementById('clear-cache');
    const apiKeyInput = document.getElementById('api-key-input');
    const saveKeyBtn = document.getElementById('save-key');
    const clearKeyBtn = document.getElementById('clear-key');
    const apiKeyPreview = document.getElementById('api-key-preview');
    const apiKeyStatus = document.getElementById('api-key-status');

    // Load existing key and show masked preview
    try {
        const stored = await chrome.storage.local.get(OPENAI_API_KEY_KEY);
        const existingKey = stored[OPENAI_API_KEY_KEY];
        if (existingKey) {
            apiKeyPreview.textContent = `Saved key: ${maskApiKey(existingKey)}`;
            apiKeyPreview.style.display = '';
        }
    } catch (e) {
        Logger.error('Failed to load API key', { error: String(e) });
    }

    saveKeyBtn?.addEventListener('click', async () => {
        const key = apiKeyInput.value.trim();
        if (!key) {
            apiKeyStatus.textContent = 'Enter an API key to save.';
            return;
        }
        try {
            await chrome.storage.local.set({ [OPENAI_API_KEY_KEY]: key });
            apiKeyInput.value = '';
            apiKeyPreview.textContent = `Saved key: ${maskApiKey(key)}`;
            apiKeyPreview.style.display = '';
            apiKeyStatus.textContent = 'API key saved.';
            Logger.info('Saved OpenAI API key');
        } catch (e) {
            apiKeyStatus.textContent = 'Failed to save API key.';
            Logger.error('Failed to save API key', { error: String(e) });
        }
    });

    clearKeyBtn?.addEventListener('click', async () => {
        try {
            await chrome.storage.local.remove(OPENAI_API_KEY_KEY);
            apiKeyPreview.textContent = '';
            apiKeyPreview.style.display = 'none';
            apiKeyStatus.textContent = 'API key cleared.';
            Logger.info('Cleared OpenAI API key');
        } catch (e) {
            apiKeyStatus.textContent = 'Failed to clear API key.';
            Logger.error('Failed to clear API key', { error: String(e) });
        }
    });

    clearCacheBtn?.addEventListener('click', async () => {
        try {
            statusEl.textContent = 'Clearing cached analysis data...';
            const response = await chrome.runtime.sendMessage({ type: 'SUBTEXT_CLEAR_ANALYSIS_CACHE' });

            if (!response?.ok) {
                statusEl.textContent = 'Failed to clear cached analysis data';
                Logger.error('Failed to clear analysis cache', {
                    error: response?.error || 'Unknown error'
                });
                return;
            }

            statusEl.textContent = response.removedCount
                ? `Cleared ${response.removedCount} cached analysis entr${response.removedCount === 1 ? 'y' : 'ies'}.`
                : 'No cached analysis data was stored.';
            Logger.info('Cleared cached analysis data', {
                removedCount: response.removedCount || 0
            });
        } catch (e) {
            statusEl.textContent = 'Failed to clear cached analysis data';
            Logger.error('Failed to clear analysis cache', { error: String(e) });
        }
    });
});

