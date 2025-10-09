function extractArticleText() {
    try {
        // Clone the DOM because Readability modifies it.
        const docClone = document.cloneNode(true);
        const reader = new Readability(docClone);
        const article = reader.parse();

        if (article) {
            return {
                title: article.title,
                text: article.textContent,
                length: article.length
            };
        } else {
            return {
                title: document.title,
                text: document.body.innerText
            };
        }
    } catch (err) {
        console.error("Readability failed:", err);
        return {
            title: document.title,
            text: document.body.innerText
        };
    }
}

// ---- 1) Inject styles once
function injectBiasStylesOnce() {
    if (document.getElementById('bias-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'bias-styles';
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

// ---- 2) Utilities
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function categoryClass(cat) {
    if (cat === 'left') return 'bias-left';
    if (cat === 'right') return 'bias-right';
    return 'bias-loaded';
}

function isSkippableNode(node) {
    const p = node.parentNode;
    if (!p) return true;
    const tag = p.nodeName;
    return (
        node.nodeType !== Node.TEXT_NODE ||
        /^(SCRIPT|STYLE|NOSCRIPT|IFRAME|TEXTAREA|CODE|PRE)$/.test(tag) ||
        p.closest('.bias-tag') // don’t re-process our own spans
    );
}

// ---- 3) Walk the DOM and wrap matches
function highlightBias(annotations) {
    injectBiasStylesOnce();

    // sort phrases by length DESC to avoid partial overlaps
    const items = annotations
        .filter(x => x && x.phrase && x.category)
        .map(x => ({ phrase: x.phrase.trim(), category: x.category, reason: x.reason?.trim() || 'Possible bias' }))
        .filter(x => x.phrase.length > 0);
    items.sort((a, b) => b.phrase.length - a.phrase.length);

    // Build a single alternation regex (case-insensitive), with word-boundaries where safe
    const escaped = items.map(x => escapeRegExp(x.phrase));
    if (!escaped.length) return;

    const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return isSkippableNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        }
    });

    const toProcess = [];
    while (walker.nextNode()) toProcess.push(walker.currentNode);

    for (const textNode of toProcess) {
        const text = textNode.nodeValue;
        if (!pattern.test(text)) continue; // quick check
        pattern.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let lastIdx = 0;
        let m;

        while ((m = pattern.exec(text)) !== null) {
            const match = m[0];
            const start = m.index;
            const end = start + match.length;

            // Append preceding plain text
            if (start > lastIdx) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx, start)));
            }

            // Which annotation matched? (case-insensitive)
            const ann = items.find(x => match.toLowerCase() === x.phrase.toLowerCase());
            const span = document.createElement('span');
            span.className = `bias-tag ${categoryClass(ann?.category)}`;
            span.textContent = text.slice(start, end);
            span.setAttribute('data-reason', ann?.reason || 'Possible bias');

            // Optional: adjust tooltip shift if near right edge
            requestAnimationFrame(() => {
                const rect = span.getBoundingClientRect();
                const overflow = Math.max(0, rect.left + 320 - window.innerWidth); // assume ~320px tooltip
                if (overflow > 0) span.style.setProperty('--bias-tooltip-shift', `-${overflow + 8}px`);
            });

            frag.appendChild(span);
            lastIdx = end;
        }

        // Append trailing text
        if (lastIdx < text.length) {
            frag.appendChild(document.createTextNode(text.slice(lastIdx)));
        }

        // Replace node
        textNode.parentNode.replaceChild(frag, textNode);
    }
}

// ---- 4) Clear highlights (unwrap spans)
function clearBiasHighlights() {
    document.querySelectorAll('span.bias-tag').forEach(span => {
        const parent = span.parentNode;
        if (!parent) return;
        parent.replaceChild(document.createTextNode(span.textContent), span);
        parent.normalize(); // merge adjacent text nodes
    });
}

// ---- 5) Messaging hooks
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "SCAN_ARTICLE") {
        const article = extractArticleText();
        sendResponse(article);
        return;
    }
    if (msg?.type === 'APPLY_HIGHLIGHTS' && Array.isArray(msg.annotations)) {
        clearBiasHighlights();
        highlightBias(msg.annotations);
        sendResponse({ ok: true });
        return true;
    }
    if (msg?.type === 'CLEAR_HIGHLIGHTS') {
        clearBiasHighlights();
        sendResponse({ ok: true });
        return true;
    }
});