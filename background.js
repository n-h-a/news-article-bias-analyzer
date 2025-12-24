// background.js

// ========== HELPERS ==========
function getApiSettings(cb) {
    chrome.storage.local.get(["openai_api_key", "openai_model"], data => {
        const key = (data.openai_api_key || "").trim();
        const model = data.openai_model || "gpt-4o-mini";
        cb(Boolean(key), key, model);
    });
}

function openOptionsPage() {
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html")})
    }
}

function sendToPanel(msg) {
    chrome.runtime.sendMessage(msg);
}

// ========== LLM CALL ==========
async function callBiasModel({ apiKey, model, article }) {
    const endpoint = "https://api.openai.com/v1/chat/completions";

    const system = `
You are a media analysis assistant. Read the article and return JSON in this exact shape:

{
  "bullet_points": [
    "1–2 sentence key point 1",
    "1–2 sentence key point 2",
    "1–2 sentence key point 3",
    "1–2 sentence key point 4",
    "1–2 sentence key point 5",
    "1–2 sentence key point 6"
  ],
  "bias_excerpt_html": "<p>...with <span class='bias-left' data-reason='...'>biased phrase</span> or <span class='bias-right' data-reason='...'>loaded phrase</span>...</p>",
  "indicators": [
    { "phrase": "exact phrase from article", "bias": "left|right|loaded", "reason": "short explanation" }
  ]
}

Rules:
- Stay neutral, factual, concise.
- ALWAYS return 6 bullet_points, 1–2 sentences each.
- Use only: bias-left, bias-right, bias-loaded.
- bias_excerpt_html should be 1–2 short paragraphs with annotated spans.
- indicators must match exact article text and include a brief reason.
- Output valid JSON only, no code fences.

Examples:
- Left bias: "progressive reform" — frames liberal policy positively.
- Left bias: "climate justice" — moral framing supporting environmental activism.
- Right bias: "radical liberals" — portrays opposing ideology as extreme.
- Right bias: "leftist agenda" — implies manipulative political intent.
- Loaded: "shocking revelation" — evokes emotional reaction.
- Loaded: "heroic stand" — praises one side or actor emotionally.
    `.trim();

    const user = `
Article:
${article}
    `.trim();

    const body = {
        model,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
        temperature: 0.4
    };

    const res = await fetch(endpoint, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });

    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error("OpenAI error: " + res.status + " " + txt);
    }

    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content?.trim() || "";

    // Strip code fences if model added them.
    if (content.startsWith("```")) {
        content = content.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    }

    // Default Structure
    let parsed = {
        bullet_points: [],
        bias_excerpt_html: "",
        indicators: []
    };

    try {
        parsed = JSON.parse(content);
    } catch (err) {}

    if (!Array.isArray(parsed.bullet_points)) {
        parsed.bullet_points = [];
    }

    if (!Array.isArray(parsed.indicators)) {
        parsed.indicators = [];
    }

    return parsed;
}

// ========== MESSAGE HUB ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // 1. Panel asks if API key exists.
    if (msg.type === "SUBTEXT_CHECK_API_KEY") {
        getApiSettings(hasKey => {
            sendToPanel({
                type: "SUBTEXT_HAS_API_KEY",
                payload: { hasKey }
            });
        });
        return;
    }

    // 2. Panel clicked "Analyze".
    if (msg.type === "SUBTEXT_START_ANALYSIS") {
        getApiSettings((hasKey, apiKey, model) => {
            if (!hasKey) {
                sendToPanel({
                    type: "SUBTEXT_HAS_API_KEY",
                    payload: { hasKey: false }
                });
                openOptionsPage();
                return;
            }

            // Ask current tab for article content.
            chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
                const tab = tabs[0];
                if (!tab) return;
                chrome.tabs.sendMessage(tab.id, {
                    type: "SUBTEXT_GET_ARTICLE"
                });
            });
        });
        return;
    }
    
    // 3. Content script sent back article.
    if (msg.type === "SUBTEXT_ARTICLE_DATA") {
        getApiSettings(async (hasKey, apiKey, model) => {
            if (!hasKey) {
                sendToPanel({
                    type: "SUBTEXT_HAS_API_KEY",
                    payload: { hasKey: false }
                });
                openOptionsPage();
                return;
            }

            const art = msg.payload || {};
            const articleText = art.text || art.excerpt || "";

            let llmResult = {
                bullet_points: [],
                bias_excerpt_html: "",
                indicators: []
            }
            
            // 3a. Call bias model with extracted article.
            try {
                llmResult = await callBiasModel({
                    apiKey,
                    model,
                    article: articleText
                });
            } catch (err) {
                console.warn("LLM call failed:", err);
            }

            // 3b. Tell the tab to highlight.
            const tabId = sender?.tab?.id;
            const annotations = (llmResult.indicators || []).map(ind => ({
                phrase: ind.phrase,
                category: ind.bias,
                reason: ind.reason || "Possible bias"
            }));

            if (tabId) {
                // New style, HTML spans.
                chrome.tabs.sendMessage(tabId, {
                    type: "SUBTEXT_APPLY_BIAS_HTML",
                    payload: {
                        bias_excerpt_html: llmResult.bias_excerpt_html || "",
                        indicators: llmResult.indicators || []
                    }
                });

                // Old style, DOM-walk.
                chrome.tabs.sendMessage(tabId, {
                    type: "APPLY_HIGHLIGHTS",
                    annotations
                });
            } else {
                // Fallback to active tab.
                chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
                    const tab = tabs[0];
                    if (!tab) return;

                    chrome.tabs.sendMessage(tab.id, {
                        type: "SUBTEXT_APPLY_BIAS_HTML",
                        payload: {
                            bias_excerpt_html: llmResult.bias_excerpt_html || "",
                            indicators: llmResult.indicators || []
                        }
                    });

                    chrome.tabs.sendMessage(tab.id, {
                        type: "APPLY_HIGHLIGHTS",
                        annotations
                    });
                });
            }

            // 3c. Tell the side panel to render.
            sendToPanel({
                type: "SUBTEXT_RESULT",
                payload: {
                    title: art.title || "Untitled article",
                    source: art.source || "",
                    url: art.url || "",
                    bulletPoints: llmResult.bullet_points || [],
                    biasExcerptHtml: llmResult.bias_excerpt_html || art.excerpt || "No excerpt available.",
                    indicators: llmResult.indicators || [],
                    sourceInfo: {
                        name: art.source || "Unknown source",
                        bias: "Unknown",
                        credibility: "Unknown",
                        provider: "Subtext (LLM)"
                    }
                }
            });
        });
        
        return true;
    }

    if (msg.type === "SUBTEXT_OPEN_SETTINGS") {
        openOptionsPage();
    }

    if (msg.type === "SUBTEXT_OPEN_CONTEXT") {
        chrome.tabs.create({ url: "https://www.google.com/" });
    }
});