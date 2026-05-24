// sidepanel.js

import Logger from '../logger.js';

let panelPort = null;
let panelWindowId = null;
let reconnectTimerId = null;
let isCurrentPageArticle = false;
let isAnalysisInProgress = false;

function syncAnalyzeButtonState() {
    if (!analyzeBtn) {
        return;
    }

    analyzeBtn.disabled = isAnalysisInProgress || !isCurrentPageArticle;
}

function handlePanelMessage(msg) {
    if (msg.type === "SUBTEXT_PAGE_STATE") {
        Logger.info("Received page state update", {
            mode: msg.payload?.mode || "unknown",
            tabId: msg.payload?.tabId ?? null,
            hasResult: Boolean(msg.payload?.result)
        });
        applyPageState(msg.payload || {});
    }

    if (msg.type === "SUBTEXT_ANALYSIS_ERROR") {
        const message = msg.payload?.message || "Subtext could not analyze this page. Try again.";
        const reason = msg.payload?.reason || "unknown";
        Logger.error("Analysis error received", { reason, message });
        recoverFromAnalysisError(message);
    }

    if (msg.type === "SUBTEXT_RESULT") {
        const tabId = msg.payload?.tabId ?? null;
        const res = msg.payload?.result || {};

        if (!matchesCurrentContext(tabId, res.url || "")) {
            Logger.info("Ignoring stale analysis result", {
                tabId,
                url: res.url || ""
            });
            return;
        }

        pendingResult = res;
        analysisDone = true;

        Logger.info("Analysis result received", {
            bulletCount: Array.isArray(res.bulletPoints) ? res.bulletPoints.length : 0,
            indicatorCount: Array.isArray(res.indicators) ? res.indicators.length : 0
        });

        maybeFinalizeRun(currentRunId);
    }
}

function initializePanelSession() {
    if (!panelPort || typeof panelWindowId !== "number") {
        return;
    }

    try {
        panelPort.postMessage({
            type: "SUBTEXT_PANEL_CONNECTED",
            payload: { windowId: panelWindowId }
        });
        panelPort.postMessage({ type: "SUBTEXT_PANEL_READY" });
        Logger.info("Panel session initialized", { windowId: panelWindowId });
    } catch (error) {
        Logger.error("Failed to initialize panel session", {
            windowId: panelWindowId,
            error: String(error)
        });
    }
}

function schedulePanelReconnect() {
    if (reconnectTimerId !== null) {
        return;
    }

    reconnectTimerId = window.setTimeout(() => {
        reconnectTimerId = null;
        connectPanelPort();
    }, 800);
}

function connectPanelPort() {
    if (panelPort) {
        return panelPort;
    }

    try {
        panelPort = chrome.runtime.connect({ name: "subtext-sidepanel" });
        panelPort.onMessage.addListener(handlePanelMessage);
        panelPort.onDisconnect.addListener(() => {
            const disconnectError = chrome.runtime.lastError?.message || "Port disconnected";
            panelPort = null;
            cancelPendingAnalysisRun();
            isAnalysisInProgress = false;
            syncAnalyzeButtonState();
            showStartPage();
            setStartPageStatus("Connection to the Subtext background service was interrupted. Reconnecting…", "warning");
            Logger.error("Side panel port disconnected", { error: disconnectError });
            schedulePanelReconnect();
        });

        initializePanelSession();
    } catch (error) {
        panelPort = null;
        Logger.error("Failed to connect side panel port", { error: String(error) });
        schedulePanelReconnect();
    }

    return panelPort;
}

function sendPanelMessage(message) {
    const port = panelPort || connectPanelPort();
    if (!port) {
        Logger.error("Unable to send message because side panel port is unavailable", {
            type: message?.type || "unknown"
        });
        return false;
    }

    try {
        port.postMessage(message);
        return true;
    } catch (error) {
        Logger.error("Failed to send side panel message", {
            type: message?.type || "unknown",
            error: String(error)
        });
        return false;
    }
}

