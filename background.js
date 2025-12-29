// background.js

// ========== HELPERS ==========
function getApiSettings(cb) {
    chrome.storage.local.get(["openai_api_key", "openai_model"], data => {
        const key = (data.openai_api_key || "").trim();
        const model = data.openai_model || "gpt-4o-mini";
        cb(Boolean(key), key, model);
    });
}

function openSidePanel() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id) return;
        chrome.sidePanel.open({ tabId: tab.id });
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
async function callBiasModel({ apiKey, model, articleTitle, articleUrl, articleSource, articleText }) {
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
  "indicators": [
    { "phrase": "exact phrase from article", "bias": "left|right|loaded", "reason": "short explanation" }
  ],
  "source_analysis": {
    "leaning": "Left|Center-left|Center|Center-right|Right|Mixed|Unknown",
    "confidence": "High|Medium|Low",
    "credibility": "High|Medium|Low|Unknown",
  }
}

Rules:
- Stay neutral, factual, concise.
- ALWAYS return 6 bullet_points, 1–2 sentences each.
- indicators must match exact article text and include a brief reason.
- source_analysis should describe typical editorial leaning of the outlet, not the intent of individual journalists.
- If you are unsure, use leaning="Unknown" with confidence="Low".
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
Title: ${articleTitle || "Unknown"}
URL: ${articleUrl || "Unknown"}
Source: ${articleSource || "Unknown"}
Article:
${articleText}
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
        indicators: [],
        source_analysis: {
            leaning: "Unknown",
            confidence: "Low",
            credibility: "Unknown"
        }
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

    if (!parsed.source_analysis || typeof parsed.source_analysis !== "object") {
        parsed.source_analysis = { leaning: "Unknown", confidence: "Low", credibility: "Unknown" };
    }

    return parsed;
}

// ========== MESSAGE HUB ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Open side panel.
    if (msg.type === "OPEN_SIDE_PANEL") {
        openSidePanel();
        return;
    }
   
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
            const articleTitle = art.title || "Untitled article";
            const articleUrl = art.url || "";
            const articleSource = art.source || "";
            const articleText = art.text || "";

            let llmResult = {
                bullet_points: [],
                // bias_excerpt_html: "",
                indicators: []
            }
            
            // 3a. Call bias model with extracted article.
            try {
                llmResult = await callBiasModel({
                    apiKey,
                    model,
                    articleTitle,
                    articleUrl,
                    articleSource,
                    articleText,
                });
            } catch (err) {
                console.warn("LLM call failed:", err);
            }

            // 3b. Tell the side panel to render.
            const sourceAnalysis = llmResult.source_analysis || {};
            sendToPanel({
                type: "SUBTEXT_RESULT",
                payload: {
                    title: articleTitle,
                    url: articleUrl,
                    source: articleSource,
                    excerpt: art.excerpt || "",
                    bulletPoints: llmResult.bullet_points || [],
                    indicators: llmResult.indicators || [],
                    sourceInfo: {
                        name: art.source || "Unknown source",
                        bias: sourceAnalysis.leaning || "Unknown",
                        credibility: sourceAnalysis.credibility || "Unknown",
                        confidence: sourceAnalysis.confidence || "Low",
                        provider: "Subtext (LLM)"
                    }
                }
            });

            // 3c. Tell the tab to highlight.
            const tabId = sender?.tab?.id;
            const annotations = (llmResult.indicators || []).map(ind => ({
                phrase: ind.phrase,
                category: ind.bias,
                reason: ind.reason || "Possible bias"
            }));

            if (tabId) {
                // Apply highlights by DOM-walk.
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
                        type: "APPLY_HIGHLIGHTS",
                        annotations
                    });
                });
            }
        });
        
        return true;
    }

    if (msg.type === "SUBTEXT_OPEN_SETTINGS") {
        openOptionsPage();
        return;
    }

    if (msg.type === "SUBTEXT_OPEN_CONTEXT") {
        chrome.tabs.create({ url: "https://www.google.com/" });
        return;
    }
});