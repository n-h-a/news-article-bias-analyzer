// background.js

const PANEL_PATH = "sidepanel/sidepanel.html";
const ANALYSIS_CACHE_PREFIX = "analysis:";
const MAX_ARTICLE_CHARS = 18000;
const ANALYSIS_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const ANALYSIS_CACHE_MAX_ENTRIES = 40;

function logBackground(level, msg, data = {}) {
    const timestamp = new Date().toLocaleTimeString();
    const method = level === "error" ? "error" : "log";
    console[method](`[${timestamp}] [${level.toUpperCase()}] [Background] ${msg}`, data);
}

const logInfo = (msg, data = {}) => logBackground("info", msg, data);
const logError = (msg, data = {}) => logBackground("error", msg, data);

async function configureActionToOpenSidePanel() {
    if (!chrome.sidePanel?.setPanelBehavior) {
        return;
    }

    try {
        await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        logInfo("Configured action click to open side panel");
    } catch (error) {
        logError("Failed to configure action click side panel behavior", {
            error: String(error)
        });
    }
}


// ========== SETTINGS ==========
function getApiSettings(cb) {
    chrome.storage.local.get(["openai_api_key", "openai_model"], data => {
        const key = (data.openai_api_key || "").trim();
        const model = data.openai_model || "gpt-4o-mini";
        cb(Boolean(key), key, model);
    });
}

function openOptionsPage() {
    logInfo("Opening options page");
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html")});
    }
}

function sendToPanel(msg) {
    logInfo("Sending message to side panel", { type: msg?.type || "unknown" });
    chrome.runtime.sendMessage(msg);
}

function sendAnalysisError(reason, message) {
    sendToPanel({
        type: "SUBTEXT_ANALYSIS_ERROR",
        payload: { reason, message }
    });
}

function normalizeUrl(url) {
    if (!url || typeof url !== "string") return "";

    try {
        const parsed = new URL(url);
        parsed.hash = "";
        return parsed.toString();
    } catch {
        return url;
    }
}

