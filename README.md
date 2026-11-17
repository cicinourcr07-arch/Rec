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
- **Personal Fish Audio API Key Storage**: `src/lib/fishKeyStore.ts` stores the user's personal Fish Audio API key locally inside browser IndexedDB (`recap_studio_personal_keys_v1`) when **Remember API Key on this device** is enabled, or in memory for the current session only. It is never uploaded to any database, exported in project backups, logged, or committed to GitHub.
- **Cloudflare Pages Functions**:
  - `functions/api/fish-audio.js`: Accepts `POST /api/fish-audio` requests only over HTTPS from the same origin, reads the user's personal key from the `Authorization: Bearer <token>` header, supports real connection verification (`{ action: "test" }`), and forwards TTS requests to `https://api.fish.audio/v1/tts` without logging or persisting the key.
  - `functions/api/[[catchall]].ts`: Handles `/api/system/status`, `/api/fish/status`, `/api/fish/voices`, `/api/fish/asr`, `/api/projects/:id/dubbing/*`, and `/api/projects/:id/translate` directly on Cloudflare Pages Functions.
- **Local Express Dev Server**: `server.ts` + `server/services/` (port `3000`)

## Configuration & Personal API Keys

- **Fish Audio (No Central Server Secret Required)**:
  1. Open **Settings → Fish Audio API Settings** inside the app.
  2. Paste your personal Fish Audio API key, choose **Remember API Key on this device** (IndexedDB), click **Save API Key**, and verify with **Test Connection**.
  3. Never use `VITE_FISH_AUDIO_API_KEY` or commit keys to source control.
- **Optional Server Environment Variables**:
  - `FISH_API_BASE_URL`: Optional Fish Audio API base URL (default `https://api.fish.audio`).
  - `GEMINI_API_KEY`: Optional key for server-side automated AI translation.

### Deploying to Cloudflare Pages (GitHub Integration)

1. Push this repository to GitHub (`.env` is excluded by `.gitignore`).
2. In your **Cloudflare Pages** project, verify **Build & deployments**:
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
3. Cloudflare Pages automatically deploys `functions/api/fish-audio.js` as `/api/fish-audio` and serves `dist/` for the frontend. No `FISH_AUDIO_API_KEY` environment variable needs to be configured in Cloudflare for users to enter and use their own personal keys.

## Running Locally

1. Install dependencies and start the server:
   ```bash
   npm install
   npm run dev
   ```
2. Open `http://localhost:3000`, go to **Settings → Fish Audio API Settings**, and add your personal Fish Audio API key.

