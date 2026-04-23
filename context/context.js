function getParams() {
    const params = new URLSearchParams(window.location.search);
    return {
        title: params.get("title") || "",
        url: params.get("url") || "",
        source: params.get("source") || ""
    };
}

function safeUrl(url) {
    try {
        return new URL(url);
    } catch {
        return null;
    }
}

function buildSearchUrl(query, baseUrl = "https://www.google.com/search?q=") {
    return `${baseUrl}${encodeURIComponent(query)}`;
}

function buildResources(article) {
    const resources = [];
    const articleUrl = safeUrl(article.url);
    const titleQuery = article.title || article.url || article.source;
    const sourceQuery = article.source || articleUrl?.hostname || "";

    if (article.url) {
        resources.push({
            title: "Open original article",
            description: "Jump back to the source page Subtext analyzed.",
            primaryLabel: "Open article",
            primaryUrl: article.url,
            secondaryLabel: articleUrl ? "Open source homepage" : "",
            secondaryUrl: articleUrl ? `${articleUrl.origin}/` : ""
        });
    }

    if (titleQuery) {
        resources.push({
            title: "Search recent coverage",
            description: "Look for additional reporting on the same topic in Google News.",
            primaryLabel: "Search Google News",
            primaryUrl: buildSearchUrl(titleQuery, "https://news.google.com/search?q="),
            secondaryLabel: "Search the web",
            secondaryUrl: buildSearchUrl(`${titleQuery} ${sourceQuery}`.trim())
        });

        resources.push({
            title: "Look for fact checks",
            description: "Search for fact-check coverage tied to the same claim or headline.",
            primaryLabel: "Search fact checks",
            primaryUrl: buildSearchUrl(`${titleQuery} fact check`),
            secondaryLabel: "Search quote matches",
            secondaryUrl: buildSearchUrl(`"${titleQuery}"`)
        });
    }

    if (sourceQuery) {
        resources.push({
            title: "Research the source",
            description: "Review background information and additional reporting from the outlet.",
            primaryLabel: "Search source background",
            primaryUrl: buildSearchUrl(`${sourceQuery} media bias credibility`),
            secondaryLabel: "Search Wikipedia",
            secondaryUrl: buildSearchUrl(`${sourceQuery} site:wikipedia.org`)
        });
    }

    return resources.filter(resource => resource.primaryUrl);
}

function renderCard(resource) {
    const article = document.createElement("article");
    article.className = "card";

    const title = document.createElement("h2");
    title.textContent = resource.title;

    const description = document.createElement("p");
    description.textContent = resource.description;

    const actions = document.createElement("div");
    actions.className = "actions";

    const primary = document.createElement("a");
    primary.className = "button";
    primary.href = resource.primaryUrl;
    primary.target = "_blank";
    primary.rel = "noreferrer";
    primary.textContent = resource.primaryLabel;
    actions.appendChild(primary);

    if (resource.secondaryUrl && resource.secondaryLabel) {
        const secondary = document.createElement("a");
        secondary.className = "button secondary";
        secondary.href = resource.secondaryUrl;
        secondary.target = "_blank";
        secondary.rel = "noreferrer";
        secondary.textContent = resource.secondaryLabel;
        actions.appendChild(secondary);
    }

    article.appendChild(title);
    article.appendChild(description);
    article.appendChild(actions);
    return article;
}

function renderPage(article) {
    const pageTitle = document.getElementById("page-title");
    const pageSummary = document.getElementById("page-summary");
    const urlPill = document.getElementById("article-url-pill");
    const sourcePill = document.getElementById("article-source-pill");
    const grid = document.getElementById("resource-grid");
    const emptyState = document.getElementById("empty-state");

    const resources = buildResources(article);

    if (!resources.length) {
        if (emptyState) emptyState.hidden = false;
        if (grid) grid.hidden = true;
        if (pageSummary) {
            pageSummary.textContent = "Subtext opens this page with article details after an analysis result is available.";
        }
        if (urlPill) urlPill.textContent = "No article URL";
        if (sourcePill) sourcePill.textContent = "No source";
        return;
    }

    if (pageTitle) {
        pageTitle.textContent = article.title || "More context for this article";
    }

    if (pageSummary) {
        pageSummary.textContent = "Use these links to compare coverage, check source background, and look for independent verification.";
    }

    if (urlPill) {
        urlPill.textContent = article.url || "No article URL";
    }

    if (sourcePill) {
        sourcePill.textContent = article.source || "Unknown source";
    }

    if (grid) {
        resources.forEach(resource => {
            grid.appendChild(renderCard(resource));
        });
    }
}

renderPage(getParams());