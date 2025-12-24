// sidepanel.js

// ========== PAGE ELEMENTS ==========
const pageStart = document.getElementById("start-page");
const pageResults = document.getElementById("results-page");

// -- Page 1 : Start Page --
const apiWarningCard = document.getElementById("api-warning-card");
const openSettingsBtn = document.getElementById("btn-api-warning-card-open-settings");
const detectedTitleEl = document.getElementById("detected-article-card-title");
const detectedSourceEl = document.getElementById("detected-article-card-source");
const detectedUrlEl = document.getElementById("detected-article-card-url");
const analyzeBtn = document.getElementById("btn-start-analyze");

// -- Page 2 : Results Page --
const titleEl = document.getElementById("article-header-title");
const sourceEl = document.getElementById("article-header-source");
const linkEl = document.getElementById("article-header-link");
const analyzingCard = document.getElementById("analyzing-card");
const analyzingArticleTitle = document.getElementById("analyzing-card-article-title");

const summaryList = document.getElementById("summary-section-list");
const biasExcerpt = document.getElementById("bias-section-excerpt");
const biasIndicatorsList = document.getElementById("bias-indicators-section-list");

const sourceNameEl = document.getElementById("source-section-name");
const sourcePillEl = document.getElementById("source-section-bias-pill");
const sourceCredEl = document.getElementById("source-section-credibility");
const sourceProviderEl = document.getElementById("source-section-provider");

// -- actions --
const copyBtn = document.getElementById("btn-actions-section-copy-summary");
const seeContextBtn = document.getElementById("btn-actions-section-see-context");
const settingsBtn = document.getElementById("btn-actions-section-settings");
const closeBtn = document.getElementById("btn-close-panel-header");

// ========== PAGE TOGGLES ==========
function showStartPage() {
    if (pageStart) pageStart.classList.add("page--active");
    if (pageResults) pageResults.classList.remove("page--active");
}

function showResultsPage() {
    if (pageResults) pageResults.classList.add("page--active");
    if (pageStart) pageStart.classList.remove("page--active");
}

