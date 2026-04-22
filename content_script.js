// content_script.js

function logContent(level, msg, data = {}) {
    try {
        chrome.runtime.sendMessage({
            type: "LOG",
            level,
            msg,
            data: {
                page: location.hostname,
                ...data
            }
        });
    } catch (error) {
        const method = level === "error" ? "error" : "log";
        console[method](`[${level.toUpperCase()}] ${msg}`, data, error);
    }
}

const logInfo = (msg, data = {}) => logContent("info", msg, data);
const logError = (msg, data = {}) => logContent("error", msg, data);

// ========== ARTICLE EXTRACTION ==========
function extractArticle() {
    const url = location.href;

    let title = 
        document.querySelector("meta[property='og:title']")?.content ||
        document.title ||
        "";
    let source = location.hostname.replace(/^www\./, "");
    let text = document.body ? document.body.innerText : "";
    let excerpt = clipToSentence(text.slice(0, 420));

    try {
        const documentClone = document.cloneNode(true);
        const reader = new Readability(documentClone);
        const article = reader.parse();

        if (article) {
            title = article.title || title;
            source = article.siteName || source;
            text = article.textContent || text;
            excerpt = article.excerpt 
                ? clipToSentence(article.excerpt) 
                : clipToSentence(text.slice(0, 600));
        }
    } catch (e) {
        logError("Readability parsing failed", { error: String(e) });
    }

    return { title, url, source, text, excerpt };
}

// ========== STYLES ==========
function injectBiasStylesOnce() {
    if (document.getElementById("bias-styles")) return;
    const style = document.createElement("style");
    style.id = "bias-styles";
    style.textContent = `
        .bias-tag { 
            position: relative; 
            text-decoration: underline; 
            text-decoration-thickness: 2px; 
            text-underline-offset: 4px; 
            cursor: help; 
            --bias-tooltip-shift: 0px; 
            --bias-gap: 10px;
        }
        .bias-left   { color: #1b398e; text-decoration-color: #2c7eff; }   /* blue */
        .bias-right  { color: #821819; text-decoration-color: #fb2c37; }   /* red  */
        .bias-loaded { color: #7a3306; text-decoration-color: #fe9a00; }   /* goldenrod */

        /* Tooltip */
        .bias-tag::after {
            content: attr(data-reason);
            position: absolute;
            left: var(--bias-tooltip-shift); 
            top: auto; 
            bottom: calc(100% + var(--bias-gap));
            transform: translateY(-6px);
            max-width: min(55ch, 60vw);
            background: #ffffff; color: #364152;
            padding: 8px 10px; border-radius: 8px;
            font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
            box-shadow: 0 8px 20px rgba(0,0,0,0.25);
            opacity: 0; pointer-events: none;
            transition: opacity .12s ease, transform .12s ease;
            white-space: normal;
            z-index: 2147483647;
        }

        .bias-tag:hover::after {
            opacity: 1; transform: translateY(0);
        }
`;
    
    (document.head || document.documentElement).appendChild(style);
}

// ========== HELPERS ==========
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function categoryClass(cat) {
    if (!cat) return "bias-loaded";
    const c = cat.toLowerCase();
    if (c === "left") return "bias-left";
    if (c === "right") return "bias-right";
    return "bias-loaded";
}

function clipToSentence(s, maxLen = 420) {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t.length <= maxLen) return t;
    const cut = t.slice(0, maxLen);
    const idx = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (idx > 120) return cut.slice(0, idx + 1).trim();
    return cut.trim() + "...";
}

function isSkippableNode(node) {
    const p = node.parentNode;
    if (!p) return true;
    const tag = p.nodeName;
    return (
        node.nodeType !== Node.TEXT_NODE ||
        /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|TEXTAREA|CODE|PRE|A)$/.test(tag) ||
        p.closest(".bias-tag")
    );
}

