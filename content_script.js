function extractArticleText() {
    try {
        if (typeof Readability !== 'function' && typeof Readability !== 'object') {
            throw new Error('Readability not available');
        }

        const docClone = document.cloneNode(true);
        const reader = new Readability(docClone);
        const article = reader.parse();

        if (article && article.textContent?.trim()) {
            return {
                ok: true,
                title: article.title || document.title,
                text: article.textContent.trim(),
                length: article.length || article.textContent.length,
                excerpt: article.excerpt || "",
                url: location.href,
                siteName: article.siteName || location.hostname,
                method: "readability"
            };
        }

        // Fallback if Readability couldn't parse anything meaningful.
        const fallbackText = document.body?.textContent?.trim() || "";
        return {
            ok: true,
            title: document.title,
            text: fallbackText,
            length: fallbackText.length,
            url: location.href,
            siteName: location.hostname,
            method: "fallback"
        };
    } catch (err) {
        console.warn('extractArticleText failed:', err);

        // Final fallback to ensure a response is always returned.
        const fallbackText = document.body?.textContent?.trim() || "";
        return {
            ok: false,
            error: err?.message || String(err),
            title: document.title,
            text: fallbackText,
            length: fallbackText.length,
            url: location.href,
            siteName: location.hostname,
            method: "error-fallback"
        };
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SCAN_ARTICLE') {
        const article = extractArticleText();
        sendResponse(article);
        return;
    }

    if (msg?.type === 'APPLY_HIGHLIGHTS' && Array.isArray(msg.annotations)) {
        
        return true;
    }
});