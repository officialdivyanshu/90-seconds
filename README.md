# 90SECONDS

**An AI speaking coach.** You get a random topic, thirty seconds to think,
then the camera opens by itself and records you for ninety seconds. When
you stop, you get told exactly what to fix.

### → [Try it live](https://nine0-seconds-api.onrender.com)

> Hosted on a free tier, so the first load after a quiet period takes
> about thirty seconds to wake up. After that it is instant.

---

## Why it exists

Most people avoid practising public speaking because self-review is
useless. You cannot hear your own filler words. Rewatching yourself is
uncomfortable and teaches you nothing specific. A human coach costs money
and needs scheduling.

90SECONDS sits in that gap: instant, private, unlimited, and specific
enough to act on.

---

## How a round works

| Time | What happens |
|------|--------------|
| — | Spin the wheel. You get a topic. You don't get to skip it. |
| 0:00 → 0:30 | Read it, find an angle. Long enough to pick a direction, too short to write a script. |
| 0:30 → 2:00 | The camera opens on its own. Ninety seconds, one take, no pause button. |
| After | Review your take, then send it for analysis. |

You can skip the thinking time if you're ready, and stop early if you're
done — an early stop keeps everything you recorded.

---

## What you get back

Six measurements, computed from your actual speech:

- **Filler words** — count and breakdown, including phrases like "you know"
- **Speaking pace** — words per minute over actual talking time
- **Longest pause** — and how many pauses ran over 0.6 seconds
- **Time to first word** — how long you hesitated before starting
- **Repeated restarts** — sentences you began, abandoned, and began again
- **Time used** — how much of the ninety seconds you actually filled

Then a written coach note: what happened, why, one thing that worked, and
a single specific thing to change next round.

---

## Design decisions

A few choices that shaped the whole build.

**Generation never happens on the request path.** Topics are written
ahead of time and served from memory, so handing someone a prompt is a
single array read rather than a model call. Nothing the user waits on
depends on an external API.

**Code counts, the model explains.** Every number above is computed in
`server/services/metrics.js` — arithmetic over word-level timestamps.
Language models are unreliable at counting and excellent at phrasing, so
the model receives finished numbers and is asked only to interpret them.

**Your video never leaves your device.** The browser records two streams:
video for you to review and download, and a separate audio-only track.
Only the audio is uploaded — roughly 1MB against 30MB for the video. This
started as a fix for slow uploads and turned out to be a much better
privacy position.

**No scores, no streaks, no dashboard.** Every round is judged on its own.
Progress tracking pulls attention toward the graph and away from the
ninety seconds, which is the part that actually makes you better.

**The AI is never load-bearing.** Metrics are computed and saved before
the model is called. If the API fails or no key is configured, you still
get your transcript and every measurement — you just lose the written
note.

---

## Architecture

```
Browser                    Node / Express              External
────────────────────────────────────────────────────────────────
spin wheel      ──→  GET /api/topics
                     (in-memory, no I/O)

record          ──→  MediaRecorder
                     video blob stays local
                     audio blob uploaded

send            ──→  POST /api/sessions
                     returns session id immediately
                          │
                          ├──────────────────────→  Groq Whisper
                          │                         (transcript +
                          │                          word timings)
                          │
                          ├──→  metrics.js
                          │     (pure computation)
                          │
                          └──────────────────────→  Gemini
                                                    (coaching note)

poll            ──→  GET /api/sessions/:id
                     uploaded → transcribing → analysed
```

The upload responds before any processing starts. Transcription and
coaching run in the background while the client polls, so a slow model
call never blocks the API.

---

## Stack

- **Frontend** — vanilla JavaScript, no build step. SVG wheel,
  `getUserMedia`, dual `MediaRecorder`.
- **Backend** — Node and Express. Multer for uploads.
- **Transcription** — Groq Whisper (`whisper-large-v3-turbo`) with
  word-level timestamps.
- **Coaching** — Google Gemini, rate-limited and retried with backoff.
- **Design** — neo-brutalist. Paper beige, teal, magenta, yellow. Thick
  black strokes, zero border radius, hard offset shadows.
- **Hosting** — Render free tier.

---

## Running locally

```bash
git clone https://github.com/officialdivyanshu/90-seconds.git
cd 90-seconds
npm install
```

Create a `.env` file:

```
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
```

Keys come from [console.groq.com](https://console.groq.com) and
[aistudio.google.com/apikey](https://aistudio.google.com/apikey). Both
have free tiers that comfortably cover personal use.

```bash
npm start
```

Then open http://localhost:3000

The camera requires a secure context, so it works over `localhost` or
HTTPS — opening `index.html` directly as a file will not work.

---

## Notes on the free tier

**Recordings are ephemeral.** The host wipes the filesystem on restart,
so uploaded audio and session records disappear. Since the video never
leaves your browser and the audio is only needed for transcription, this
is closer to a feature than a limitation.

**The service sleeps.** After about fifteen minutes without traffic it
shuts down, and the next visitor waits roughly thirty seconds for it to
wake.

**Rate limits are handled.** Gemini calls are serialised with a minimum
gap between them, keeping the app under the free tier's per-minute cap
regardless of how many people submit at once. Under a burst, users wait
slightly longer rather than seeing errors.

---

## Project layout

```
├── public/
│   └── index.html          entire frontend, single file
├── server/
│   ├── index.js            express app, routes, pipeline
│   ├── topics.json         the topic bank
│   └── services/
│       ├── transcriber.js  groq whisper
│       ├── metrics.js      all measurement, no AI
│       └── gemini.js       coaching, rate limiting, retries
├── PROJECT-NOTES.md        every decision and the reasoning behind it
└── SETUP.md                setup steps
```

`PROJECT-NOTES.md` is worth reading if you want the reasoning rather than
the result.

---

## Not built yet

- Accounts, so coaching can reference your own history across sessions
- Persistent storage
- The load-testing writeup — the architecture was built for concurrency,
  but the numbers aren't measured yet
