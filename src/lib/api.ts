/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import {
  CloudAssetKind,
  DEFAULT_VIDEO_CANVAS,
  FishVoiceModel,
  GeminiVoiceName,
  PresetCategory,
  Project,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StudioPreset,
  StudioPresetAssetRef,
  SupportedLanguage,
  SyncMode,
  SystemStatus,
  VideoMetadata,
} from '../types/studio';
import {
  BUILTIN_FONT_CATALOG,
  ensureFontLoaded,
  type FontCatalogItem,
} from './fontCatalog';
import {
  cleanupOrphanedBrowserMedia,
  collectProjectMediaUris,
  computeBlobSha256,
  deleteMediaAsset,
  deleteProjectMediaAssets,
  getBrowserMediaUsage,
  getCachedObjectUrl,
  getMediaBlob,
  getMediaRecord,
  isLocalMediaUri,
  resolveBrowserMediaUrl,
  saveMediaBlob,
} from './browserMediaStore';
import {
  dataUrlToBlob,
  extractBrowserAsrAudioChunks,
  extractBrowserAudioTrack,
  extractBrowserThumbnailFrames,
  probeAudioDuration,
  probeVideoMetadataAndCover,
  synthesizeBrowserSampleVideo,
  validateAudioFile,
  validateBrowserVideoFile,
  validateFontFile,
  validateImageFile,
} from './browserVideoProcessor';
import {
  compressBrowserVideo,
  renderProjectInBrowser,
} from './browserVideoExporter';
import {
  fetchFishAudioFromEndpoint,
  generateEdgeFishDubbing,
  renderMergedDubWavFromClips,
} from './browserAudioDubbing';
import {
  FishConnectionStatus,
  FishIntegrationSnapshot,
  getLastFishSnapshot,
  getPersonalFishApiKey,
  hasPersonalFishApiKey,
  loadPersonalFishKeyState,
  setLastFishSnapshot,
} from './fishKeyStore';
import {
  GeminiConnectionStatus,
  getPersonalGeminiApiKey,
  hasPersonalGeminiApiKey,
} from './geminiKeyStore';
import { syncSpeakersFromCaptions } from './speakers';
import {
  applySyncPlanToClips,
  buildTimelineSyncPlan,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import {
  applyPresetsToProjectObject,
  buildDefaultProject,
  ClientPresetApplyOptions,
  ClientPresetWarning,
  createPresetLocal,
  createSavedFishVoiceLocal,
  deleteCustomFontLocal,
  deletePresetLocal,
  deleteProjectLocal,
  deleteSavedFishVoiceLocal,
  generateSrtContent,
  generateVttContent,
  getJobLocal,
  getProjectLocal,
  importPresetsLocal,
  listAllJobsLocal,
  listCustomFontsLocal,
  listPresetsLocal,
  listProjectJobsLocal,
  listProjectsLocal,
  listSavedFishVoicesLocal,
  parseSrtOrVtt,
  saveCustomFontLocal,
  saveProjectLocal,
  updatePresetLocal,
  updateProjectLocal,
  updateSavedFishVoiceLocal,
  upsertJobLocal,
} from './clientStore';

export type PresetApplyOptions = ClientPresetApplyOptions;
export type PresetWarning = ClientPresetWarning;

const edgeVoiceJobIds = new Set<string>();

export interface LocalAssetManifestItem {
  localUrl: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  exists: boolean;
  exceedsFree50MbCap: boolean;
  necessaryForCloudSync: boolean;
}

// Optional external AI API base URL (only used for server-side key-protected Gemini / Fish Audio AI calls)
export const API_BASE_URL = String(
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) ||
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_URL) ||
    ''
)
  .trim()
  .replace(/\/+$/, '');

export function resolveApiUrl(path: string): string {
  if (!path) return '';
  if (isLocalMediaUri(path)) {
    return getCachedObjectUrl(path);
  }
  if (
    path.startsWith('http://') ||
    path.startsWith('https://') ||
    path.startsWith('blob:') ||
    path.startsWith('data:')
  ) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

function isFishEndpointPath(url: string): boolean {
  return (
    url.startsWith('/api/fish') ||
    url.includes('/dubbing/') ||
    url.startsWith('/api/system/status')
  );
}

function isGeminiEndpointPath(url: string): boolean {
  return (
    url.startsWith('/api/gemini') ||
    url.includes('/translate') ||
    url.startsWith('/api/system/status')
  );
}

function isHtmlResponseText(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.includes('</html>');
}

function scrubSecretFromText(text: string, ...secrets: Array<string | null | undefined>): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      clean = clean.split(secret).join('[redacted]');
    }
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  clean = clean.replace(/[?&]key=[^&\s"']+/gi, '?key=[redacted]');
  return clean;
}

async function aiBackendRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = resolveApiUrl(url);
  const headers = new Headers(init?.headers || {});
  let usedFishKey: string | null = null;
  let usedGeminiKey: string | null = null;

  if (isFishEndpointPath(url) && !headers.has('Authorization')) {
    usedFishKey = await getPersonalFishApiKey();
    if (usedFishKey) {
      headers.set('Authorization', `Bearer ${usedFishKey}`);
    }
  }
  if (isGeminiEndpointPath(url) && !headers.has('X-Gemini-Api-Key')) {
    usedGeminiKey = await getPersonalGeminiApiKey();
    if (usedGeminiKey) {
      headers.set('X-Gemini-Api-Key', usedGeminiKey);
    }
  }

  let res: Response;
  try {
    res = await fetch(fullUrl, { ...init, headers });
  } catch (err) {
    const detail = scrubSecretFromText(
      err instanceof Error ? err.message : String(err),
      usedFishKey,
      usedGeminiKey
    );
    throw new Error(
      `Automated AI service is unreachable (${detail}). Video handling, preview, export, SRT/VTT import, and External Gemini (No Key) work 100% locally in your browser.`
    );
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const raw = await res.text();
  const looksHtml = contentType.includes('text/html') || isHtmlResponseText(raw);

  let data: Record<string, unknown> | null = null;
  if (raw && !looksHtml) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 405 || res.status === 404) {
      const serverErr = typeof data?.error === 'string' ? data.error : '';
      if (serverErr) {
        throw new Error(scrubSecretFromText(serverErr, usedFishKey, usedGeminiKey));
      }
      throw new Error(
        `API endpoint ${url} is unavailable on static hosting (HTTP ${res.status}). Ensure Cloudflare Pages Functions (/functions/api/*) are deployed, or use External Gemini (No Key) mode.`
      );
    }
    const errMsg =
      typeof data?.error === 'string'
        ? data.error
        : looksHtml
        ? `Received HTML error page instead of JSON from ${url} (HTTP ${res.status}).`
        : `AI request failed (${res.status})`;
    throw new Error(scrubSecretFromText(errMsg, usedFishKey, usedGeminiKey));
  }
  if (!data) {
    if (looksHtml) {
      throw new Error(
        `API route ${url} returned an HTML page instead of JSON. Deploy Cloudflare Pages with the /functions directory enabled (avoid static-only uploads without Functions).`
      );
    }
    throw new Error(`Unexpected non-JSON response from AI endpoint (${url}).`);
  }
  return data as T;
}

