import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  AUDIO_DIR,
  BACKGROUNDS_DIR,
  EXPORTS_DIR,
  FONTS_DIR,
  LOGOS_DIR,
  MASKS_DIR,
  STORAGE_DIR,
  THUMBS_DIR,
  UPLOADS_DIR,
  checkAssetAvailableByUrl,
  createPreset,
  createProject,
  deleteCustomFont,
  deletePreset,
  deleteProject,
  getAssetByUrl,
  getJob,
  getPreset,
  getProject,
  getSavedFishVoices,
  listAllJobs,
  listCustomFonts,
  listPresets,
  listProjectJobs,
  listProjects,
  registerCustomFont,
  saveSavedFishVoices,
  updatePreset,
  updateProject,
  upsertProjectFromCloud,
} from './server/db.ts';
import {
  CompressionPreset,
  compressProjectVideoForFreeCloud,
  computeLocalStorageUsage,
  hydrateAssetToLocalBucket,
  inspectProjectAssets,
} from './server/services/local_storage_service.ts';
import { isGeminiConfigured } from './server/services/gemini_client.ts';
import {
  analyzeVideoFile,
  checkFfmpegCapabilities,
  createDemoMovieRecapClip,
  extractWaveformPeaks,
  generateHighResVideoFrame,
  generateVideoThumbnail,
} from './server/services/video_analysis_service.ts';
import {
  finalizeChunkedUpload,
  getMaxUploadBytes,
  initChunkedUpload,
  saveCanvasBackgroundFile,
  saveDirectVideoFile,
  saveFontFile,
  saveLogoFile,
  saveMusicFile,
  saveSegmentationMaskImage,
  saveSfxFile,
  saveUploadChunk,
} from './server/services/video_upload_service.ts';
import {
  extractAudioTrack,
  transcribeVideoWithGemini,
} from './server/services/transcription_service.ts';
import { translateCaptionsWithGemini } from './server/services/translation_service.ts';
import {
  generateSingleVoicePreview,
  generateSynchronizedVoiceover,
} from './server/services/voice_generation_service.ts';
import {
  generateSrtContent,
  generateVttContent,
  parseSrtOrVtt,
} from './server/services/subtitle_service.ts';
import {
  cleanupTempStorage,
  enqueueRenderJob,
} from './server/services/export_service.ts';
import { ensureFontAvailable } from './server/services/font_service.ts';
import { resolveSourceCropRect } from './server/services/video_render_service.ts';
import { buildVideoEffectsFilters } from './server/services/video_effects_service.ts';
import {
  enqueueFishDubJob,
  generateDubDiagnosticReport,
  generateFishSynchronizedDub,
  generateFishVoicePreview,
  getFishDubJobResult,
  inspectFullDubTrackDiagnostics,
  isFishAudioConfigured,
  listFishVoices,
  regenerateFishSegments,
  resyncExistingFishClips,
  synthesizeFishMp3Buffer,
  testFishAudioConnection,
  transcribeVideoWithFishAudio,
} from './server/services/fish_audio_service.ts';
import {
  clampContinuousPauseMs,
  normalizeSyncMode,
} from './server/services/timeline_sync_service.ts';
import { BUILTIN_FONT_CATALOG } from './src/lib/fontCatalog.ts';
import { resolveCanvasDimensions } from './src/lib/workflowStages.ts';
import {
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  GeminiVoiceName,
  PresetCategory,
  Project,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
} from './src/types/studio.ts';

const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.set('trust proxy', 1);

function extractBearerToken(req: express.Request): string | undefined {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!m) return undefined;
  const token = m[1].trim();
  if (!token || /[\r\n\s]/.test(token)) return undefined;
  return token;
}

function parseAllowedOrigins(): string[] {
  const raw = [
    process.env.CORS_ORIGINS,
    process.env.FRONTEND_URL,
    process.env.APP_URL,
  ]
    .filter(Boolean)
    .join(',');
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s && s !== 'MY_APP_URL');
}

function isOriginAllowed(origin: string | undefined, allowlist: string[]): boolean {
  if (!origin) return true;
  if (allowlist.length === 0 || allowlist.includes('*')) return true;
  const normalized = origin.replace(/\/+$/, '');
  if (allowlist.includes(normalized)) return true;

  try {
    const parsed = new URL(normalized);
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname.endsWith('.pages.dev') ||
      parsed.hostname.endsWith('.run.app')
    ) {
      return process.env.STRICT_CORS === 'true' ? allowlist.includes(normalized) : true;
    }
  } catch {
    return false;
  }
  return false;
}

// Production-ready CORS & Cross-Origin Resource Policy for Cloudflare Pages (*.pages.dev) + custom domains
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowlist = parseAllowedOrigins();
  const allowed = isOriginAllowed(origin, allowlist);

  res.header('Vary', 'Origin');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');

  if (origin && allowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (!origin && (allowlist.length === 0 || allowlist.includes('*'))) {
    res.header('Access-Control-Allow-Origin', '*');
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range'
  );
  res.header(
    'Access-Control-Expose-Headers',
    'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
  );
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    if (origin && !allowed) {
      res.status(403).json({ error: `CORS origin not allowed: ${origin}` });
      return;
    }
    res.sendStatus(204);
    return;
  }
  next();
});

// Concise server logs for uploads, exports, and API errors
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }
  const startMs = Date.now();
  res.on('finish', () => {
    const isPolling = req.method === 'GET' && /^\/api\/(jobs|projects)$/.test(req.path);
    const isChunk = /\/api\/uploads\/[^/]+\/chunk$/.test(req.path);
    if ((isPolling || isChunk) && res.statusCode < 400) {
      return;
    }
    console.log(
      `[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startMs}ms)`
    );
  });
  next();
});

app.use(express.json({ limit: '25mb' }));
app.use(
  express.raw({
    type: (req) => (req.headers['content-type'] || '').toLowerCase().includes('application/octet-stream'),
    limit: '30mb',
  })
);

const uploadMem = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 55 * 1024 * 1024 },
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'recap-studio-backend',
    storageDir: STORAGE_DIR,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'recap-studio-backend',
    storageDir: STORAGE_DIR,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Media streaming route with HTTP Range & HEAD support for video seeking and download disposition
app.get('/media/:bucket/:filename', (req, res) => {
  const { bucket, filename } = req.params;
  const safeName = path.basename(filename);
  const bucketMap: Record<string, string> = {
    uploads: UPLOADS_DIR,
    logos: LOGOS_DIR,
    backgrounds: BACKGROUNDS_DIR,
    fonts: FONTS_DIR,
    audio: AUDIO_DIR,
    masks: MASKS_DIR,
    exports: EXPORTS_DIR,
    thumbs: THUMBS_DIR,
  };
  const baseDir = bucketMap[bucket];
  if (!baseDir) {
    res.status(404).json({ error: 'Invalid media bucket' });
    return;
  }

  const filePath = path.join(baseDir, safeName);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Media file not found' });
    return;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    res.status(404).json({ error: 'Media file is empty or incomplete' });
    return;
  }

  const ext = path.extname(safeName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  const contentType = mimeMap[ext] || 'application/octet-stream';

  if (bucket === 'exports') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    });
    res.end();
    return;
  }

  const range = req.headers.range;
  if (range && (ext === '.mp4' || ext === '.mov' || ext === '.mkv' || ext === '.wav' || ext === '.mp3')) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parts[0] ? parseInt(parts[0], 10) : 0;
    const rawEnd = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const end = Math.min(stat.size - 1, isNaN(rawEnd) ? stat.size - 1 : rawEnd);

    if (isNaN(start) || start < 0 || start >= stat.size || end < start) {
      res.writeHead(416, {
        'Content-Range': `bytes */${stat.size}`,
      });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => {
      console.error('[Media Stream Error]', err);
      if (!res.headersSent) res.sendStatus(500);
      else res.end();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Length': stat.size,
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  });
  const fullStream = fs.createReadStream(filePath);
  fullStream.on('error', (err) => {
    console.error('[Media Stream Error]', err);
    if (!res.headersSent) res.sendStatus(500);
    else res.end();
  });
  res.on('close', () => fullStream.destroy());
  fullStream.pipe(res);
});