// ========== RENDER HELPERS ==========
function renderDetectedArticle(data = {}) {
    const { title, source, url } = data;

    if (detectedTitleEl && title) detectedTitleEl.textContent = title;
    if (detectedSourceEl && source) detectedSourceEl.textContent = source;
    if (detectedUrlEl && url) {
        detectedUrlEl.textContent = url;
        detectedUrlEl.href = url;
    }

    if (titleEl && title) titleEl.textContent = title;
    if (sourceEl && source) sourceEl.textContent = source;
    if (linkEl && url) {
        linkEl.textContent = url;
        linkEl.href = url;
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

function renderBiasExcerpt(html) {
    if (!biasExcerpt) return;
    if (!html) {
        biasExcerpt.textContent = "No excerpt available for this article.";
        return;
    }
    biasExcerpt.innerHTML = html;
}

function renderBiasIndicators(indicators) {
    if (!biasIndicatorsList) return;
    biasIndicatorsList.innerHTML = "";

    if (!Array.isArray(indicators) || !indicators.length) {
        const p = document.createElement("p");
        p.textContent = "No explicit bias indicators found.";
        p.style.fontSize = "0.7rem";
        p.style.color = "rgba(15,23,42,0.6)";
        biasIndicatorsList.appendChild(p);
        return;
    }

    indicators.forEach(item => {
        if (!item) return;
        
        const card = document.createElement("article");
        card.className = "bias-indicators-section-card";
        const bias = (item.bias || "loaded").toLowerCase();
        if (bias === "left") card.classList.add("bias-indicators-section-card--left");
        else if (bias === "right") card.classList.add("bias-indicators-section-card--right");
        else card.classList.add("bias-indicators-section-card--loaded");

        const phrase = document.createElement("p");
        phrase.className = "bias-indicators-section-card-phrase";
        phrase.textContent = `"${item.phrase}"`;

        const text = document.createElement("p");
        text.className = "bias-indicators-section-card-text";
        text.textContent = item.reason || item.explanation || "Bias-indicative phrase";

        card.appendChild(phrase);
        card.appendChild(text);
        biasIndicatorsList.appendChild(card);
    });
}

function renderSourceAnalysis(info) {
    if (!info) return;
    if (sourceNameEl && info.name) sourceNameEl.textContent = info.name;

    if (sourcePillEl) {
        sourcePillEl.className = "source-section-bias-pill";
        if (info.bias) {
            sourcePillEl.textContent = info.bias;
            const lower = info.bias.toLowerCase();
            if (lower.includes("left")) {
                sourcePillEl.classList.add("source-section-bias-pill--left");
            } else if (lower.includes("right")) {
                sourcePillEl.classList.add("source-section-bias-pill--right");
            } else {
                sourcePillEl.style.background = "var(--color-gray-100, #eef2f7)";
                sourcePillEl.style.color = "var(--color-gray-700, #334155)";
            }
        } else {
            sourcePillEl.textContent = "Unknown";
        }
    }

    if (sourceCredEl && info.credibility) {
        sourceCredEl.textContent = `Credibility: ${info.credibility}`;
    }

    if (sourceProviderEl) {
        sourceProviderEl.textContent = info.provider ? `via ${info.provider}` : "";
    }
}

function startAnalyzingUi() {
    showResultsPage();
    if (analyzingCard) {
        analyzingCard.style.removeProperty("display")
    }
    renderSummary([]);
    renderBiasExcerpt("");
    renderBiasIndicators([]);
}

// ========== BUTTON EVENTS ==========
analyzeBtn?.addEventListener("click", () => {
    startAnalyzingUi();

    chrome.runtime.sendMessage({ type: "SUBTEXT_START_ANALYSIS" });
});

openSettingsBtn?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SUBTEXT_OPEN_SETTINGS" });
});

copyBtn?.addEventListener("click", async () => {
    if (!summaryList) return;
    const items = Array.from(summaryList.querySelectorAll("li"))
        .map(li => li.textContent.trim())
        .filter(Boolean);

    const text = items.map(i => `• ${i}`).join("\n");

    try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
        copyBtn.innerHTML =
            '<span class="actions-section-secondary-icon" aria-hidden="true">📋</span><span>Copy Summary</span>';
        }, 1200);
    } catch (err) {
        console.warn("Clipboard failed", err);
    }
});

seeContextBtn?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SUBTEXT_OPEN_CONTEXT" });
});

settingsBtn?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SUBTEXT_OPEN_SETTINGS" });
});

closeBtn?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "SUBTEXT_CLOSE_PANEL" });
})

// ========== MESSAGE HANDLER ==========
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SUBTEXT_DETECTED_ARTICLE") {
        renderDetectedArticle(msg.payload || {});
    }

    if (msg.type === "SUBTEXT_HAS_API_KEY") {
        if (apiWarningCard) {
            apiWarningCard.style.display = msg.payload?.hasKey ? "none" : "block";
        }
    }

    if (msg.type === "SUBTEXT_RESULT") {
        const res = msg.payload || {};

        if (titleEl && res.title) titleEl.textContent = res.title;
        if (sourceEl && res.source) sourceEl.textContent = res.source;
        if (linkEl && res.url) {
            linkEl.textContent = res.url;
            linkEl.href = res.url;
        }

        if (analyzingArticleTitle) {
            analyzingArticleTitle.textContent = res.title || 'Loading...';
        }
        renderSummary(res.bulletPoints);
        renderBiasExcerpt(res.biasExcerptHtml);
        renderBiasIndicators(res.indicators);
        renderSourceAnalysis(res.sourceInfo);

        showResultsPage();
    }
});

chrome.runtime.sendMessage({ type: "SUBTEXT_CHECK_API_KEY" });
