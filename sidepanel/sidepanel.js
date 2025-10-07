const statusEl = document.getElementById('status');
const contentEl = document.getElementById('content');
const analyzeBtn = document.getElementById('analyze-article');

async function analyzeArticle() {
    statusEl.textContent = 'Thinking...';
    contentEl.textContent = '';

    console.log('Analyze article!');
}

analyzeBtn.addEventListener('click', analyzeArticle);