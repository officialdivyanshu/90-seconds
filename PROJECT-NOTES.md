# 90SECONDS — project notes

Revision notes. Every decision made so far and the reasoning behind it.
Status: frontend prototype built, backend not started.

---

## 1. The product in one line

A speaking-practice tool. You are given a random topic, thirty seconds to
read it and find an angle, then the camera opens by itself and records you
for ninety seconds. Afterwards you get told exactly what to fix.

The problem it solves: people avoid practising public speaking because
self-review is useless. You cannot hear your own filler words, and
rewatching yourself is painful and teaches nothing. A human coach costs
money. This sits in that gap.

---

## 2. Web, not native

Decided: build a website, made installable as a PWA.

- `getUserMedia` and `MediaRecorder` work in Chrome and Safari on mobile,
  so nothing important is lost.
- Load-testing a native app really means load-testing its backend anyway.
- If native is wanted later, React Native reuses the same API untouched.

---

## 3. The core architectural rule

**Never call the AI on the request path.**

If every session triggers an LLM call, then a hundred concurrent users means
a hundred in-flight requests, each one to three seconds, each costing money,
each subject to rate limits. The load test would fail without teaching
anything.

Instead the work is split into two paths:

- **Fast path** — serving a topic. A single indexed database lookup.
  Sub-ten milliseconds. Never waits on a model.
- **Slow path** — generating feedback. Pushed to a job queue. The API
  returns a job id immediately and the client polls.

This one decision is the most interview-worthy part of the whole project.

---

## 4. Topics are generated offline

A script generates a few thousand topics ahead of time across categories
(films, hot takes, lifestyle, explain-it-simply) and stores them with a
category tag. A background job tops the bank up periodically.

Serving one is a database read, not an API call.

---

## 5. Where the AI actually earns its place

Topic generation is the *least* interesting use of a model — any decent
random list looks the same whether a human or a model wrote it.

The irreplaceable use is **after the user stops talking**:

1. Audio goes to speech-to-text.
2. Transcript plus computed metrics go to the model.
3. The model returns coaching specific to that one recording.

This cannot be pre-generated. It is different for every user, every time.
There is no lookup table for "you said 'like' fourteen times and your pace
dropped in the second half".

---

## 6. The division of labour between code and model

**Code counts. The model explains.**

Never ask a language model to count filler words — models are bad at
counting and good at phrasing. Compute the numbers in code from Whisper's
word-level timestamps, then hand the model the finished numbers.

Metrics computed in code:

- filler word count
- speaking pace (words per minute)
- longest pause
- time to first word (hesitation)
- repeated sentence restarts
- proportion of the ninety seconds actually used

---

## 7. Build the metrics layer before the AI layer

Filler counting is a word list and a loop. Pace is arithmetic. Pause
detection is gaps between timestamps. None of it needs a model.

Get these working and displayed as raw numbers first. Then add the model as
the layer that interprets them. If the API budget runs out mid-demo, the app
still functions. The model must never be a single point of failure.

---

## 8. Constrain the model's output

Ask for structured JSON: an observation, a cause, one action item for the
next round. Free-form feedback drifts into generic praise ("great energy!")
which users learn to ignore within three sessions. Structure forces
specificity.

---

## 9. Cost control

- Feedback runs once per recording, not per page load.
- A ninety-second transcript is only a few hundred words of input.
- Use a cheap model tier. Fractions of a cent per session.
- Self-host Whisper (`faster-whisper` on CPU) — removes the largest
  per-session cost and removes a rate limit from the load test.
- Rate limit feedback per user per day.

---

## 10. Session timings

- **0:00 → 0:30** — read the topic, find an angle. Long enough to pick a
  direction, too short to write a script in your head.
- **0:30 → 2:00** — camera opens on its own. Ninety seconds, one continuous
  take, no pause button.
- **After 2:00** — the report.

Thinking and speaking are deliberately separate phases. If they share one
window, a nervous user burns half their airtime staring at the screen.

---

## 11. No analytics, deliberately

No scores, no streaks, no dashboards, no progress charts.

Each round is judged on its own. Measurement pulls attention away from the
thing that matters, which is the ninety seconds itself. The product states
this openly on the page rather than quietly omitting it — that turns an
absence into a stance.

---

## 12. Frontend design

Neo-brutalist. Paper beige `#F5F5DC` background, teal `#00C2CB`, magenta
`#FF00FF`, yellow `#FFD700`, 3px black strokes, zero border radius, hard
offset shadows.

Type: Archivo Black for display, JetBrains Mono for anything numeric.
Mono on numbers is what stops brutalism looking like a poster and starts it
looking like an instrument.

The hero does not show a screenshot of the product — it *is* the product.
The working demo sits where the marketing image would normally go.

---

## 13. The topic wheel

A Monopoly-style spinner with ten segments. Clicking spins for about four
and a half seconds with a hard deceleration curve.

Important detail: the result is picked in JavaScript **first**, then the
rotation is computed backwards to land that segment under the pointer. It
is a genuinely fair random draw, not a wheel that stops wherever and reads
off whatever it hit.

