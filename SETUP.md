# Setup

## 1. Install Node dependencies

```bash
npm install
```

## 2. Get a Groq key for transcription

Create a key at https://console.groq.com — transcription runs entirely
through the Groq API, so there is nothing to install locally.

## 3. Create your .env

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env` and set your keys:

```
GEMINI_API_KEY=AIza...
GROQ_API_KEY=gsk_...
```

No quotes, no spaces around the `=`.

**Check it is ignored by git before committing anything:**

```bash
git status
```

`.env` must not appear in the list.

## 4. Run

```bash
npm start
```

Open http://localhost:3000

The camera needs `localhost` or `https` — opening the HTML file
directly will not work.

## First run

Watch the server console:

```
Session abc… — 4.2MB
Session abc… analysed — 187 words, 11 fillers, 168 wpm
Session abc… coached
```

Three lines means the whole pipeline worked.

## Without a Gemini key

Everything still runs. You get the transcript and all six metrics; the
AI coach note is simply omitted. The model is never a single point of
failure.
