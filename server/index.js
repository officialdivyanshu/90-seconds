/**
 * 90SECONDS — server entry point.
 *
 * Serves the frontend and the topics API.
 *
 * Architectural rule (see PROJECT-NOTES.md): nothing on this path may call
 * a language model. Topics are pre-generated and served from memory so the
 * request stays in single-digit milliseconds under concurrent load.
 */

// Optional: .env is only needed once real secrets exist.
try { require('dotenv').config(); } catch (_) {}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TOPICS_PATH = path.join(__dirname, 'topics.json');

/* ------------------------------------------------------------------
   Topic bank
   Loaded once at boot. A database read replaces this later, but the
   principle stays: no generation happens during a request.
------------------------------------------------------------------ */

let TOPICS = [];
try {
  TOPICS = JSON.parse(fs.readFileSync(TOPICS_PATH, 'utf8'));
  console.log(`Loaded ${TOPICS.length} topics`);
} catch (err) {
  console.error('Could not read topics.json:', err.message);
  process.exit(1);
}

/* ------------------------------------------------------------------
   Uploads

   Recordings are written straight to disk, not held in memory — a
   90-second take is 8-15MB and buffering many at once would be the
   first thing to fall over under concurrent load.
------------------------------------------------------------------ */

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 50;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = (file.mimetype || '').includes('mp4') ? 'mp4' : 'webm';
    // The session id doubles as the filename so everything downstream
    // (transcript, metrics, feedback) keys off one value.
    req.sessionId = crypto.randomUUID();
    cb(null, `${req.sessionId}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /^video\/(webm|mp4)/.test(file.mimetype || '');
    cb(ok ? null : new Error('Only webm or mp4 recordings are accepted'), ok);
  }
});

const { spawn } = require('child_process');
const { computeMetrics, gradeMetrics } = require('./services/metrics');
const { getCoaching } = require('./services/gemini');

const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'base.en';

/**
 * Transcribe and analyse a recording in the background.
 *
 * This deliberately does not block the upload response. Whisper takes
 * several seconds on CPU; the client gets its session id immediately and
 * polls for the result. The same pattern absorbs the Gemini call later.
 */
function processSession(sessionId, filePath, metaPath) {
  const patch = (fields) => {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, ...fields }, null, 2));
    } catch (e) {
      console.error(`Could not update ${sessionId}:`, e.message);
    }
  };

  patch({ status: 'transcribing' });

  const py = spawn(PYTHON, [path.join(__dirname, 'transcribe.py'), filePath, WHISPER_MODEL]);

  let out = '';
  let err = '';
  py.stdout.on('data', (d) => { out += d; });
  py.stderr.on('data', (d) => { err += d; });

  py.on('error', (e) => {
    patch({ status: 'failed', error: `Could not run ${PYTHON}: ${e.message}` });
  });

  py.on('close', (code) => {
    if (code !== 0) {
      patch({ status: 'failed', error: err.slice(-400) || `exit ${code}` });
      return console.error(`Transcription failed for ${sessionId}: ${err.slice(-200)}`);
    }

    let result;
    try {
      result = JSON.parse(out.trim().split('\n').pop());
    } catch (_) {
      return patch({ status: 'failed', error: 'Bad worker output' });
    }

    if (!result.ok) {
      return patch({ status: 'failed', error: result.error });
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const metrics = computeMetrics(
      result.words,
      result.text,
      meta.durationSec || result.durationSec,
      Number(process.env.RECORD_SECONDS) || 90
    );

    patch({
      status: 'analysed',
      transcript: result.text,
      language: result.language,
      words: result.words,
      metrics,
      grades: gradeMetrics(metrics),
      analysedAt: new Date().toISOString()
    });

    console.log(`Session ${sessionId} analysed — ${metrics.wordCount} words, ${metrics.fillerCount} fillers, ${metrics.wpm} wpm`);

    // Final stage: the model reads the numbers and explains them. Runs
    // after the metrics are already saved, so a Gemini failure or a
    // missing key never costs the user their report.
    getCoaching({
      topic: meta.topic,
      transcript: result.text,
      metrics,
      history: recentHistory(sessionId)
    })
      .then((coaching) => {
        if (!coaching) return;
        patch({ coaching, coachedAt: new Date().toISOString() });
        console.log(`Session ${sessionId} coached`);
      })
      .catch((e) => {
        patch({ coachingError: e.message });
        console.error(`Coaching failed for ${sessionId}:`, e.message);
      });
  });
}

/**
 * The last few analysed sessions, compacted. Feeding numbers rather than
 * whole transcripts keeps the prompt small while still letting the coach
 * say "that is three sessions running".
 */
function recentHistory(excludeId, limit = 5) {
  try {
    return fs.readdirSync(UPLOAD_DIR)
      .filter((f) => f.endsWith('.json') && !f.startsWith(excludeId))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(UPLOAD_DIR, f), 'utf8'));
          if (!s.metrics) return null;
          return {
            at: s.analysedAt,
            fillerCount: s.metrics.fillerCount,
            wpm: s.metrics.wpm,
            restarts: s.metrics.restarts,
            adviceGiven: s.coaching?.actionItem
          };
        } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------
   Middleware
------------------------------------------------------------------ */

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ------------------------------------------------------------------
   Routes
------------------------------------------------------------------ */

// Config the frontend needs at boot. Never put secrets here — this
// response is visible to anyone who opens the page.
app.get('/api/config', (req, res) => {
  res.json({
    thinkSeconds: Number(process.env.THINK_SECONDS) || 30,
    recordSeconds: Number(process.env.RECORD_SECONDS) || 90
  });
});

// The wheel needs a set of topics to render its segments.
// ?count=10 controls how many. Capped to keep responses small.
app.get('/api/topics', (req, res) => {
  const count = Math.min(Math.max(Number(req.query.count) || 10, 1), 20);
  const pool = [...TOPICS];

  // Fisher-Yates shuffle, then take the first `count`.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  res.json({ topics: pool.slice(0, count) });
});

/* A recording the user has reviewed and chosen to submit.
   Only takes that reach here will ever cost a model call. */
app.post('/api/sessions', (req, res) => {
  upload.single('recording')(req, res, (err) => {
    if (err) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Recording exceeds ${MAX_MB}MB` : err.message
      });
    }
    if (!req.file) return res.status(400).json({ error: 'No recording received' });

    const session = {
      sessionId: req.sessionId,
      file: req.file.filename,
      bytes: req.file.size,
      topic: (req.body.topic || '').slice(0, 300),
      durationSec: Number(req.body.durationSec) || null,
      receivedAt: new Date().toISOString(),
      status: 'uploaded'   // → transcribing → analysed
    };

    // Written synchronously: the background worker reads this file
    // immediately and must not race the write.
    const metaPath = path.join(UPLOAD_DIR, `${req.sessionId}.json`);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(session, null, 2));
    } catch (writeErr) {
      console.error('Metadata write failed:', writeErr.message);
      return res.status(500).json({ error: 'Could not save session' });
    }

    console.log(`Session ${req.sessionId} — ${(req.file.size / 1048576).toFixed(1)}MB`);
    res.status(201).json(session);

    // Fire and forget. The client polls GET /api/sessions/:id for the result.
    setImmediate(() => {
      processSession(req.sessionId, req.file.path, metaPath);
    });
  });
});

app.get('/api/sessions/:id', (req, res) => {
  if (!/^[a-f0-9-]{36}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Bad session id' });
  }
  const meta = path.join(UPLOAD_DIR, `${req.params.id}.json`);
  fs.readFile(meta, 'utf8', (err, data) => {
    if (err) return res.status(404).json({ error: 'Session not found' });
    const session = JSON.parse(data);
    // Word timings are large and only needed for debugging; the client
    // polls this endpoint repeatedly so keep the payload small.
    if (req.query.words !== '1') delete session.words;
    res.json(session);
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, topics: TOPICS.length, uptime: process.uptime() });
});

/* ------------------------------------------------------------------
   Errors
------------------------------------------------------------------ */

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  90SECONDS running at http://localhost:${PORT}\n`);
});
