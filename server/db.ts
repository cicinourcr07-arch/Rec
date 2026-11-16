import fs from 'fs';
import path from 'path';
import {
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  DEFAULT_VOICE_CONFIG,
  Project,
  PresetCategory,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StudioPreset,
  StudioPresetAssetRef,
} from '../src/types/studio.ts';

export const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || './storage');
export const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
export const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
export const LOGOS_DIR = path.join(STORAGE_DIR, 'logos');
export const BACKGROUNDS_DIR = path.join(STORAGE_DIR, 'backgrounds');
export const FONTS_DIR = path.join(STORAGE_DIR, 'fonts');
export const AUDIO_DIR = path.join(STORAGE_DIR, 'audio');
export const MASKS_DIR = path.join(STORAGE_DIR, 'masks');
export const EXPORTS_DIR = path.join(STORAGE_DIR, 'exports');
export const THUMBS_DIR = path.join(STORAGE_DIR, 'thumbs');
export const TEMP_DIR = path.join(STORAGE_DIR, 'temp');

for (const dir of [
  STORAGE_DIR,
  UPLOADS_DIR,
  CHUNKS_DIR,
  LOGOS_DIR,
  BACKGROUNDS_DIR,
  FONTS_DIR,
  AUDIO_DIR,
  MASKS_DIR,
  EXPORTS_DIR,
  THUMBS_DIR,
  TEMP_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

interface AssetRecord {
  id: string;
  project_id: string | null;
  kind: string;
  filename: string;
  file_path: string;
  url: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

interface FontRecord {
  id: string;
  family: string;
  filename: string;
  file_path: string;
  url: string;
  created_at: string;
}

interface AppSettingRecord {
  key: string;
  value: string;
  updated_at: string;
}

interface PresetRecord {
  id: string;
  category: PresetCategory;
  name: string;
  description: string;
  isDefault: boolean;
  thumbnailStyle: StudioPreset['thumbnailStyle'];
  payload: Record<string, unknown>;
  assetRefs: StudioPresetAssetRef[];
  createdAt: string;
  updatedAt: string;
}

interface StoreState {
  projects: Project[];
  jobs: RenderJob[];
  assets: AssetRecord[];
  appSettings: Record<string, AppSettingRecord>;
  presets: PresetRecord[];
  customFonts: FontRecord[];
}

const storePath = path.join(STORAGE_DIR, 'recap_studio_store.json');

function loadStore(): StoreState {
  try {
    if (fs.existsSync(storePath)) {
      const raw = fs.readFileSync(storePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<StoreState>;
      return {
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
        jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
        assets: Array.isArray(parsed.assets) ? parsed.assets : [],
        appSettings: parsed.appSettings && typeof parsed.appSettings === 'object' ? parsed.appSettings : {},
        presets: Array.isArray(parsed.presets) ? parsed.presets : [],
        customFonts: Array.isArray(parsed.customFonts) ? parsed.customFonts : [],
      };
    }
  } catch (err) {
    console.warn('[AI Studio] Failed to load JSON store, starting fresh:', err);
  }
  return {
    projects: [],
    jobs: [],
    assets: [],
    appSettings: {},
    presets: [],
    customFonts: [],
  };
}

const store: StoreState = loadStore();

function persistStore() {
  try {
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[AI Studio] Failed to persist JSON store:', err);
  }
}

// Mock db export (in-memory/JSON store replaces native better-sqlite3)
export const db = {
  prepare: () => ({
    get: () => null,
    all: () => [],
    run: () => ({ changes: 0 }),
  }),
};

function normalizeProject(raw: Project): Project {
  const rawVoice = (raw.voice || {}) as Partial<Project['voice']>;
  const originalAudioMuted =
    rawVoice.originalAudioMuted !== undefined
      ? Boolean(rawVoice.originalAudioMuted)
      : rawVoice.preserveOriginalAudio !== undefined
      ? !Boolean(rawVoice.preserveOriginalAudio)
      : true;
  const originalAudioEnabled =
    rawVoice.originalAudioEnabled !== undefined
      ? Boolean(rawVoice.originalAudioEnabled)
      : Boolean(rawVoice.preserveOriginalAudio);
  const bgMusicEnabled =
    rawVoice.bgMusicEnabled !== undefined
      ? Boolean(rawVoice.bgMusicEnabled)
      : Boolean(rawVoice.bgMusicUrl && (rawVoice.bgMusicVolume ?? 0) > 0.005);

  const normalizedVoice: Project['voice'] = {
    ...DEFAULT_VOICE_CONFIG,
    ...rawVoice,
    voiceMuted: Boolean(rawVoice.voiceMuted),
    originalAudioMuted,
    originalAudioEnabled,
    preserveOriginalAudio: !originalAudioMuted && originalAudioEnabled,
    bgMusicEnabled,
    bgMusicMuted: Boolean(rawVoice.bgMusicMuted),
    sfxEnabled: Boolean(rawVoice.sfxEnabled),
    sfxMuted: Boolean(rawVoice.sfxMuted),
  };

  return {
    ...raw,
    savedThumbnails: raw.savedThumbnails || [],
    waveformPeaks: raw.waveformPeaks || [],
    captions: raw.captions || [],
    subtitleStyle: {
      ...DEFAULT_SUBTITLE_STYLE,
      ...(raw.subtitleStyle || {}),
      useTranslated: true,
    },
    translation: raw.translation || {
      sourceLanguage: 'Auto',
      targetLanguage: 'Spanish',
      preserveProperNouns: true,
    },
    voice: normalizedVoice,
    blurs: raw.blurs || [],
    logos: raw.logos || [],
    videoEffects: { ...DEFAULT_VIDEO_EFFECTS, ...(raw.videoEffects || {}) },
    canvas: { ...DEFAULT_VIDEO_CANVAS, ...(raw.canvas || {}) },
    workflow:
      raw.workflow && Array.isArray(raw.workflow.visitedStages)
        ? raw.workflow
        : {
            visitedStages: ['dashboard'],
            completedStages: [],
            needsAttentionStages: [],
          },
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS, ...(raw.exportSettings || {}) },
  };
}

export function listProjects(): Project[] {
  return [...store.projects]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(normalizeProject);
}

export function getProject(id: string): Project | null {
  const found = store.projects.find((p) => p.id === id);
  return found ? normalizeProject(found) : null;
}

export function createProject(id: string, name: string): Project {
  const now = new Date().toISOString();
  const savedVoices = getSavedFishVoices();
  const defaultVoice = savedVoices.find((v) => v.isDefault);
  const initialVoice = defaultVoice
    ? {
        ...DEFAULT_VOICE_CONFIG,
        fishReferenceId: defaultVoice.voiceId,
        fishVoiceTitle: defaultVoice.name,
      }
    : DEFAULT_VOICE_CONFIG;

  const project: Project = normalizeProject({
    id,
    name,
    sourceVideoUrl: null,
    sourceFilename: null,
    thumbnailUrl: null,
    savedThumbnails: [],
    metadata: null,
    waveformPeaks: [],
    captions: [],
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    translation: {
      sourceLanguage: 'Auto',
      targetLanguage: 'Spanish',
      preserveProperNouns: true,
    },
    voice: initialVoice,
    blurs: [],
    logos: [],
    videoEffects: { ...DEFAULT_VIDEO_EFFECTS },
    canvas: { ...DEFAULT_VIDEO_CANVAS },
    workflow: {
      visitedStages: ['dashboard'],
      completedStages: [],
      needsAttentionStages: [],
    },
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS },
    lastExportUrl: null,
    lastExportSize: null,
    lastExportedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  store.projects.push(project);
  persistStore();
  return normalizeProject(project);
}

export function updateProject(id: string, patch: Partial<Project>): Project | null {
  const idx = store.projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = normalizeProject(store.projects[idx]);
  const merged = normalizeProject({
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  });
  store.projects[idx] = merged;
  persistStore();
  return normalizeProject(merged);
}

export function upsertProjectFromCloud(cloudProject: Project): Project {
  const existing = getProject(cloudProject.id);
  const now = new Date().toISOString();
  const safeWorkflow: NonNullable<Project['workflow']> =
    cloudProject.workflow && Array.isArray(cloudProject.workflow.visitedStages)
      ? cloudProject.workflow
      : {
          visitedStages: ['dashboard'],
          completedStages: [],
          needsAttentionStages: [],
        };

  if (!existing) {
    const inserted = normalizeProject({
      ...cloudProject,
      name: cloudProject.name || 'Cloud Project',
      sourceVideoUrl: cloudProject.sourceVideoUrl ?? null,
      sourceFilename: cloudProject.sourceFilename ?? null,
      thumbnailUrl: cloudProject.thumbnailUrl ?? null,
      metadata: cloudProject.metadata ?? null,
      workflow: safeWorkflow,
      cloudSync: cloudProject.cloudSync || { syncStatus: 'cloud-synced' },
      cloudAssets: cloudProject.cloudAssets || {},
      savedThumbnails: cloudProject.savedThumbnails || [],
      lastExportUrl: cloudProject.lastExportUrl ?? null,
      lastExportSize: cloudProject.lastExportSize ?? null,
      lastExportedAt: cloudProject.lastExportedAt ?? null,
      createdAt: cloudProject.createdAt || now,
      updatedAt: cloudProject.updatedAt || now,
    });
    store.projects.push(inserted);
    persistStore();
    return normalizeProject(inserted);
  }

  return updateProject(cloudProject.id, {
    ...cloudProject,
    cloudSync: cloudProject.cloudSync || { syncStatus: 'cloud-synced' },
    cloudAssets: cloudProject.cloudAssets || existing.cloudAssets,
    savedThumbnails: cloudProject.savedThumbnails || existing.savedThumbnails,
  })!;
}

export function deleteProject(id: string): boolean {
  const prevLen = store.projects.length;
  store.projects = store.projects.filter((p) => p.id !== id);
  if (store.projects.length < prevLen) {
    store.jobs = store.jobs.filter((j) => j.projectId !== id);
    persistStore();
    return true;
  }
  return false;
}

export function createJob(job: Omit<RenderJob, 'createdAt' | 'updatedAt'>): RenderJob {
  const now = new Date().toISOString();
  const record: RenderJob = {
    ...job,
    createdAt: now,
    updatedAt: now,
  };
  store.jobs.push(record);
  persistStore();
  return { ...record };
}

export function getJob(id: string): RenderJob | null {
  const found = store.jobs.find((j) => j.id === id);
  return found ? { ...found } : null;
}

export function listProjectJobs(projectId: string): RenderJob[] {
  return store.jobs
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
    .map((j) => ({ ...j }));
}

export function listAllJobs(): RenderJob[] {
  return [...store.jobs]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((j) => ({ ...j }));
}

export function updateJob(id: string, patch: Partial<RenderJob>): RenderJob | null {
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const merged: RenderJob = {
    ...store.jobs[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.jobs[idx] = merged;
  persistStore();
  return { ...merged };
}

export function registerAsset(asset: {
  id: string;
  projectId: string | null;
  kind: string;
  filename: string;
  filePath: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const record: AssetRecord = {
    id: asset.id,
    project_id: asset.projectId,
    kind: asset.kind,
    filename: asset.filename,
    file_path: asset.filePath,
    url: asset.url,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    created_at: new Date().toISOString(),
  };
  const idx = store.assets.findIndex((a) => a.id === asset.id);
  if (idx >= 0) {
    store.assets[idx] = record;
  } else {
    store.assets.push(record);
  }
  persistStore();
}

export function getAssetByUrl(url: string): { file_path: string; filename: string; mime_type: string } | null {
  const row = store.assets.find((a) => a.url === url);
  if (row) {
    return {
      file_path: row.file_path,
      filename: row.filename,
      mime_type: row.mime_type,
    };
  }
  return null;
}

export function listAssetsByProject(projectId: string): Array<{
  id: string;
  kind: string;
  filename: string;
  file_path: string;
  url: string;
  mime_type: string;
  size_bytes: number;
}> {
  return store.assets
    .filter((a) => a.project_id === projectId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      filename: a.filename,
      file_path: a.file_path,
      url: a.url,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
    }));
}

export function getAppSetting(key: string, fallback: string): string {
  const row = store.appSettings[key];
  return row ? row.value : fallback;
}

export function setAppSetting(key: string, value: string) {
  store.appSettings[key] = {
    key,
    value,
    updated_at: new Date().toISOString(),
  };
  persistStore();
}

const SAVED_VOICES_KEY = 'saved_fish_voices';

export function getSavedFishVoices(): SavedFishVoice[] {
  try {
    const raw = getAppSetting(SAVED_VOICES_KEY, '[]');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedFishVoice[]) : [];
  } catch {
    return [];
  }
}

export function saveSavedFishVoices(voices: SavedFishVoice[]) {
  setAppSetting(SAVED_VOICES_KEY, JSON.stringify(voices));
}

export function checkAssetAvailableByUrl(url: string): boolean {
  if (!url) return false;
  const asset = getAssetByUrl(url);
  if (asset && fs.existsSync(asset.file_path)) {
    return true;
  }
  const fontRow = store.customFonts.find((f) => f.url === url);
  if (fontRow && fs.existsSync(fontRow.file_path)) {
    return true;
  }
  return false;
}

function recordToPreset(record: PresetRecord): StudioPreset {
  const missingAssets = (record.assetRefs || []).filter((ref) => !checkAssetAvailableByUrl(ref.url));
  return {
    id: record.id,
    category: record.category,
    name: record.name,
    description: record.description || undefined,
    isDefault: Boolean(record.isDefault),
    thumbnailStyle: record.thumbnailStyle || {},
    payload: record.payload || {},
    assetRefs: record.assetRefs || [],
    missingAssets,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function listPresets(category?: PresetCategory): StudioPreset[] {
  const filtered = category
    ? store.presets.filter((p) => p.category === category)
    : [...store.presets];
  return filtered
    .sort((a, b) => {
      if (!category && a.category !== b.category) return a.category.localeCompare(b.category);
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .map(recordToPreset);
}

export function getPreset(id: string): StudioPreset | null {
  const row = store.presets.find((p) => p.id === id);
  return row ? recordToPreset(row) : null;
}

export function createPreset(preset: {
  id: string;
  category: PresetCategory;
  name: string;
  description?: string;
  isDefault?: boolean;
  thumbnailStyle?: StudioPreset['thumbnailStyle'];
  payload: Record<string, unknown>;
  assetRefs?: StudioPresetAssetRef[];
}): StudioPreset {
  const now = new Date().toISOString();
  if (preset.isDefault) {
    store.presets.forEach((p) => {
      if (p.category === preset.category) p.isDefault = false;
    });
  }
  const record: PresetRecord = {
    id: preset.id,
    category: preset.category,
    name: preset.name.trim(),
    description: preset.description || '',
    isDefault: Boolean(preset.isDefault),
    thumbnailStyle: preset.thumbnailStyle || {},
    payload: preset.payload || {},
    assetRefs: preset.assetRefs || [],
    createdAt: now,
    updatedAt: now,
  };
  store.presets.push(record);
  persistStore();
  return recordToPreset(record);
}

export function updatePreset(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    isDefault: boolean;
    thumbnailStyle: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs: StudioPresetAssetRef[];
  }>
): StudioPreset | null {
  const idx = store.presets.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = store.presets[idx];
  if (patch.isDefault) {
    store.presets.forEach((p) => {
      if (p.category === existing.category) p.isDefault = false;
    });
  }
  const now = new Date().toISOString();
  const updated: PresetRecord = {
    ...existing,
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    description: patch.description !== undefined ? patch.description : existing.description || '',
    isDefault: patch.isDefault !== undefined ? Boolean(patch.isDefault) : existing.isDefault,
    thumbnailStyle: patch.thumbnailStyle ?? existing.thumbnailStyle ?? {},
    payload: patch.payload ?? existing.payload ?? {},
    assetRefs: patch.assetRefs ?? existing.assetRefs ?? [],
    updatedAt: now,
  };
  store.presets[idx] = updated;
  persistStore();
  return recordToPreset(updated);
}

export function deletePreset(id: string): boolean {
  const prevLen = store.presets.length;
  store.presets = store.presets.filter((p) => p.id !== id);
  if (store.presets.length < prevLen) {
    persistStore();
    return true;
  }
  return false;
}

export function listCustomFonts(): SavedFontAsset[] {
  return [...store.customFonts]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => ({
      id: r.id,
      family: r.family,
      filename: r.filename,
      url: r.url,
      createdAt: r.created_at,
    }));
}

export function registerCustomFont(font: {
  id: string;
  family: string;
  filename: string;
  filePath: string;
  url: string;
}): SavedFontAsset {
  const now = new Date().toISOString();
  const record: FontRecord = {
    id: font.id,
    family: font.family,
    filename: font.filename,
    file_path: font.filePath,
    url: font.url,
    created_at: now,
  };
  store.customFonts.push(record);
  persistStore();
  return {
    id: font.id,
    family: font.family,
    filename: font.filename,
    url: font.url,
    createdAt: now,
  };
}

export function deleteCustomFont(id: string): boolean {
  const idx = store.customFonts.findIndex((f) => f.id === id);
  if (idx === -1) return false;
  const row = store.customFonts[idx];
  if (row && fs.existsSync(row.file_path)) {
    try {
      fs.unlinkSync(row.file_path);
    } catch {
      // ignore fs error
    }
  }
  store.customFonts.splice(idx, 1);
  persistStore();
  return true;
}
