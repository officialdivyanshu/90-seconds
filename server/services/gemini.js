/**
 * 90SECONDS — Gemini coaching.
 *
 * Architectural rule (PROJECT-NOTES.md §6): the model never counts
 * anything. It receives numbers already computed in metrics.js and its
 * only job is to explain what they mean and name one thing to fix.
 *
 * Rate limiting matters here: the free tier is ~30 requests/minute, so
 * calls are serialised through a small queue rather than fired in
 * parallel. Under a spike users wait slightly longer; nobody sees a 429.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
const ENDPOINT = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

const MIN_GAP_MS = Number(process.env.GEMINI_MIN_GAP_MS) || 2200; // ~27 req/min
const MAX_RETRIES = 3;

let lastCall = 0;
let chain = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(topic, transcript, metrics, history) {
  const fillerList = Object.entries(metrics.fillers || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w, c]) => `"${w}" x${c}`)
    .join(', ') || 'none';

  const past = history && history.length
    ? `\nPrevious sessions (most recent first):\n` +
      history.slice(0, 5).map((h, i) =>
        `${i + 1}. ${h.fillerCount} fillers, ${h.wpm} wpm, ${h.restarts} restarts` +
        (h.adviceGiven ? ` — advice given: "${h.adviceGiven}"` : '')
      ).join('\n') +
      `\nDo not repeat advice already given. If something has improved, say so.`
    : '';

  return `You are a speaking coach reviewing one 90-second impromptu answer.

TOPIC GIVEN: ${topic || '(unknown)'}

MEASURED (computed in code — treat as fact, never recount):
- words spoken: ${metrics.wordCount}
- filler words: ${metrics.fillerCount} (${metrics.fillerRate}% of words) — ${fillerList}
- pace: ${metrics.wpm} words per minute
- longest pause: ${metrics.longestPauseSec}s (${metrics.pauseCount} pauses over 0.6s)
- silence before first word: ${metrics.timeToFirstWordSec}s
- restarted sentences: ${metrics.restarts}
- time used: ${metrics.usedSec}s of ${metrics.allowedSec}s
${past}

TRANSCRIPT:
"""
${(transcript || '').slice(0, 4000)}
"""

Judge whether they actually answered the topic. Be specific and quote
their own words where it helps. Be direct but not unkind — this person
is practising something difficult on camera.

Return ONLY valid JSON, no markdown fences:
{
  "onTopic": true or false,
  "onTopicNote": "one sentence on how well they addressed the topic",
  "observation": "the single most useful thing you noticed, 1-2 sentences",
  "cause": "why it is happening, 1 sentence",
  "actionItem": "one concrete thing to do differently next round, 1 sentence",
  "strength": "one thing that genuinely worked, 1 sentence"
}`;
}

async function callGemini(prompt, apiKey) {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 500,      // a runaway response cannot drain the quota
      responseMimeType: 'application/json'
    }
  });

  /* Google is migrating from standard keys (AIza...) to auth keys (AQ...).
     Auth keys authenticate via a bearer header; standard keys via the
     ?key= query param. Try the header first, fall back on 401/403.
     Never validate the key's shape — the provider can rebrand it. */
  const attempts = [
    {
      url: ENDPOINT(MODEL),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'x-goog-api-key': apiKey
      }
    },
    {
      url: `${ENDPOINT(MODEL)}?key=${encodeURIComponent(apiKey)}`,
      headers: { 'Content-Type': 'application/json' }
    }
  ];

  let lastErr;
  for (const { url, headers } of attempts) {
    const res = await fetch(url, { method: 'POST', headers, body });

    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Empty response from Gemini');
      return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
    }

    const errBody = await res.text();
    lastErr = new Error(`Gemini ${res.status}: ${errBody.slice(0, 250)}`);
    lastErr.status = res.status;

    // Only an auth failure is worth retrying with the other scheme.
    if (res.status !== 401 && res.status !== 403) throw lastErr;
  }

  throw lastErr;
}

/**
 * Serialised, rate-limited, retried call.
 * @returns {Promise<object|null>} coaching object, or null if unavailable
 */
function getCoaching({ topic, transcript, metrics, history }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'your_key_here') {
    return Promise.resolve(null);   // no key: app still works, just no AI note
  }

  const task = async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const prompt = buildPrompt(topic, transcript, metrics, history);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callGemini(prompt, apiKey);
      } catch (e) {
        const retryable = e.status === 429 || e.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) throw e;
        // Exponential backoff with jitter — immediate retries make a
        // rate limit worse, not better.
        const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
        console.warn(`Gemini ${e.status}, retrying in ${Math.round(backoff)}ms`);
        await sleep(backoff);
        lastCall = Date.now();
      }
    }
  };

  chain = chain.then(task, task);
  return chain;
}

module.exports = { getCoaching, buildPrompt };