Buttons lock during the spin — a fast double-click would otherwise stack two
spins and the pointer would land on a lie.

---

## 14. Camera handling

Permission is requested **before** the round starts, never mid-round.
Browsers only grant camera access on a user gesture, so asking at the moment
the timer hits zero would fail.

- Preview is mirrored, matching the convention of every video call.
- Denial is handled: the round still runs, without a feed.
- `getUserMedia` requires a secure context — `https` or `localhost`. Opening
  the file as a bare `file://` path makes `navigator.mediaDevices`
  undefined. Serve it (`python3 -m http.server`) while developing.

---

## 15. Accounts and login

Google OAuth only. No passwords means no password storage, which removes the
single biggest security liability.

Use an existing auth layer — Supabase Auth, Firebase Auth, or Auth.js.
Rolling your own authentication is the one genuinely bad choice available.

---

## 16. Database shape

Postgres.

```
users        id, google_id, email, name, created_at
sessions     id, user_id, topic_id, recorded_at, duration
transcripts  session_id, text, word_timings (jsonb)
metrics      session_id, filler_count, wpm, longest_pause, ...
feedback     session_id, coach_json, model_used
topics       id, text, category
```

Word timings go in a `jsonb` column — Whisper returns nested data and
normalising it into rows is wasted effort.

Video files go to object storage (S3, R2, Supabase Storage). The database
stores only the URL. A hundred users at five sessions a day would otherwise
fill a database very quickly.

---

## 17. How the AI uses past sessions

Do **not** feed old recordings back to the model. Feed a compact summary:

```
Last 5 sessions: avg 12 fillers, avg 165 wpm.
Recurring issue: restarts sentences, weak endings.
Advice already given: "state your opening sentence first".
Today: [transcript + metrics]
```

A few hundred tokens. This lets the coach say "you have fixed the pace, but
the restart habit is still there — that is three sessions running", and stops
it repeating advice already given. That is what makes coaching feel real
rather than canned.

Vector embeddings and semantic retrieval would work, but the numeric summary
gets ninety percent of the value at five percent of the complexity. Skip
vectors until there is a reason.

---

## 18. Privacy position

Consider transcribing, extracting metrics, then **discarding the video
within twenty-four hours**. Storing users' faces creates obligations around
privacy policy, deletion flows, and data protection law. Discarding is
cheaper, safer, and reads well in a README.

---

## 19. Secrets handling

The Gemini key never touches the frontend. If it is in the HTML, or in any
`VITE_` or `REACT_APP_` variable, it ships to every visitor and can be read
from view-source in seconds. The browser calls your Node server; only the
Node server calls Gemini.

- `.env` is gitignored. `.env.example` is committed as a template.
- The gitignore also blocks `uploads/` and all media extensions, because
  this project records people's faces.
- Run `git status` before the first commit and confirm `.env` is absent.
- A key that has been pushed is burned. Deleting it in a later commit does
  not help — it stays in git history. Revoke and regenerate.

---

## 20. The load test

This is the point of the project, so it deserves care.

- Mock the model call with a fixed delay. You are measuring your queue, your
  workers, your database — not a vendor's uptime.
- Test the two paths separately. Topic fetch should be trivially fast under a
  hundred concurrent users. Submission should stay responsive because nothing
  blocks on the model.
- Show queue depth over time.
- Run one small *real* concurrency test separately to observe genuine
  rate-limit behaviour and confirm the retry and backoff logic works.

A writeup showing this is far stronger than "my endpoint returned a random
string a hundred times".

---

## 21. Build order

Each phase is independently demoable. Ship each before starting the next.

1. **The ugly loop** — hardcoded topics, countdown, camera opens,
   recording lands on the server. No styling, no database. If this works,
   the project is real.
2. **Metrics layer** — Whisper, word timestamps, filler counting, pace,
   pauses. Displayed as raw numbers. Zero API cost.
3. **AI feedback** — job queue, coaching prompt, structured JSON, session
   history.
4. **Load test** — Locust or k6, mocked model, a hundred virtual users,
   queue depth graphs, written up.

Phase 1 is where most people quit. Do it dirty and do it first.

---

## 22. Project structure

```
ninety-seconds/
├── .gitignore
├── .env.example        committed
├── .env                never committed
├── package.json
├── server/
│   ├── index.js        Express entry
│   ├── config.js       reads env, validates on boot
│   ├── routes/         topics, sessions
│   ├── services/       gemini, whisper, metrics
│   ├── queue/          job worker
│   └── db/             schema, migrations
├── public/
│   ├── index.html
│   ├── css/
│   └── js/             wheel, session, camera, api, main
└── uploads/            gitignored
```

---

## 23. One-sentence summary for a CV

An AI speaking coach that serves adaptive practice prompts and delivers
personalised post-session critique via speech-to-text and LLM analysis, with
generation moved off the request path for sub-ten-millisecond prompt
delivery under concurrent load.