// System Diagnostics & Configuration Status
app.get('/api/system/status', async (_req, res) => {
  const caps = await checkFfmpegCapabilities();
  res.json({
    geminiConfigured: isGeminiConfigured(),
    fishConfigured: isFishAudioConfigured(),
    ffmpegAvailable: caps.ffmpegAvailable,
    ffprobeAvailable: caps.ffprobeAvailable,
    ffmpegVersion: caps.ffmpegVersion,
    storageDir: STORAGE_DIR,
    maxUploadSizeMb: Math.round(getMaxUploadBytes() / (1024 * 1024)),
    tempRetentionHours: Number(process.env.TEMP_RETENTION_HOURS || '24'),
    supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
    supportedLogoFormats: ['PNG', 'SVG'],
  });
});


app.get('/api/system/storage-usage', (_req, res) => {
  try {
    res.json(computeLocalStorageUsage());
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Fish Audio Backend Status & Direct Proxy Endpoints
app.get('/api/fish/status', (req, res) => {
  res.json({
    configured: Boolean(extractBearerToken(req) || isFishAudioConfigured()),
    ttsModel: 's2.1-pro-free',
    asrModel: 'transcribe-1-pro',
  });
});

app.post(['/api/fish-audio', '/api/fish/tts'], async (req, res) => {
  try {
    const apiKey = extractBearerToken(req);

    if (req.body?.action === 'test') {
      if (!apiKey && !isFishAudioConfigured()) {
        res.status(401).json({
          ok: false,
          status: 'not_configured',
          error:
            'Fish Audio API key is missing. Add your personal API key in Settings -> Fish Audio API Settings.',
        });
        return;
      }
      const testRes = await testFishAudioConnection(apiKey);
      const httpStatus =
        testRes.status === 'connected'
          ? 200
          : testRes.status === 'invalid_key'
          ? 401
          : 502;
      res.status(httpStatus).json(testRes);
      return;
    }

    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'text is required for Fish Audio TTS.' });
      return;
    }
    const referenceIdRaw =
      req.body?.reference_id ?? req.body?.referenceId ?? req.body?.voiceId ?? req.body?.voice_id;
    const referenceId = typeof referenceIdRaw === 'string' ? referenceIdRaw.trim() : undefined;
    const rawFormat = String(req.body?.format || 'mp3').toLowerCase();
    const format = (['mp3', 'wav', 'pcm', 'opus'].includes(rawFormat) ? rawFormat : 'mp3') as
      | 'mp3'
      | 'wav'
      | 'pcm'
      | 'opus';
    const model = typeof req.body?.model === 'string' ? req.body.model.trim() : undefined;
    const speedRaw = Number(req.body?.prosody?.speed ?? req.body?.speakingSpeed ?? req.body?.speed);
    const speakingSpeed = Number.isFinite(speedRaw)
      ? Math.min(2.0, Math.max(0.5, speedRaw))
      : undefined;

    const audioBuffer = await synthesizeFishMp3Buffer({
      text,
      referenceId,
      format,
      model,
      speakingSpeed,
      apiKey,
    });

    const contentTypeMap = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
      opus: 'audio/ogg',
    };
    res.setHeader('Content-Type', contentTypeMap[format]);
    res.setHeader('Content-Length', String(audioBuffer.length));
    res.setHeader('Cache-Control', 'no-store');
    res.send(audioBuffer);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.all(['/api/fish-audio', '/api/fish/tts'], (_req, res) => {
  res
    .setHeader('Allow', 'POST')
    .status(405)
    .json({ error: 'Method Not Allowed. Only POST requests are accepted at /api/fish-audio.' });
});

app.post('/api/fish/asr', uploadMem.single('audio'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      res.status(400).json({ error: 'Multipart audio file ("audio") is required for Fish Audio ASR.' });
      return;
    }
    const duration = Math.max(1, Number(req.body?.duration) || 10);
    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string' ? req.body.sourceLanguage : undefined;
    const result = await transcribeVideoWithFishAudio({
      audioBuffer: req.file.buffer,
      audioFilename: req.file.originalname || 'audio.wav',
      projectId: String(req.body?.projectId || 'direct_asr'),
      duration,
      hasAudio: true,
      sourceLanguage,
      apiKey: extractBearerToken(req),
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Fish Audio Voice Library & Authorized Cloned Voices
app.get('/api/fish/voices', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    const selfOnly = req.query.self === 'true';
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const result = await listFishVoices({
      query,
      selfOnly,
      language,
      apiKey: extractBearerToken(req),
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Saved Custom Fish Audio Voices CRUD (persisted globally in SQLite app_settings)
app.get('/api/fish/saved-voices', (_req, res) => {
  res.json({ voices: getSavedFishVoices() });
});

app.post('/api/fish/saved-voices', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const voiceId = String(req.body?.voiceId || '').trim();
  const setDefault = Boolean(req.body?.isDefault);

  if (!name) {
    res.status(400).json({ error: 'Voice display name is required.' });
    return;
  }
  if (!voiceId) {
    res.status(400).json({ error: 'Fish Audio Voice ID is required.' });
    return;
  }

  const now = new Date().toISOString();
  const existing = getSavedFishVoices();
  const newVoice = {
    id: uuidv4(),
    name,
    voiceId,
    isDefault: setDefault || existing.length === 0,
    createdAt: now,
    updatedAt: now,
  };

  const next = existing
    .map((v) => (newVoice.isDefault ? { ...v, isDefault: false } : v))
    .concat(newVoice);

  saveSavedFishVoices(next);
  res.status(201).json({ voice: newVoice, voices: next });
});

app.patch('/api/fish/saved-voices/:id', (req, res) => {
  const existing = getSavedFishVoices();
  const found = existing.find((v) => v.id === req.params.id);
  if (!found) {
    res.status(404).json({ error: 'Saved voice not found.' });
    return;
  }

  const name =
    req.body?.name !== undefined ? String(req.body.name).trim() : found.name;
  const voiceId =
    req.body?.voiceId !== undefined ? String(req.body.voiceId).trim() : found.voiceId;
  const isDefault =
    req.body?.isDefault !== undefined ? Boolean(req.body.isDefault) : found.isDefault;

  if (!name || !voiceId) {
    res.status(400).json({ error: 'Both voice name and voice ID are required.' });
    return;
  }

  const now = new Date().toISOString();
  const next = existing.map((v) => {
    if (v.id === req.params.id) {
      return { ...v, name, voiceId, isDefault, updatedAt: now };
    }
    return isDefault ? { ...v, isDefault: false } : v;
  });

  saveSavedFishVoices(next);
  const updated = next.find((v) => v.id === req.params.id)!;
  res.json({ voice: updated, voices: next });
});

app.delete('/api/fish/saved-voices/:id', (req, res) => {
  const existing = getSavedFishVoices();
  const next = existing.filter((v) => v.id !== req.params.id);
  if (next.length === existing.length) {
    res.status(404).json({ error: 'Saved voice not found.' });
    return;
  }
  if (next.length > 0 && !next.some((v) => v.isDefault)) {
    next[0] = { ...next[0], isDefault: true };
  }
  saveSavedFishVoices(next);
  res.json({ deleted: true, voices: next });
});

app.post('/api/system/cleanup', (_req, res) => {
  const hours = Number(process.env.TEMP_RETENTION_HOURS || '24');
  const result = cleanupTempStorage(hours);
  res.json(result);
});

// Custom Fonts & Built-in Font Catalog / Resolution
app.get('/api/fonts', (_req, res) => {
  res.json({ fonts: listCustomFonts() });
});

app.get('/api/fonts/catalog', (_req, res) => {
  res.json({ builtin: BUILTIN_FONT_CATALOG, custom: listCustomFonts() });
});

app.get('/api/fonts/ensure', async (req, res) => {
  const family = typeof req.query.family === 'string' ? req.query.family : '';
  const weight = Number(req.query.weight || 700);
  const italic = req.query.italic === '1' || req.query.italic === 'true';
  try {
    const result = await ensureFontAvailable({ family, weight, italic });
    res.json(result);
  } catch (err) {
    res.json({
      available: false,
      family,
      resolvedWeight: weight,
      italic,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post('/api/fonts', uploadMem.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No font file uploaded.' });
      return;
    }
    const customFamily = typeof req.body?.family === 'string' ? req.body.family : undefined;
    const saved = saveFontFile(req.file.originalname, req.file.buffer, customFamily);
    const font = registerCustomFont({
      id: uuidv4(),
      family: saved.family,
      filename: saved.filename,
      filePath: saved.filePath,
      url: saved.url,
    });
    res.status(201).json({
      font,
      fonts: listCustomFonts(),
      exportCompatible: !/\.woff2?$/i.test(saved.filename),
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/fonts/:id', (req, res) => {
  const deleted = deleteCustomFont(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: 'Custom font not found.' });
    return;
  }
  res.json({ deleted: true, fonts: listCustomFonts() });
});

// Unified Persistent Preset Library CRUD + Import/Export
app.get('/api/presets', (req, res) => {
  const cat = req.query.category as PresetCategory | undefined;
  const presets = listPresets(cat && ['caption', 'filter', 'editing'].includes(cat) ? cat : undefined);
  res.json({ presets });
});

app.get('/api/presets/export', (_req, res) => {
  const presets = listPresets();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="recap_studio_presets.json"');
  res.send(JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), presets }, null, 2));
});

app.post('/api/presets/import', (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.presets)
      ? req.body.presets
      : Array.isArray(req.body)
      ? req.body
      : [];
    if (incoming.length === 0) {
      res.status(400).json({ error: 'Provide a valid presets array in the JSON payload.' });
      return;
    }
    const imported: StudioPreset[] = [];
    for (const raw of incoming) {
      if (!raw || !raw.name || !['caption', 'filter', 'editing'].includes(raw.category)) {
        continue;
      }
      const created = createPreset({
        id: uuidv4(),
        category: raw.category as PresetCategory,
        name: String(raw.name),
        description: typeof raw.description === 'string' ? raw.description : '',
        isDefault: Boolean(raw.isDefault),
        thumbnailStyle: raw.thumbnailStyle && typeof raw.thumbnailStyle === 'object' ? raw.thumbnailStyle : {},
        payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
        assetRefs: Array.isArray(raw.assetRefs) ? raw.assetRefs : [],
      });
      imported.push(created);
    }
    res.status(201).json({ importedCount: imported.length, imported, presets: listPresets() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/presets', (req, res) => {
  try {
    const category = req.body?.category as PresetCategory;
    const name = String(req.body?.name || '').trim();
    if (!['caption', 'filter', 'editing'].includes(category)) {
      res.status(400).json({ error: 'Valid preset category required (caption | filter | editing).' });
      return;
    }
    if (!name) {
      res.status(400).json({ error: 'Preset name is required.' });
      return;
    }
    const preset = createPreset({
      id: uuidv4(),
      category,
      name,
      description: typeof req.body?.description === 'string' ? req.body.description : '',
      isDefault: Boolean(req.body?.isDefault),
      thumbnailStyle: req.body?.thumbnailStyle || {},
      payload: req.body?.payload || {},
      assetRefs: Array.isArray(req.body?.assetRefs) ? req.body.assetRefs : [],
    });
    res.status(201).json({ preset, presets: listPresets() });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/presets/:id', (req, res) => {
  const updated = updatePreset(req.params.id, {
    name: req.body?.name,
    description: req.body?.description,
    isDefault: req.body?.isDefault,
    thumbnailStyle: req.body?.thumbnailStyle,
    payload: req.body?.payload,
    assetRefs: req.body?.assetRefs,
  });
  if (!updated) {
    res.status(404).json({ error: 'Preset not found.' });
    return;
  }
  res.json({ preset: updated, presets: listPresets() });
});

app.delete('/api/presets/:id', (req, res) => {
  const ok = deletePreset(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Preset not found.' });
    return;
  }
  res.json({ deleted: true, presets: listPresets() });
});

function applyPresetIdsToProject(
  project: Project,
  opts: {
    captionPresetId?: string | null;
    filterPresetId?: string | null;
    editingPresetId?: string | null;
    applyDefaults?: boolean;
    preserveCaptionEnabledState?: boolean;
  }
): { patch: Partial<Project>; warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> } {
  const allPresets = listPresets();
  const resolvePreset = (cat: PresetCategory, explicitId?: string | null): StudioPreset | undefined => {
    if (explicitId === 'none') return undefined;
    if (explicitId) return getPreset(explicitId) || undefined;
    if (opts.applyDefaults) {
      return allPresets.find((p) => p.category === cat && p.isDefault);
    }
    return undefined;
  };

  const capPreset = resolvePreset('caption', opts.captionPresetId);
  const filPreset = resolvePreset('filter', opts.filterPresetId);
  const edtPreset = resolvePreset('editing', opts.editingPresetId);

  const patch: Partial<Project> = {};
  const warnings: Array<{ presetName: string; missingAssets: StudioPresetAssetRef[] }> = [];

  if (capPreset) {
    const pStyle = (capPreset.payload?.subtitleStyle || capPreset.payload || {}) as Record<string, unknown>;
    const missingFont = (capPreset.missingAssets || []).filter((a) => a.kind === 'font');
    if (missingFont.length > 0) {
      warnings.push({ presetName: capPreset.name, missingAssets: missingFont });
    }
    const nextFontUrl =
      typeof pStyle.customFontUrl === 'string' && !checkAssetAvailableByUrl(pStyle.customFontUrl)
        ? undefined
        : (pStyle.customFontUrl as string | undefined);
    patch.subtitleStyle = {
      ...DEFAULT_SUBTITLE_STYLE,
      ...project.subtitleStyle,
      ...(pStyle as Partial<Project['subtitleStyle']>),
      customFontUrl: nextFontUrl,
      // Strict rule: never auto-enable captions when applying preset to a brand new video with 0 segments
      enabled: opts.preserveCaptionEnabledState
        ? Boolean(project.subtitleStyle.enabled)
        : Boolean(project.captions.length > 0 && (pStyle.enabled ?? project.subtitleStyle.enabled)),
    };
  }

  if (filPreset) {
    const pFx = (filPreset.payload?.videoEffects || filPreset.payload || {}) as Partial<Project['videoEffects']>;
    patch.videoEffects = {
      ...DEFAULT_VIDEO_EFFECTS,
      ...project.videoEffects,
      ...pFx,
    };
  }

  if (edtPreset) {
    const pEdt = edtPreset.payload as {
      canvas?: Partial<Project['canvas']>;
      exportSettings?: Partial<Project['exportSettings']>;
      logos?: Project['logos'];
    };
    const missing = edtPreset.missingAssets || [];
    if (missing.length > 0) {
      warnings.push({ presetName: edtPreset.name, missingAssets: missing });
    }
    if (pEdt.canvas) {
      const nextCanvas = {
        ...DEFAULT_VIDEO_CANVAS,
        ...(project.canvas || {}),
        ...pEdt.canvas,
      };
      if (nextCanvas.bgImageUrl && !checkAssetAvailableByUrl(nextCanvas.bgImageUrl)) {
        nextCanvas.bgImageUrl = undefined;
      }
      patch.canvas = nextCanvas;
    }
    if (pEdt.exportSettings) {
      patch.exportSettings = {
        ...project.exportSettings,
        ...pEdt.exportSettings,
      };
    }
    if (Array.isArray(pEdt.logos)) {
      const validLogos = pEdt.logos
        .filter((l) => l && l.url && checkAssetAvailableByUrl(l.url))
        .map((l) => ({ ...l, id: uuidv4() }));
      if (validLogos.length > 0) {
        patch.logos = [...project.logos, ...validLogos];
      }
    }
  }

  return { patch, warnings };
}

// Projects CRUD
app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects() });
});

app.post('/api/projects', (req, res) => {
  const name = String(req.body?.name || '').trim() || `Recap Project ${new Date().toLocaleDateString()}`;
  const created = createProject(uuidv4(), name);
  const { patch, warnings } = applyPresetIdsToProject(created, {
    captionPresetId: req.body?.captionPresetId,
    filterPresetId: req.body?.filterPresetId,
    editingPresetId: req.body?.editingPresetId,
    applyDefaults: Boolean(req.body?.applyDefaults),
    preserveCaptionEnabledState: false,
  });
  const finalProject = Object.keys(patch).length > 0 ? updateProject(created.id, patch)! : created;
  res.status(201).json({ project: finalProject, presetWarnings: warnings });
});

app.post('/api/projects/:id/apply-presets', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const { patch, warnings } = applyPresetIdsToProject(project, {
    captionPresetId: req.body?.captionPresetId,
    filterPresetId: req.body?.filterPresetId,
    editingPresetId: req.body?.editingPresetId,
    applyDefaults: false,
    preserveCaptionEnabledState: true,
  });
  const updated = Object.keys(patch).length > 0 ? updateProject(project.id, patch)! : project;
  res.json({ project: updated, presetWarnings: warnings });
});

app.get('/api/projects/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project });
});

app.patch('/api/projects/:id', (req, res) => {
  const updated = updateProject(req.params.id, req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ project: updated });
});

app.delete('/api/projects/:id', (req, res) => {
  const ok = deleteProject(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json({ deleted: true });
});

app.post('/api/projects/upsert-from-cloud', (req, res) => {
  try {
    const incoming = req.body?.project as Project | undefined;
    if (!incoming || !incoming.id) {
      res.status(400).json({ error: 'Valid project payload with id is required.' });
      return;
    }
    const project = upsertProjectFromCloud(incoming);
    res.json({ project });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/projects/:id/hydrate-asset', uploadMem.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Asset file is required.' });
      return;
    }
    const bucket = String(req.body?.bucket || 'uploads');
    const filename = String(req.body?.filename || req.file.originalname || 'asset.bin');
    const assetKind = String(req.body?.assetKind || bucket);
    const mimeType = String(req.body?.mimeType || req.file.mimetype || 'application/octet-stream');
    const targetLocalUrl =
      typeof req.body?.targetLocalUrl === 'string' ? req.body.targetLocalUrl : undefined;

    const saved = hydrateAssetToLocalBucket({
      projectId: req.params.id,
      targetLocalUrl,
      bucket,
      filename,
      assetKind,
      mimeType,
      buffer: req.file.buffer,
    });
    res.json({
      localUrl: saved.localUrl,
      filePath: saved.filePath,
      sizeBytes: saved.sizeBytes,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


// Inspect Project Assets (SHA-256 + Size + Free 50 MB single-file cap check)
app.get('/api/projects/:id/asset-manifest', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(inspectProjectAssets(project));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// User-Requested Local FFmpeg Compression (ONLY when user clicks compress; preserves original file)
app.post('/api/projects/:id/compress-video', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const rawPreset = String(req.body?.preset || 'under-45mb');
    const preset: CompressionPreset =
      rawPreset === '720p-compact' || rawPreset === '480p-compact'
        ? rawPreset
        : 'under-45mb';
    const target = req.body?.target === 'final-export' ? 'final-export' : 'source';

    const { project: _p, ...result } = await compressProjectVideoForFreeCloud({ project, preset, target });
    const updated =
      target === 'final-export'
        ? updateProject(project.id, {
            lastExportUrl: result.compressedUrl,
            lastExportSize: result.compressedBytes,
            lastExportedAt: new Date().toISOString(),
          })
        : updateProject(project.id, {
            sourceVideoUrl: result.compressedUrl,
            sourceFilename: result.filename,
            metadata: result.metadata,
          });
    res.json({
      project: updated,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});


// Generate a real FFmpeg-synthesized sample movie recap video for immediate pipeline testing
app.post('/api/projects/:id/sample-video', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const clip = await createDemoMovieRecapClip(project.id);
    const metadata = await analyzeVideoFile(clip.filePath);
    const thumbnailUrl = await generateVideoThumbnail(clip.filePath, project.id, 2);
    const waveformPeaks = await extractWaveformPeaks(clip.filePath, metadata.hasAudio);

    const updated = updateProject(project.id, {
      sourceVideoUrl: clip.url,
      sourceFilename: clip.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
    });
    if (!updated) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ project: updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Chunked Video Upload Flow
app.post('/api/uploads/init', (req, res) => {
  try {
    const { projectId, filename, totalSize, totalChunks } = req.body || {};
    if (!projectId || !filename || totalSize === undefined || totalChunks === undefined) {
      res.status(400).json({ error: 'Missing required chunk initialization parameters.' });
      return;
    }
    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const session = initChunkedUpload({
      projectId,
      filename: String(filename),
      totalSize: Number(totalSize),
      totalChunks: Number(totalChunks),
    });

    res.json({ uploadId: session.uploadId, totalChunks: session.totalChunks });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/uploads/:uploadId/chunk', (req, res) => {
  try {
    const chunkIndex = Number(req.query.index);
    const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!Buffer.isBuffer(req.body) || bodyBuf.length === 0) {
      res.status(400).json({ error: 'Expected non-empty binary application/octet-stream chunk payload.' });
      return;
    }
    const progress = saveUploadChunk(req.params.uploadId, chunkIndex, bodyBuf);
    res.json(progress);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/uploads/:uploadId/complete', async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || '');
    const existingProj = getProject(projectId);
    if (!existingProj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }

    const uploaded = await finalizeChunkedUpload(req.params.uploadId);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const seekSec =
      Number.isFinite(metadata.duration) && metadata.duration > 0
        ? Math.min(2, Math.max(0.2, metadata.duration * 0.15))
        : 0;
    const thumbnailUrl = await generateVideoThumbnail(uploaded.filePath, projectId, seekSec);
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(projectId, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl: thumbnailUrl ?? existingProj.thumbnailUrl,
      metadata,
      waveformPeaks,
      exportSettings: {
        ...existingProj.exportSettings,
        aspectRatio: existingProj.exportSettings.aspectRatio || 'original',
      },
    });
    if (!updated) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    res.json({ project: updated, metadata });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Direct Video Upload (Single-request multipart upload with Multer)
app.post('/api/projects/:id/video', uploadMem.single('file'), async (req, res) => {
  try {
    const projectId = req.params.id;
    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.' });
      return;
    }
    const uploaded = saveDirectVideoFile(projectId, req.file.originalname, req.file.buffer);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const thumbnailUrl = await generateVideoThumbnail(
      uploaded.filePath,
      projectId,
      Math.min(2, Math.max(0.2, metadata.duration * 0.15))
    );
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(projectId, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      exportSettings: {
        ...project.exportSettings,
        aspectRatio: project.exportSettings.aspectRatio || 'original',
      },
    });

    res.json({ project: updated, metadata });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/upload', uploadMem.single('file'), async (req, res) => {
  try {
    const projectId = String(req.body?.projectId || req.query?.projectId || '');
    if (!projectId) {
      res.status(400).json({ error: 'Missing projectId.' });
      return;
    }
    const project = getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.' });
      return;
    }
    const uploaded = saveDirectVideoFile(projectId, req.file.originalname, req.file.buffer);
    const metadata = await analyzeVideoFile(uploaded.filePath);
    const thumbnailUrl = await generateVideoThumbnail(
      uploaded.filePath,
      projectId,
      Math.min(2, Math.max(0.2, metadata.duration * 0.15))
    );
    const waveformPeaks = await extractWaveformPeaks(uploaded.filePath, metadata.hasAudio);

    const updated = updateProject(projectId, {
      sourceVideoUrl: uploaded.url,
      sourceFilename: uploaded.filename,
      thumbnailUrl,
      metadata,
      waveformPeaks,
      exportSettings: {
        ...project.exportSettings,
        aspectRatio: project.exportSettings.aspectRatio || 'original',
      },
    });

    res.json({ project: updated, metadata });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Logo PNG/SVG Upload
app.post('/api/projects/:id/logo', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No logo file uploaded' });
      return;
    }
    const saved = saveLogoFile(project.id, req.file.originalname, req.file.buffer);
    const newLogo = {
      id: uuidv4(),
      filename: saved.filename,
      url: saved.url,
      enabled: true,
      x: 0.78,
      y: 0.05,
      widthPct: 16,
      opacity: 0.9,
      permanent: true,
      startTime: 0,
      endTime: project.metadata?.duration || 30,
      presetPosition: 'top-right' as const,
      motion: {
        enabled: false,
        pattern: 'static' as const,
        speed: 1.0,
        endX: 0.78,
        endY: 0.8,
      },
    };
    const updated = updateProject(project.id, {
      logos: [...project.logos, newLogo],
    });
    res.json({ project: updated, logo: newLogo });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Canvas Background Image Upload (PNG/JPG/JPEG/WEBP)
app.post('/api/projects/:id/canvas-bg', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No background image file uploaded' });
      return;
    }
    const saved = saveCanvasBackgroundFile(
      project.id,
      req.file.originalname,
      req.file.buffer
    );
    const updated = updateProject(project.id, {
      canvas: {
        ...(project.canvas || {
          aspectRatio: 'original',
          customWidth: 1080,
          customHeight: 1920,
          zoom: 1,
          offsetX: 0,
          offsetY: 0,
          cropTop: 0,
          cropRight: 0,
          cropBottom: 0,
          cropLeft: 0,
          bgColor: '#09090B',
          bgImageScale: 1,
          bgImageOffsetX: 0,
          bgImageOffsetY: 0,
          bgBlurIntensity: 24,
          bgBlurBrightness: -15,
          bgBlurOpacity: 0.9,
        }),
        backgroundType: 'image',
        bgImageUrl: saved.url,
        bgImageFilename: saved.filename,
      },
    });
    res.json({ project: updated, url: saved.url, filename: saved.filename });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Music Upload
app.post('/api/projects/:id/music', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No audio file uploaded' });
      return;
    }
    const saved = saveMusicFile(project.id, req.file.originalname, req.file.buffer);
    const updated = updateProject(project.id, {
      voice: {
        ...project.voice,
        bgMusicFilename: saved.filename,
        bgMusicUrl: saved.url,
        bgMusicEnabled: true,
        bgMusicMuted: false,
        bgMusicVolume: project.voice.bgMusicVolume > 0.01 ? project.voice.bgMusicVolume : 0.25,
      },
    });
    res.json({ project: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Sound Effects (SFX) Upload
app.post('/api/projects/:id/sfx', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No SFX audio file uploaded' });
      return;
    }
    const saved = saveSfxFile(project.id, req.file.originalname, req.file.buffer);
    const updated = updateProject(project.id, {
      voice: {
        ...project.voice,
        sfxFilename: saved.filename,
        sfxUrl: saved.url,
        sfxEnabled: true,
        sfxMuted: false,
        sfxVolume: project.voice.sfxVolume ?? 1.0,
      },
    });
    res.json({ project: updated });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Segmentation Mask PNG Upload
app.post('/api/projects/:id/mask', (req, res) => {
  try {
    const { blurId, maskBase64 } = req.body || {};
    if (!blurId || !maskBase64) {
      res.status(400).json({ error: 'blurId and maskBase64 are required' });
      return;
    }
    const saved = saveSegmentationMaskImage(req.params.id, blurId, maskBase64);
    res.json({ maskUrl: saved.url, assetId: saved.assetId });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Audio Extraction
app.post('/api/projects/:id/audio/extract', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl) {
      res.status(404).json({ error: 'Project video not found' });
      return;
    }
    if (!project.metadata?.hasAudio) {
      res.status(400).json({ error: 'Source video has no audio track' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Video asset missing on disk' });
      return;
    }
    const extractedPath = await extractAudioTrack(asset.file_path, project.id, 'wav');
    const filename = path.basename(extractedPath);
    res.json({
      audioUrl: `/media/audio/${filename}`,
      downloadUrl: `/media/audio/${filename}?download=1`,
      filename,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Transcription (supports Fish Audio ASR or Gemini ASR)
app.post('/api/projects/:id/transcribe', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before running AI transcription.' });
      return;
    }
    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Source video file not found.' });
      return;
    }

    const requestedProvider = req.body?.provider as 'fish' | 'gemini' | undefined;
    const useFish = requestedProvider === 'fish' || (!requestedProvider && isFishAudioConfigured());
    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string'
        ? req.body.sourceLanguage
        : project.translation.sourceLanguage;

    const result = useFish
      ? await transcribeVideoWithFishAudio({
          videoPath: asset.file_path,
          projectId: project.id,
          duration: project.metadata.duration,
          hasAudio: project.metadata.hasAudio,
          sourceLanguage,
        })
      : await transcribeVideoWithGemini({
          videoPath: asset.file_path,
          projectId: project.id,
          duration: project.metadata.duration,
          hasAudio: project.metadata.hasAudio,
        });

    const updated = updateProject(project.id, {
      captions: result.segments,
      translation: {
        ...project.translation,
        sourceLanguage: result.detectedLanguage,
      },
    });

    res.json({
      project: updated,
      detectedLanguage: result.detectedLanguage,
      segmentCount: result.segments.length,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio ASR Transcription Route (supports server-stored video OR multipart extracted audio from browser)
app.post('/api/projects/:id/dubbing/transcribe', uploadMem.single('audio'), async (req, res) => {
  try {
    const project = getProject(req.params.id);
    const sourceLanguage =
      typeof req.body?.sourceLanguage === 'string'
        ? req.body.sourceLanguage
        : project?.translation?.sourceLanguage;

    let result: { segments: import('./src/types/studio.ts').CaptionSegment[]; detectedLanguage: string };

    if (req.file && req.file.buffer && req.file.buffer.length > 0) {
      const duration = Math.max(1, Number(req.body?.duration) || project?.metadata?.duration || 10);
      result = await transcribeVideoWithFishAudio({
        audioBuffer: req.file.buffer,
        audioFilename: req.file.originalname || 'browser_audio.wav',
        projectId: req.params.id,
        duration,
        hasAudio: true,
        sourceLanguage,
        apiKey: extractBearerToken(req),
      });
    } else {
      if (!project || !project.sourceVideoUrl || !project.metadata) {
        res.status(404).json({
          error: 'Upload a video or send extracted browser audio before running Fish Audio transcription.',
        });
        return;
      }
      const asset = getAssetByUrl(project.sourceVideoUrl);
      if (!asset) {
        res.status(404).json({ error: 'Source video file not found.' });
        return;
      }
      result = await transcribeVideoWithFishAudio({
        videoPath: asset.file_path,
        projectId: project.id,
        duration: project.metadata.duration,
        hasAudio: project.metadata.hasAudio,
        sourceLanguage,
        apiKey: extractBearerToken(req),
      });
    }

    const updated =
      project &&
      updateProject(project.id, {
        captions: result.segments,
        translation: {
          ...project.translation,
          sourceLanguage: result.detectedLanguage,
        },
      });

    res.json({
      project: updated || {
        id: req.params.id,
        captions: result.segments,
        translation: {
          sourceLanguage: result.detectedLanguage,
          targetLanguage: 'French',
          preserveProperNouns: true,
          lastTranslatedAt: null,
        },
      },
      detectedLanguage: result.detectedLanguage,
      segmentCount: result.segments.length,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio Voice Preview Route (s2.1-pro-free -> MP3)
app.post('/api/projects/:id/dubbing/preview', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'Preview text is required' });
      return;
    }
    const referenceId =
      typeof req.body?.referenceId === 'string'
        ? req.body.referenceId
        : project?.voice?.fishReferenceId;
    const preview = await generateFishVoicePreview({
      projectId: req.params.id,
      text,
      referenceId,
      speakingSpeed: 1.0,
      apiKey: extractBearerToken(req),
    });

    res.json({ audioUrl: preview.audioUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dedicated Fish Audio Full Synchronized Dubbing Route (Background Job: s2.1-pro-free -> segmented MP3s -> merged MP3)
app.post('/api/projects/:id/dubbing/generate', (req, res) => {
  try {
    const project = getProject(req.params.id);
    const captions = Array.isArray(req.body?.captions)
      ? req.body.captions
      : project?.captions || [];

    const voiceConfig = {
      ...(project?.voice || ({} as Project['voice'])),
      ...(req.body?.voice || {}),
      provider: 'fish' as const,
      syncMode: normalizeSyncMode(req.body?.voice?.syncMode ?? project?.voice?.syncMode),
      continuousPauseMs: clampContinuousPauseMs(
        req.body?.voice?.continuousPauseMs ?? project?.voice?.continuousPauseMs
      ),
      speakingSpeed: 1.0,
      enabled: true,
    };

    const useTranslated =
      req.body?.useTranslated !== undefined
        ? Boolean(req.body.useTranslated)
        : true;
    const totalDuration =
      Number(req.body?.totalDuration) || project?.metadata?.duration || undefined;

    if (project) {
      updateProject(project.id, {
        captions,
        voice: voiceConfig,
      });
    }

    const job = enqueueFishDubJob({
      projectId: req.params.id,
      voiceConfig,
      captions,
      useTranslated,
      totalDuration,
      apiKey: extractBearerToken(req),
    });

    res.status(202).json({ job });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Re-synchronize existing 1.0x MP3 clips under Continuous, Smart Gap Removal (Flexible), or Original duration mode
app.post('/api/projects/:id/dubbing/resync', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    const voiceInput = req.body?.voice || project?.voice;
    const captions = Array.isArray(req.body?.captions)
      ? req.body.captions
      : project?.captions || [];
    const totalDuration = Number(req.body?.totalDuration) || project?.metadata?.duration;

    if (!voiceInput || !totalDuration) {
      res.status(404).json({ error: 'Project video metadata not found.' });
      return;
    }

    const syncMode: SyncMode = normalizeSyncMode(req.body?.syncMode ?? voiceInput.syncMode);
    const continuousPauseMs = clampContinuousPauseMs(
      req.body?.continuousPauseMs ?? voiceInput.continuousPauseMs
    );

    if (voiceInput.generatedClips && voiceInput.generatedClips.length > 0) {
      const resynced = await resyncExistingFishClips({
        projectId: req.params.id,
        captions,
        voiceConfig: voiceInput,
        originalDuration: totalDuration,
        syncMode,
        continuousPauseMs,
      });

      const nextVoice = {
        ...voiceInput,
        syncMode,
        continuousPauseMs,
        speakingSpeed: 1.0,
        generatedClips: resynced.clips,
        fullDubUrl: resynced.fullDubUrl,
        syncPlan: resynced.syncPlan,
      };
      const updated = project ? updateProject(project.id, { voice: nextVoice }) : null;
      res.json({ project: updated || { id: req.params.id, voice: nextVoice } });
      return;
    }

    const nextVoice = {
      ...voiceInput,
      syncMode,
      continuousPauseMs,
      syncPlan: voiceInput.syncPlan
        ? { ...voiceInput.syncPlan, syncMode, pauseDurationMs: continuousPauseMs }
        : undefined,
    };
    const updated = project ? updateProject(project.id, { voice: nextVoice }) : null;
    res.json({ project: updated || { id: req.params.id, voice: nextVoice } });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Dubbing Diagnostic Report Route
app.get('/api/projects/:id/dubbing/diagnostic', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const report = generateDubDiagnosticReport(project);
    const fullTrackAudit = await inspectFullDubTrackDiagnostics(project).catch(() => null);
    res.json({ report, fullTrackAudit });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Selective Fish Audio Regeneration (Only regenerates specified corrected segment IDs, preserving passing clips & 1.0x speed)
app.post('/api/projects/:id/dubbing/regenerate-segments', async (req, res) => {
  try {
    const segmentIds = Array.isArray(req.body?.segmentIds) ? req.body.segmentIds : [];
    const result = await regenerateFishSegments({
      projectId: req.params.id,
      segmentIds,
      captions: Array.isArray(req.body?.captions) ? req.body.captions : undefined,
      voiceConfig: req.body?.voice,
      useTranslated:
        req.body?.useTranslated !== undefined ? Boolean(req.body.useTranslated) : undefined,
      totalDuration:
        typeof req.body?.totalDuration === 'number' ? req.body.totalDuration : undefined,
      apiKey: extractBearerToken(req),
    });
    res.json(result);
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Language Translation (supports server-stored or client-side IndexedDB project captions)
app.post('/api/projects/:id/translate', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    const captions = Array.isArray(req.body?.captions)
      ? req.body.captions
      : project?.captions;

    if (!captions || !Array.isArray(captions)) {
      res.status(404).json({ error: 'Project captions not found' });
      return;
    }

    const sourceLanguage =
      req.body?.sourceLanguage || project?.translation?.sourceLanguage || 'Auto';
    const targetLanguage = (
      req.body?.targetLanguage ||
      project?.translation?.targetLanguage ||
      'French'
    ) as SupportedLanguage;
    const preserveProperNouns =
      req.body?.preserveProperNouns !== undefined
        ? Boolean(req.body.preserveProperNouns)
        : Boolean(project?.translation?.preserveProperNouns ?? true);

    const translatedSegments = await translateCaptionsWithGemini({
      captions,
      sourceLanguage,
      targetLanguage,
      preserveProperNouns,
    });

    const translationMeta = {
      ...(project?.translation || {
        sourceLanguage,
        targetLanguage,
        preserveProperNouns,
        lastTranslatedAt: null,
      }),
      sourceLanguage,
      targetLanguage,
      preserveProperNouns,
      lastTranslatedAt: new Date().toISOString(),
    };

    if (project) {
      const updated = updateProject(project.id, {
        captions: translatedSegments,
        translation: translationMeta,
        subtitleStyle: {
          ...project.subtitleStyle,
          useTranslated: true,
        },
      });
      res.json({ project: updated });
      return;
    }

    res.json({
      project: {
        id: req.params.id,
        captions: translatedSegments,
        translation: translationMeta,
        subtitleStyle: {
          useTranslated: true,
        },
      },
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// SRT / VTT Subtitle Export
app.get('/api/projects/:id/subtitles/:format', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const format = req.params.format.toLowerCase();
  if (format === 'srt') {
    const srt = generateSrtContent(project.captions, project.subtitleStyle);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/\s+/g, '_')}.srt"`);
    res.send(srt);
    return;
  }
  if (format === 'vtt') {
    const vtt = generateVttContent(project.captions, project.subtitleStyle);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/\s+/g, '_')}.vtt"`);
    res.send(vtt);
    return;
  }
  res.status(400).json({ error: 'Supported formats: srt, vtt' });
});

// Import SRT / VTT Subtitle File
app.post('/api/projects/:id/captions/import', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const rawContent = String(req.body?.content || '').trim();
    if (!rawContent) {
      res.status(400).json({ error: 'No subtitle content provided in request body' });
      return;
    }
    const parsed = parseSrtOrVtt(rawContent);
    if (parsed.length === 0) {
      res.status(400).json({ error: 'Could not parse any valid subtitle segments from file' });
      return;
    }
    const updated = updateProject(project.id, { captions: parsed });
    res.json({ project: updated, count: parsed.length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Voice Preview
app.post('/api/projects/:id/voice/preview', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ error: 'Preview text is required' });
      return;
    }

    const preview = await generateSingleVoicePreview({
      projectId: project.id,
      text,
      voiceName: (req.body?.voiceName || project.voice.voiceName) as GeminiVoiceName,
      style: String(req.body?.style || project.voice.style),
      targetLanguage: (req.body?.targetLanguage || project.voice.targetLanguage) as SupportedLanguage,
      speakingSpeed: 1.0,
    });

    res.json({ audioUrl: preview.audioUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// AI Voice Full Synchronized Dubbing
app.post('/api/projects/:id/voice/generate', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.metadata) {
      res.status(404).json({ error: 'Project video not found' });
      return;
    }

    const voiceConfig = {
      ...project.voice,
      ...(req.body?.voice || {}),
      enabled: true,
    };

    const useTranslated =
      req.body?.useTranslated !== undefined
        ? Boolean(req.body.useTranslated)
        : project.subtitleStyle.useTranslated;

    const generated = await generateSynchronizedVoiceover({
      projectId: project.id,
      captions: project.captions,
      voiceConfig,
      useTranslated,
      totalDuration: project.metadata.duration,
    });

    const updated = updateProject(project.id, {
      voice: {
        ...voiceConfig,
        generatedClips: generated.clips,
        fullDubUrl: generated.fullDubUrl,
      },
    });

    res.json({ project: updated, fullDubUrl: generated.fullDubUrl });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// One-Click Video Audio Language Change (Auto-Transcribe -> Translate -> Synchronized AI Dubbing)
app.post('/api/projects/:id/voice/auto-dub', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !project.sourceVideoUrl || !project.metadata) {
      res.status(404).json({ error: 'Upload a video before dubbing its audio.' });
      return;
    }

    const asset = getAssetByUrl(project.sourceVideoUrl);
    if (!asset) {
      res.status(404).json({ error: 'Source video file not found.' });
      return;
    }

    const voiceConfig = {
      ...project.voice,
      ...(req.body?.voice || {}),
      syncMode: normalizeSyncMode(req.body?.voice?.syncMode ?? project.voice.syncMode),
      continuousPauseMs: clampContinuousPauseMs(
        req.body?.voice?.continuousPauseMs ?? project.voice.continuousPauseMs
      ),
      speakingSpeed: 1.0,
      enabled: true,
    };
    const useFish = voiceConfig.provider === 'fish' || isFishAudioConfigured();
    const targetLanguage = voiceConfig.targetLanguage as SupportedLanguage;
    const preserveProperNouns =
      req.body?.preserveProperNouns !== undefined
        ? Boolean(req.body.preserveProperNouns)
        : project.translation.preserveProperNouns;

    let captions = project.captions;
    let sourceLanguage = project.translation.sourceLanguage || 'Auto';

    // Step 1: Transcribe original video audio if captions do not yet exist
    if (!captions || captions.length === 0) {
      const transcribed = useFish
        ? await transcribeVideoWithFishAudio({
            videoPath: asset.file_path,
            projectId: project.id,
            duration: project.metadata.duration,
            hasAudio: project.metadata.hasAudio,
            sourceLanguage,
          })
        : await transcribeVideoWithGemini({
            videoPath: asset.file_path,
            projectId: project.id,
            duration: project.metadata.duration,
            hasAudio: project.metadata.hasAudio,
          });
      captions = transcribed.segments;
      sourceLanguage = transcribed.detectedLanguage;
    }

    // Step 2: Translate segments into target language
    const translatedCaptions = await translateCaptionsWithGemini({
      captions,
      sourceLanguage,
      targetLanguage,
      preserveProperNouns,
    });

    // Step 3: Generate synchronized TTS voiceover in target language
    const generated = useFish
      ? await generateFishSynchronizedDub({
          projectId: project.id,
          captions: translatedCaptions,
          voiceConfig,
          useTranslated: true,
          totalDuration: project.metadata.duration,
        })
      : await generateSynchronizedVoiceover({
          projectId: project.id,
          captions: translatedCaptions,
          voiceConfig,
          useTranslated: true,
          totalDuration: project.metadata.duration,
        });

    const generatedSyncPlan = 'syncPlan' in generated ? generated.syncPlan : undefined;

    const updated = updateProject(project.id, {
      captions: translatedCaptions,
      translation: {
        sourceLanguage,
        targetLanguage,
        preserveProperNouns,
        lastTranslatedAt: new Date().toISOString(),
      },
      subtitleStyle: {
        ...project.subtitleStyle,
        useTranslated: true,
      },
      voice: {
        ...voiceConfig,
        generatedClips: generated.clips,
        fullDubUrl: generated.fullDubUrl,
        ...(generatedSyncPlan ? { syncPlan: generatedSyncPlan } : {}),
      },
    });

    res.json({
      project: updated,
      sourceLanguage,
      targetLanguage,
      fullDubUrl: generated.fullDubUrl,
    });
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode || 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Professional 5-Option High-Res Thumbnail Frame Extraction (from final export or cropped/graded source)
app.post('/api/projects/:id/thumbnails/generate', async (req, res) => {
  const project = getProject(req.params.id);
  if (!project || !project.sourceVideoUrl) {
    res.status(404).json({ error: 'Project or source video not found.' });
    return;
  }
  try {
    let targetVideoPath: string | null = null;
    let sourceMode: 'final-export' | 'edited-source' = 'edited-source';
    let duration = project.metadata?.duration || 10;

    // Prefer final rendered MP4 if it exists on disk and export isn't marked outdated
    const exportIsOutdated = Boolean(project.workflow?.needsAttentionStages?.includes('export'));
    if (project.lastExportUrl && !exportIsOutdated) {
      const exportAsset = getAssetByUrl(project.lastExportUrl);
      if (exportAsset && fs.existsSync(exportAsset.file_path)) {
        targetVideoPath = exportAsset.file_path;
        sourceMode = 'final-export';
        const meta = await analyzeVideoFile(targetVideoPath).catch(() => null);
        if (meta?.duration) duration = meta.duration;
      }
    }

    let vfFilter: string | undefined;
    if (!targetVideoPath) {
      const asset = getAssetByUrl(project.sourceVideoUrl);
      if (!asset || !fs.existsSync(asset.file_path)) {
        res.status(404).json({ error: 'Source video file not found on disk.' });
        return;
      }
      targetVideoPath = asset.file_path;

      // Apply user's current Stage 5 crop & color filter so source frames reflect editing choices
      const canvas = { ...DEFAULT_VIDEO_CANVAS, ...(project.canvas || {}) };
      const srcW = project.metadata?.width || 1280;
      const srcH = project.metadata?.height || 720;
      const rect = resolveSourceCropRect(srcW, srcH, canvas);
      const dims = resolveCanvasDimensions(canvas, project.exportSettings, project.metadata);
      const filterParts: string[] = [];
      if (rect.cw < srcW || rect.ch < srcH) {
        filterParts.push(`crop=${rect.cw}:${rect.ch}:${rect.cx}:${rect.cy}`);
      }
      filterParts.push(
        `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=increase,crop=${dims.width}:${dims.height}`
      );
      if (project.videoEffects) {
        const fxRes = buildVideoEffectsFilters({
          config: project.videoEffects,
          startLabel: 'v_base',
          outputLabel: 'v_fx_out',
        });
        for (const step of fxRes.filterSteps) {
          if (step.includes('split') || step.includes('][')) continue;
          const cleanFilter = step
            .replace(/^\[[^\]]+\]/, '')
            .replace(/\[[^\]]+\]$/, '')
            .trim();
          if (cleanFilter && cleanFilter !== 'null' && !cleanFilter.includes('vignette=')) {
            filterParts.push(cleanFilter);
          }
        }
      }
      vfFilter = filterParts.join(',');
    }

    const timestamps = [
      Math.max(0.25, Number((duration * 0.1).toFixed(2))),
      Math.max(0.5, Number((duration * 0.28).toFixed(2))),
      Math.max(0.75, Number((duration * 0.48).toFixed(2))),
      Math.max(1.0, Number((duration * 0.68).toFixed(2))),
      Math.max(1.25, Number((duration * 0.88).toFixed(2))),
    ];
    const urls: string[] = [];
    for (const t of timestamps) {
      const thumbUrl = await generateHighResVideoFrame(targetVideoPath, project.id, t, vfFilter);
      urls.push(thumbUrl);
    }

    // Strict rule: derive suggested titles/subtitles ONLY from project.name and segment.translatedText (NEVER seg.text)
    const translatedLines = project.captions
      .map((c) => (c.translatedText || '').trim())
      .filter(Boolean);
    const shortHooks = translatedLines
      .map((line) => {
        const words = line.split(/\s+/).filter(Boolean);
        return words.slice(0, 6).join(' ');
      })
      .filter(Boolean);

    const suggestedTitles = [
      project.name || shortHooks[0] || 'Movie Recap',
      shortHooks[0] || project.name || 'Full Recap',
      shortHooks[1] || shortHooks[0] || project.name || 'Hidden Twist',
      shortHooks[2] || shortHooks[0] || project.name || 'The Ending',
      shortHooks[shortHooks.length - 1] || project.name || 'Watch Until End',
    ];

    res.json({
      thumbnails: urls,
      sourceMode,
      suggestedTitle: suggestedTitles[0],
      suggestedSubtitle: translatedLines[0] || '',
      suggestedTitles,
      translationMissingWarning: translatedLines.length === 0,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Save a rendered composite thumbnail (TikTok PNG/JPG) onto project storage so it syncs across devices
app.post('/api/projects/:id/thumbnails/save', uploadMem.single('file'), (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'Thumbnail image file is required.' });
      return;
    }
    const format = req.body?.format === 'jpg' ? 'jpg' : 'png';
    const label = String(req.body?.label || 'TikTok Thumbnail').slice(0, 80);
    const width = Number(req.body?.width) || 1080;
    const height = Number(req.body?.height) || 1920;
    const thumbId = uuidv4();
    const safeFilename = `tiktok_thumb_${project.id.slice(0, 8)}_${thumbId.slice(0, 8)}.${format}`;
    const thumbUrl = `/media/thumbs/${safeFilename}`;
    const saved = hydrateAssetToLocalBucket({
      projectId: project.id,
      targetLocalUrl: thumbUrl,
      bucket: 'thumbs',
      filename: safeFilename,
      assetKind: 'thumbnail',
      mimeType: format === 'jpg' ? 'image/jpeg' : 'image/png',
      buffer: req.file.buffer,
    });

    const newThumb = {
      id: thumbId,
      url: saved.localUrl,
      label,
      width,
      height,
      format: format as 'png' | 'jpg',
      createdAt: new Date().toISOString(),
    };
    const nextSaved = [newThumb, ...(project.savedThumbnails || [])].slice(0, 20);
    const updated = updateProject(project.id, {
      savedThumbnails: nextSaved,
      thumbnailUrl: req.body?.setAsCover === 'true' ? saved.localUrl : project.thumbnailUrl,
    });
    res.json({ thumbnail: newThumb, project: updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Background Render / Export Jobs
app.post('/api/projects/:id/export', (req, res) => {
  try {
    if (req.body?.exportSettings) {
      updateProject(req.params.id, { exportSettings: req.body.exportSettings });
    }
    const job = enqueueRenderJob(req.params.id);
    res.status(202).json({ job });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/projects/:id/jobs', (req, res) => {
  res.json({ jobs: listProjectJobs(req.params.id) });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const dubResult = getFishDubJobResult(job.id);
  res.json(dubResult ? { job, dubResult } : { job });
});

app.get('/api/jobs', (_req, res) => {
  res.json({ jobs: listAllJobs() });
});

// Express JSON error handler for Multer size limits and unexpected server errors
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[API Error] ${req.method} ${req.originalUrl}:`, err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `Uploaded file exceeds the 55 MB direct multipart limit. Use the chunked upload flow (/api/uploads/init) for videos up to ${Math.round(
          getMaxUploadBytes() / (1024 * 1024)
        )} MB.`,
      });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: message });
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const distPath = path.resolve('./dist');
  const distIndexPath = path.join(distPath, 'index.html');

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distIndexPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(distIndexPath);
    });
  } else {
    app.get('/', (_req, res) => {
      res.json({
        ok: true,
        service: 'recap-studio-backend',
        mode: 'api-only',
        health: '/health',
        systemStatus: '/api/system/status',
      });
    });
    app.use('/api/*', (_req, res) => {
      res.status(404).json({ error: 'API endpoint not found.' });
    });
  }

  // Schedule periodic temp file cleanup every 6 hours
  setInterval(() => {
    cleanupTempStorage(Number(process.env.TEMP_RETENTION_HOURS || '24'));
  }, 6 * 3600 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    const allowedOrigins = parseAllowedOrigins();
    console.log(`Recap Studio AI server listening on http://0.0.0.0:${PORT}`);
    console.log(
      `[Config] mode=${isProd ? 'production' : 'development'} storageDir=${STORAGE_DIR} corsOrigins=${
        allowedOrigins.length > 0 ? allowedOrigins.join(',') : 'auto(*.pages.dev,localhost)'
      }`
    );
  });
}

startServer();