function openSettings() {
    if (sendPanelMessage({ type: "SUBTEXT_OPEN_SETTINGS" })) {
        return;
    }

    if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
        return;
    }

    chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
}


// ========== PAGE ELEMENTS ==========
const pageStart = document.getElementById("start-page");
const pageResults = document.getElementById("results-page");

// -- Page 1 : Start Page --
const detectedTopIconEl = document.getElementById("detected-top-icon");
const detectedTopTitleEl = document.getElementById("detected-top-title");
const detectedTopTextEl = document.getElementById("detected-top-text");
const detectedCardLabelEl = document.getElementById("detected-article-card-label");
const detectedTitleEl = document.getElementById("detected-article-card-title");
const detectedSourceEl = document.getElementById("detected-article-card-source");
const detectedUrlEl = document.getElementById("detected-article-card-url");
const analyzeBtn = document.getElementById("btn-start-analyze");
const startPageStatusCardEl = document.getElementById("start-page-status-card");
const startPageStatusAccentEl = document.getElementById("start-page-status-accent");
const startPageStatusEl = document.getElementById("start-page-status");

// -- Loading --
const summaryLoading = document.getElementById("summary-section-loading");
const summaryContent = document.getElementById("summary-section-content");
const biasLoading = document.getElementById("bias-section-loading");
const biasContent = document.getElementById("bias-section-content");
const biasIndicatorsLoading = document.getElementById("bias-indicators-section-loading");
const biasIndicatorsContent = document.getElementById("bias-indicators-section-content");
const sourceLoading = document.getElementById("source-section-loading");
const sourceContent = document.getElementById("source-section-content");

const summaryLoadingBar = document.getElementById("summary-section-loading-bar");
const summaryLoadingBarFill = document.getElementById("summary-section-loading-bar-fill");
const summaryPctLabel = document.getElementById("summary-section-loading-bar-percentage-label");
const summaryLabel = document.getElementById("summary-section-loading-bar-label");

// -- Page 2 : Results Page --
const titleEl = document.getElementById("article-header-title");
const sourceEl = document.getElementById("article-header-source");

const linkEl = document.getElementById("article-header-link");
const analyzingCardImg = document.getElementById("analyzing-card-icon-img");
const analyzingCardLabel = document.getElementById("analyzing-card-label");
const analyzingArticleTitle = document.getElementById("analyzing-card-article-title");
const DEFAULT_ANALYSIS_CARD_ICON = "../icons/world_icon.png";

const summaryList = document.getElementById("summary-section-list");
const biasExcerpt = document.getElementById("bias-section-excerpt");
const biasIndicatorsList = document.getElementById("bias-indicators-section-list");

const sourceNameEl = document.getElementById("source-section-name");
const sourceLookupLinkEl = document.getElementById("source-section-lookup-link");

// -- actions --
const copyBtn = document.getElementById("btn-actions-section-copy-summary");
const seeContextBtn = document.getElementById("btn-actions-section-see-context");
const settingsBtn = document.getElementById("btn-actions-section-settings");
const contextLinksSection = document.getElementById("context-links-section");
const contextLinksList = document.getElementById("context-links-list");
const contextLinksFullViewEl = document.getElementById("context-links-full-view");

// ========== PAGE TOGGLES ==========
function showStartPage() {
    if (pageStart) pageStart.classList.add("page--active");
    if (pageResults) pageResults.classList.remove("page--active");
    Logger.info("Showing start page");
}

function showResultsPage() {
    if (pageResults) pageResults.classList.add("page--active");
    if (pageStart) pageStart.classList.remove("page--active");
    Logger.info("Showing results page");
}