function serializeWithHighlights(rootEl) {
    const out = [];
    
    function esc(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function walk(node) {
        if (!node) return;

        if (node.nodeType === Node.TEXT_NODE) {
            out.push(esc(node.nodeValue || ""));
            return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = node;
        if (el.tagName === "SPAN" && el.classList.contains("bias-tag")) {
            const className = esc(el.className || "bias-tag");
            const reason = esc(el.getAttribute("data-reason") || "");
            const text = esc(el.textContent || "");
            out.push(`<span class="${className}" data-reason="${reason}">${text}</span>`);
            return;
        }

        for (const child of el.childNodes) walk(child);
    }

    walk(rootEl);
    return out.join("");
}

// ========== HIGHLIGHTER ==========
function highlightBias(annotations) {
    injectBiasStylesOnce();

    // Clean and normalize annotations.
    const items = (annotations || [])
        .filter(x => x && x.phrase)
        .map(x => ({
            phrase: x.phrase.trim(),
            category: x.category || x.bias || "loaded",
            reason: x.reason?.trim() || "Possible bias"
        }))
        .filter(x => x.phrase.length > 0);

    if (!items.length) {
        logInfo("No annotations available for highlighting");
        return;
    }

    // Sort by longer phrases first to ensure regex tests them.
    items.sort((a, b) => b.phrase.length - a.phrase.length);

    // Build fast lookup table (lowercased phrase -> item).
    const itemMap = new Map(items.map(it => [it.phrase.toLowerCase(), it]));

    // Build case insensitive global regex that matches any of the phrases.
    const escaped = items.map(x => escapeRegExp(x.phrase));
    const pattern = new RegExp("(" + escaped.join("|") + ")", "gi");

    // Use TreeWalker to find text nodes.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return isSkippableNode(node)
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT;
        }
    });

    // Collect nodes before modifying DOM.
    const toProcess = [];
    while (walker.nextNode()) {
        toProcess.push(walker.currentNode);
    }

    let matchCount = 0;

    // Process each text node.
    for (const textNode of toProcess) {
        const text = textNode.nodeValue;
        if (!pattern.test(text)) {
            pattern.lastIndex = 0;
            continue;
        }
        pattern.lastIndex = 0;

        // Build a replacement fragment.
        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let m;

        while ((m = pattern.exec(text)) !== null) {
            const match = m[0];
            const start = m.index;
            const end = start + match.length;
            matchCount++;

            // Add plain text before the match.
            if (start > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
            }

            // Build the highlighted span.
            const item = itemMap.get(match.toLowerCase());
            const span = document.createElement("span");
            span.className = "bias-tag " + categoryClass(item?.category);
            span.textContent = text.slice(start, end);
            span.setAttribute(
                "data-reason",
                item?.reason || "Bias indicative phrase"
            );
            frag.appendChild(span);

            lastIdx = end;
        }

        if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }

        textNode.parentNode.replaceChild(frag, textNode);
    }

    logInfo("Bias highlights applied", {
        annotationCount: items.length,
        matchCount
    });
}

function clearBiasHighlights() {
    const existingHighlights = document.querySelectorAll("span.bias-tag");

    existingHighlights.forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
    });

    if (existingHighlights.length) {
        logInfo("Cleared existing highlights", { count: existingHighlights.length });
    }
}

// ========== RETRIEVE EXCERPT ==========
function getBestHighlightedExcerpt() { 
    const highlightSelector = "span.bias-tag";
    const candidates = Array.from(document.querySelectorAll("p"));

    let bestEl = null;
    let bestCount = 0;

    for (const p of candidates) {
        const text = (p.innerText || "").trim();
        const count = p.querySelectorAll(highlightSelector).length;
        
        if (count === 0) continue; 
        if (count > bestCount) {
            bestEl = p;
            bestCount = count;
        } else if (count === bestCount && bestEl) {
            const bestText = (bestEl.innerText || "").trim();
            if (text.length > bestText.length) bestEl = p;
        }
    }

    if (!bestEl) {
        return { excerpt: "", excerptHtml: "", highlightCount: 0 };
    }  

    let excerpt = (bestEl.innerText || "").trim();
    let excerptHtml = serializeWithHighlights(bestEl);

    return { excerpt, excerptHtml, highlightCount: bestCount };
}

// ========== MESSAGE HANDLER ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SUBTEXT_PING") {
        sendResponse({ ok: true });
        return true;
    }
    
    if (msg.type === "SUBTEXT_GET_ARTICLE_INFO") {
        const art = extractArticle();
        logInfo("Sending article preview info", {
            hasTitle: Boolean(art.title),
            source: art.source || "Unknown"
        });
        chrome.runtime.sendMessage({
            type: "SUBTEXT_DETECTED_ARTICLE_INFO",
            payload: {
                title: art.title,
                source: art.source,
                url: art.url
            }
        });
        return true;
    }
    
    if (msg.type === "SUBTEXT_GET_ARTICLE") {
        const art = extractArticle();
        logInfo("Sending article data for analysis", {
            title: art.title || "Untitled article",
            source: art.source || "Unknown",
            textLength: (art.text || "").length
        });
        sendResponse(art);
        chrome.runtime.sendMessage({
            type: "SUBTEXT_ARTICLE_DATA",
            payload: art
        });
        return true;
    }

    if (msg.type === "APPLY_HIGHLIGHTS" && Array.isArray(msg.annotations)) {
        logInfo("Received highlight request", { annotationCount: msg.annotations.length });
        clearBiasHighlights();
        highlightBias(msg.annotations);

        const best = getBestHighlightedExcerpt();
        if (best.excerptHtml) {
            logInfo("Sending highlighted excerpt update", { highlightCount: best.highlightCount });
            chrome.runtime.sendMessage({
                type: "SUBTEXT_EXCERPT_UPDATE",
                payload: {
                    excerpt: best.excerpt,
                    excerptHtml: best.excerptHtml,
                    highlightCount: best.highlightCount
                }
            });
        }

        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === "CLEAR_HIGHLIGHTS") {
        logInfo("Received clear highlights request");
        clearBiasHighlights();
        sendResponse({ ok: true });
        return true;
    }
});