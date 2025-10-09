const statusEl = document.getElementById('status');
const contentEl = document.getElementById('content');
const analyzeBtn = document.getElementById('analyze-article');

async function analyzeArticle() {
    statusEl.textContent = 'Thinking...';
    contentEl.textContent = '';

    // Retrieve the first (and only) active tab.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) { statusEl.textContent = 'No active tab found'; return; }

    // 1) Retrieve article from content script.
    const article = await chrome.tabs.sendMessage(tab.id, { type: 'SCAN_ARTICLE' });
    if (!article) { statusEl.textContent = 'No article text found'; return; }

    // 2) Summarize article and detect bias.
    const [summaryResp, biasResp] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'SUMMARIZE_AND_INTERPRET_ARTICLE', article }),
        chrome.runtime.sendMessage({ type: 'DETECT_BIAS', article })
    ]);

    // Display summary.
    if (summaryResp?.ok) {
        statusEl.textContent = summaryResp.title || 'Article';
        contentEl.textContent = summaryResp.text;
    } else {
        statusEl.textContent = 'Error summarizing';
        contentEl.textContent = summaryResp?.error || 'Could not process article';
    }

    // Apply highlights

    if (biasResp?.ok && Array.isArray(biasResp.annotations) && biasResp.annotations.length > 0) {
        try {
            await chrome.tabs.sendMessage(tab.id, { type: 'APPLY_HIGHLIGHTS', annotations: biasResp.annotations });
        } catch (err) {
            console.warn('APPLY_HIGHLIGHTS failed:', err);
        }
    }
}

analyzeBtn.addEventListener('click', analyzeArticle);