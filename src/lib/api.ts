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
  getPersonalFishApiKey,
  hasPersonalFishApiKey,
} from './fishKeyStore';
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

function scrubSecretFromText(text: string, secret?: string | null): string {
  let clean = text;
  if (secret && secret.length >= 4) {
    clean = clean.split(secret).join('[redacted]');
  }
  return clean.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

async function aiBackendRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = resolveApiUrl(url);
  const headers = new Headers(init?.headers || {});
  let usedPersonalKey: string | null = null;
  if (isFishEndpointPath(url) && !headers.has('Authorization')) {
    usedPersonalKey = await getPersonalFishApiKey();
    if (usedPersonalKey) {
      headers.set('Authorization', `Bearer ${usedPersonalKey}`);
    }
  }

  let res: Response;
  try {
    res = await fetch(fullUrl, { ...init, headers });
  } catch (err) {
    const detail = scrubSecretFromText(err instanceof Error ? err.message : String(err), usedPersonalKey);
    throw new Error(
      `Automated AI service is unreachable (${detail}). Video handling, preview, export, SRT/VTT import, and External Gemini (No Key) work 100% locally in your browser.`
    );
  }
  const raw = await res.text();
  let data: Record<string, unknown> | null = null;
  if (raw) {
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (res.status === 405 || res.status === 404) {
      throw new Error(
        `Automated server-side AI endpoint is unavailable on static hosting (HTTP ${res.status}). API keys are never exposed in frontend code — use External Gemini (No Key) mode or run with an AI backend configured.`
      );
    }
    const errMsg =
      typeof data?.error === 'string' ? data.error : `AI request failed (${res.status})`;
    throw new Error(scrubSecretFromText(errMsg, usedPersonalKey));
  }
  if (!data) {
    throw new Error('Unexpected non-JSON response from AI endpoint.');
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
    const localFishConfigured = await hasPersonalFishApiKey();
    try {
      const serverStatus = await aiBackendRequest<SystemStatus>('/api/system/status');
      return {
        ...serverStatus,
        fishConfigured: Boolean(serverStatus.fishConfigured || localFishConfigured),
      };
    } catch {
      return {
        geminiConfigured: false,
        fishConfigured: localFishConfigured,
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

  testFishConnection: async (overrideKey?: string): Promise<{
    ok: boolean;
    status: FishConnectionStatus;
    message: string;
    credit?: string;
  }> => {
    const rawKey = overrideKey !== undefined ? overrideKey : await getPersonalFishApiKey();
    const keyToTest = (rawKey || '').trim();
    if (!keyToTest) {
      return {
        ok: false,
        status: 'not_configured',
        message: 'No Fish Audio API key configured. Enter and save your personal API key.',
      };
    }

    const endpointUrl = resolveApiUrl('/api/fish-audio');
    let res: Response;
    try {
      res = await fetch(endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keyToTest}`,
        },
        body: JSON.stringify({ action: 'test' }),
      });
    } catch (err) {
      const detail = scrubSecretFromText(err instanceof Error ? err.message : String(err), keyToTest);
      return {
        ok: false,
        status: 'connection_error',
        message: `Unable to reach /api/fish-audio (${detail}).`,
      };
    }

    const raw = await res.text().catch(() => '');
    let parsed: Record<string, unknown> | null = null;
    if (raw) {
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
            : 'Connected to Fish Audio API.',
        credit: typeof parsed.credit === 'string' ? parsed.credit : undefined,
      };
    }

    const rawErr =
      (typeof parsed?.error === 'string' && parsed.error) ||
      (typeof parsed?.message === 'string' && parsed.message) ||
      `Connection check failed (${res.status}).`;
    const cleanErr = scrubSecretFromText(rawErr, keyToTest);

    if (res.status === 401 || res.status === 403 || parsed?.status === 'invalid_key') {
      return {
        ok: false,
        status: 'invalid_key',
        message: cleanErr || 'Invalid Fish Audio API key.',
      };
    }

    return {
      ok: false,
      status: 'connection_error',
      message: cleanErr,
    };
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

  // Automated Server-Side Key-Protected AI Calls (never expose GEMINI_API_KEY / FISH_API_KEY in frontend)
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
    const merged = await updateProjectLocal(projectId, {
      captions: res.project.captions,
      translation: res.project.translation,
      subtitleStyle: res.project.subtitleStyle,
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

    let res: { project: Project; detectedLanguage: string; segmentCount: number };
    if (isLocalMediaUri(localProject.sourceVideoUrl)) {
      const videoBlob = await getMediaBlob(localProject.sourceVideoUrl);
      if (!videoBlob) {
        throw new Error('Video file is unavailable in browser storage. Please re-select the video.');
      }
      const extracted = await extractBrowserAudioTrack({
        sourceUri: localProject.sourceVideoUrl,
        sourceFilename: localProject.sourceFilename || 'video.mp4',
      });
      const wavBlob = await getMediaBlob(extracted.audioUrl);
      if (!wavBlob) {
        throw new Error('Failed to read extracted browser audio track for transcription.');
      }
      const formData = new FormData();
      formData.append('audio', wavBlob, extracted.filename || 'audio.wav');
      formData.append('duration', String(localProject.metadata?.duration || 10));
      if (sourceLanguage) {
        formData.append('sourceLanguage', sourceLanguage);
      }
      res = await aiBackendRequest<{ project: Project; detectedLanguage: string; segmentCount: number }>(
        `/api/projects/${projectId}/dubbing/transcribe`,
        {
          method: 'POST',
          body: formData,
        }
      );
    } else {
      res = await aiBackendRequest<{ project: Project; detectedLanguage: string; segmentCount: number }>(
        `/api/projects/${projectId}/dubbing/transcribe`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceLanguage }),
        }
      );
    }

    const merged = await updateProjectLocal(projectId, {
      captions: res.project.captions,
      translation: {
        ...localProject.translation,
        sourceLanguage: res.detectedLanguage,
      },
    });
    return {
      project: merged,
      detectedLanguage: res.detectedLanguage,
      segmentCount: res.segmentCount,
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
    params: { voice: Project['voice']; captions?: Project['captions']; useTranslated?: boolean }
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
          stage: 'Fish Audio dubbing failed',
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
