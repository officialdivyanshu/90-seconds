# Setup

## 1. Install Node dependencies

```bash
npm install
```

## 2. Install the transcription engine

```bash
pip install faster-whisper
```

Verify:

```bash
python -c "import faster_whisper; print('OK')"
```

## 3. Create your .env

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Open `.env` and set your key from https://aistudio.google.com/apikey

```
GEMINI_API_KEY=AIza...
```

No quotes, no spaces around the `=`.

If `python` is not your command, also set `PYTHON_BIN=python3`.

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

The first recording you submit downloads the Whisper model (~150MB).
Expect a wait. After that transcription takes a few seconds per clip.

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