function setStartPageStatus(message = "", tone = "info") {
    if (!startPageStatusEl || !startPageStatusCardEl) return;

    if (!message) {
        startPageStatusEl.textContent = "";
        startPageStatusCardEl.classList.add("hidden");
        startPageStatusCardEl.classList.remove(
            "start-page-status-card--info",
            "start-page-status-card--warning",
            "start-page-status-card--error"
        );
        return;
    }

    startPageStatusEl.textContent = message;
    startPageStatusCardEl.classList.remove("hidden");
    startPageStatusCardEl.classList.remove(
        "start-page-status-card--info",
        "start-page-status-card--warning",
        "start-page-status-card--error"
    );
    startPageStatusCardEl.classList.add(`start-page-status-card--${tone}`);

    if (startPageStatusAccentEl) {
        startPageStatusAccentEl.textContent = tone === "error" ? "!" : tone === "warning" ? "?" : "i";
    }
}

function recoverFromAnalysisError(message) {
    cancelPendingAnalysisRun();
    isAnalysisInProgress = false;
    showStartPage();
    syncAnalyzeButtonState();
    setStartPageStatus(message || "Subtext could not analyze this page. Try again.", "error");
    Logger.error("Recovered panel from analysis error", { message: message || "Unknown error" });
}

let currentContext = {
    tabId: null,
    url: ""
};

let currentResult = null;

// ========== LOADING TIMELINE (4 steps, min 1s each) ==========
let currentRunId = 0;
let minUiDone = false;
let analysisDone = false;
let pendingResult = null;

const LOADING_STEPS = [
    { label: "Reading article...", pct: 25 },
    { label: "Analyzing content...", pct: 50 },
    { label: "Generating summary...", pct: 75 },
    { label: "Complete", pct: 100 }
];

function cancelPendingAnalysisRun() {
    // Bump the run id so any in-flight loading animation exits without finalizing stale results.
    currentRunId++;
    minUiDone = false;
    analysisDone = false;
    pendingResult = null;
}

function setLoadingVisible() {
    isAnalysisInProgress = true;
    syncAnalyzeButtonState();
    setSummaryProgress(0, "");
    setStartPageStatus("");
    
    showResultsPage();
    renderSummary([]);
    renderBiasExcerpt("");
    renderBiasIndicators([]);

    if (summaryLoading) summaryLoading.classList.remove("hidden");
    if (summaryContent) summaryContent.classList.add("hidden");
    if (biasLoading) biasLoading.classList.remove("hidden");
    if (biasContent) biasContent.classList.add("hidden");
    if (biasIndicatorsLoading) biasIndicatorsLoading.classList.remove("hidden");
    if (biasIndicatorsContent) biasIndicatorsContent.classList.add("hidden");
    if (sourceLoading) sourceLoading.classList.remove("hidden");
    if (sourceContent) sourceContent.classList.add("hidden");
    if (contextLinksSection) contextLinksSection.classList.add("hidden");

    Logger.info('Show loading page and elements');
}

function setResultsVisible() {
    isAnalysisInProgress = false;
    showResultsPage();

    if (summaryContent) summaryContent.classList.remove("hidden");
    if (summaryLoading) summaryLoading.classList.add("hidden");
    if (biasContent) biasContent.classList.remove("hidden");
    if (biasLoading) biasLoading.classList.add("hidden");
    if (biasIndicatorsContent) biasIndicatorsContent.classList.remove("hidden");
    if (biasIndicatorsLoading) biasIndicatorsLoading.classList.add("hidden");
    if (sourceContent) sourceContent.classList.remove("hidden");
    if (sourceLoading) sourceLoading.classList.add("hidden");

    syncAnalyzeButtonState();
    Logger.info('Show results page and elements');

}

function clearRenderedResults() {
    renderAnalysisCard({});
    renderSummary([]);
    renderBiasExcerpt("");
    renderBiasIndicators([]);
    renderSourceAnalysis({ name: "" });
    currentResult = null;
    if (contextLinksSection) contextLinksSection.classList.add("hidden");
    const ctxLabelEl = seeContextBtn?.querySelector(".actions-section-primary-label");
    const ctxDescEl = seeContextBtn?.querySelector(".actions-section-primary-desc");
    if (ctxLabelEl) ctxLabelEl.textContent = "See More Context";
    if (ctxDescEl) ctxDescEl.textContent = "Fact-checks, coverage & source research";
}

