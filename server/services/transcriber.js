/**
 * 90SECONDS — Groq transcription.
 *
 * Replaces the local faster-whisper worker (server/transcribe.py — left on
 * disk as a documented fallback, no longer on the active path) with Groq's
 * hosted Whisper endpoint. Returns the exact same shape the Python worker
 * used to, so metrics/grading/Gemini downstream need no changes.
 *
 * The client now records and uploads audio separately from video (see
 * public/index.html), so the common case arrives as a sub-1MB audio/webm
 * file that Groq accepts directly — no ffmpeg needed. The video/* path is
 * kept only as a fallback (e.g. server/transcribe.py callers, or a client
 * that couldn't split streams): Groq caps uploads at ~25MB and only needs
 * the audio track, so a video is transcoded down to mono 16kHz/64kbps
 * audio first — Whisper downsamples to 16kHz internally anyway, so
 * anything higher is wasted bytes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegPath);

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
const MAX_RETRIES = 3;
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // Groq's limit is ~25MB; leave headroom

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => (bytes / 1048576).toFixed(1);

function transcodeToAudio(filePath) {
  const outPath = path.join(os.tmpdir(), `${crypto.randomUUID()}.mp3`);
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('64k')
      .audioCodec('libmp3lame')
      .format('mp3')
      .on('error', (err) => {
        fs.unlink(outPath, () => {});
        reject(err);
      })
      .on('end', () => resolve(outPath))
      .save(outPath);
  });
}

async function callGroq(audioPath, apiKey, contentType) {
  const buffer = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType }), path.basename(audioPath));
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
 * @param {string} [mimetype] The upload's original mimetype. audio/* skips
 *   the ffmpeg extraction step entirely; anything else (or omitted) is
 *   treated as video and transcoded first.
 * @returns {Promise<{ok: boolean, text?: string, durationSec?: number, language?: string, words?: {w: string, start: number, end: number}[], error?: string}>}
 */
async function transcribe(filePath, mimetype) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'GROQ_API_KEY is not set' };
  }

  const isAudio = (mimetype || '').startsWith('audio/');

  let audioPath = filePath;
  let contentType = mimetype || 'audio/webm';

  if (!isAudio) {
    try {
      audioPath = await transcodeToAudio(filePath);
      contentType = 'audio/mpeg';
    } catch (e) {
      return { ok: false, error: `Audio extraction failed: ${e.message}` };
    }
  }

  try {
    const audioBytes = fs.statSync(audioPath).size;
    if (isAudio) {
      console.log(`Audio upload: ${mb(audioBytes)}MB (no extraction needed)`);
    } else {
      console.log(`Audio extracted: ${mb(fs.statSync(filePath).size)}MB video → ${mb(audioBytes)}MB audio`);
    }

    if (audioBytes > MAX_AUDIO_BYTES) {
      return { ok: false, error: `Audio is ${mb(audioBytes)}MB, over Groq's 25MB upload limit` };
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callGroq(audioPath, apiKey, contentType);

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
  } finally {
    // Only the transcoded copy is a temp file we own; the original upload
    // is cleaned up on its own schedule by the upload-cleanup routine.
    if (!isAudio) fs.unlink(audioPath, () => {});
  }
}

module.exports = { transcribe };
