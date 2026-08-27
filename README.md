# 90SECONDS

A speaking-practice tool. You get a random topic, thirty seconds to think,
then the camera opens by itself and records you for ninety seconds.
Afterwards you get told exactly what to fix.

**Status:** frontend prototype. Backend not started.

---

## Running it

The camera needs a secure context, so open it over `localhost` — not as a
`file://` path.

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000/public/

If `navigator.mediaDevices` is `undefined` in the console, you are not on
localhost.

---

## What works right now

- Topic wheel with a fair random draw (result picked first, rotation
  computed backwards to land on it)
- 30 second thinking phase, 90 second recording phase
- Camera permission request, live mirrored preview, REC indicator
- Report card showing the metric shape (dummy values for now)

## What does not exist yet

- Any backend
- MediaRecorder — the camera previews but nothing is captured
- Groq transcription
- Gemini feedback
- Accounts, database, storage

---

## Structure

```
├── public/         frontend
├── server/         Node backend (empty)
├── uploads/        recordings, gitignored
├── .env.example    template, safe to commit
└── PROJECT-NOTES.md   every decision and why
```

Read `PROJECT-NOTES.md` before changing anything. It documents the
architecture and the reasoning behind each choice.

---

## Secrets

Copy the template and fill it in:

```bash
cp .env.example .env
```

`.env` is gitignored. The Gemini and Groq keys are server-side only and must
never appear in frontend code — anything shipped to the browser can be read
from view-source. Get a Groq key at https://console.groq.com.

Before your first push, run `git status` and confirm `.env` is not listed.
A key that has been pushed is burned; revoke and regenerate rather than
deleting it in a later commit.

---

## Build order

1. **The ugly loop** — MediaRecorder, upload, recording lands on the server
2. **Metrics** — Groq transcription, filler counts, pace, pauses (no AI cost)
3. **AI feedback** — job queue, Gemini, structured JSON
4. **Load test** — 100 concurrent users, mocked model, queue depth

Ship each phase before starting the next.
