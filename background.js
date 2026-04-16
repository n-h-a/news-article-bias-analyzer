// background.js

const PANEL_PATH = "sidepanel/sidepanel.html";

const analysisRequested = new Set();

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

async function enablePanelForTab(tabId) {
    try {
        await chrome.sidePanel.setOptions({
            tabId,
            path: PANEL_PATH,
            enabled: true
        });
    } catch (e) {
        console.warn('setOptions failed', e);
    }
}

function sendMessageToTab(tabId, msg) {
    return new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, msg, (resp) => {
            if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                resolve({ ok: true, resp });
            }
        });
    });
}

async function ensureContentScript(tabId) {
    const ping = await sendMessageToTab(tabId, { type: "SUBTEXT_PING" });
    if (ping.ok) return true;

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["vendor/Readability.js", "content_script.js"]
        });

        const ping2 = await sendMessageToTab(tabId, { type: "SUBTEXT_PING" });
        return ping2.ok;
    } catch (e) {
        console.warn("Failed to inject content script", e);
        return false;
    }
}

async function requestArticlePreview(tabId) {
    const ok = await ensureContentScript(tabId);
    if (!ok) return;

    const articleInfo = await sendMessageToTab(tabId, { type: "SUBTEXT_GET_ARTICLE_INFO" });
}

function invalidUrl(url) {
  if (!url || typeof url !== "string") return true;

  const blockedPrefixes = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:",
    "devtools://",
    "view-source:",
    "moz-extension://"
  ];

  return blockedPrefixes.some(prefix => url.startsWith(prefix));
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
- source_analysis should describe typical editorial leaning of the outlet, not the intent of individual journalists or the article.
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

    if (!Array.isArray(parsed.bullet_points)) { parsed.bullet_points = []; }
    if (!Array.isArray(parsed.indicators)) { parsed.indicators = []; }
    if (!parsed.source_analysis || typeof parsed.source_analysis !== "object") {
        parsed.source_analysis = { leaning: "Unknown", confidence: "Low", credibility: "Unknown" };
    }

    return parsed;
}

// ========== MESSAGE HUB ==========
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => { 
    // Logger
    if (msg.type === "LOG") {
        const timestamp = new Date().toLocaleTimeString();
        const source = sender.tab ? `Tab: ${sender.tab.id}` : `Extension`;

        console.log(`[${timestamp}] [${msg.level.toUpperCase()}] [${source}]`, msg.msg, msg.data);
    }

    // 0. Panel asks if API key exists.
    if (msg.type === "SUBTEXT_CHECK_API_KEY") {
        getApiSettings(hasKey => {
            sendToPanel({
                type: "SUBTEXT_HAS_API_KEY",
                payload: { hasKey }
            });
        });
        return;
    }

    // 1. If panel is ready, then request article preview.
    if (msg.type === "SUBTEXT_PANEL_READY") {
        chrome.tabs.query({ active: true, currentWindow: true}, async (tabs) => {
            const tabId = tabs?.[0]?.id;
            if (tabId) await requestArticlePreview(tabId);
        });
        return;
    }

    // 2. If panel clicked "Analyze", then request article.
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


// ========== EVENT LISTENERS ==========
chrome.runtime.onInstalled.addListener(async () => {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || invalidUrl(tab.url)) continue;
        await ensureContentScript(tab.id);
    }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    if (invalidUrl(tab.url)) return;
    
    enablePanelForTab(tabId);
    await requestArticlePreview(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== "complete") return;
    if (!tab?.url) return;
    if (invalidUrl(tab.url)) return;

    enablePanelForTab(tabId);
    await requestArticlePreview(tabId);
});