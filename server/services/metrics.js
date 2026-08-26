/**
 * 90SECONDS — speech metrics.
 *
 * Architectural rule (PROJECT-NOTES.md §6): code counts, the model
 * explains. Everything here is arithmetic over Whisper's word timings.
 * A language model is never asked to count anything — models are bad at
 * counting and good at phrasing.
 */

// Single words that function as hesitation markers.
const FILLERS = new Set([
  'um', 'uh', 'erm', 'ah', 'eh', 'hmm', 'mm', 'mhm',
  'like', 'basically', 'actually', 'literally', 'obviously',
  'right', 'okay', 'so', 'well', 'anyway', 'whatever'
]);

// Multi-word fillers, matched against the normalised transcript.
const FILLER_PHRASES = [
  'you know', 'i mean', 'sort of', 'kind of', 'i guess',
  'or something', 'and stuff', 'and everything', 'or whatever'
];

// Words that commonly begin a restarted sentence.
const RESTART_STARTERS = new Set([
  'i', 'so', 'and', 'but', 'the', 'it', 'we', 'you', 'that', 'this', 'there'
]);

const norm = (w) => w.toLowerCase().replace(/[^a-z']/g, '');

/**
 * @param {{w:string,start:number,end:number}[]} words
 * @param {string} text
 * @param {number} durationSec  actual recorded length
 * @param {number} allowedSec   the window they were given (90)
 */
function computeMetrics(words, text, durationSec, allowedSec = 90) {
  const empty = {
    wordCount: 0, fillerCount: 0, fillerRate: 0, fillers: {},
    wpm: 0, longestPauseSec: 0, pauseCount: 0,
    timeToFirstWordSec: null, restarts: 0,
    usedSec: 0, allowedSec, usedPct: 0, speakingSec: 0
  };

  if (!Array.isArray(words) || words.length === 0) return empty;

  const clean = words.map(w => ({ ...w, n: norm(w.w) })).filter(w => w.n);
  if (!clean.length) return empty;

  /* ---- fillers ------------------------------------------------- */
  const fillers = {};
  let fillerCount = 0;

  for (const w of clean) {
    if (FILLERS.has(w.n)) {
      fillers[w.n] = (fillers[w.n] || 0) + 1;
      fillerCount++;
    }
  }

  const flat = clean.map(w => w.n).join(' ');
  for (const phrase of FILLER_PHRASES) {
    // Count non-overlapping occurrences.
    const matches = flat.split(phrase).length - 1;
    if (matches > 0) {
      fillers[phrase] = (fillers[phrase] || 0) + matches;
      fillerCount += matches;
      // "you know" already counted "know"? No — "know" is not in FILLERS.
      // But "so" and "like" inside phrases could double count; accepted
      // as a minor overcount rather than adding fragile de-duplication.
    }
  }

  /* ---- pace ---------------------------------------------------- */
  const firstStart = clean[0].start;
  const lastEnd = clean[clean.length - 1].end;
  const speakingSec = Math.max(lastEnd - firstStart, 0.001);
  const wordCount = clean.length;
  const wpm = Math.round((wordCount / speakingSec) * 60);

  /* ---- pauses -------------------------------------------------- */
  // A gap over 0.6s reads as a pause to a listener; under that it is
  // just the rhythm of normal speech.
  const PAUSE_THRESHOLD = 0.6;
  let longestPause = 0;
  let pauseCount = 0;

  for (let i = 1; i < clean.length; i++) {
    const gap = clean[i].start - clean[i - 1].end;
    if (gap > PAUSE_THRESHOLD) {
      pauseCount++;
      if (gap > longestPause) longestPause = gap;
    }
  }

  /* ---- restarts ------------------------------------------------ */
  // A restart looks like: pause, then a sentence-opening word that was
  // also used just before the pause. "I think — I think what matters..."
  let restarts = 0;
  for (let i = 1; i < clean.length; i++) {
    const gap = clean[i].start - clean[i - 1].end;
    if (gap > 0.35 && RESTART_STARTERS.has(clean[i].n)) {
      // look back a few words for the same opener
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (clean[j].n === clean[i].n) { restarts++; break; }
      }
    }
  }

  /* ---- time use ------------------------------------------------ */
  const usedSec = Math.round(durationSec || lastEnd);
  const usedPct = Math.min(Math.round((usedSec / allowedSec) * 100), 100);

  return {
    wordCount,
    fillerCount,
    fillerRate: Number(((fillerCount / wordCount) * 100).toFixed(1)),
    fillers,
    wpm,
    longestPauseSec: Number(longestPause.toFixed(1)),
    pauseCount,
    timeToFirstWordSec: Number(firstStart.toFixed(1)),
    restarts,
    usedSec,
    allowedSec,
    usedPct,
    speakingSec: Number(speakingSec.toFixed(1))
  };
}

/**
 * Turn raw numbers into good/warn/bad verdicts. Thresholds live here so
 * the frontend never hardcodes judgement.
 */
function gradeMetrics(m) {
  const band = (v, good, warn) => (v <= good ? 'good' : v <= warn ? 'warn' : 'bad');

  return {
    fillerCount:   band(m.fillerRate, 3, 6),
    wpm:           m.wpm < 110 ? 'warn' : m.wpm <= 160 ? 'good' : m.wpm <= 185 ? 'warn' : 'bad',
    longestPause:  band(m.longestPauseSec, 2, 4),
    timeToFirst:   band(m.timeToFirstWordSec ?? 0, 1.5, 3),
    restarts:      band(m.restarts, 2, 5),
    usedTime:      m.usedPct >= 85 ? 'good' : m.usedPct >= 60 ? 'warn' : 'bad'
  };
}

module.exports = { computeMetrics, gradeMetrics, FILLERS, FILLER_PHRASES };
