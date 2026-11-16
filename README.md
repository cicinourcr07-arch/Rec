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

- **Frontend**: `src/` (React 19, TypeScript, Tailwind CSS v4, Lucide Icons)
- **Backend Services**: `server.ts` + `server/services/`
  - `video_upload_service.ts`
  - `video_analysis_service.ts`
  - `transcription_service.ts`
  - `translation_service.ts`
  - `voice_generation_service.ts`
  - `blur_processing_service.ts`
  - `logo_overlay_service.ts`
  - `subtitle_service.ts`
  - `audio_processing_service.ts`
  - `video_render_service.ts`
  - `export_service.ts`
- **Database**: SQLite (`db/schema.sql`, `server/db.ts`)
- **Optional Python FastAPI + OpenCV Worker**: `python_backend/main.py`

## Environment Variables

Configure via a local `.env` file (ignored by Git via `.gitignore`) or your hosting provider's environment variables / Secrets panel (never expose secret keys in `VITE_*` variables):

- `FISH_AUDIO_API_KEY`: Required on the backend for Fish Audio ASR transcription, voice library browsing, and `s2.1-pro-free` MP3 dubbing (`/api/fish/*`, `/api/projects/:id/dubbing/*`).
- `FISH_API_BASE_URL`: Optional Fish Audio API base URL (default `https://api.fish.audio`).
- `GEMINI_API_KEY`: Required for server-side automated AI translation.
- `STORAGE_DIR`: Directory for temporary audio/server assets (default `./storage`).

### Deploying with Fish Audio API

If you deploy the Express backend to a hosting provider (e.g. Render, Railway, Cloud Run, or Fly.io):
1. Open your backend service **Environment Variables** (or **Secrets**) panel.
2. Add `FISH_AUDIO_API_KEY` with your Fish Audio key (do **not** prefix it with `VITE_`).
3. On your Cloudflare Pages frontend project, set `VITE_API_BASE_URL` to your deployed backend URL (e.g. `https://your-backend.onrender.com`) so Fish Audio requests proxy through the backend without ever exposing the API key in the browser.

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