function renderDetectedPageState(data = {}) {
    const detectionConfidence = data.detectionConfidence || (data.isArticle ? "high" : "low");
    const isArticle = detectionConfidence !== "low";
    const isUncertainArticle = detectionConfidence === "medium";
    isCurrentPageArticle = isArticle;

    if (detectedTopIconEl) {
        detectedTopIconEl.classList.remove(
            "detected-top-icon--article",
            "detected-top-icon--possible",
            "detected-top-icon--empty"
        );
        detectedTopIconEl.classList.add(
            isArticle
                ? (isUncertainArticle ? "detected-top-icon--possible" : "detected-top-icon--article")
                : "detected-top-icon--empty"
        );
    }

    if (detectedTopTitleEl) {
        detectedTopTitleEl.textContent = isArticle
            ? (isUncertainArticle ? "Possible Article Detected" : "Article Detected")
            : "No Article Detected";
    }

    if (detectedTopTextEl) {
        detectedTopTextEl.textContent = isArticle
            ? (isUncertainArticle
                ? "This page might be a standalone article. You can analyze it, but the detection signal is weaker than usual."
                : "Subtext has detected a news article. Analyze to get a plain-language summary, see loaded language signals, and find fact-checks and more context.")
            : "This page does not look like a standalone article yet. Open an article page to analyze it with Subtext.";
    }

    if (detectedCardLabelEl) {
        detectedCardLabelEl.textContent = isArticle
            ? (isUncertainArticle ? "POSSIBLE ARTICLE" : "DETECTED ARTICLE")
            : "PAGE PREVIEW";
    }

    if (analyzeBtn) {
        analyzeBtn.textContent = "Analyze Article";
    }

    syncAnalyzeButtonState();
}

function setCurrentContext(tabId, url) {
    currentContext = {
        tabId: tabId ?? null,
        url: url || ""
    };
}

function matchesCurrentContext(tabId, url) {
    return currentContext.tabId === (tabId ?? null) && currentContext.url === (url || "");
}

function applyPageState(payload = {}) {
    const article = payload.article || {};
    const tabId = payload.tabId ?? null;
    const articleUrl = article.url || "";

    cancelPendingAnalysisRun();
    setCurrentContext(tabId, articleUrl);
    renderDetectedPageState(article);
    renderDetectedArticle(article);

    if (payload.mode === "results" && payload.result) {
        applyResultToUI(payload.result);
        return;
    }

    clearRenderedResults();
    showStartPage();
    const detectionConfidence = article.detectionConfidence || (article.isArticle ? "high" : "low");
    const statusTone = detectionConfidence === "medium" ? "warning" : "info";
    setStartPageStatus(payload.statusMessage || "", statusTone);
}

function applyResultToUI(res) {
    if (titleEl) titleEl.textContent = res.title || "Untitled article";
    if (sourceEl) sourceEl.textContent = res.source || "Unknown source";
    if (linkEl) {
        linkEl.textContent = res.url || "No article link available";
        linkEl.href = res.url || "#";
    }

    renderAnalysisCard({ title: res.title, source: res.source, url: res.url });
    renderSummary(res.bulletPoints);
    renderBiasExcerpt(res.excerpt, res.excerptHtml || "");
    renderBiasIndicators(res.indicators);
    renderSourceAnalysis(res.sourceInfo);
    currentResult = res;

    setResultsVisible();
    Logger.info('Applied results to UI');
}

