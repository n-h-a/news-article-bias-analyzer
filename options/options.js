import Logger from '../logger.js';

async function validateApiConfiguration(apiKey, model) {
    const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    });

    let detail = '';
    let data = null;
    try {
        data = await response.json();
        detail = data?.error?.message || '';
    } catch {
        detail = '';
    }

    if (response.ok) {
        const availableModels = Array.isArray(data?.data) ? data.data : [];
        const hasModelAccess = availableModels.some(item => item?.id === model);

        if (!hasModelAccess) {
            return {
                ok: false,
                message: `The API key is valid, but the model "${model}" is not available to this account.`
            };
        }

        return { ok: true, message: 'API key and model validated successfully.' };
    }

    if (response.status === 401) {
        return { ok: false, message: 'That OpenAI API key was rejected. Check the key and try again.' };
    }

    return {
        ok: false,
        message: detail || `OpenAI validation failed with status ${response.status}.`
    };
}

document.addEventListener('DOMContentLoaded', async () => {

    const apiKeyEl = document.getElementById('apikey');
    const modelEl = document.getElementById('model');
    const statusEl = document.getElementById('status');

    document.getElementById('save').addEventListener('click', async () => {
        try {
            const apiKey = apiKeyEl.value.trim();
            const model = modelEl.value.trim() || 'gpt-4o-mini';
            const stored = await chrome.storage.local.get(['openai_api_key']);
            const existingApiKey = (stored.openai_api_key || '').trim();
            const effectiveApiKey = apiKey || existingApiKey;

            if (!effectiveApiKey) {
                statusEl.textContent = 'Enter an OpenAI API key before saving.';
                return;
            }

            statusEl.textContent = 'Validating API key and model...';
            const validation = await validateApiConfiguration(effectiveApiKey, model);
            if (!validation.ok) {
                statusEl.textContent = validation.message;
                Logger.info('API configuration validation failed', {
                    message: validation.message,
                    model,
                    usedStoredKey: !apiKey
                });
                return;
            }

            await chrome.storage.local.set({
                openai_api_key: effectiveApiKey,
                openai_model: model
            });

            statusEl.textContent = apiKey
                ? 'Saved. API key and model validated successfully.'
                : 'Saved. Existing API key kept and model validated successfully.';
            Logger.info('Options saved', { model, hasNewApiKey: Boolean(apiKey) });
        } catch (e) {
            statusEl.textContent = 'Failed to save settings';
            Logger.error('Failed to save options', { error: String(e) });
        }
    });

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

    try {
        const { openai_model, openai_api_key } = await chrome.storage.local.get(['openai_model', 'openai_api_key']);
        if (openai_model) {
            modelEl.value = openai_model;
            Logger.info('Previous model loaded', { model: openai_model });
        }

        if (openai_api_key) {
            apiKeyEl.placeholder = 'Stored API key will be kept unless you enter a new one';
        }
    } catch (e) {
        Logger.error('Failed to load saved model', { error: String(e) });
    }
});
    