function normalizeCacheText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildArticlePreviewFingerprint(article = {}) {
    const signatureSource = [
        normalizeUrl(article.url || ""),
        normalizeCacheText(article.title || ""),
        normalizeCacheText(article.source || ""),
        normalizeCacheText(article.excerpt || "")
    ].join("||");

    let hash = 2166136261;
    for (let i = 0; i < signatureSource.length; i++) {
        hash ^= signatureSource.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return `preview:v1:${(hash >>> 0).toString(16)}`;
}

function buildArticleContentFingerprint(article = {}) {
    const signatureSource = [
        buildArticlePreviewFingerprint(article),
        normalizeCacheText(article.text || "")
    ].join("||");

    let hash = 2166136261;
    for (let i = 0; i < signatureSource.length; i++) {
        hash ^= signatureSource.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }

    return `content:v1:${(hash >>> 0).toString(16)}`;
}

function isExpiredCacheEntry(entry) {
    if (!entry?.cachedAt) return true;
    return Date.now() - entry.cachedAt > ANALYSIS_CACHE_TTL_MS;
}

async function removeCachedAnalysisByKey(cacheKey) {
    if (!cacheKey) return;
    await chrome.storage.session.remove(cacheKey);
}

async function pruneAnalysisCache() {
    const sessionEntries = await chrome.storage.session.get(null);
    const cacheEntries = Object.entries(sessionEntries)
        .filter(([key]) => key.startsWith(ANALYSIS_CACHE_PREFIX))
        .map(([key, value]) => ({ key, value }));

    const expiredKeys = cacheEntries
        .filter(entry => isExpiredCacheEntry(entry.value))
        .map(entry => entry.key);

    if (expiredKeys.length) {
        await chrome.storage.session.remove(expiredKeys);
    }

    const freshEntries = cacheEntries
        .filter(entry => !expiredKeys.includes(entry.key))
        .sort((a, b) => {
            const aStamp = a.value?.lastAccessedAt || a.value?.cachedAt || 0;
            const bStamp = b.value?.lastAccessedAt || b.value?.cachedAt || 0;
            return bStamp - aStamp;
        });

    if (freshEntries.length <= ANALYSIS_CACHE_MAX_ENTRIES) {
        return;
    }

    const keysToRemove = freshEntries
        .slice(ANALYSIS_CACHE_MAX_ENTRIES)
        .map(entry => entry.key);

    if (keysToRemove.length) {
        await chrome.storage.session.remove(keysToRemove);
    }
}

function getAnalysisCacheKey(url) {
    const normalizedUrl = normalizeUrl(url);
    return normalizedUrl ? `${ANALYSIS_CACHE_PREFIX}${normalizedUrl}` : "";
}

async function getCachedAnalysis(url, article = null) {
    const cacheKey = getAnalysisCacheKey(url);
    if (!cacheKey) return null;

    const cached = await chrome.storage.session.get(cacheKey);
    const entry = cached[cacheKey] || null;

    if (!entry) return null;

    if (isExpiredCacheEntry(entry)) {
        await removeCachedAnalysisByKey(cacheKey);
        return null;
    }

    if (article) {
        const currentPreviewFingerprint = buildArticlePreviewFingerprint(article);
        if (entry.articlePreviewFingerprint && entry.articlePreviewFingerprint !== currentPreviewFingerprint) {
            logInfo("Discarding cached analysis due to content mismatch", {
                url: normalizeUrl(url)
            });
            await removeCachedAnalysisByKey(cacheKey);
            return null;
        }
    }

    await chrome.storage.session.set({
        [cacheKey]: {
            ...entry,
            lastAccessedAt: Date.now()
        }
    });

    return {
        ...entry,
        lastAccessedAt: Date.now()
    };
}

async function setCachedAnalysis(url, result, article = null) {
    const cacheKey = getAnalysisCacheKey(url);
    if (!cacheKey) return;

    const articlePreviewFingerprint = buildArticlePreviewFingerprint(article || result || { url });
    const articleContentFingerprint = buildArticleContentFingerprint(article || result || { url });

    await chrome.storage.session.set({
        [cacheKey]: {
            ...result,
            articlePreviewFingerprint,
            articleContentFingerprint,
            normalizedUrl: normalizeUrl(url),
            cachedAt: Date.now(),
            lastAccessedAt: Date.now()
        }
    });

    await pruneAnalysisCache();
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs?.[0] || null;
}

function buildResultPayload({ art, llmResult, excerpt, excerptHtml }) {
    const sourceAnalysis = llmResult.source_analysis || {};

    return {
        title: art.title || "Untitled article",
        url: art.url || "",
        source: art.source || "",
        excerpt: excerpt ?? art.excerpt ?? "",
        excerptHtml: excerptHtml || "",
        bulletPoints: llmResult.bullet_points || [],
        indicators: llmResult.indicators || [],
        sourceInfo: {
            name: art.source || "Unknown source",
            bias: sourceAnalysis.leaning || "Unknown",
            credibility: sourceAnalysis.credibility || "Unknown",
            confidence: sourceAnalysis.confidence || "Low",
            provider: "Subtext (LLM)"
        }
    };
}

function trimArticleTextForModel(articleText, maxChars = MAX_ARTICLE_CHARS) {
    const normalized = (articleText || "").replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length <= maxChars) {
        return normalized;
    }

    const clipped = normalized.slice(0, maxChars);
    const sentenceBoundary = Math.max(
        clipped.lastIndexOf(". "),
        clipped.lastIndexOf("! "),
        clipped.lastIndexOf("? ")
    );

    if (sentenceBoundary > Math.floor(maxChars * 0.6)) {
        return clipped.slice(0, sentenceBoundary + 1).trim();
    }

    return `${clipped.trim()}...`;
}