export async function processLocalVideoUpload(params: {
  projectId: string;
  file: File;
  onProgress: (pct: number, stage: string) => void;
}): Promise<Project> {
  const { projectId, file, onProgress } = params;
  validateBrowserVideoFile(file);

  const existing = await getProjectLocal(projectId);
  if (!existing) {
    throw new Error('Target project not found in browser storage.');
  }

  onProgress(6, 'Validating video stream locally in browser...');
  const { metadata, coverBlob, waveformPeaks } = await probeVideoMetadataAndCover(
    file,
    file.name,
    onProgress
  );

  // Store disk-backed File/Blob handle & revoke prior video + thumbnail Object URLs cleanly
  const savedVideo = await saveMediaBlob({
    bucket: 'video',
    filename: file.name,
    blob: file,
    mimeType: file.type || 'video/mp4',
    existingUrlToRevoke: existing.sourceVideoUrl,
  });

  let nextThumbUrl = existing.thumbnailUrl;
  if (coverBlob) {
    const savedThumb = await saveMediaBlob({
      bucket: 'thumbs',
      filename: `${file.name.replace(/\.[^.]+$/, '')}_cover.jpg`,
      blob: coverBlob,
      mimeType: 'image/jpeg',
      existingUrlToRevoke: existing.thumbnailUrl,
    });
    nextThumbUrl = savedThumb.uri;
  } else if (existing.thumbnailUrl) {
    await deleteMediaAsset(existing.thumbnailUrl);
    nextThumbUrl = null;
  }

  if (existing.lastExportUrl) {
    await deleteMediaAsset(existing.lastExportUrl);
  }

  const updated = await updateProjectLocal(projectId, {
    sourceVideoUrl: savedVideo.uri,
    sourceFilename: file.name,
    thumbnailUrl: nextThumbUrl,
    metadata,
    waveformPeaks,
    lastExportUrl: null,
    lastExportSize: null,
    lastExportedAt: null,
  });

  onProgress(100, 'Video ready in browser workspace');
  return updated;
}

// Legacy alias kept so any callers continue compiling without backend calls
export const uploadVideoChunked = processLocalVideoUpload;