function setSummaryProgress(pct, label) {
    const clamped = Math.max(0, Math.min(100, pct));
    if (summaryLoadingBarFill) summaryLoadingBarFill.style.width = `${clamped.toFixed(2)}%`;
    if (summaryLoadingBar) summaryLoadingBar.setAttribute("aria-valuenow", String(clamped));
    if (summaryPctLabel) summaryPctLabel.textContent = `${Math.round(clamped)}%`;
    if (summaryLabel) summaryLabel.textContent = label || "";
}

function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runMinimumLoadingTimeline(runId) {
    minUiDone = false;

    setSummaryProgress(0, "");
    await nextFrame();

    let lastPct = 0;

    for (let i = 0; i < LOADING_STEPS.length; i++) {
        if (runId !== currentRunId) return;

        const step = LOADING_STEPS[i];
        const fromPct = lastPct;
        const toPct = step.pct;

        Logger.info("Loading step updated", { label: step.label, pct: step.pct, runId });

        const start = performance.now();
        const duration = 500;

        while (true) {
            if (runId !== currentRunId) return;

            const elapsed = performance.now() - start;
            const t = Math.min(1, elapsed / duration);

            const pct = fromPct + (toPct - fromPct) * t;
            setSummaryProgress(pct, step.label);

            if (t >= 1) break;
            await nextFrame();
        }

        await sleep(750);
        lastPct = toPct;
    }

    if (runId !== currentRunId) return;
    minUiDone = true;
    maybeFinalizeRun(runId);
}

function maybeFinalizeRun(runId) {
    if (runId !== currentRunId) return;
    if (!minUiDone) return;
    if (!analysisDone) return;
    if (!pendingResult) return;

    applyResultToUI(pendingResult);
    pendingResult = null;
    analysisDone = false;
}

// ========== RENDER HELPERS ==========
function renderDetectedArticle(data = {}) {
    const { title, source, url } = data;
    const detectionConfidence = data.detectionConfidence || (data.isArticle ? "high" : "low");
    const isArticle = detectionConfidence !== "low";

    const defaultTitle = isArticle ? "Retrieving title..." : "No standalone article found";
    const defaultSource = isArticle ? "Retrieving source..." : "Open an article page to continue";
    const defaultUrl = isArticle ? "Retrieving link..." : (url || "Current page");

    if (detectedTitleEl) detectedTitleEl.textContent = title || defaultTitle;
    if (detectedSourceEl) detectedSourceEl.textContent = source || defaultSource;
    if (detectedUrlEl) {
        detectedUrlEl.textContent = url || defaultUrl;
        detectedUrlEl.href = url || "#";
    }

    if (titleEl) titleEl.textContent = title || "";
    if (sourceEl) sourceEl.textContent = source || "";
    if (linkEl) {
        linkEl.textContent = url || "";
        linkEl.href = url || "#";
    }

    Logger.info("Detected article info updated", {
        hasTitle: Boolean(title),
        source: source || "Unknown"
    });
}

function renderAnalysisCard(data = {}) {
    const { title, source, url } = data;

    if (analyzingArticleTitle) { 
        analyzingArticleTitle.textContent = title || 'Loading...'; 
    }
    if (analyzingCardLabel) { 
        analyzingCardLabel.textContent = source || "Analyzing full article"; 
    }
    if (analyzingCardImg) {
        const sourceIcon = url ? faviconURL(url) : DEFAULT_ANALYSIS_CARD_ICON;
        analyzingCardImg.src = sourceIcon || DEFAULT_ANALYSIS_CARD_ICON;
    }
}

function renderSummary(bulletPoints) {
    if (!summaryList) return;
    summaryList.innerHTML = "";

    if (!Array.isArray(bulletPoints) || !bulletPoints.length) {
        const li = document.createElement("li");
        li.textContent = "No key points.";
        summaryList.appendChild(li);
        return;
    }

    bulletPoints.forEach(pt => {
        if (!pt) return;
        const li = document.createElement("li");
        li.textContent = pt;
        summaryList.appendChild(li);
    });
}

