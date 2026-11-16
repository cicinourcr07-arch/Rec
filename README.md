# Recap Studio AI

**Recap Studio AI** is a full-stack AI movie recap video editing platform built with React, TypeScript, Tailwind CSS, Express/Node.js, FFmpeg/FFprobe, SQLite, and Google Gemini AI (`@google/genai`), with an optional Python FastAPI + OpenCV CSRT vision worker.

## Key Capabilities

1. **Chunked Video Upload & Stream Analysis**
   - Supports `.mp4`, `.mov`, and `.mkv` files up to 2 GB via 5 MB chunked uploads.
   - Extracts real metadata (duration, resolution, FPS, video/audio codecs, bitrate, waveform peaks, and thumbnail) via `ffprobe` and `ffmpeg`.
   - Includes a one-click FFmpeg sample clip synthesizer for immediate pipeline testing.

2. **Automatic AI Captions & Subtitles**
   - Extracts audio with `ffmpeg` and transcribes spoken narration via `gemini-3.5-transcribe` + `gemini-4-hydrogen` word-level & sentence-level alignment.
   - Supports TikTok, YouTube Shorts, Cinematic, and Minimal presets, custom fonts, colors, outlines, shadows, background box opacity, and `.srt` / `.vtt` file export.

3. **9-Language AI Translation**
   - Translates timestamped segments into **English, Arabic, French, Spanish, German, Portuguese, Italian, Turkish, and Hindi** while preserving character names and movie terminology.

4. **AI Voiceover & Audio Mixing**
   - Generates real `.wav` voiceover narration via `gemini-3.8-flash-lite-tts` with Male/Female voice selection, custom style direction, speaking speed (`atempo`), and timeline-aligned `adelay` + `amix` dubbing.
   - Supports preserving/ducking original audio, fade-in/fade-out, and custom background music mixing.

5. **4-Mode Advanced Blur Engine**
   - **Full Video Blur**: Time-windowed Gaussian, Box, or Pixelate blur.
   - **Background Blur**: Foreground segmentation alpha-matte composited via FFmpeg `alphamerge`.
   - **Selective Blur**: Interactive draw-on-video rectangular or elliptical blur zones.
   - **Motion Tracking Blur**: Client-side Normalized Cross-Correlation (NCC) object tracker generating time-varying `(t, x, y, w, h)` keyframes rendered smoothly by FFmpeg.

6. **Logo & Watermark Branding**
   - Upload transparent `.png` or `.svg` logos, drag-and-drop/resize on the player, set opacity, preset positions, and permanent or timed display windows.

7. **Background FFmpeg Export Center**
   - Renders H.264 / AAC `.mp4` in `16:9`, `9:16`, or `1:1` aspect ratios at `480p`, `720p`, or `1080p` with live progress percentage, stage updates, ETA, preview, and download.

## Architecture

- **Frontend**: `src/` (React 19, TypeScript, Tailwind CSS v4, Lucide Icons) — handles all video selection, preview, frame extraction, audio extraction, subtitles, and rendering locally in the browser via File API, Canvas, Web Audio, MediaRecorder, and IndexedDB.
- **Cloudflare Worker Backend + Static Assets**: `wrangler.jsonc` + `worker/index.ts` (plus `functions/api/[[catchall]].ts` fallback for Pages) — serves `./dist` static assets via `env.ASSETS` and executes `/api/fish-audio` and `/api/fish/*` using `env.FISH_AUDIO_API_KEY`.
- **Local Express Dev Server**: `server.ts` + `server/services/` (port `3000`)

## Environment Variables

Configure via a local `.env` file (ignored by Git via `.gitignore`) for local development, or in Cloudflare Worker **Variables and Secrets** for production (never expose secret keys in `VITE_*` variables):

- `FISH_AUDIO_API_KEY`: Required on the Worker/backend for Fish Audio TTS (`/api/fish-audio`), ASR transcription (`/api/fish/asr`), and voice library browsing (`/api/fish/voices`).
- `FISH_API_BASE_URL`: Optional Fish Audio API base URL (default `https://api.fish.audio`).
- `GEMINI_API_KEY`: Optional key for server-side automated AI translation.

### Deploying to Cloudflare Workers + Static Assets (Recommended via GitHub)

This repository includes `wrangler.jsonc` configured with `"main": "worker/index.ts"` and `"assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": ["/api/*", "/health"] }`, allowing you to deploy both the Vite SPA and `/api/fish-audio` Worker backend together—and add environment secrets cleanly in Cloudflare.

1. Push this repository to GitHub (`.env` is excluded by `.gitignore`).
2. In the **Cloudflare Dashboard** → **Compute (Workers)** → **Workers & Pages** → **Create** → **Import a repository** (connect your GitHub repo).
3. Configure the build settings:
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: `/` (leave default)
4. Click **Deploy** once to create the Worker.
5. Open your Worker → **Settings** → **Variables and Secrets** → **+ Add**:
   - Type: **Secret**
   - Variable name: `FISH_AUDIO_API_KEY`
   - Value: your actual Fish Audio API key
   - Click **Deploy / Save** (Cloudflare will redeploy with `env.FISH_AUDIO_API_KEY` active).
   - *(CLI alternative)*: run `npm run build && npx wrangler secret put FISH_AUDIO_API_KEY && npx wrangler deploy`.

## Running Locally

1. Add your key in `.env`:
   ```env
   FISH_AUDIO_API_KEY=your_key_here
   ```
2. Install dependencies and start the server:
   ```bash
   npm install
   npm run dev
   ```

The server listens on `http://localhost:3000`.