export const api = {
  // Diagnostics: returns real browser status + optional AI server status without failing static sites
  getSystemStatus: async (): Promise<SystemStatus> => {
    const [localFishState, localGeminiConfigured] = await Promise.all([
      loadPersonalFishKeyState(),
      hasPersonalGeminiApiKey(),
    ]);
    const localFishConfigured = Boolean(localFishState.apiKey);
    try {
      const serverStatus = await aiBackendRequest<SystemStatus>('/api/system/status');
      const fishKeySource: SystemStatus['fishKeySource'] = localFishConfigured
        ? 'request_header'
        : serverStatus.fishKeySource === 'server_env' || serverStatus.fishConfigured
        ? 'server_env'
        : 'none';
      const functionsActive =
        typeof serverStatus.functionsActive === 'boolean' ? serverStatus.functionsActive : true;

      // Sync non-auth dimensions of snapshot without claiming authenticated unless verified
      const prev = getLastFishSnapshot();
      const localStorageMode: FishIntegrationSnapshot['localStorageMode'] = localFishConfigured
        ? localFishState.rememberOnDevice
          ? 'indexeddb'
          : 'session'
        : 'none';
      const resolvedKeySource: FishIntegrationSnapshot['keySource'] = localFishConfigured
        ? localStorageMode === 'indexeddb'
          ? 'indexeddb'
          : 'session'
        : fishKeySource === 'server_env'
        ? 'server_env'
        : 'none';
      setLastFishSnapshot({
        ...prev,
        integrationConfigured: functionsActive,
        localKeySaved: localFishConfigured,
        localStorageMode,
        keySource: resolvedKeySource,
        status:
          resolvedKeySource === 'none' && prev.status !== 'connection_error'
            ? 'not_configured'
            : prev.status === 'not_configured' && resolvedKeySource !== 'none'
            ? 'unverified'
            : prev.status,
      });

      return {
        ...serverStatus,
        fishConfigured: Boolean(serverStatus.fishConfigured || localFishConfigured),
        fishKeySource,
        functionsActive,
        geminiConfigured: Boolean(serverStatus.geminiConfigured || localGeminiConfigured),
      };
    } catch {
      const prev = getLastFishSnapshot();
      setLastFishSnapshot({
        ...prev,
        integrationConfigured: false,
        localKeySaved: localFishConfigured,
        localStorageMode: localFishConfigured
          ? localFishState.rememberOnDevice
            ? 'indexeddb'
            : 'session'
          : 'none',
        keySource: localFishConfigured
          ? localFishState.rememberOnDevice
            ? 'indexeddb'
            : 'session'
          : 'none',
        authenticated: false,
        serviceReachable: false,
      });
      return {
        geminiConfigured: localGeminiConfigured,
        fishConfigured: localFishConfigured,
        fishKeySource: localFishConfigured ? 'request_header' : 'none',
        functionsActive: false,
        ffmpegAvailable: typeof MediaRecorder !== 'undefined',
        ffprobeAvailable: typeof HTMLVideoElement !== 'undefined',
        ffmpegVersion: 'Browser Canvas + MediaRecorder',
        storageDir: 'Browser IndexedDB + File API',
        maxUploadSizeMb: 2048,
        tempRetentionHours: 24,
        supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
        supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
      };
    }
  },

  testGeminiConnection: async (overrideKey?: string): Promise<{
    ok: boolean;
    status: GeminiConnectionStatus;
    message: string;
  }> => {
    const rawKey = overrideKey !== undefined ? overrideKey : await getPersonalGeminiApiKey();
    const keyToTest = (rawKey || '').trim();
    if (!keyToTest) {
      return {
        ok: false,
        status: 'not_configured',
        message: 'No Gemini API key configured. Enter and save your personal key, or use External Gemini (No Key) mode for free.',
      };
    }

    const endpointUrl = resolveApiUrl('/api/gemini/test');
    let res: Response;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gemini-Api-Key': keyToTest,
        },
        body: JSON.stringify({ action: 'test' }),
      });
    } catch (err) {
      const detail = scrubSecretFromText(err instanceof Error ? err.message : String(err), keyToTest);
      return {
        ok: false,
        status: 'connection_error',
        message: `Unable to reach /api/gemini/test (${detail}).`,
      };
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text().catch(() => '');
    const looksHtml = contentType.includes('text/html') || isHtmlResponseText(raw);
    let parsed: Record<string, unknown> | null = null;
    if (raw && !looksHtml) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (res.ok && parsed?.ok) {
      return {
        ok: true,
        status: 'connected',
        message:
          typeof parsed.message === 'string'
            ? parsed.message
            : 'Connected to Gemini API (gemini-2.5-flash).',
      };
    }

    const rawErr =
      (typeof parsed?.error === 'string' && parsed.error) ||
      (typeof parsed?.message === 'string' && parsed.message) ||
      (looksHtml
        ? `Backend endpoint /api/gemini/test returned HTML instead of JSON (${res.status}). Deploy Cloudflare Pages Functions.`
        : `Gemini connection check failed (${res.status}).`);
    const cleanErr = scrubSecretFromText(rawErr, keyToTest);

    if (res.status === 401 || res.status === 403 || parsed?.status === 'invalid_key') {
      return {
        ok: false,
        status: 'invalid_key',
        message: cleanErr || 'Invalid Gemini API key or insufficient permissions.',
      };
    }

    return {
      ok: false,
      status: 'connection_error',
      message: cleanErr,
    };
  },

  testFishConnection: async (
    overrideKey?: string,
    opts?: { allowServerFallback?: boolean; updateSnapshot?: boolean }
  ): Promise<{
    ok: boolean;
    status: FishConnectionStatus;
    authenticated: boolean;
    serviceReachable: boolean;
    integrationConfigured: boolean;
    localKeySaved: boolean;
    localStorageMode: 'indexeddb' | 'session' | 'none';
    keySource: 'indexeddb' | 'session' | 'server_env' | 'none';
    message: string;
    credit?: string;
  }> => {
    const allowServerFallback = Boolean(opts?.allowServerFallback);
    const shouldUpdateSnapshot = opts?.updateSnapshot !== false;
    const localState = await loadPersonalFishKeyState();
    const localKeySaved = Boolean(localState.apiKey);
    const localStorageMode: 'indexeddb' | 'session' | 'none' = localKeySaved
      ? localState.rememberOnDevice
        ? 'indexeddb'
        : 'session'
      : 'none';

    const rawKey = overrideKey !== undefined ? overrideKey : localState.apiKey;
    const keyToTest = (rawKey || '').trim();
    const defaultKeySource: 'indexeddb' | 'session' | 'server_env' | 'none' = keyToTest
      ? localState.apiKey === keyToTest
        ? localStorageMode === 'indexeddb'
          ? 'indexeddb'
          : 'session'
        : localStorageMode !== 'none'
        ? localStorageMode
        : 'session'
      : allowServerFallback
      ? 'server_env'
      : 'none';

    const finalize = (result: {
      ok: boolean;
      status: FishConnectionStatus;
      authenticated: boolean;
      serviceReachable: boolean;
      integrationConfigured: boolean;
      keySource: 'indexeddb' | 'session' | 'server_env' | 'none';
      message: string;
      credit?: string;
    }) => {
      const fullResult = {
        ...result,
        localKeySaved,
        localStorageMode,
      };
      if (shouldUpdateSnapshot) {
        setLastFishSnapshot({
          status: result.status,
          integrationConfigured: result.integrationConfigured,
          localKeySaved,
          localStorageMode,
          keySource: result.keySource,
          authenticated: result.authenticated,
          serviceReachable: result.serviceReachable,
          message: result.message,
          checkedAt: new Date().toISOString(),
        });
      }
      return fullResult;
    };

    if (!keyToTest && !allowServerFallback) {
      return finalize({
        ok: false,
        status: 'not_configured',
        authenticated: false,
        serviceReachable: getLastFishSnapshot().serviceReachable,
        integrationConfigured: getLastFishSnapshot().integrationConfigured,
        keySource: 'none',
        message: 'No Fish Audio API key configured. Enter and save your personal API key.',
      });
    }

    const endpointUrl = resolveApiUrl('/api/fish-audio');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (keyToTest) {
      headers.Authorization = `Bearer ${keyToTest}`;
    }

    let res: Response;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'test' }),
      });
    } catch (err) {
      const detail = scrubSecretFromText(err instanceof Error ? err.message : String(err), keyToTest);
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: false,
        integrationConfigured: false,
        keySource: keyToTest ? defaultKeySource : 'none',
        message: `Unable to reach /api/fish-audio (${detail}).`,
      });
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const raw = await res.text().catch(() => '');
    const looksHtml = contentType.includes('text/html') || isHtmlResponseText(raw);

    // CRITICAL: Never blame API key validity when Cloudflare/proxy returns an HTML fallback or error page
    if (looksHtml) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: false,
        integrationConfigured: false,
        keySource: keyToTest ? defaultKeySource : 'none',
        message: `API endpoint /api/fish-audio returned an HTML page instead of JSON (HTTP ${res.status}). Ensure Cloudflare Pages Functions (/functions/api/fish-audio.js) are deployed cleanly.`,
      });
    }

    let parsed: Record<string, unknown> | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }

    if (!parsed) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: false,
        integrationConfigured: res.status !== 404 && res.status !== 405,
        keySource: keyToTest ? defaultKeySource : 'none',
        message: `Unexpected non-JSON response from /api/fish-audio (HTTP ${res.status}).`,
      });
    }

    const resolvedKeySource: 'indexeddb' | 'session' | 'server_env' | 'none' =
      parsed.keySource === 'server_env'
        ? 'server_env'
        : parsed.keySource === 'none'
        ? 'none'
        : defaultKeySource;

    const cleanServerMsg = scrubSecretFromText(
      (typeof parsed.error === 'string' && parsed.error) ||
        (typeof parsed.message === 'string' && parsed.message) ||
        `Connection check failed (${res.status}).`,
      keyToTest
    );

    // Only accept authenticated=true when response explicitly succeeded with ok===true and authenticated!==false
    if (res.ok && parsed.ok === true && parsed.authenticated !== false) {
      return finalize({
        ok: true,
        status: 'connected',
        authenticated: true,
        serviceReachable: parsed.serviceReachable !== false,
        integrationConfigured: true,
        keySource: resolvedKeySource === 'none' ? defaultKeySource : resolvedKeySource,
        message:
          typeof parsed.message === 'string'
            ? parsed.message
            : 'Connected & authenticated with Fish Audio API.',
        credit: typeof parsed.credit === 'string' ? parsed.credit : undefined,
      });
    }

    // Missing key (both local & server)
    if (parsed.status === 'not_configured' || (res.status === 401 && resolvedKeySource === 'none')) {
      return finalize({
        ok: false,
        status: 'not_configured',
        authenticated: false,
        serviceReachable: Boolean(parsed.serviceReachable),
        integrationConfigured: true,
        keySource: 'none',
        message:
          cleanServerMsg ||
          'No Fish Audio API key configured. Enter and save your personal API key.',
      });
    }

    // Policy block (HTTPS/CORS/Origin 403 from our own Edge/server middleware) is NEVER an invalid API key
    if (parsed.code === 'SECURITY_POLICY_BLOCKED') {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: false,
        integrationConfigured: true,
        keySource: resolvedKeySource,
        message: cleanServerMsg,
      });
    }

    // Explicit authentication failure from Fish Audio upstream (HTTP 401 or JSON status === 'invalid_key')
    if (parsed.status === 'invalid_key' || res.status === 401) {
      return finalize({
        ok: false,
        status: 'invalid_key',
        authenticated: false,
        serviceReachable: parsed.serviceReachable !== false,
        integrationConfigured: true,
        keySource: resolvedKeySource,
        message: cleanServerMsg || 'Invalid Fish Audio API key or unauthorized access.',
      });
    }

    // Non-auth 403 (WAF/gateway policy) -> connection_error, NOT invalid_key
    if (res.status === 403) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: Boolean(parsed.serviceReachable),
        integrationConfigured: true,
        keySource: resolvedKeySource,
        message: cleanServerMsg || 'Access blocked by gateway or origin policy (HTTP 403).',
      });
    }

    if (res.status === 402) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: parsed.authenticated === true,
        serviceReachable: true,
        integrationConfigured: true,
        keySource: resolvedKeySource,
        message: cleanServerMsg || 'Fish Audio account balance or credits are insufficient.',
      });
    }

    if (res.status === 429) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: parsed.authenticated === true,
        serviceReachable: true,
        integrationConfigured: true,
        keySource: resolvedKeySource,
        message: cleanServerMsg || 'Fish Audio API rate limit exceeded. Please wait and try again.',
      });
    }

    if (res.status === 405 || res.status === 404) {
      return finalize({
        ok: false,
        status: 'connection_error',
        authenticated: false,
        serviceReachable: false,
        integrationConfigured: false,
        keySource: resolvedKeySource,
        message:
          cleanServerMsg ||
          `Backend endpoint /api/fish-audio is unavailable (HTTP ${res.status}). Deploy with Cloudflare Pages Functions enabled.`,
      });
    }

    return finalize({
      ok: false,
      status: 'connection_error',
      authenticated: parsed.authenticated === true,
      serviceReachable: parsed.serviceReachable === true,
      integrationConfigured: true,
      keySource: resolvedKeySource,
      message: cleanServerMsg,
    });
  },

  getLocalStorageUsage: () => getBrowserMediaUsage(),

  runCleanup: async () => {
    const [projects, fonts] = await Promise.all([listProjectsLocal(), listCustomFontsLocal()]);
    const removedFiles = await cleanupOrphanedBrowserMedia(
      projects,
      fonts.map((f) => f.url)
    );
    return { removedFiles };
  },

  getProjectAssetManifest: async (projectId: string) => {
    const project = await getProjectLocal(projectId);
    if (!project) {
      return { assets: [], totalBytes: 0, necessaryBytes: 0, oversizedCount: 0 };
    }
    const items = collectProjectMediaUris(project);
    const assets: LocalAssetManifestItem[] = [];
    let totalBytes = 0;
    let necessaryBytes = 0;
    let oversizedCount = 0;

    for (const item of items) {
      const rec = await getMediaRecord(item.uri);
      const exists = Boolean(rec && rec.blob);
      const sizeBytes = rec?.sizeBytes || 0;
      const sha256 = rec?.blob ? await computeBlobSha256(rec.blob) : '';
      const exceedsFree50MbCap = sizeBytes > 50 * 1024 * 1024;
      if (exists) {
        totalBytes += sizeBytes;
        if (item.necessary) necessaryBytes += sizeBytes;
        if (exceedsFree50MbCap) oversizedCount += 1;
      }
      assets.push({
        localUrl: item.uri,
        bucket: item.bucket,
        filename: item.filename,
        assetKind: item.assetKind,
        mimeType: rec?.mimeType || 'application/octet-stream',
        sizeBytes,
        sha256,
        exists,
        exceedsFree50MbCap,
        necessaryForCloudSync: item.necessary,
      });
    }

    return { assets, totalBytes, necessaryBytes, oversizedCount };
  },

  compressProjectVideo: async (
    projectId: string,
    preset: 'under-45mb' | '720p-compact' | '480p-compact',
    target: 'source' | 'final-export' = 'source'
  ) => {
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const res = await compressBrowserVideo({ project, preset, target });
    const patch: Partial<Project> =
      target === 'final-export'
        ? {
            lastExportUrl: res.compressedUri,
            lastExportSize: res.compressedBytes,
            lastExportedAt: new Date().toISOString(),
          }
        : {
            sourceVideoUrl: res.compressedUri,
            sourceFilename: res.filename,
            metadata: res.metadata,
          };
    const updated = await updateProjectLocal(projectId, patch);
    return {
      project: updated,
      compressedUrl: res.compressedUri,
      filename: res.filename,
      originalSourceUrl: project.sourceVideoUrl || '',
      originalBytes: res.originalBytes,
      compressedBytes: res.compressedBytes,
      metadata: res.metadata,
      target,
    };
  },

  saveProjectThumbnail: async (
    projectId: string,
    params: {
      blob: Blob;
      label: string;
      width: number;
      height: number;
      format: 'png' | 'jpg';
      setAsCover?: boolean;
    }
  ) => {
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const saved = await saveMediaBlob({
      bucket: 'thumbs',
      filename: `saved_${Date.now()}.${params.format}`,
      blob: params.blob,
      mimeType: params.format === 'png' ? 'image/png' : 'image/jpeg',
    });
    const entry = {
      id: uuidv4(),
      url: saved.uri,
      label: params.label,
      width: params.width,
      height: params.height,
      format: params.format,
      createdAt: new Date().toISOString(),
    };
    const nextSavedThumbs = [entry, ...(project.savedThumbnails || [])].slice(0, 24);
    const updated = await updateProjectLocal(projectId, {
      savedThumbnails: nextSavedThumbs,
      ...(params.setAsCover ? { thumbnailUrl: saved.uri } : {}),
    });
    return { thumbnail: entry, project: updated };
  },

  upsertProjectFromCloud: async (project: Project) => {
    const saved = await saveProjectLocal(project);
    await resolveBrowserMediaUrl(saved.sourceVideoUrl).catch(() => null);
    return { project: saved };
  },

  hydrateAssetFromBlob: async (
    _projectId: string,
    params: {
      blob: Blob;
      bucket: string;
      filename: string;
      assetKind: CloudAssetKind;
      mimeType: string;
      targetLocalUrl?: string;
    }
  ) => {
    const saved = await saveMediaBlob({
      bucket: params.bucket,
      filename: params.filename,
      blob: params.blob,
      mimeType: params.mimeType,
      targetUri: params.targetLocalUrl,
    });
    return {
      localUrl: saved.uri,
      filePath: saved.uri,
      sizeBytes: saved.sizeBytes,
    };
  },

  // Fish Saved Voices (IndexedDB)
  listSavedFishVoices: async () => ({ voices: await listSavedFishVoicesLocal() }),
  createSavedFishVoice: (params: { name: string; voiceId: string; isDefault?: boolean }) =>
    createSavedFishVoiceLocal(params),
  updateSavedFishVoice: (
    id: string,
    params: { name?: string; voiceId?: string; isDefault?: boolean }
  ) => updateSavedFishVoiceLocal(id, params),
  deleteSavedFishVoice: (id: string) => deleteSavedFishVoiceLocal(id),

  // Custom Fonts (IndexedDB + Browser FontFace)
  listCustomFonts: async () => ({ fonts: await listCustomFontsLocal() }),
  getFontCatalog: async () => ({
    builtin: BUILTIN_FONT_CATALOG as FontCatalogItem[],
    custom: await listCustomFontsLocal(),
  }),
  ensureFont: async (family: string, weight = 700, italic = false) => {
    const customFonts = await listCustomFontsLocal();
    const match = customFonts.find((f) => f.family.toLowerCase() === family.toLowerCase());
    const status = await ensureFontLoaded({
      family,
      weight,
      italic,
      customUrl: match?.url,
    });
    return {
      available: status.status === 'loaded',
      family: status.family,
      resolvedWeight: weight,
      italic,
      url: match?.url,
      source: status.source,
      exportCompatible: status.availableForExport,
      error: status.error,
    };
  },
  uploadCustomFont: async (file: File, family?: string) => {
    validateFontFile(file);
    const cleanFamily =
      (family || file.name.replace(/\.[^.]+$/, '')).replace(/[^a-zA-Z0-9 _-]+/g, ' ').trim() ||
      'Custom Font';
    const saved = await saveMediaBlob({
      bucket: 'fonts',
      filename: file.name,
      blob: file,
      mimeType: file.type || 'font/ttf',
    });
    const font: SavedFontAsset = {
      id: uuidv4(),
      family: cleanFamily,
      filename: saved.filename,
      url: saved.uri,
      createdAt: new Date().toISOString(),
    };
    const fonts = await saveCustomFontLocal(font);
    await ensureFontLoaded({ family: cleanFamily, customUrl: saved.uri });
    return { font, fonts, exportCompatible: true };
  },
  deleteCustomFont: async (id: string) => {
    const current = await listCustomFontsLocal();
    const target = current.find((f) => f.id === id);
    if (target?.url) {
      await deleteMediaAsset(target.url);
    }
    const fonts = await deleteCustomFontLocal(id);
    return { deleted: Boolean(target), fonts };
  },

  // Presets (IndexedDB)
  listPresets: async (category?: PresetCategory) => ({
    presets: await listPresetsLocal(category),
  }),
  createPreset: createPresetLocal,
  updatePreset: updatePresetLocal,
  deletePreset: deletePresetLocal,
  importPresets: importPresetsLocal,
  downloadPresetsJson: async () => {
    const presets = await listPresetsLocal();
    const blob = new Blob([JSON.stringify({ presets }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recap-studio-presets.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  // Projects (IndexedDB)
  listProjects: async () => ({ projects: await listProjectsLocal() }),
  createProject: async (name: string, presetOpts?: PresetApplyOptions) => {
    const base = buildDefaultProject(name);
    const { project, presetWarnings } = await applyPresetsToProjectObject(base, presetOpts);
    const saved = await saveProjectLocal(project);
    return { project: saved, presetWarnings };
  },
  applyPresetsToProject: async (projectId: string, presetOpts: PresetApplyOptions) => {
    const existing = await getProjectLocal(projectId);
    if (!existing) throw new Error('Project not found.');
    const { project, presetWarnings } = await applyPresetsToProjectObject(existing, presetOpts);
    const saved = await saveProjectLocal(project);
    return { project: saved, presetWarnings };
  },
  getProject: async (id: string) => {
    const project = await getProjectLocal(id);
    if (!project) throw new Error('Project not found.');
    return { project };
  },
  updateProject: async (id: string, patch: Partial<Project>) => ({
    project: await updateProjectLocal(id, patch),
  }),
  deleteProject: async (id: string) => {
    const existing = await getProjectLocal(id);
    if (existing) {
      await deleteProjectMediaAssets(existing);
    }
    await deleteProjectLocal(id);
    return { deleted: true };
  },

  // Remove Source Video & clean Object URLs in memory
  removeProjectVideo: async (projectId: string) => {
    const existing = await getProjectLocal(projectId);
    if (!existing) throw new Error('Project not found.');
    if (existing.sourceVideoUrl) await deleteMediaAsset(existing.sourceVideoUrl);
    if (existing.thumbnailUrl) await deleteMediaAsset(existing.thumbnailUrl);
    if (existing.lastExportUrl) await deleteMediaAsset(existing.lastExportUrl);
    const updated = await updateProjectLocal(projectId, {
      sourceVideoUrl: null,
      sourceFilename: null,
      thumbnailUrl: null,
      metadata: null,
      waveformPeaks: [],
      lastExportUrl: null,
      lastExportSize: null,
      lastExportedAt: null,
    });
    return { project: updated };
  },

  // Sample Video generated natively in Browser Canvas + Web Audio + MediaRecorder
  createSampleVideo: async (
    projectId: string,
    onProgress?: (pct: number, stage: string) => void
  ) => {
    const existing = await getProjectLocal(projectId);
    if (!existing) throw new Error('Project not found.');

    const synth = await synthesizeBrowserSampleVideo(onProgress);
    const { metadata, coverBlob, waveformPeaks } = await probeVideoMetadataAndCover(
      synth.blob,
      synth.filename,
      onProgress
    );

    const savedVideo = await saveMediaBlob({
      bucket: 'video',
      filename: synth.filename,
      blob: synth.blob,
      mimeType: synth.mimeType,
      existingUrlToRevoke: existing.sourceVideoUrl,
    });

    let nextThumb: string | null = null;
    if (coverBlob) {
      const savedThumb = await saveMediaBlob({
        bucket: 'thumbs',
        filename: 'sample_cover.jpg',
        blob: coverBlob,
        mimeType: 'image/jpeg',
        existingUrlToRevoke: existing.thumbnailUrl,
      });
      nextThumb = savedThumb.uri;
    }

    const sampleCaptions = [
      {
        id: uuidv4(),
        start: 0.2,
        end: 1.4,
        text: 'At 2:14 AM, the observatory roof dome unlocked from inside.',
        translatedText: 'At 2:14 AM, the observatory roof dome unlocked from inside.',
      },
      {
        id: uuidv4(),
        start: 1.5,
        end: 2.8,
        text: 'Fourteen minutes of security tape were missing.',
        translatedText: 'Fourteen minutes of security tape were missing.',
      },
      {
        id: uuidv4(),
        start: 2.9,
        end: 4.1,
        text: 'Nobody entered the vault—someone left it.',
        translatedText: 'Nobody entered the vault—someone left it.',
      },
    ];

    const updated = await updateProjectLocal(projectId, {
      sourceVideoUrl: savedVideo.uri,
      sourceFilename: savedVideo.filename,
      thumbnailUrl: nextThumb,
      metadata,
      waveformPeaks,
      captions: existing.captions.length > 0 ? existing.captions : sampleCaptions,
    });
    return { project: updated };
  },

  // Media Overlays & Tracks (100% Browser File API + IndexedDB)
  uploadLogo: async (projectId: string, file: File) => {
    validateImageFile(file, ['png', 'svg', 'jpg', 'jpeg', 'webp']);
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const saved = await saveMediaBlob({
      bucket: 'logos',
      filename: file.name,
      blob: file,
      mimeType: file.type || 'image/png',
    });
    const logoId = uuidv4();
    const newLogo = {
      id: logoId,
      filename: file.name,
      url: saved.uri,
      enabled: true,
      x: 0.78,
      y: 0.04,
      widthPct: 16,
      opacity: 0.9,
      rotation: 0,
      locked: false,
      permanent: true,
      startTime: 0,
      endTime: project.metadata?.duration || 30,
      presetPosition: 'top-right' as const,
      motion: { enabled: false, pattern: 'static' as const, speed: 1 },
    };
    const nextLogos = [...project.logos, newLogo];
    const nextCanvas = {
      ...DEFAULT_VIDEO_CANVAS,
      ...(project.canvas || {}),
      layerOrder: [
        ...(project.canvas?.layerOrder || ['bg-image', 'video']),
        `logo:${logoId}`,
      ],
    };
    const updated = await updateProjectLocal(projectId, {
      logos: nextLogos,
      canvas: nextCanvas,
    });
    return { project: updated };
  },

  uploadCanvasBackground: async (projectId: string, file: File) => {
    validateImageFile(file, ['png', 'jpg', 'jpeg', 'webp']);
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const saved = await saveMediaBlob({
      bucket: 'backgrounds',
      filename: file.name,
      blob: file,
      mimeType: file.type || 'image/jpeg',
      existingUrlToRevoke: project.canvas?.bgImageUrl,
    });
    const nextCanvas = {
      ...DEFAULT_VIDEO_CANVAS,
      ...(project.canvas || {}),
      backgroundType: 'image' as const,
      bgImageUrl: saved.uri,
      bgImageFilename: file.name,
    };
    const updated = await updateProjectLocal(projectId, { canvas: nextCanvas });
    return { project: updated, url: saved.uri, filename: file.name };
  },

  uploadMusic: async (projectId: string, file: File) => {
    validateAudioFile(file);
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    await probeAudioDuration(file).catch(() => 0);
    const saved = await saveMediaBlob({
      bucket: 'audio',
      filename: file.name,
      blob: file,
      mimeType: file.type || 'audio/mpeg',
      existingUrlToRevoke: project.voice.bgMusicUrl,
    });
    const updated = await updateProjectLocal(projectId, {
      voice: {
        ...project.voice,
        bgMusicEnabled: true,
        bgMusicMuted: false,
        bgMusicUrl: saved.uri,
        bgMusicFilename: file.name,
        bgMusicVolume: project.voice.bgMusicVolume > 0 ? project.voice.bgMusicVolume : 0.3,
      },
    });
    return { project: updated };
  },

  uploadSfx: async (projectId: string, file: File) => {
    validateAudioFile(file);
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const saved = await saveMediaBlob({
      bucket: 'audio',
      filename: file.name,
      blob: file,
      mimeType: file.type || 'audio/mpeg',
      existingUrlToRevoke: project.voice.sfxUrl,
    });
    const updated = await updateProjectLocal(projectId, {
      voice: {
        ...project.voice,
        sfxEnabled: true,
        sfxMuted: false,
        sfxUrl: saved.uri,
        sfxFilename: file.name,
        sfxVolume: project.voice.sfxVolume ?? 0.85,
      },
    });
    return { project: updated };
  },

  uploadMask: async (projectId: string, blurId: string, maskBase64: string) => {
    const project = await getProjectLocal(projectId);
    if (!project) throw new Error('Project not found.');
    const blob = dataUrlToBlob(maskBase64);
    const existingBlur = project.blurs.find((b) => b.id === blurId);
    const saved = await saveMediaBlob({
      bucket: 'masks',
      filename: `${blurId}.png`,
      blob,
      mimeType: 'image/png',
      existingUrlToRevoke: existingBlur?.maskAssetId,
    });
    const nextBlurs = project.blurs.map((b) =>
      b.id === blurId ? { ...b, maskAssetId: saved.uri } : b
    );
    await updateProjectLocal(projectId, { blurs: nextBlurs });
    return { maskUrl: saved.uri, assetId: saved.uri };
  },

  extractAudio: async (projectId: string) => {
    const project = await getProjectLocal(projectId);
    if (!project || !project.sourceVideoUrl) {
      throw new Error('No source video available to extract audio.');
    }
    return extractBrowserAudioTrack({
      sourceUri: project.sourceVideoUrl,
      sourceFilename: project.sourceFilename,
    });
  },

  importCaptions: async (projectId: string, content: string) => {
    const segments = parseSrtOrVtt(content);
    if (segments.length === 0) {
      throw new Error('No valid subtitle entries found in SRT/VTT file.');
    }
    const updated = await updateProjectLocal(projectId, {
      captions: segments,
    });
    return { project: updated, count: segments.length };
  },

  downloadSubtitlesFile: async (project: Project, format: 'srt' | 'vtt') => {
    const content =
      format === 'srt'
        ? generateSrtContent(project.captions)
        : generateVttContent(project.captions);
    const blob = new Blob([content], {
      type: format === 'srt' ? 'application/x-subrip' : 'text/vtt',
    });
    const url = URL.createObjectURL(blob);
    const safeName = (project.name || 'subtitles').replace(/[^a-zA-Z0-9._-]+/g, '_');
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  },

  generateThumbnails: async (projectId: string) => {
    const project = await getProjectLocal(projectId);
    if (!project || !project.sourceVideoUrl) {
      throw new Error('No source video available to extract thumbnails.');
    }
    const sourceUri = project.lastExportUrl || project.sourceVideoUrl;
    const isFinal = Boolean(project.lastExportUrl);
    const thumbnails = await extractBrowserThumbnailFrames({
      sourceUri,
      canvas: isFinal ? undefined : project.canvas,
      videoEffects: isFinal ? undefined : project.videoEffects,
    });

    // Derive suggested titles strictly from project.name and segment.translatedText (NEVER seg.text)
    const translatedLines = project.captions
      .map((c) => (c.translatedText || '').trim())
      .filter(Boolean);
    const shortHooks = translatedLines
      .map((line) => {
        const words = line.split(/\s+/).slice(0, 6).join(' ');
        return words.length > 36 ? `${words.slice(0, 35)}…` : words;
      })
      .filter(Boolean);

    const suggestedTitle = shortHooks[0] || project.name || 'Movie Recap';
    const suggestedTitles = Array.from(
      new Set([
        suggestedTitle,
        shortHooks[1] || `${project.name} Explained`,
        shortHooks[2] || `Shocking Ending · ${project.name}`,
        shortHooks[3] || `The Truth Behind ${project.name}`,
        shortHooks[4] || `${project.name} Full Story`,
      ])
    ).slice(0, 5);

    return {
      thumbnails,
      sourceMode: isFinal ? ('final-export' as const) : ('edited-source' as const),
      suggestedTitle,
      suggestedSubtitle: translatedLines[0] || '',
      suggestedTitles,
      translationMissingWarning: translatedLines.length === 0,
    };
  },

  // Export Pipeline (100% Browser Canvas + Web Audio + MediaRecorder)
  startExport: async (projectId: string, exportSettings: Project['exportSettings']) => {
    const project = await getProjectLocal(projectId);
    if (!project || !project.sourceVideoUrl) {
      throw new Error('Source video is missing from browser storage.');
    }

    const jobId = uuidv4();
    const now = new Date().toISOString();
    const initialJob: RenderJob = {
      id: jobId,
      projectId,
      type: 'render',
      status: 'processing',
      progress: 1,
      stage: 'Preparing browser video render pipeline...',
      etaSeconds: Math.ceil(project.metadata?.duration || 10),
      outputUrl: null,
      outputSize: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await upsertJobLocal(initialJob);

    // Run async render loop in browser and update IndexedDB job record cleanly
    void (async () => {
      try {
        const result = await renderProjectInBrowser({
          project,
          settings: exportSettings,
          onProgress: (pct, stage, etaSeconds) => {
            void upsertJobLocal({
              ...initialJob,
              status: 'processing',
              progress: pct,
              stage,
              etaSeconds,
              updatedAt: new Date().toISOString(),
            });
          },
        });

        await updateProjectLocal(projectId, {
          exportSettings,
          lastExportUrl: result.outputUri,
          lastExportSize: result.sizeBytes,
          lastExportedAt: new Date().toISOString(),
        });

        await upsertJobLocal({
          ...initialJob,
          status: 'completed',
          progress: 100,
          stage: `Rendered in browser (${result.width}×${result.height})`,
          etaSeconds: 0,
          outputUrl: result.outputUri,
          outputSize: result.sizeBytes,
          error: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        await upsertJobLocal({
          ...initialJob,
          status: 'failed',
          progress: 0,
          stage: 'Browser export failed',
          etaSeconds: null,
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        });
      }
    })();

    return { job: initialJob };
  },

  listProjectJobs: async (projectId: string) => ({
    jobs: await listProjectJobsLocal(projectId),
  }),
  getJob: async (jobId: string) => {
    const localJob = await getJobLocal(jobId);
    if (
      localJob &&
      (edgeVoiceJobIds.has(jobId) ||
        localJob.status === 'completed' ||
        localJob.status === 'failed' ||
        localJob.type !== 'voice')
    ) {
      return { job: localJob };
    }
    if (localJob && !API_BASE_URL) {
      const interrupted: RenderJob = {
        ...localJob,
        status: 'failed',
        etaSeconds: null,
        error:
          'Dubbing job was interrupted by a page reload. Any completed segment clips were saved — click Generate Voice to resume.',
        updatedAt: new Date().toISOString(),
      };
      await upsertJobLocal(interrupted);
      return { job: interrupted };
    }
    const res = await aiBackendRequest<{
      job: RenderJob;
      dubResult?: { captions: Project['captions']; voicePatch: Partial<Project['voice']> };
    }>(`/api/jobs/${jobId}`);
    if (res.job.status === 'completed' || res.job.status === 'failed') {
      if (res.dubResult) {
        const localProject = await getProjectLocal(res.job.projectId);
        if (localProject) {
          await updateProjectLocal(res.job.projectId, {
            captions: res.dubResult.captions,
            speakers: syncSpeakersFromCaptions(localProject.speakers, res.dubResult.captions),
            voice: {
              ...localProject.voice,
              ...res.dubResult.voicePatch,
            },
          });
        }
      }
      await upsertJobLocal(res.job);
    }
    return { job: res.job };
  },
  listAllJobs: async () => ({ jobs: await listAllJobsLocal() }),

  // Automated AI Calls (keys stored strictly in user's browser IndexedDB or Cloudflare Env Secrets)
  translate: async (
    projectId: string,
    targetLanguage: SupportedLanguage,
    preserveProperNouns: boolean
  ) => {
    const localProject = await getProjectLocal(projectId);
    if (!localProject) throw new Error('Project not found.');
    const res = await aiBackendRequest<{ project: Project }>(`/api/projects/${projectId}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguage,
        preserveProperNouns,
        captions: localProject.captions,
        sourceLanguage: localProject.translation.sourceLanguage,
      }),
    });
    const nextCaptions = res.project.captions.map((seg, idx) => ({
      ...seg,
      speaker: seg.speaker ?? localProject.captions[idx]?.speaker,
    }));
    const merged = await updateProjectLocal(projectId, {
      captions: nextCaptions,
      speakers: syncSpeakersFromCaptions(localProject.speakers, nextCaptions),
      translation: res.project.translation,
      subtitleStyle: {
        ...localProject.subtitleStyle,
        ...(res.project.subtitleStyle || {}),
        useTranslated: true,
      },
    });
    return { project: merged };
  },

  listFishVoices: (params?: { query?: string; selfOnly?: boolean; language?: string }) => {
    const qs = new URLSearchParams();
    if (params?.query) qs.set('q', params.query);
    if (params?.selfOnly) qs.set('self', 'true');
    if (params?.language) qs.set('language', params.language);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return aiBackendRequest<{ voices: FishVoiceModel[]; total: number }>(
      `/api/fish/voices${suffix}`
    );
  },

  transcribe: (projectId: string, params?: { provider?: 'fish' | 'gemini'; sourceLanguage?: string }) =>
    aiBackendRequest<{ project: Project; detectedLanguage: string; segmentCount: number }>(
      `/api/projects/${projectId}/transcribe`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      }
    ),

  transcribeWithFish: async (projectId: string, sourceLanguage?: string) => {
    const localProject = await getProjectLocal(projectId);
    if (!localProject || !localProject.sourceVideoUrl) {
      throw new Error('Select a video before running Fish Audio transcription.');
    }

    let mergedCaptions: Project['captions'] = [];
    let detectedLanguage = sourceLanguage || 'Auto';

    if (isLocalMediaUri(localProject.sourceVideoUrl)) {
      const chunks = await extractBrowserAsrAudioChunks({
        sourceUri: localProject.sourceVideoUrl,
        sourceFilename: localProject.sourceFilename || 'video.mp4',
      });
      if (chunks.length === 0) {
        throw new Error('Could not extract any audio frames from the selected video.');
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const formData = new FormData();
        formData.append('audio', chunk.blob, chunk.filename);
        formData.append('duration', String(Math.max(1, Math.round(chunk.durationSec * 100) / 100)));
        if (sourceLanguage) {
          formData.append('sourceLanguage', sourceLanguage);
        }

        const chunkRes = await aiBackendRequest<{
          project?: { captions: Project['captions'] };
          segments?: Project['captions'];
          detectedLanguage: string;
        }>(i === 0 ? `/api/projects/${projectId}/dubbing/transcribe` : `/api/fish/asr`, {
          method: 'POST',
          body: formData,
        });

        const chunkSegments = chunkRes.project?.captions || chunkRes.segments || [];
        if (i === 0 && chunkRes.detectedLanguage) {
          detectedLanguage = chunkRes.detectedLanguage;
        }
        const shifted = chunkSegments.map((seg) => ({
          ...seg,
          start: Math.round((seg.start + chunk.offsetSec) * 100) / 100,
          end: Math.round((seg.end + chunk.offsetSec) * 100) / 100,
          words: seg.words?.map((w) => ({
            ...w,
            start: Math.round((w.start + chunk.offsetSec) * 100) / 100,
            end: Math.round((w.end + chunk.offsetSec) * 100) / 100,
          })),
        }));
        mergedCaptions.push(...shifted);
      }
      mergedCaptions.sort((a, b) => a.start - b.start);
    } else {
      const res = await aiBackendRequest<{
        project: Project;
        detectedLanguage: string;
        segmentCount: number;
      }>(`/api/projects/${projectId}/dubbing/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLanguage }),
      });
      mergedCaptions = res.project.captions;
      detectedLanguage = res.detectedLanguage;
    }

    const syncedSpeakers = syncSpeakersFromCaptions(localProject.speakers, mergedCaptions);
    const merged = await updateProjectLocal(projectId, {
      captions: mergedCaptions,
      speakers: syncedSpeakers,
      translation: {
        ...localProject.translation,
        sourceLanguage: detectedLanguage,
      },
    });
    return {
      project: merged,
      detectedLanguage,
      segmentCount: mergedCaptions.length,
    };
  },

  generateFishAudio: async (params: {
    text: string;
    referenceId?: string;
    format?: 'mp3' | 'wav' | 'pcm' | 'opus';
  }) => {
    const personalKey = await getPersonalFishApiKey();
    const audioBlob = await fetchFishAudioFromEndpoint({
      endpointUrl: resolveApiUrl('/api/fish-audio'),
      text: params.text,
      referenceId: params.referenceId,
      format: params.format || 'mp3',
      apiKey: personalKey,
    });
    const saved = await saveMediaBlob({
      bucket: 'audio',
      filename: `fish_audio_${Date.now()}.${params.format || 'mp3'}`,
      blob: audioBlob,
      mimeType: audioBlob.type || 'audio/mpeg',
    });
    return { audioUrl: saved.uri, blob: audioBlob };
  },

  previewFishDub: async (
    projectId: string,
    params: { text: string; referenceId?: string; speakingSpeed: number }
  ) => {
    const personalKey = await getPersonalFishApiKey();
    const audioBlob = await fetchFishAudioFromEndpoint({
      endpointUrl: resolveApiUrl('/api/fish-audio'),
      text: params.text,
      referenceId: params.referenceId,
      format: 'mp3',
      apiKey: personalKey,
    });
    const saved = await saveMediaBlob({
      bucket: 'audio',
      filename: `fish_preview_${projectId.slice(0, 8)}_${Date.now()}.mp3`,
      blob: audioBlob,
      mimeType: 'audio/mpeg',
    });
    return { audioUrl: saved.uri };
  },

  generateFishDub: async (
    projectId: string,
    params: {
      voice: Project['voice'];
      captions?: Project['captions'];
      useTranslated?: boolean;
      skipExistingValid?: boolean;
    }
  ) => {
    const localProject = await getProjectLocal(projectId);
    const personalKey = await getPersonalFishApiKey();
    const res = await aiBackendRequest<{ job?: RenderJob; workerEdgeMode?: boolean }>(
      `/api/projects/${projectId}/dubbing/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...params,
          totalDuration: localProject?.metadata?.duration,
        }),
      }
    );

    if (res.job && !res.workerEdgeMode) {
      return { job: res.job };
    }

    if (!localProject) {
      throw new Error('Project not found in browser storage.');
    }

    const now = new Date().toISOString();
    const captions = params.captions || localProject.captions;
    const jobId = uuidv4();
    edgeVoiceJobIds.add(jobId);
    const initialJob: RenderJob = {
      id: jobId,
      projectId,
      type: 'voice',
      status: 'processing',
      progress: 2,
      stage: 'Synthesizing Fish Audio segments via Pages Function (/api/fish-audio)...',
      etaSeconds: null,
      outputUrl: null,
      outputSize: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await upsertJobLocal(initialJob);

    void (async () => {
      try {
        const result = await generateEdgeFishDubbing({
          project: localProject,
          captions,
          voiceConfig: params.voice,
          useTranslated: params.useTranslated ?? true,
          fishEndpointUrl: resolveApiUrl('/api/fish-audio'),
          apiKey: personalKey,
          skipExistingValid: params.skipExistingValid,
          onClipGenerated: async (clipsSoFar) => {
            const latest = (await getProjectLocal(projectId)) || localProject;
            await updateProjectLocal(projectId, {
              voice: {
                ...latest.voice,
                ...params.voice,
                provider: 'fish',
                speakingSpeed: 1.0,
                generatedClips: clipsSoFar,
              },
            });
          },
          onProgress: (progress, stage, etaSeconds) => {
            void upsertJobLocal({
              ...initialJob,
              status: 'processing',
              progress,
              stage,
              etaSeconds,
              updatedAt: new Date().toISOString(),
            });
          },
        });

        await updateProjectLocal(projectId, {
          captions,
          speakers: syncSpeakersFromCaptions(localProject.speakers, captions),
          voice: {
            ...localProject.voice,
            ...params.voice,
            provider: 'fish',
            syncMode: result.syncPlan.syncMode,
            continuousPauseMs:
              result.syncPlan.pauseDurationMs ?? params.voice.continuousPauseMs,
            speakingSpeed: 1.0,
            enabled: true,
            generatedClips: result.clips,
            fullDubUrl: result.fullDubUrl,
            syncPlan: result.syncPlan,
          },
        });

        await upsertJobLocal({
          ...initialJob,
          status: 'completed',
          progress: 100,
          stage: `Generated all ${result.clips.length} synchronized segments`,
          etaSeconds: 0,
          outputUrl: result.fullDubUrl,
          outputSize: null,
          error: null,
          updatedAt: new Date().toISOString(),
        });
      } catch (err) {
        await upsertJobLocal({
          ...initialJob,
          status: 'failed',
          progress: 0,
          stage: 'Fish Audio dubbing failed (completed clips preserved)',
          etaSeconds: null,
          error: err instanceof Error ? err.message : String(err),
          updatedAt: new Date().toISOString(),
        });
      }
    })();

    return { job: initialJob };
  },

  resyncFishDub: async (projectId: string, syncMode: SyncMode, continuousPauseMs?: number) => {
    const localProject = await getProjectLocal(projectId);
    if (!localProject) throw new Error('Project not found.');

    const existingClips = localProject.voice.generatedClips || [];
    const allClipsLocal =
      existingClips.length > 0 && existingClips.every((c) => isLocalMediaUri(c.audioUrl));

    if (allClipsLocal) {
      const normalizedMode = normalizeSyncMode(syncMode);
      const pauseMs = clampContinuousPauseMs(
        continuousPauseMs ?? localProject.voice.continuousPauseMs
      );
      const captionById = new Map(localProject.captions.map((c) => [c.id, c]));
      const syncPlan = buildTimelineSyncPlan({
        captions: localProject.captions,
        measuredClips: existingClips.map((c) => {
          const orig = captionById.get(c.segmentId);
          return {
            segmentId: c.segmentId,
            start: orig ? orig.start : c.start,
            end: orig ? orig.end : c.end,
            duration: c.duration,
            speechDuration: c.speechDuration,
            leadingSilence: c.leadingSilence,
            trailingSilence: c.trailingSilence,
          };
        }),
        originalVideoDuration: localProject.metadata?.duration || 112,
        syncMode: normalizedMode,
        continuousPauseMs: pauseMs,
      });

      const clips = applySyncPlanToClips(existingClips, syncPlan);
      const merged = await renderMergedDubWavFromClips({
        projectId,
        clipEntries: clips.map((c) => ({ audioUri: c.audioUrl, startSec: c.start })),
        totalDuration: syncPlan.estimatedFinalDuration,
      });

      const updated = await updateProjectLocal(projectId, {
        voice: {
          ...localProject.voice,
          syncMode: normalizedMode,
          continuousPauseMs: pauseMs,
          speakingSpeed: 1.0,
          generatedClips: clips,
          fullDubUrl: merged.fullDubUrl,
          syncPlan,
        },
      });
      return { project: updated };
    }

    const res = await aiBackendRequest<{ project: Project }>(
      `/api/projects/${projectId}/dubbing/resync`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          syncMode,
          continuousPauseMs,
          captions: localProject.captions,
          voice: localProject.voice,
          totalDuration: localProject.metadata?.duration,
        }),
      }
    );
    const merged = await updateProjectLocal(projectId, {
      voice: res.project.voice,
    });
    return { project: merged };
  },

  regenerateFishSegments: async (
    projectId: string,
    params: {
      segmentIds: string[];
      captions?: Project['captions'];
      voice?: Partial<Project['voice']>;
      useTranslated?: boolean;
    }
  ) => {
    const localProject = await getProjectLocal(projectId);
    if (!localProject) throw new Error('Project not found.');

    const existingClips = localProject.voice.generatedClips || [];
    const useEdgeDub =
      existingClips.length === 0 || existingClips.every((c) => isLocalMediaUri(c.audioUrl));

    if (useEdgeDub) {
      const captions = params.captions || localProject.captions;
      const mergedVoice: Project['voice'] = {
        ...localProject.voice,
        ...(params.voice || {}),
        provider: 'fish',
        speakingSpeed: 1.0,
        enabled: true,
      };
      const personalKey = await getPersonalFishApiKey();
      const result = await generateEdgeFishDubbing({
        project: localProject,
        captions,
        voiceConfig: mergedVoice,
        useTranslated: params.useTranslated ?? true,
        fishEndpointUrl: resolveApiUrl('/api/fish-audio'),
        apiKey: personalKey,
        targetSegmentIds: new Set(params.segmentIds),
      });
      const targetSet = new Set(params.segmentIds);
      const remainingPending = (localProject.translation.pendingRegenerateSegmentIds || []).filter(
        (id) => !targetSet.has(id)
      );
      const updated = await updateProjectLocal(projectId, {
        captions,
        speakers: syncSpeakersFromCaptions(localProject.speakers, captions),
        translation: {
          ...localProject.translation,
          pendingRegenerateSegmentIds: remainingPending,
        },
        voice: {
          ...mergedVoice,
          syncMode: result.syncPlan.syncMode,
          continuousPauseMs:
            result.syncPlan.pauseDurationMs ?? mergedVoice.continuousPauseMs,
          generatedClips: result.clips,
          fullDubUrl: result.fullDubUrl,
          syncPlan: result.syncPlan,
        },
      });
      return {
        project: updated,
        regeneratedIds: result.regeneratedIds,
        fullDubUrl: result.fullDubUrl,
      };
    }

    const res = await aiBackendRequest<{
      project: Project;
      regeneratedIds: string[];
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/dubbing/regenerate-segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...params,
        totalDuration: localProject.metadata?.duration,
      }),
    });
    const merged = await updateProjectLocal(projectId, {
      captions: res.project.captions,
      voice: res.project.voice,
      translation: res.project.translation || localProject.translation,
    });
    return {
      project: merged,
      regeneratedIds: res.regeneratedIds,
      fullDubUrl: res.fullDubUrl,
    };
  },

  previewVoice: (
    projectId: string,
    params: {
      text: string;
      voiceName: GeminiVoiceName;
      style: string;
      targetLanguage: SupportedLanguage;
      speakingSpeed: number;
    }
  ) =>
    aiBackendRequest<{ audioUrl: string }>(`/api/projects/${projectId}/voice/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),

  generateVoiceover: (
    projectId: string,
    params: { voice: Project['voice']; useTranslated: boolean }
  ) =>
    aiBackendRequest<{ project: Project; fullDubUrl: string }>(
      `/api/projects/${projectId}/voice/generate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }
    ),

  autoDubVideo: (
    projectId: string,
    params: { voice: Project['voice']; preserveProperNouns?: boolean }
  ) =>
    aiBackendRequest<{
      project: Project;
      sourceLanguage: string;
      targetLanguage: SupportedLanguage;
      fullDubUrl: string;
    }>(`/api/projects/${projectId}/voice/auto-dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }),
};

// Re-export helper for direct usage
export { getMediaBlob };
