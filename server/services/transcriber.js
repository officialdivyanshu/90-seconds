/**
 * 90SECONDS — Groq transcription.
 *
 * Replaces the local faster-whisper worker (server/transcribe.py — left on
 * disk as a documented fallback, no longer on the active path) with Groq's
 * hosted Whisper endpoint. Returns the exact same shape the Python worker
 * used to, so metrics/grading/Gemini downstream need no changes.
 */

const fs = require('fs');
const path = require('path');

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mimeFor(filePath) {
  return path.extname(filePath).toLowerCase() === '.mp4' ? 'video/mp4' : 'video/webm';
}

async function callGroq(filePath, apiKey) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeFor(filePath) }), path.basename(filePath));
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: form
  });

  if (res.ok) return res.json();

  const errBody = await res.text();
  const err = new Error(`Groq ${res.status}: ${errBody.slice(0, 250)}`);
  err.status = res.status;
  throw err;
}

/**
 * @param {string} filePath
 * @returns {Promise<{ok: boolean, text?: string, durationSec?: number, language?: string, words?: {w: string, start: number, end: number}[], error?: string}>}
 */
async function transcribe(filePath) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'GROQ_API_KEY is not set' };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await callGroq(filePath, apiKey);

      const words = (data.words || [])
        .map((w) => ({
          w: (w.word || '').trim(),
          start: Math.round(w.start * 1000) / 1000,
          end: Math.round(w.end * 1000) / 1000
        }))
        .filter((w) => w.w);

      return {
        ok: true,
        text: (data.text || '').trim(),
        durationSec: Math.round((data.duration || 0) * 100) / 100,
        language: data.language,
        words
      };
    } catch (e) {
      const retryable = e.status === 429 || e.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        return { ok: false, error: e.message };
      }
      // Exponential backoff with jitter, same pattern as services/gemini.js.
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.warn(`Groq ${e.status}, retrying in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
}

module.exports = { transcribe };
