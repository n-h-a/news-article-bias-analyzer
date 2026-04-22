import Logger from '../logger.js';

document.addEventListener('DOMContentLoaded', async () => {

    const apiKeyEl = document.getElementById('apikey');
    const modelEl = document.getElementById('model');
    const statusEl = document.getElementById('status');

    // If 'save' button is clicked, save API key and model to storage.
    document.getElementById('save').addEventListener('click', async () => {
        try {
            const apiKey = apiKeyEl.value.trim();
            const model = modelEl.value.trim() || 'gpt-4o-mini';

            await chrome.storage.local.set({
                openai_api_key: apiKey,
                openai_model: model
            });

            statusEl.textContent = 'Saved. (Key stays in your browser; you can remove it anytime.)';
            Logger.info('Options saved', { model });
        } catch (e) {
            statusEl.textContent = 'Failed to save settings';
            Logger.error('Failed to save options', { error: String(e) });
        }
    });

    // If 'forget' button is clicked, remove API key from storage.
    document.getElementById('forget').addEventListener('click', async () => {
        try {
            await chrome.storage.local.remove(['openai_api_key']);
            statusEl.textContent = 'API key removed';
            Logger.info('API key removed');
        } catch (e) {
            statusEl.textContent = 'Failed to remove API key';
            Logger.error('Failed to remove API key', { error: String(e)});
        }
    });

    // Load previously saved model from storage and prefill input box when Options page opens.
    try {
        const { openai_model } = await chrome.storage.local.get(['openai_model']);
        if (openai_model) {
            modelEl.value = openai_model;
            Logger.info('Previous model loaded', { model: openai_model });
        }
    } catch (e) {
        Logger.error('Failed to load saved model', { error: String(e) });
    }
});
    
