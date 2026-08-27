/**
 * Standalone Gemini API probe.
 * Tests both auth schemes and lists available models.
 * Run: node diag-gemini.js
 */
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) { console.error('GEMINI_API_KEY not set'); process.exit(1); }
console.log(`Key: ${API_KEY.slice(0, 3)}... (length ${API_KEY.length})\n`);

const MODEL    = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const BASE     = 'https://generativelanguage.googleapis.com/v1beta';
const GENERATE = `${BASE}/models/${MODEL}:generateContent`;

const BODY = JSON.stringify({
  contents: [{ parts: [{ text: 'Say "ok" and nothing else.' }] }],
  generationConfig: { maxOutputTokens: 10 }
});

async function probe(label, url, headers) {
  console.log(`--- ${label} ---`);
  console.log(`URL: ${url.replace(API_KEY, API_KEY.slice(0,3)+'...')}`);
  try {
    const r = await fetch(url, { method: 'POST', headers, body: BODY });
    const text = await r.text();
    console.log(`HTTP ${r.status}`);
    // Truncate long responses
    console.log(text.slice(0, 400));
  } catch (e) {
    console.log(`Fetch error: ${e.message}`);
  }
  console.log();
}

async function listModels(url) {
  console.log(`--- List models ---`);
  try {
    const r = await fetch(url);
    const data = await r.json();
    console.log(`HTTP ${r.status}`);
    if (data.models) {
      const gemini = data.models
        .filter(m => m.name.includes('gemini'))
        .map(m => `  ${m.name}  (${(m.supportedGenerationMethods||[]).join(', ')})`);
      console.log(gemini.join('\n') || '  (no gemini models)');
    } else {
      console.log(JSON.stringify(data).slice(0, 400));
    }
  } catch (e) {
    console.log(`Fetch error: ${e.message}`);
  }
  console.log();
}

(async () => {
  // Scheme 1: Bearer + x-goog-api-key header (new AQ. style)
  await probe(
    'Scheme 1: Bearer + x-goog-api-key header',
    GENERATE,
    { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}`, 'x-goog-api-key': API_KEY }
  );

  // Scheme 2: ?key= query param (classic AIza style)
  await probe(
    'Scheme 2: ?key= query param',
    `${GENERATE}?key=${encodeURIComponent(API_KEY)}`,
    { 'Content-Type': 'application/json' }
  );

  // List models via Bearer header
  await listModels(`${BASE}/models?key=${encodeURIComponent(API_KEY)}`);
})();