function buildContextPageUrl(article = {}) {
    const pageUrl = chrome.runtime.getURL("context/context.html");
    const url = new URL(pageUrl);

    if (article.title) url.searchParams.set("title", article.title);
    if (article.url) url.searchParams.set("url", article.url);
    if (article.source) url.searchParams.set("source", article.source);

    return url.toString();
}

function sendPageStateToPanel({ tabId, article, mode, result, statusMessage }) {
    sendToPanel({
        type: "SUBTEXT_PAGE_STATE",
        payload: {
            tabId,
            article: article || null,
            mode,
            result: result || null,
            statusMessage: statusMessage || ""
        }
    });
}

function buildHighlightAnnotations(indicators = []) {
    return indicators.map(ind => ({
        phrase: ind.phrase,
        category: ind.bias,
        reason: ind.reason || "Possible bias"
    }));
}

async function syncPanelStateForTab(tabId, tabUrl) {
    if (!tabId) return;

    if (invalidUrl(tabUrl)) {
        sendPageStateToPanel({
            tabId,
            article: {
                title: "Unsupported page",
                source: "",
                url: tabUrl || ""
            },
            mode: "start",
            statusMessage: "Subtext only works on normal web pages."
        });
        return;
    }

    const ok = await ensureContentScript(tabId);
    if (!ok) {
        sendPageStateToPanel({
            tabId,
            article: null,
            mode: "start",
            statusMessage: "Subtext could not access this page. Reload it and try again."
        });
        return;
    }

    const previewResult = await sendMessageToTab(tabId, { type: "SUBTEXT_GET_ARTICLE_INFO" });
    if (!previewResult.ok || !previewResult.resp) {
        logError("Failed to retrieve article preview", {
            tabId,
            error: previewResult.error || "Unknown error"
        });
        sendPageStateToPanel({
            tabId,
            article: null,
            mode: "start",
            statusMessage: "Subtext could not read this page. Reload it and try again."
        });
        return;
    }

    const article = previewResult.resp;
    if (!article.isArticle) {
        sendPageStateToPanel({
            tabId,
            article,
            mode: "start",
            statusMessage: "Subtext works best on standalone article pages. Open an article to analyze it."
        });
        return;
    }

    const cachedResult = await getCachedAnalysis(article.url, article);

    if (cachedResult) {
        const highlightRestore = await sendMessageToTab(tabId, {
            type: "APPLY_HIGHLIGHTS",
            annotations: buildHighlightAnnotations(cachedResult.indicators || [])
        });

        if (highlightRestore.ok && highlightRestore.resp?.excerptHtml) {
            cachedResult.excerpt = highlightRestore.resp.excerpt || cachedResult.excerpt || "";
            cachedResult.excerptHtml = highlightRestore.resp.excerptHtml || cachedResult.excerptHtml || "";
            await setCachedAnalysis(article.url, cachedResult, article);
        } else if (!highlightRestore.ok) {
            logError("Failed to restore cached highlights", {
                tabId,
                error: highlightRestore.error || "Unknown error"
            });
        }
    }

    sendPageStateToPanel({
        tabId,
        article,
        mode: cachedResult ? "results" : "start",
        result: cachedResult,
        statusMessage: ""
    });
}

async function enablePanelForTab(tabId) {
    try {
        await chrome.sidePanel.setOptions({
            tabId,
            path: PANEL_PATH,
            enabled: true
        });
        logInfo("Enabled side panel for tab", { tabId });
    } catch (e) {
        logError("Failed to enable side panel", { tabId, error: String(e) });
    }
}

