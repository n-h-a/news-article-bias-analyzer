import Logger from '../logger.js';

document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('status');
    const clearCacheBtn = document.getElementById('clear-cache');

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