function renderBiasExcerpt(text, html) {
    if (!biasExcerpt) return;

    if (html) {
        biasExcerpt.innerHTML = html;
        return;
    }
    
    if (!text) {
        biasExcerpt.textContent = "No excerpt available for this article.";
        return;
    }
    biasExcerpt.textContent = text;
}

function renderBiasIndicators(indicators) {
    if (!biasIndicatorsList) return;
    biasIndicatorsList.innerHTML = "";

    if (!Array.isArray(indicators) || !indicators.length) {
        const p = document.createElement("p");
        p.textContent = "No strong language signals were found.";
        p.style.fontSize = "0.7rem";
        p.style.color = "rgba(15,23,42,0.6)";
        biasIndicatorsList.appendChild(p);
        return;
    }

    indicators.forEach(item => {
        if (!item) return;
        
        const card = document.createElement("article");
        card.className = "bias-indicators-section-card";
        card.classList.add("bias-indicators-section-card--loaded");

        const phrase = document.createElement("p");
        phrase.className = "bias-indicators-section-card-phrase";
        phrase.textContent = `"${item.phrase}"`;

        const text = document.createElement("p");
        text.className = "bias-indicators-section-card-text";
        text.textContent = item.reason || "Bias-indicative phrase";

        const searchLink = document.createElement("a");
        searchLink.className = "bias-indicators-section-card-search";
        searchLink.href = `https://www.google.com/search?q=${encodeURIComponent('"' + item.phrase + '"')}`;
        searchLink.target = "_blank";
        searchLink.rel = "noopener noreferrer";
        searchLink.textContent = "Search this phrase \u2192";

        card.appendChild(phrase);
        card.appendChild(text);
        card.appendChild(searchLink);
        biasIndicatorsList.appendChild(card);
    });
}

function renderSourceAnalysis(info) {
    if (!info) return;
    if (sourceNameEl) sourceNameEl.textContent = info.name || "Unknown source";

    if (sourceLookupLinkEl) {
        const outletName = info.name || "";
        const query = encodeURIComponent(outletName ? `${outletName} AllSides` : "AllSides media bias ratings");
        sourceLookupLinkEl.textContent = outletName
            ? `Look up "${outletName}" on AllSides \u2192`
            : "Look up this outlet on AllSides \u2192";
        sourceLookupLinkEl.href = `https://www.allsides.com/search?search=${query}`;
    }

}

function buildContextPageUrl(res) {
    const pageUrl = chrome.runtime.getURL("context/context.html");
    const url = new URL(pageUrl);
    if (res.title) url.searchParams.set("title", res.title);
    if (res.url) url.searchParams.set("url", res.url);
    if (res.source) url.searchParams.set("source", res.source);
    return url.toString();
}

function renderContextLinks(res) {
    if (!contextLinksList) return;
    contextLinksList.innerHTML = "";

    const title = res.title || "";
    const url = res.url || "";
    const source = res.source || "";

    const links = [];

    if (title) {
        links.push({
            label: "More coverage",
            desc: "Google News",
            href: `https://news.google.com/search?q=${encodeURIComponent(title)}`
        });
        links.push({
            label: "Search for fact checks",
            desc: "Google",
            href: `https://www.google.com/search?q=${encodeURIComponent(title + " fact check")}`
        });
    }

    if (url) {
        let urlDesc = source;
        if (!urlDesc) {
            try { urlDesc = new URL(url).hostname; } catch { urlDesc = url; }
        }
        links.push({
            label: "Open original article",
            desc: urlDesc,
            href: url
        });
    }

    if (source) {
        links.push({
            label: `${source} on AllSides`,
            desc: "Media bias ratings",
            href: `https://www.allsides.com/search?search=${encodeURIComponent(source)}`
        });
        links.push({
            label: `${source} background`,
            desc: "Wikipedia",
            href: `https://www.google.com/search?q=${encodeURIComponent(source + " site:wikipedia.org")}`
        });
    }

    links.forEach(link => {
        const a = document.createElement("a");
        a.className = "context-link-row";
        a.href = link.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";

        const labelSpan = document.createElement("span");
        labelSpan.className = "context-link-label";
        labelSpan.textContent = link.label;

        const descSpan = document.createElement("span");
        descSpan.className = "context-link-desc";
        descSpan.textContent = link.desc;

        a.appendChild(labelSpan);
        a.appendChild(descSpan);
        contextLinksList.appendChild(a);
    });

    if (contextLinksFullViewEl) {
        contextLinksFullViewEl.href = buildContextPageUrl(res);
    }
}

