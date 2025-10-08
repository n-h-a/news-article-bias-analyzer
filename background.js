chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SUMMARIZE_AND_INTERPRET_ARTICLE' && msg?.article?.text) {
        console.log('Summarize message received by background.');
    }

    if (msg?.type === 'DETECT_BIAS' && msg?.article?.text) {
        console.log('Detect bias message received by background.')
    }
});