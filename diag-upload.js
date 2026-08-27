/**
 * Standalone upload probe. Sends a 1 MB multipart POST to /api/sessions
 * using http.request and logs every socket/request event with timestamps.
 * Run with:  node diag-upload.js
 */
const http   = require('http');
const crypto = require('crypto');

const PAYLOAD_MB = 1;
const fileData   = Buffer.alloc(PAYLOAD_MB * 1024 * 1024, 0x42); // 1 MB of 0x42
const boundary   = '----FormBoundary' + crypto.randomBytes(8).toString('hex');

const preamble = Buffer.from(
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="recording"; filename="diag.webm"\r\n` +
  `Content-Type: video/webm\r\n\r\n`
);
const epilogue = Buffer.from(
  `\r\n--${boundary}\r\n` +
  `Content-Disposition: form-data; name="topic"\r\n\r\nDiagnostic test\r\n` +
  `--${boundary}\r\n` +
  `Content-Disposition: form-data; name="durationSec"\r\n\r\n15\r\n` +
  `--${boundary}--\r\n`
);
const body = Buffer.concat([preamble, fileData, epilogue]);

const t0  = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(2)}s] ${msg}`);

log(`Body size: ${(body.length / 1024).toFixed(0)} KB`);
log(`Connecting to http://localhost:3000/api/sessions`);

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/sessions',
  method: 'POST',
  headers: {
    'Content-Type':   `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
  },
}, (res) => {
  log(`Response: HTTP ${res.statusCode}`);
  let data = '';
  res.on('data', (c) => { data += c; });
  res.on('end',  ()  => { log(`Body: ${data}`); process.exit(0); });
});

req.on('socket', (socket) => {
  log('Socket assigned');
  socket.on('connect',  ()      => log('Socket: CONNECT'));
  socket.on('error',    (e)     => log(`Socket: ERROR — ${e.code} ${e.message}`));
  socket.on('close',    (hadErr)=> log(`Socket: CLOSE (hadError=${hadErr})`));
  socket.on('timeout',  ()      => log('Socket: TIMEOUT'));
  socket.on('drain',    ()      => log('Socket: DRAIN (send buffer flushed)'));
  socket.on('end',      ()      => log('Socket: END (server closed write side)'));
});

req.on('error', (e) => {
  log(`Request ERROR: ${e.code} — ${e.message}`);
  process.exit(1);
});

// Send in 64 KB chunks to mirror what a browser does
const CHUNK_SIZE = 64 * 1024;
let offset = 0;

function writeChunk() {
  if (offset >= body.length) {
    log('All bytes written — calling req.end()');
    req.end();
    return;
  }
  const end   = Math.min(offset + CHUNK_SIZE, body.length);
  const chunk = body.subarray(offset, end);
  offset = end;
  log(`Wrote ${(offset / 1024).toFixed(0)} KB / ${(body.length / 1024).toFixed(0)} KB`);
  const drained = req.write(chunk);
  if (drained) {
    setImmediate(writeChunk);
  } else {
    log('Back-pressure — waiting for drain');
    req.once('drain', writeChunk);
  }
}

writeChunk();

// Kill after 30 s so the script doesn't hang indefinitely
setTimeout(() => {
  log('WATCHDOG: 30 s elapsed with no response — destroying socket');
  req.destroy();
  process.exit(2);
}, 30000);
