function extractText(d) {
  try {
    // 1) Convenience field (sometimes present)
    if (typeof d?.output_text === 'string' && d.output_text.trim()) {
      return d.output_text.trim();
    }

    // 2) Responses-style structure
    if (Array.isArray(d?.output)) {
      const parts = [];
      for (const item of d.output) {
        // content array with .text entries
        if (Array.isArray(item?.content)) {
          for (const c of item.content) {
            if (typeof c?.text === 'string') parts.push(c.text);
          }
        }
        // some responses put text directly on the item
        if (typeof item?.text === 'string') parts.push(item.text);
      }
      const joined = parts.join('\n').trim();
      if (joined) return joined;
    }

    // 3) Older chat-like shapes (defensive fallback)
    if (Array.isArray(d?.choices)) {
      const t = d.choices
        .map(ch => ch?.message?.content || ch?.text)
        .filter(Boolean)
        .join('\n')
        .trim();
      if (t) return t;
    }
  } catch (e) {}

  return '';
}

async function askOpenAI(prompt) {
    const { openai_api_key, openai_model } = await chrome.storage.local.get([
        'openai_api_key',
        'openai_model'
    ]);
    if (!openai_api_key) throw new Error('Missing API key. Add it in Options.');

    const resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openai_api_key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: openai_model || 'gpt-4o-mini',
            input: prompt,
            temperature: 0,
            max_output_tokens: 300
        })
    });

    if (!resp.ok) {
        if (resp.status === 401) throw new Error('Unauthorized: check your API key.');
        if (resp.status == 429) throw new Error('Rate limited: try again later.');
        const text = await resp.text();
        throw new Error(`OpenAI error ${resp.status}: ${text}`);
    }

    const data = await resp.json();
    const raw = extractText(data) || '(no text from model)';

    // Try to parse annotations from the model's JSON
    let annotations = [];
    try {
        annotations = JSON.parse(raw);
    } catch {}

    return { ok: true, text: raw, annotations };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'SUMMARIZE_AND_INTERPRET_ARTICLE' && msg?.article?.text) {
        const { text: article_text, title, length } = msg.article;
        const prompt = `Summarize and identify possible biases in this article:\n\n${article_text}`;

        askOpenAI(prompt)
            .then(res => sendResponse({ ...res, title }))
            .catch(err => sendResponse({ ok: false, error: err.message }));

        return true; // Keep the message channel open for async sendResponse.
    }

    if (msg?.type === 'DETECT_BIAS' && msg?.article?.text) {
        const { text: article_text, title, length } = msg.article;
        const prompt = `
You are a bias annotator. From the text below, extract words/phrases that suggest bias.
For each item include:
- phrase: the exact substring
- category: one of "left", "right", "loaded"
- reason: 1–2 sentences explaining why it's biased

Return ONLY compact JSON (no prose) as an array of objects like:
[{"phrase":"big government","category":"left","reason":"Typically critiqued by right-leaning rhetoric."},
 {"phrase":"tax cuts for the rich","category":"left","reason":"Framing suggesting wealth-targeted policy critique."},
 {"phrase":"radical agenda","category":"right","reason":"Emotionally charged label used in political attacks."},
 {"phrase":"disastrous","category":"loaded","reason":"Loaded adjective implying strong negative judgment."}]

Text:
${article_text}
`;

        askOpenAI(prompt)
            .then(res => sendResponse({ ...res, title }))
            .catch(err => sendResponse({ ok: false, error: err.message }));

        return true; // Keep the message channel open for async sendResponse.
    }
});