async function closePanelForTab(tabId) {
    try {
        if (chrome.sidePanel?.close) {
            await chrome.sidePanel.close({ tabId });
        } else {
            await chrome.sidePanel.setOptions({ tabId, enabled: false });
        }

        logInfo("Closed side panel for tab", { tabId });
    } catch (e) {
        logError("Failed to close side panel", { tabId, error: String(e) });
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
    if (ping.ok) {
        logInfo("Content script already available", { tabId });
        return true;
    }

    try {
        logInfo("Injecting content script", { tabId });
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["vendor/Readability.js", "content_script.js"]
        });

        const ping2 = await sendMessageToTab(tabId, { type: "SUBTEXT_PING" });
        if (!ping2.ok) {
            logError("Content script injection verification failed", { tabId, error: ping2.error || "Unknown error" });
        }
        return ping2.ok;
    } catch (e) {
        logError("Failed to inject content script", { tabId, error: String(e) });
        return false;
    }
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
        "credibility": "High|Medium|Low|Unknown"
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

    const trimmedArticleText = trimArticleTextForModel(articleText);

    const user = `
Title: ${articleTitle || "Unknown"}
URL: ${articleUrl || "Unknown"}
Source: ${articleSource || "Unknown"}
Article:
${trimmedArticleText}
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
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch (err) {
        logError("Failed to parse model response as JSON", {
            error: String(err),
            contentPreview: content.slice(0, 500)
        });
        throw new Error("Model returned invalid JSON");
    }

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
        const source = sender.tab ? `Tab: ${sender.tab.id}` : "Extension";
        const method = msg.level === "error" ? "error" : "log";

        console[method](`[${timestamp}] [${msg.level.toUpperCase()}] [${source}]`, msg.msg, msg.data);
        return;
    }

    // 0. Panel asks if API key exists.
    if (msg.type === "SUBTEXT_CHECK_API_KEY") {
        logInfo("Received API key status check request");
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
        logInfo("Side panel reported ready");
        chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
            const tab = tabs?.[0];
            if (tab?.id) await syncPanelStateForTab(tab.id, tab.url);
        });
        return;
    }

    // 2. If panel clicked "Analyze", then request article.
    if (msg.type === "SUBTEXT_START_ANALYSIS") {
        logInfo("Analysis requested from side panel");
        getApiSettings((hasKey, apiKey, model) => {
            if (!hasKey) {
                logInfo("Analysis blocked because API key is missing");
                sendToPanel({
                    type: "SUBTEXT_HAS_API_KEY",
                    payload: { hasKey: false }
                });
                sendAnalysisError("missing-api-key", "Add your OpenAI API key in Settings to analyze this article.");
                openOptionsPage();
                return;
            }

            // Ask current tab for article content.
            chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
                const tab = tabs[0];
                if (!tab) {
                    logError("No active tab found for analysis request");
                    sendAnalysisError("no-active-tab", "Open an article tab and try again.");
                    return;
                }

                const ok = await ensureContentScript(tab.id);
                if (!ok) {
                    logError("Analysis blocked because content script is unavailable", { tabId: tab.id });
                    sendAnalysisError("content-script-unavailable", "Subtext could not access this page. Reload it and try again.");
                    return;
                }

                logInfo("Requesting article content from active tab", { tabId: tab.id, model });
                const result = await sendMessageToTab(tab.id, {
                    type: "SUBTEXT_GET_ARTICLE"
                });

                if (!result.ok) {
                    logError("Failed to request article content from tab", {
                        tabId: tab.id,
                        error: result.error || "Unknown error"
                    });
                    sendAnalysisError("article-request-failed", "Subtext could not read this article. Reload the page and try again.");
                    return;
                }
                
                const art = result.resp || {};
                const articleTitle = art.title || "Untitled article";
                const articleUrl = art.url || tab.url || "";
                const articleSource = art.source || "";
                const articleText = art.text || "";
                const trimmedArticleText = trimArticleTextForModel(articleText);

                if (!art.isArticle) {
                    sendAnalysisError("not-an-article", "Subtext could not find a standalone article on this page.");
                    return;
                }

                logInfo("Article data received for analysis", {
                    title: articleTitle,
                    source: articleSource || "Unknown",
                    textLength: articleText.length,
                    trimmedTextLength: trimmedArticleText.length,
                    model,
                    tabId: tab.id
                });

                let llmResult;

                try {
                    logInfo("Calling bias model", { model, articleTitle });
                    llmResult = await callBiasModel({
                        apiKey,
                        model,
                        articleTitle,
                        articleUrl,
                        articleSource,
                        articleText: trimmedArticleText,
                    });
                    logInfo("Bias model returned result", {
                        bulletCount: Array.isArray(llmResult.bullet_points) ? llmResult.bullet_points.length : 0,
                        indicatorCount: Array.isArray(llmResult.indicators) ? llmResult.indicators.length : 0,
                        tabId: tab.id
                    });
                } catch (err) {
                    logError("LLM call failed", { error: String(err) });
                    sendAnalysisError("analysis-failed", "Subtext could not complete the analysis. Try again in a moment.");
                    return;
                }

                const annotations = buildHighlightAnnotations(llmResult.indicators || []);

                let excerpt = art.excerpt || "";
                let excerptHtml = "";

                const highlightResult = await sendMessageToTab(tab.id, {
                    type: "APPLY_HIGHLIGHTS",
                    annotations
                });

                if (highlightResult.ok && highlightResult.resp) {
                    excerpt = highlightResult.resp.excerpt || excerpt;
                    excerptHtml = highlightResult.resp.excerptHtml || "";
                } else if (!highlightResult.ok) {
                    logError("Failed to apply highlights", {
                        tabId: tab.id,
                        error: highlightResult.error || "Unknown error"
                    });
                }

                const payload = buildResultPayload({
                    art,
                    llmResult,
                    excerpt,
                    excerptHtml
                });

                await setCachedAnalysis(articleUrl, payload, art);

                const activeTab = await getActiveTab();
                if (!activeTab?.id) return;

                const activeUrl = normalizeUrl(activeTab.url || "");
                const resultUrl = normalizeUrl(articleUrl);

                if (activeTab.id === tab.id && activeUrl === resultUrl) {
                    sendToPanel({
                        type: "SUBTEXT_RESULT",
                        payload: {
                            tabId: tab.id,
                            result: payload
                        }
                    });
                }
            });
        });
        return;
    }

    if (msg.type === "SUBTEXT_OPEN_SETTINGS") {
        logInfo("Open settings request received");
        openOptionsPage();
        return;
    }

    if (msg.type === "SUBTEXT_OPEN_CONTEXT") {
        logInfo("Open context request received");
        chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
            const tab = tabs?.[0];
            const articleUrl = tab?.url || "";
            const article = articleUrl && !invalidUrl(articleUrl)
                ? (await getCachedAnalysis(articleUrl)) || { url: articleUrl }
                : {};

            chrome.tabs.create({ url: buildContextPageUrl(article) });
        });
        return;
    }

    if (msg.type === "SUBTEXT_CLOSE_PANEL") {
        chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
            const tabId = tabs?.[0]?.id;
            if (!tabId) {
                logError("No active tab found for close panel request");
                return;
            }

            await closePanelForTab(tabId);
        });
        return;
    }
});


// ========== EVENT LISTENERS ==========
chrome.runtime.onInstalled.addListener(async () => {
    await configureActionToOpenSidePanel();
    logInfo("Extension installed; checking open tabs for content script injection");
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || invalidUrl(tab.url)) continue;
        await ensureContentScript(tab.id);
    }
});

chrome.runtime.onStartup?.addListener(async () => {
    await configureActionToOpenSidePanel();
});

configureActionToOpenSidePanel();

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    logInfo("Active tab changed", { tabId, url: tab?.url || "" });

    if (!tab?.url || invalidUrl(tab.url)) {
        await syncPanelStateForTab(tabId, tab?.url || "");
        return;
    }

    enablePanelForTab(tabId);
    await syncPanelStateForTab(tabId, tab.url);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status !== "complete") return;
    if (!tab?.active) return;

    logInfo("Tab finished loading", { tabId, url: tab?.url || "" });

    if (!tab?.url || invalidUrl(tab.url)) {
        await syncPanelStateForTab(tabId, tab?.url || "");
        return;
    }

    enablePanelForTab(tabId);
    await syncPanelStateForTab(tabId, tab.url);
});