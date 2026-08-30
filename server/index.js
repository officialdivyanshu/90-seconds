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
const cors = require('cors');

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

const PROJECT_ROOT = path.join(__dirname, '..');
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(PROJECT_ROOT, process.env.UPLOAD_DIR)
  : path.join(PROJECT_ROOT, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
console.log(`Uploads → ${UPLOAD_DIR}`);

// Render's free tier disk is ephemeral and small — recordings and their
// metadata are only ever needed for the few minutes it takes to analyse
// them, so anything older than an hour is stale and safe to delete.
const UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

function cleanupOldUploads() {
  let removed = 0;
  const now = Date.now();
  let files;
  try {
    files = fs.readdirSync(UPLOAD_DIR);
  } catch (e) {
    return console.error('Upload cleanup could not list directory:', e.message);
  }
  for (const file of files) {
    const filePath = path.join(UPLOAD_DIR, file);
    try {
      if (now - fs.statSync(filePath).mtimeMs > UPLOAD_MAX_AGE_MS) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch (_) {}
  }
  if (removed) console.log(`Upload cleanup: removed ${removed} file(s) older than 1 hour`);
}
cleanupOldUploads();
setInterval(cleanupOldUploads, 15 * 60 * 1000).unref();

// The client uploads audio only now (~1MB for a 90s take at 64kbps) — video
// never leaves the browser. video/* is kept accepted as a fallback path
// (see transcriber.js), so the ceiling still needs headroom for a full
// recording, just not the old 50MB sized for routine video uploads.
const MAX_MB = Number(process.env.MAX_UPLOAD_MB) || 40;

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
    // Browsers send things like "audio/webm;codecs=opus" for the normal
    // audio-only upload, or "video/webm;codecs=vp9,opus" for the video
    // fallback path. Accept either and let the transcriber be the thing
    // that complains if the container is unusable.
    const mt = file.mimetype || '';
    console.log(`Upload incoming: ${file.originalname} (${mt})`);
    if (/^video\//.test(mt) || /^audio\//.test(mt) || mt === 'application/octet-stream') {
      return cb(null, true);
    }
    console.warn(`Rejected upload with mimetype: ${mt}`);
    cb(new Error(`Unsupported type: ${mt}`), false);
  }
});

const { computeMetrics, gradeMetrics } = require('./services/metrics');
const { getCoaching } = require('./services/gemini');
const { transcribe } = require('./services/transcriber');

// Transcription is the only active path — every session fails without a
// key, so fail loudly at boot instead of letting each one fail mysteriously.
if (!process.env.GROQ_API_KEY) {
  console.error('GROQ_API_KEY is not set. Get one at https://console.groq.com and add it to .env — see .env.example.');
  process.exit(1);
}

/**
 * Transcribe and analyse a recording in the background.
 *
 * This deliberately does not block the upload response. Transcription takes
 * a few seconds; the client gets its session id immediately and polls for
 * the result. The same pattern absorbs the Gemini call later.
 */
async function processSession(sessionId, filePath, metaPath, mimetype) {
  const patch = (fields) => {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, ...fields }, null, 2));
    } catch (e) {
      console.error(`Could not update ${sessionId}:`, e.message);
    }
  };

  patch({ status: 'transcribing' });

  const result = await transcribe(filePath, mimetype);

  if (!result.ok) {
    patch({ status: 'failed', error: result.error });
    return console.error(`Transcription failed for ${sessionId}: ${result.error}`);
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

// The frontend is deployed separately (Netlify) from this API (Render),
// so cross-origin requests are the normal case, not the exception.
// ALLOWED_ORIGINS is a comma-separated allowlist; unset means allow any
// origin, which is fine for an API with no cookie/session auth.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsOptions = { origin: ALLOWED_ORIGINS.includes('*') ? '*' : ALLOWED_ORIGINS };
app.use('/api', cors(corsOptions));

// Scoped deliberately: applying express.json() to every request means it
// inspects multipart upload streams too, which can interfere with multer.
app.use((req, res, next) => {
  if ((req.headers['content-type'] || '').startsWith('multipart/')) return next();
  express.json({ limit: '1mb' })(req, res, next);
});
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
/* Diagnostic: accepts a POST body and reports what arrived. Bypasses
   multer entirely, so it separates "the connection dies" from "multer
   rejects it". Visit /api/echo-test from the browser console. */
app.post('/api/echo', (req, res) => {
  let bytes = 0;
  console.log(`ECHO: request started, content-length=${req.headers['content-length'] || '?'}`);

  req.on('data', (chunk) => { bytes += chunk.length; });

  req.on('aborted', () => {
    console.error(`ECHO: client aborted after ${bytes} bytes`);
  });

  req.on('error', (e) => {
    console.error(`ECHO: stream error after ${bytes} bytes — ${e.message}`);
  });

  req.on('end', () => {
    console.log(`ECHO: received ${bytes} bytes successfully`);
    res.json({ ok: true, bytes });
  });
});

app.post('/api/sessions', (req, res) => {
  console.log(`POST /api/sessions — ${req.headers['content-length'] || '?'} bytes declared`);
  upload.single('recording')(req, res, (err) => {
    if (err) {
      console.error('Upload failed:', err.code || '', err.message);
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: tooBig ? `Recording exceeds ${MAX_MB}MB` : err.message
      });
    }
    if (!req.file) {
      console.error('Upload failed: no file in request');
      return res.status(400).json({ error: 'No recording received' });
    }

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
    // Tell Chrome not to reuse this connection. Stale keep-alive sockets from
    // a previous server instance cause uploads to stall at ~6% on Windows.
    res.setHeader('Connection', 'close');
    res.status(201).json(session);

    // Fire and forget. The client polls GET /api/sessions/:id for the result.
    setImmediate(() => {
      processSession(req.sessionId, req.file.path, metaPath, req.file.mimetype);
    });
  });
});

