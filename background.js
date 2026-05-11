// background.js

const ANALYSIS_CACHE_PREFIX = "analysis:";
const MAX_ARTICLE_CHARS = 18000;
const ANALYSIS_CACHE_TTL_MS = 1000 * 60 * 60 * 12;
const ANALYSIS_CACHE_MAX_ENTRIES = 40;
const ANALYSIS_REQUEST_TIMEOUT_MS = 45000;

// Key used to persist the anonymous device UUID in chrome.storage.local.
// The UUID is generated once on first use and reused across sessions.
const DEVICE_ID_KEY = "subtext_device_id";

const IS_DEV = !("update_url" in chrome.runtime.getManifest());
const BACKEND_API_URL = IS_DEV
    ? "http://localhost:3000/analyze"
    : "https://subtext-api-production-82b5.up.railway.app/analyze";

// ========== DEVICE ID ==========

// Returns the stored anonymous device UUID, creating and persisting one if
// this is the first time the extension has been used on this device.
// Uses crypto.randomUUID() which is available natively in MV3 service workers.
async function getOrCreateDeviceId() {
    const stored = await chrome.storage.local.get(DEVICE_ID_KEY);
    if (stored[DEVICE_ID_KEY]) return stored[DEVICE_ID_KEY];

    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    return id;
}

const panelSessions = new Map();

function logBackground(level, msg, data = {}) {
    const timestamp = new Date().toLocaleTimeString();
    const method = level === "error" ? "error" : "log";
    console[method](`[${timestamp}] [${level.toUpperCase()}] [Background] ${msg}`, data);
}

const logInfo = (msg, data = {}) => logBackground("info", msg, data);
const logError = (msg, data = {}) => logBackground("error", msg, data);

function getPanelSession(windowId) {
    return typeof windowId === "number" ? panelSessions.get(windowId) || null : null;
}

function isSidePanelOpen(windowId) {
    if (typeof windowId === "number") {
        return Boolean(getPanelSession(windowId)?.port);
    }

    return panelSessions.size > 0;
}

function setPanelSession(windowId, session) {
    if (typeof windowId !== "number") {
        return;
    }

    panelSessions.set(windowId, {
        windowId,
        currentTabId: null,
        currentUrl: "",
        currentRunId: 0,
        ...session
    });
}

function clearPanelSession(windowId, port = null) {
    if (typeof windowId !== "number") {
        return;
    }

    const existing = panelSessions.get(windowId);
    if (!existing) {
        return;
    }

    if (port && existing.port !== port) {
        return;
    }

    panelSessions.delete(windowId);
}

function updatePanelSession(windowId, updates = {}) {
    const session = getPanelSession(windowId);
    if (!session) {
        return null;
    }

    const next = {
        ...session,
        ...updates
    };

    panelSessions.set(windowId, next);
    return next;
}

function postToPanel(windowId, msg) {
    const session = getPanelSession(windowId);
    if (!session?.port) {
        return false;
    }

    try {
        session.port.postMessage(msg);
        return true;
    } catch (error) {
        logError("Failed to post message to side panel", {
            windowId,
            type: msg?.type || "unknown",
            error: String(error)
        });
        return false;
    }
}

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




function openOptionsPage() {
    logInfo("Opening options page");
    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
    } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html")});
    }
}

