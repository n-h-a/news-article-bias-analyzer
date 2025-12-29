document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyEl = document.getElementById('apikey');
    const modelEl = document.getElementById('model');
    const statusEl = document.getElementById('status');
    const checkboxEl = document.getElementById('toggle-onscreen-button');

    // If 'save' button is clicked, save API key and model to storage.
    document.getElementById('save').addEventListener('click', async () => {
        const apiKey = apiKeyEl.value.trim();
        const model = modelEl.value.trim() || 'gpt-4o-mini';

        await chrome.storage.local.set({
            openai_api_key: apiKey,
            openai_model: model
        });

        statusEl.textContent = 'Saved. (Key stays in your browser; you can remove it anytime.)';
    });

    // If 'forget' button is clicked, remove API key from storage.
    document.getElementById('forget').addEventListener('click', async () => {
        await chrome.storage.local.remove(['openai_api_key']);
        statusEl.textContent = 'API key removed';
    });

    // If checkbox is clicked, set it to true if checked, otherwise false.
    document.getElementById('toggle-onscreen-button').addEventListener("change", async (e) => {
        await chrome.storage.local.set({ toggle_onscreen_button: e.target.checked });
    });

    // Load previously saved model from storage and prefill input box when Options page opens.
    chrome.storage.local.get(console.log);
    const { openai_model } = await chrome.storage.local.get(['openai_model']);
    if (openai_model) modelEl.value = openai_model;

    const { toggle_onscreen_button } = await chrome.storage.local.get(['toggle_onscreen_button']);
    checkboxEl.checked = !!toggle_onscreen_button;
});
    