/* Fallback for when multipart/form-data is rejected mid-stream (e.g.
   Chrome's ERR_CONNECTION_RESET on some Windows paths). The client sends
   the raw video blob as the request body; topic and duration come in as
   query params. No multer, so nothing can reject the content-type. */
app.post('/api/sessions/raw', (req, res) => {
  const mime = req.headers['content-type'] || 'application/octet-stream';
  const ext  = mime.includes('mp4') ? 'mp4' : 'webm';
  const sessionId = crypto.randomUUID();
  const filename  = `${sessionId}.${ext}`;
  const filePath  = path.join(UPLOAD_DIR, filename);
  const topic     = String(req.query.topic    || '').slice(0, 300);
  const durationSec = Number(req.query.duration) || null;
  const maxBytes  = MAX_MB * 1024 * 1024;

  console.log(`POST /api/sessions/raw — declared ${req.headers['content-length'] || '?'} bytes, mime: ${mime}`);

  let received = 0;
  let capped   = false;
  const out = fs.createWriteStream(filePath);

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > maxBytes && !capped) {
      capped = true;
      req.destroy();
      out.destroy();
      try { fs.unlinkSync(filePath); } catch (_) {}
      if (!res.headersSent) res.status(413).json({ error: `Recording exceeds ${MAX_MB}MB` });
    }
  });

  req.on('error', (err) => {
    console.error(`Raw upload stream error after ${received} bytes: ${err.message}`);
    out.destroy();
    try { fs.unlinkSync(filePath); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: 'Upload stream error' });
  });

  out.on('error', (err) => {
    console.error(`Raw upload write error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'Could not write recording' });
  });

  req.pipe(out);

  out.on('finish', () => {
    if (capped) return;

    const session = {
      sessionId, file: filename, bytes: received,
      topic, durationSec,
      receivedAt: new Date().toISOString(),
      status: 'uploaded', via: 'raw'
    };

    const metaPath = path.join(UPLOAD_DIR, `${sessionId}.json`);
    try {
      fs.writeFileSync(metaPath, JSON.stringify(session, null, 2));
    } catch (writeErr) {
      console.error('Metadata write failed:', writeErr.message);
      return res.status(500).json({ error: 'Could not save session' });
    }

    console.log(`Session ${sessionId} (raw) — ${(received / 1048576).toFixed(1)}MB`);
    res.setHeader('Connection', 'close');
    res.status(201).json(session);

    setImmediate(() => processSession(sessionId, filePath, metaPath, mime));
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

process.on('uncaughtException', (e) => {
  console.error('UNCAUGHT:', e);
});
process.on('unhandledRejection', (e) => {
  console.error('UNHANDLED REJECTION:', e);
});

// 0.0.0.0, not the loopback-only default, so Render's health check (which
// connects from outside the container) can actually reach the port.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  90SECONDS running at http://localhost:${PORT}\n`);
});

// Chrome holds the TCP connection open for reuse. Node's default
// keepAliveTimeout (5 s) can race the upload on Windows loopback paths
// where the first send stalls. headersTimeout must exceed keepAliveTimeout.
server.keepAliveTimeout = 5000;   // short in dev — stale sockets from restarts confuse Chrome
server.headersTimeout   = 6000;
server.requestTimeout   = 0;     // no per-request deadline

server.on('clientError', (err, socket) => {
  console.error(`clientError [${err.code || err.message}]`);
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('connection', (socket) => {
  const addr = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`TCP connect: ${addr}`);
  socket.on('error', (err) => {
    console.error(`Socket error [${addr}]: ${err.code || err.message}`);
  });
  socket.on('close', (hadError) => {
    if (hadError) console.warn(`Socket closed with error [${addr}]`);
  });
});