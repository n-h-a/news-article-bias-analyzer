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

    console.log(article.title);
    console.log(article.text);
}

analyzeBtn.addEventListener('click', analyzeArticle);