// ========== HELPERS ==========
function faviconURL(u) {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", u);
    url.searchParams.set("size", "32");
    return url.toString();
}

// ========== BUTTON EVENTS ==========
analyzeBtn?.addEventListener("click", async () => {
    Logger.info("Analyze button clicked");
    setLoadingVisible();

    currentRunId++;
    const runId = currentRunId;

    minUiDone = false;
    analysisDone = false;
    pendingResult = null;

    runMinimumLoadingTimeline(runId);
    await nextFrame();

    const didSend = sendPanelMessage({
        type: "SUBTEXT_START_ANALYSIS",
        payload: {
            windowId: panelWindowId,
            tabId: currentContext.tabId,
            url: currentContext.url
        }
    });

    if (!didSend) {
        recoverFromAnalysisError("Subtext lost its connection to the background service. Try again in a moment.");
    }
});

copyBtn?.addEventListener("click", async () => {
    if (!summaryList) return;
    const items = Array.from(summaryList.querySelectorAll("li"))
        .map(li => li.textContent.trim())
        .filter(Boolean);

    const text = items.map(i => `• ${i}`).join("\n");

    try {
        await navigator.clipboard.writeText(text);
        Logger.info("Summary copied to clipboard", { itemCount: items.length });
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
        copyBtn.innerHTML =
            '<span class="actions-section-secondary-icon" aria-hidden="true">📋</span><span>Copy Summary</span>';
        }, 1200);
    } catch (err) {
        Logger.error("Failed to copy summary", { error: String(err) });
    }
});

seeContextBtn?.addEventListener("click", () => {
    if (!contextLinksSection || !currentResult) {
        Logger.info("Opening more context view (fallback)");
        sendPanelMessage({ type: "SUBTEXT_OPEN_CONTEXT" });
        return;
    }
    const isOpen = !contextLinksSection.classList.contains("hidden");
    const labelEl = seeContextBtn.querySelector(".actions-section-primary-label");
    const descEl = seeContextBtn.querySelector(".actions-section-primary-desc");
    if (isOpen) {
        contextLinksSection.classList.add("hidden");
        if (labelEl) labelEl.textContent = "See More Context";
        if (descEl) descEl.textContent = "Fact-checks, coverage & source research";
        Logger.info("Collapsed context links section");
    } else {
        renderContextLinks(currentResult);
        contextLinksSection.classList.remove("hidden");
        contextLinksSection.scrollIntoView({ behavior: "smooth", block: "nearest" });
        if (labelEl) labelEl.textContent = "Hide Context";
        if (descEl) descEl.textContent = "Collapse context links";
        Logger.info("Expanded context links section");
    }
});

settingsBtn?.addEventListener("click", () => {
    Logger.info("Opening settings from actions");
    openSettings();
});

Logger.info("Side panel initialized");

(async () => {
    try {
        const currentWindow = await chrome.windows.getCurrent();
        panelWindowId = currentWindow?.id ?? null;

        if (typeof panelWindowId !== "number") {
            Logger.error("Failed to initialize side panel session", {
                reason: "missing-window-id"
            });
            return;
        }

        connectPanelPort();
    } catch (error) {
        Logger.error("Failed to initialize side panel session", {
            error: String(error)
        });
    }
})();

