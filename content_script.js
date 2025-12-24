// content_script.js

// ========== ARTICLE EXTRACTION ==========
function extractArticle() {
    const title =
        document.querySelector("meta[property='og:title']")?.content || 
        document.title ||
        "";

    const url = location.href;
    const source = location.hostname.replace(/^www\./, "");
    const text = document.body ? document.body.innerText : "";
    const excerpt = text.slice(0, 400);

    return { title, url, source, text, excerpt };
}

// As soon as we load, tell the extension that this tab has an article.
const initialArticle = extractArticle();
chrome.runtime.sendMessage({
    type: "SUBTEXT_DETECTED_ARTICLE",
    payload: {
        title: initialArticle.title,
        source: initialArticle.source,
        url: initialArticle.url
    }
});

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
    
    document.head.appendChild(style);
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

function isSkippableNode(node) {
    const p = node.parentNode;
    if (!p) return true;
    const tag = p.nodeName;
    return (
        node.nodeType !== Node.TEXT_NODE ||
        /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|TEXTAREA|CODE|PRE)$/.test(tag) ||
        p.closest(".bias-tag")
    );
}

// ========== OLD HIGHLIGHTER ==========
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

    if (!items.length) return;

    // Sort by longer phrases first to ensure regex tests them.
    items.sort((a, b) => b.phrase.length - a.phrase.length);

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

            // Add plain text before the match.
            if (start > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
            }

            // Build the highlighted span.
            const item = items.find(it => it.phrase.toLowerCase() === match.toLowerCase());
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
}

function clearBiasHighlights() {
    document.querySelectorAll("span.bias-tag").forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize();
    })
}

// ========== NEW LLM STYLE HIGHLIGHTER ==========
function applyBiasFromLLM(htmlSnippet) {
    if (!htmlSnippet) return;
    injectBiasStylesOnce();

    const tmp = document.createElement("div");
    tmp.innerHTML = htmlSnippet;

    const spans = tmp.querySelectorAll(".bias-left, .bias-right, .bias-loaded, .bias-tag");
    spans.forEach(span => {
        const phrase = span.textContent.trim();
        const reason = span.getAttribute("data-reason") || "Bias-indicative phrase";
        const cls = span.classList.contains("bias-left")
            ? "bias-left"
            : span.classList.contains("bias-right")
            ? "bias-right"
            : "bias-loaded";

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return isSkippableNode(node)
                    ? NodeFilter.FILTER_REJECT
                    : NodeFilter.FILTER_ACCEPT;
            }
        });

        while (walker.nextNode()) {
            const node = walker.currentNode;
            const idx = node.nodeValue.toLowerCase().indexOf(phrase.toLowerCase());
            if (idx === -1) continue;

            const text = node.nodeValue;
            const before = text.slice(0, idx);
            const match = text.slice(idx, idx + phrase.length);
            const after = text.slice(idx + phrase.length);
            const frag = document.createDocumentFragment();
            if (before) frag.appendChild(document.createTextNode(before));
            const realSpan = document.createElement("span");
            realSpan.className = "bias-tag " + cls;
            realSpan.textContent = match;
            realSpan.setAttribute("data-reason", reason);
            frag.appendChild(realSpan);
            if (after) frag.appendChild(document.createTextNode(after));

            node.parentNode.replaceChild(frag, node);
            break;
        }
    });
}

// ========== MESSAGE HANDLER ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SUBTEXT_GET_ARTICLE") {
        const art = extractArticle();
        sendResponse(art);
        chrome.runtime.sendMessage({
            type: "SUBTEXT_ARTICLE_DATA",
            payload: art
        });
        return true;
    }

    if (msg.type === "SUBTEXT_APPLY_BIAS_HTML") {
        applyBiasFromLLM(msg.payload?.bias_excerpt_html || "");
        return;
    }

    if (msg.type === "APPLY_HIGHLIGHTS" && Array.isArray(msg.annotations)) {
        clearBiasHighlights();
        highlightBias(msg.annotations);
        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === "CLEAR_HIGHLIGHTS") {
        clearBiasHighlights();
        sendResponse({ ok: true });
        return true;
    }

    if (msg.type === "APPLY_BIAS") {
        if (Array.isArray(msg.annotations)) {
            clearBiasHighlights();
            highlightBias(msg.annotations);
        }
        return;
    }
});