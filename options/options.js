import Logger from '../logger.js';

function getOpenAIValidationMessage({ status, detail = '', code = '', model = '' }) {
    const normalizedDetail = String(detail || '').trim();
    const normalizedCode = String(code || '').trim();

    if (status === 401) {
        return 'That OpenAI API key was rejected. Check the key and try again.';
    }

    if (status === 403) {
        return model
            ? `This API key does not have permission to use the model "${model}".`
            : 'This API key does not have permission to complete the request.';
    }

    if (status === 404) {
        return model
            ? `The model "${model}" could not be found for this account. Choose another model.`
            : 'The requested OpenAI resource could not be found.';
    }

    if (status === 429) {
        if (normalizedCode === 'insufficient_quota' || /insufficient_quota|quota/i.test(normalizedDetail)) {
            return 'OpenAI reports that this account is out of quota. Check billing or use a different API key.';
        }

        return 'OpenAI rate-limited this request. Wait a moment and try again.';
    }

    if (status >= 500) {
        return 'OpenAI is temporarily unavailable. Try again in a moment.';
    }

    return normalizedDetail || `OpenAI validation failed with status ${status}.`;
}

async function validateApiConfiguration(apiKey, model) {
    const response = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`
        }
    });

    let detail = '';
    let code = '';
    let data = null;
    try {
        data = await response.json();
        detail = data?.error?.message || '';
        code = data?.error?.code || '';
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

    return {
        ok: false,
        message: getOpenAIValidationMessage({
            status: response.status,
            detail,
            code,
            model
        })
    };
}

document.addEventListener('DOMContentLoaded', async () => {

    const apiKeyEl = document.getElementById('apikey');
    const modelEl = document.getElementById('model');
    const statusEl = document.getElementById('status');
    const clearCacheBtn = document.getElementById('clear-cache');

    document.getElementById('save').addEventListener('click', async () => {
        try {
            const apiKey = apiKeyEl.value.trim();
            const model = modelEl.value.trim() || 'gpt-4o-mini';
            const stored = await chrome.storage.local.get(['openai_api_key', 'openai_model']);
            const existingApiKey = (stored.openai_api_key || '').trim();
            const existingModel = (stored.openai_model || '').trim();
            const effectiveApiKey = apiKey || existingApiKey;
            const isValidatingCurrentlySavedConfiguration = Boolean(
                effectiveApiKey &&
                existingApiKey &&
                effectiveApiKey === existingApiKey &&
                model === existingModel
            );

            if (!effectiveApiKey) {
                statusEl.textContent = 'Enter an OpenAI API key before saving.';
                return;
            }

            statusEl.textContent = 'Validating API key and model...';
            const validation = await validateApiConfiguration(effectiveApiKey, model);
            if (!validation.ok) {
                if (isValidatingCurrentlySavedConfiguration) {
                    await chrome.storage.local.set({
                        openai_api_config_valid: false,
                        openai_api_config_validated_model: model
                    });
                }

                statusEl.textContent = validation.message;
                Logger.info('API configuration validation failed', {
                    message: validation.message,
                    model,
                    usedStoredKey: !apiKey,
                    invalidatedSavedConfiguration: isValidatingCurrentlySavedConfiguration
                });
                return;
            }

            await chrome.storage.local.set({
                openai_api_key: effectiveApiKey,
                openai_model: model,
                openai_api_config_valid: true,
                openai_api_config_validated_model: model
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
            await chrome.storage.local.remove([
                'openai_api_key',
                'openai_model',
                'openai_api_config_valid',
                'openai_api_config_validated_model'
            ]);
            apiKeyEl.placeholder = 'sk-...';
            modelEl.value = 'gpt-4o-mini';
            statusEl.textContent = 'API key and model removed.';
            Logger.info('API key and model removed');
        } catch (e) {
            statusEl.textContent = 'Failed to remove API key and model.';
            Logger.error('Failed to remove API key and model', { error: String(e)});
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

