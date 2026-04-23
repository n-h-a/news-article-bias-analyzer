import Logger from '../logger.js';

async function validateApiKey(apiKey) {
    const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    });

    if (response.ok) {
        return { ok: true, message: 'API key validated and saved.' };
    }

    let detail = '';
    try {
        const data = await response.json();
        detail = data?.error?.message || '';
    } catch {
        detail = '';
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

            if (apiKey) {
                statusEl.textContent = 'Validating API key...';
                const validation = await validateApiKey(apiKey);
                if (!validation.ok) {
                    statusEl.textContent = validation.message;
                    Logger.error('API key validation failed', { message: validation.message });
                    return;
                }
            }

            await chrome.storage.local.set({
                openai_api_key: effectiveApiKey,
                openai_model: model
            });

            statusEl.textContent = apiKey
                ? 'Saved. API key validated successfully.'
                : 'Saved. Existing API key kept and model updated.';
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
    