function sendAnalysisError(windowId, reason, message) {
    logInfo("Sending analysis error to side panel", {
        windowId,
        reason,
        type: "SUBTEXT_ANALYSIS_ERROR"
    });
    postToPanel(windowId, {
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

async function clearAnalysisCache() {
    const sessionEntries = await chrome.storage.session.get(null);
    const cacheKeys = Object.keys(sessionEntries)
        .filter(key => key.startsWith(ANALYSIS_CACHE_PREFIX));

    if (cacheKeys.length) {
        await chrome.storage.session.remove(cacheKeys);
    }

    return cacheKeys.length;
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

    await chrome.storage.session.set({
        [cacheKey]: {
            ...result,
            articlePreviewFingerprint,
            normalizedUrl: normalizeUrl(url),
            cachedAt: Date.now(),
            lastAccessedAt: Date.now()
        }
    });

    await pruneAnalysisCache();
}

async function getActiveTabForWindow(windowId) {
    if (typeof windowId !== "number") {
        return null;
    }

    const tabs = await chrome.tabs.query({ active: true, windowId });
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
            provider: "Subtext AI"
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

function sendPageStateToPanel({ windowId, tabId, article, mode, result, statusMessage }) {
    logInfo("Sending page state to side panel", {
        windowId,
        tabId,
        mode: mode || "start"
    });
    postToPanel(windowId, {
        type: "SUBTEXT_PAGE_STATE",
        payload: {
            windowId,
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

async function syncPanelStateForTab(windowId, tabId, tabUrl) {
    if (typeof windowId !== "number" || !tabId) return;

    updatePanelSession(windowId, {
        currentTabId: tabId,
        currentUrl: tabUrl || ""
    });

    if (invalidUrl(tabUrl)) {
        sendPageStateToPanel({
            windowId,
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
            windowId,
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
            windowId,
            tabId,
            error: previewResult.error || "Unknown error"
        });
        sendPageStateToPanel({
            windowId,
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
            windowId,
            tabId,
            article,
            mode: "start",
            statusMessage: article.detectionReason || "Subtext works best on standalone article pages. Open an article to analyze it."
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
        windowId,
        tabId,
        article,
        mode: cachedResult ? "results" : "start",
        result: cachedResult,
        statusMessage: article.detectionConfidence === "medium"
            ? (article.detectionReason || "This page may be an article, but detection confidence is lower than usual.")
            : ""
    });
}

async function syncPanelStateIfOpen(windowId, tabId, tabUrl, reason) {
    if (!isSidePanelOpen(windowId)) {
        return;
    }

    try {
        await syncPanelStateForTab(windowId, tabId, tabUrl || "");
    } catch (error) {
        logError("Failed to synchronize open side panel", {
            windowId,
            tabId,
            tabUrl: tabUrl || "",
            reason,
            error: String(error)
        });
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

// ========== BACKEND CALL ==========
async function callBackendAnalyze({ articleTitle, articleUrl, articleSource, articleText }) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ANALYSIS_REQUEST_TIMEOUT_MS);

    // Retrieve (or generate) the anonymous device UUID for the usage counter.
    // Non-fatal: if storage fails we proceed without a device ID.
    let deviceId = null;
    try {
        deviceId = await getOrCreateDeviceId();
    } catch {
        logError("Failed to retrieve device ID; proceeding without it");
    }

    const headers = { "Content-Type": "application/json" };
    if (deviceId) headers["X-Device-ID"] = deviceId;

    let res;
    try {
        res = await fetch(BACKEND_API_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({ articleTitle, articleUrl, articleSource, articleText }),
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("The analysis is taking longer than expected. Try again in a moment.");
        }
        throw new Error("Subtext could not reach the analysis server. Check your connection and try again.");
    } finally {
        clearTimeout(timeoutId);
    }

    if (!res.ok) {
        let message = "";
        try {
            const errorData = await res.json();
            message = errorData?.error || errorData?.message || "";
        } catch {
            message = await res.text().catch(() => "");
        }

        if (res.status === 429) {
            throw new Error(message || "You've reached the analysis limit for today. Try again tomorrow.");
        }

        throw new Error(message || "Subtext could not complete the analysis. Try again in a moment.");
    }

    const data = await res.json();

    if (!Array.isArray(data.bullet_points)) { data.bullet_points = []; }
    if (!Array.isArray(data.indicators)) { data.indicators = []; }
    if (!data.source_analysis || typeof data.source_analysis !== "object") {
        data.source_analysis = { leaning: "Unknown", confidence: "Low", credibility: "Unknown" };
    }

    return data;
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

    if (msg.type === "SUBTEXT_CLEAR_ANALYSIS_CACHE") {
        (async () => {
            try {
                const removedCount = await clearAnalysisCache();
                logInfo("Cleared cached analysis data", { removedCount });
                sendResponse({ ok: true, removedCount });
            } catch (error) {
                logError("Failed to clear analysis cache", { error: String(error) });
                sendResponse({ ok: false, error: String(error) });
            }
        })();
        return true;
    }

});


// ========== EVENT LISTENERS ==========
chrome.runtime.onInstalled.addListener(async () => {
    await configureActionToOpenSidePanel();
    logInfo("Extension installed; content scripts will be injected on demand");
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "subtext-sidepanel") {
        return;
    }

    let sessionWindowId = null;

    logInfo("Side panel transport connected");

    port.onMessage.addListener((msg) => {
        if (msg.type === "SUBTEXT_PANEL_CONNECTED") {
            const windowId = msg.payload?.windowId;
            if (typeof windowId !== "number") {
                logError("Side panel connection missing window id");
                return;
            }

            sessionWindowId = windowId;
            setPanelSession(windowId, { port });
            logInfo("Side panel connected", { windowId });
            return;
        }

        if (typeof sessionWindowId !== "number") {
            logError("Ignoring side panel message before session initialization", {
                type: msg?.type || "unknown"
            });
            return;
        }

        if (msg.type === "SUBTEXT_PANEL_READY") {
            logInfo("Side panel reported ready", { windowId: sessionWindowId });
            (async () => {
                const tab = await getActiveTabForWindow(sessionWindowId);
                if (tab?.id) {
                    await syncPanelStateForTab(sessionWindowId, tab.id, tab.url);
                }
            })().catch(error => {
                logError("Failed to sync panel on ready", {
                    windowId: sessionWindowId,
                    error: String(error)
                });
            });
            return;
        }

        if (msg.type === "SUBTEXT_START_ANALYSIS") {
            logInfo("Analysis requested from side panel", {
                windowId: sessionWindowId,
                requestedTabId: msg.payload?.tabId ?? null,
                requestedUrl: msg.payload?.url || ""
            });

            (async () => {
                        const requestedTabId = msg.payload?.tabId;
                        const requestedUrl = normalizeUrl(msg.payload?.url || "");
                        let tab = null;

                        if (typeof requestedTabId === "number") {
                            try {
                                tab = await chrome.tabs.get(requestedTabId);
                            } catch (error) {
                                logError("Failed to resolve requested tab for analysis", {
                                    windowId: sessionWindowId,
                                    requestedTabId,
                                    error: String(error)
                                });
                            }
                        }

                        if (!tab || tab.windowId !== sessionWindowId) {
                            tab = await getActiveTabForWindow(sessionWindowId);
                        }

                        if (!tab?.id) {
                            logError("No active tab found for analysis request", { windowId: sessionWindowId });
                            sendAnalysisError(sessionWindowId, "no-active-tab", "Open an article tab and try again.");
                            return;
                        }

                        const normalizedTabUrl = normalizeUrl(tab.url || "");
                        if (requestedUrl && normalizedTabUrl && requestedUrl !== normalizedTabUrl) {
                            logInfo("Analysis request context changed before run started", {
                                windowId: sessionWindowId,
                                requestedUrl,
                                tabUrl: normalizedTabUrl,
                                tabId: tab.id
                            });
                        }

                        const ok = await ensureContentScript(tab.id);
                        if (!ok) {
                            logError("Analysis blocked because content script is unavailable", {
                                windowId: sessionWindowId,
                                tabId: tab.id
                            });
                            sendAnalysisError(sessionWindowId, "content-script-unavailable", "Subtext could not access this page. Reload it and try again.");
                            return;
                        }

                        logInfo("Requesting article content from tab", {
                            windowId: sessionWindowId,
                            tabId: tab.id
                        });

                        const result = await sendMessageToTab(tab.id, {
                            type: "SUBTEXT_GET_ARTICLE"
                        });

                        if (!result.ok) {
                            logError("Failed to request article content from tab", {
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                error: result.error || "Unknown error"
                            });
                            sendAnalysisError(sessionWindowId, "article-request-failed", "Subtext could not read this article. Reload the page and try again.");
                            return;
                        }

                        const art = result.resp || {};
                        const articleTitle = art.title || "Untitled article";
                        const articleUrl = art.url || tab.url || "";
                        const articleSource = art.source || "";
                        const articleText = art.text || "";
                        const trimmedArticleText = trimArticleTextForModel(articleText);

                        if (!art.isArticle) {
                            sendAnalysisError(sessionWindowId, "not-an-article", art.detectionReason || "Subtext could not find a standalone article on this page.");
                            return;
                        }

                        const session = updatePanelSession(sessionWindowId, {
                            currentTabId: tab.id,
                            currentUrl: articleUrl,
                            currentRunId: (getPanelSession(sessionWindowId)?.currentRunId || 0) + 1
                        });
                        const runId = session?.currentRunId || 0;

                        logInfo("Article data received for analysis", {
                            windowId: sessionWindowId,
                            title: articleTitle,
                            source: articleSource || "Unknown",
                            textLength: articleText.length,
                            trimmedTextLength: trimmedArticleText.length,
                            tabId: tab.id,
                            runId
                        });

                        let llmResult;

                        try {
                            logInfo("Calling analysis backend", {
                                windowId: sessionWindowId,
                                articleTitle,
                                runId
                            });
                            llmResult = await callBackendAnalyze({
                                articleTitle,
                                articleUrl,
                                articleSource,
                                articleText: trimmedArticleText
                            });
                            logInfo("Analysis backend returned result", {
                                windowId: sessionWindowId,
                                bulletCount: Array.isArray(llmResult.bullet_points) ? llmResult.bullet_points.length : 0,
                                indicatorCount: Array.isArray(llmResult.indicators) ? llmResult.indicators.length : 0,
                                tabId: tab.id,
                                runId
                            });
                        } catch (err) {
                            logError("Backend call failed", {
                                windowId: sessionWindowId,
                                runId,
                                error: String(err)
                            });
                            sendAnalysisError(sessionWindowId, "analysis-failed", err?.message || "Subtext could not complete the analysis. Try again in a moment.");
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
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                error: highlightResult.error || "Unknown error",
                                runId
                            });
                        }

                        const payload = buildResultPayload({
                            art,
                            llmResult,
                            excerpt,
                            excerptHtml
                        });

                        await setCachedAnalysis(articleUrl, payload, art);

                        const latestSession = getPanelSession(sessionWindowId);
                        const resultUrl = normalizeUrl(articleUrl);

                        if (!latestSession) {
                            logInfo("Discarding analysis result because panel session no longer exists", {
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                runId
                            });
                            return;
                        }

                        if (latestSession.currentRunId !== runId) {
                            logInfo("Discarding stale analysis result for newer run", {
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                runId,
                                latestRunId: latestSession.currentRunId
                            });
                            return;
                        }

                        if (latestSession.currentTabId !== tab.id || normalizeUrl(latestSession.currentUrl || "") !== resultUrl) {
                            logInfo("Discarding stale analysis result for changed panel context", {
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                runId,
                                sessionTabId: latestSession.currentTabId,
                                sessionUrl: latestSession.currentUrl || ""
                            });
                            return;
                        }

                        postToPanel(sessionWindowId, {
                            type: "SUBTEXT_RESULT",
                            payload: {
                                windowId: sessionWindowId,
                                tabId: tab.id,
                                result: payload
                            }
                        });
            })().catch(error => {
                logError("Analysis orchestration failed", {
                    windowId: sessionWindowId,
                    error: String(error)
                });
                sendAnalysisError(sessionWindowId, "analysis-failed", "Subtext could not complete the analysis. Try again in a moment.");
            });
            return;
        }

        if (msg.type === "SUBTEXT_OPEN_SETTINGS") {
            logInfo("Open settings request received", { windowId: sessionWindowId });
            openOptionsPage();
            return;
        }

        if (msg.type === "SUBTEXT_OPEN_CONTEXT") {
            logInfo("Open context request received", { windowId: sessionWindowId });
            (async () => {
                const session = getPanelSession(sessionWindowId);
                const activeTab = await getActiveTabForWindow(sessionWindowId);
                const articleUrl = normalizeUrl(session?.currentUrl || activeTab?.url || "");
                const article = articleUrl && !invalidUrl(articleUrl)
                    ? (await getCachedAnalysis(articleUrl)) || {
                        url: articleUrl,
                        title: activeTab?.title || "",
                        source: ""
                    }
                    : {};

                chrome.tabs.create({ url: buildContextPageUrl(article) });
            })().catch(error => {
                logError("Failed to open context page", {
                    windowId: sessionWindowId,
                    error: String(error)
                });
            });
        }
    });

    port.onDisconnect.addListener(() => {
        if (typeof sessionWindowId === "number") {
            clearPanelSession(sessionWindowId, port);
            logInfo("Side panel disconnected", { windowId: sessionWindowId });
        }
    });
});

chrome.runtime.onStartup?.addListener(async () => {
    await configureActionToOpenSidePanel();
});

// Also run immediately on script evaluation to cover service worker restarts,
// which do not reliably fire onInstalled or onStartup.
configureActionToOpenSidePanel();

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
    if (!isSidePanelOpen(windowId)) {
        return;
    }

    const tab = await chrome.tabs.get(tabId);

    logInfo("Active tab changed while panel open", { tabId, url: tab?.url || "" });
    await syncPanelStateIfOpen(tab.windowId, tabId, tab?.url || "", "tab-activated");
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (!isSidePanelOpen(tab?.windowId)) {
        return;
    }

    if (info.status !== "complete") return;
    if (!tab?.active) return;

    logInfo("Active tab finished loading while panel open", { tabId, url: tab?.url || "" });
    await syncPanelStateIfOpen(tab.windowId, tabId, tab?.url || "", "tab-updated");
});