/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  DEFAULT_EXPORT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_VIDEO_CANVAS,
  DEFAULT_VIDEO_EFFECTS,
  DEFAULT_VOICE_CONFIG,
  PresetCategory,
  Project,
  RenderJob,
  SavedFishVoice,
  SavedFontAsset,
  StudioPreset,
  StudioPresetAssetRef,
} from '../types/studio';
import { hasMediaAsset } from './browserMediaStore';
import { indexedDbStore } from './indexedDbStore';

const PRESETS_KV_KEY = 'recap_studio_presets_v1';
const JOBS_KV_KEY = 'recap_studio_jobs_v1';
const FONTS_KV_KEY = 'recap_studio_custom_fonts_v1';
const FISH_VOICES_KV_KEY = 'recap_studio_saved_fish_voices_v1';

export interface ClientPresetApplyOptions {
  captionPresetId?: string | null;
  filterPresetId?: string | null;
  editingPresetId?: string | null;
  applyDefaults?: boolean;
}

export interface ClientPresetWarning {
  presetName: string;
  missingAssets: StudioPresetAssetRef[];
}

export function buildDefaultProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    name: name.trim() || 'Untitled Recap',
    createdAt: now,
    updatedAt: now,
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
      targetLanguage: 'French',
      preserveProperNouns: true,
    },
    voice: { ...DEFAULT_VOICE_CONFIG },
    speakers: [],
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
  };
}

async function computePresetMissingAssets(
  preset: StudioPreset
): Promise<StudioPresetAssetRef[]> {
  const refs = preset.assetRefs || [];
  if (refs.length === 0) return [];
  const missing: StudioPresetAssetRef[] = [];
  for (const ref of refs) {
    if (!ref.url) continue;
    const exists = await hasMediaAsset(ref.url);
    if (!exists) {
      missing.push(ref);
    }
  }
  return missing;
}

export async function listPresetsLocal(category?: PresetCategory): Promise<StudioPreset[]> {
  const raw = (await indexedDbStore.getKv<StudioPreset[]>(PRESETS_KV_KEY)) || [];
  const hydrated = await Promise.all(
    raw.map(async (p) => ({
      ...p,
      missingAssets: await computePresetMissingAssets(p),
    }))
  );
  return category ? hydrated.filter((p) => p.category === category) : hydrated;
}

async function savePresetsRaw(presets: StudioPreset[]): Promise<StudioPreset[]> {
  const clean = presets.map(({ missingAssets: _m, ...rest }) => rest);
  await indexedDbStore.setKv(PRESETS_KV_KEY, clean);
  return Promise.all(
    clean.map(async (p) => ({
      ...p,
      missingAssets: await computePresetMissingAssets(p),
    }))
  );
}

export async function createPresetLocal(params: {
  category: PresetCategory;
  name: string;
  description?: string;
  isDefault?: boolean;
  thumbnailStyle?: StudioPreset['thumbnailStyle'];
  payload: Record<string, unknown>;
  assetRefs?: StudioPresetAssetRef[];
}): Promise<{ preset: StudioPreset; presets: StudioPreset[] }> {
  const current = (await indexedDbStore.getKv<StudioPreset[]>(PRESETS_KV_KEY)) || [];
  const now = new Date().toISOString();
  const nextPreset: StudioPreset = {
    id: uuidv4(),
    category: params.category,
    name: params.name.trim(),
    description: params.description,
    isDefault: Boolean(params.isDefault),
    thumbnailStyle: params.thumbnailStyle,
    payload: params.payload,
    assetRefs: params.assetRefs || [],
    createdAt: now,
    updatedAt: now,
  };
  const updatedList = params.isDefault
    ? current.map((p) => (p.category === params.category ? { ...p, isDefault: false } : p))
    : [...current];
  const all = await savePresetsRaw([nextPreset, ...updatedList]);
  const saved = all.find((p) => p.id === nextPreset.id) || nextPreset;
  return { preset: saved, presets: all };
}

export async function updatePresetLocal(
  id: string,
  patch: Partial<{
    name: string;
    description: string;
    isDefault: boolean;
    thumbnailStyle: StudioPreset['thumbnailStyle'];
    payload: Record<string, unknown>;
    assetRefs: StudioPresetAssetRef[];
  }>
): Promise<{ preset: StudioPreset; presets: StudioPreset[] }> {
  const current = (await indexedDbStore.getKv<StudioPreset[]>(PRESETS_KV_KEY)) || [];
  const target = current.find((p) => p.id === id);
  if (!target) throw new Error('Preset not found.');

  const now = new Date().toISOString();
  const nextList = current.map((p) => {
    if (p.id === id) {
      return { ...p, ...patch, updatedAt: now };
    }
    if (patch.isDefault === true && p.category === target.category) {
      return { ...p, isDefault: false };
    }
    return p;
  });
  const all = await savePresetsRaw(nextList);
  const updated = all.find((p) => p.id === id)!;
  return { preset: updated, presets: all };
}

export async function deletePresetLocal(id: string): Promise<{ deleted: boolean; presets: StudioPreset[] }> {
  const current = (await indexedDbStore.getKv<StudioPreset[]>(PRESETS_KV_KEY)) || [];
  const nextList = current.filter((p) => p.id !== id);
  const all = await savePresetsRaw(nextList);
  return { deleted: nextList.length < current.length, presets: all };
}

export async function importPresetsLocal(bundle: unknown): Promise<{
  importedCount: number;
  imported: StudioPreset[];
  presets: StudioPreset[];
}> {
  const items: StudioPreset[] = Array.isArray(bundle)
    ? (bundle as StudioPreset[])
    : Array.isArray((bundle as { presets?: StudioPreset[] })?.presets)
    ? ((bundle as { presets: StudioPreset[] }).presets)
    : [];

  if (items.length === 0) {
    throw new Error('No valid presets found in imported JSON bundle.');
  }

  const current = (await indexedDbStore.getKv<StudioPreset[]>(PRESETS_KV_KEY)) || [];
  const now = new Date().toISOString();
  const imported: StudioPreset[] = [];
  const merged = [...current];

  for (const item of items) {
    if (!item || !item.category || !item.name || !item.payload) continue;
    const clone: StudioPreset = {
      ...item,
      id: uuidv4(),
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    imported.push(clone);
    merged.unshift(clone);
  }

  const all = await savePresetsRaw(merged);
  return { importedCount: imported.length, imported, presets: all };
}

export async function applyPresetsToProjectObject(
  project: Project,
  opts?: ClientPresetApplyOptions
): Promise<{ project: Project; presetWarnings: ClientPresetWarning[] }> {
  if (!opts) return { project, presetWarnings: [] };
  const presets = await listPresetsLocal();
  const warnings: ClientPresetWarning[] = [];
  let updated = { ...project };

  const resolvePreset = (cat: PresetCategory, id?: string | null): StudioPreset | undefined => {
    if (id === 'none') return undefined;
    if (id) return presets.find((p) => p.id === id && p.category === cat);
    if (opts.applyDefaults) return presets.find((p) => p.category === cat && p.isDefault);
    return undefined;
  };

  const ed = resolvePreset('editing', opts.editingPresetId);
  if (ed) {
    if (ed.missingAssets && ed.missingAssets.length > 0) {
      warnings.push({ presetName: ed.name, missingAssets: ed.missingAssets });
    }
    const payload = ed.payload as Partial<Project> & { canvas?: Project['canvas'] };
    if (payload.canvas) {
      updated.canvas = { ...DEFAULT_VIDEO_CANVAS, ...(updated.canvas || {}), ...payload.canvas };
    }
    if (Array.isArray(payload.logos)) updated.logos = payload.logos;
    if (Array.isArray(payload.blurs)) updated.blurs = payload.blurs;
  }

  const fil = resolvePreset('filter', opts.filterPresetId);
  if (fil) {
    const payload = fil.payload as Partial<Project['videoEffects']>;
    updated.videoEffects = {
      ...DEFAULT_VIDEO_EFFECTS,
      ...(updated.videoEffects || {}),
      ...payload,
    };
  }

  const cap = resolvePreset('caption', opts.captionPresetId);
  if (cap) {
    if (cap.missingAssets && cap.missingAssets.length > 0) {
      warnings.push({ presetName: cap.name, missingAssets: cap.missingAssets });
    }
    const payload = cap.payload as Partial<Project['subtitleStyle']>;
    updated.subtitleStyle = {
      ...updated.subtitleStyle,
      ...payload,
      enabled: updated.subtitleStyle.enabled, // Never auto-enable captions
    };
  }

  updated.updatedAt = new Date().toISOString();
  return { project: updated, presetWarnings: warnings };
}

export async function listProjectsLocal(): Promise<Project[]> {
  const rows = await indexedDbStore.listProjectSnapshots();
  return rows.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getProjectLocal(id: string): Promise<Project | null> {
  const rows = await indexedDbStore.listProjectSnapshots();
  return rows.find((p) => p.id === id) || null;
}

export async function saveProjectLocal(project: Project): Promise<Project> {
  const stamped: Project = { ...project, updatedAt: new Date().toISOString() };
  await indexedDbStore.saveProjectSnapshot(stamped);
  return stamped;
}

export async function updateProjectLocal(
  id: string,
  patch: Partial<Project>
): Promise<Project> {
  const existing = await getProjectLocal(id);
  if (!existing) throw new Error('Project not found in local browser storage.');
  const updated: Project = {
    ...existing,
    ...patch,
    id: existing.id,
    updatedAt: new Date().toISOString(),
  };
  await indexedDbStore.saveProjectSnapshot(updated);
  return updated;
}

export async function deleteProjectLocal(id: string): Promise<void> {
  await indexedDbStore.deleteProjectSnapshot(id);
}

// Render Jobs
export async function listAllJobsLocal(): Promise<RenderJob[]> {
  const rows = (await indexedDbStore.getKv<RenderJob[]>(JOBS_KV_KEY)) || [];
  return rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export async function listProjectJobsLocal(projectId: string): Promise<RenderJob[]> {
  const all = await listAllJobsLocal();
  return all.filter((j) => j.projectId === projectId);
}

export async function getJobLocal(jobId: string): Promise<RenderJob | null> {
  const all = await listAllJobsLocal();
  return all.find((j) => j.id === jobId) || null;
}

export async function upsertJobLocal(job: RenderJob): Promise<RenderJob> {
  const all = await listAllJobsLocal();
  const exists = all.some((j) => j.id === job.id);
  const next = exists ? all.map((j) => (j.id === job.id ? job : j)) : [job, ...all];
  await indexedDbStore.setKv(JOBS_KV_KEY, next.slice(0, 60));
  return job;
}

// Custom Fonts
export async function listCustomFontsLocal(): Promise<SavedFontAsset[]> {
  return (await indexedDbStore.getKv<SavedFontAsset[]>(FONTS_KV_KEY)) || [];
}

export async function saveCustomFontLocal(font: SavedFontAsset): Promise<SavedFontAsset[]> {
  const current = await listCustomFontsLocal();
  const next = [font, ...current.filter((f) => f.id !== font.id)];
  await indexedDbStore.setKv(FONTS_KV_KEY, next);
  return next;
}

export async function deleteCustomFontLocal(id: string): Promise<SavedFontAsset[]> {
  const current = await listCustomFontsLocal();
  const next = current.filter((f) => f.id !== id);
  await indexedDbStore.setKv(FONTS_KV_KEY, next);
  return next;
}

// Saved Fish Voices
export async function listSavedFishVoicesLocal(): Promise<SavedFishVoice[]> {
  return (await indexedDbStore.getKv<SavedFishVoice[]>(FISH_VOICES_KV_KEY)) || [];
}

export async function createSavedFishVoiceLocal(params: {
  name: string;
  voiceId: string;
  isDefault?: boolean;
}): Promise<{ voice: SavedFishVoice; voices: SavedFishVoice[] }> {
  const current = await listSavedFishVoicesLocal();
  const now = new Date().toISOString();
  const item: SavedFishVoice = {
    id: uuidv4(),
    name: params.name.trim(),
    voiceId: params.voiceId.trim(),
    isDefault: Boolean(params.isDefault),
    createdAt: now,
    updatedAt: now,
  };
  const next = [
    item,
    ...current.map((v) => (params.isDefault ? { ...v, isDefault: false } : v)),
  ];
  await indexedDbStore.setKv(FISH_VOICES_KV_KEY, next);
  return { voice: item, voices: next };
}

export async function updateSavedFishVoiceLocal(
  id: string,
  params: { name?: string; voiceId?: string; isDefault?: boolean }
): Promise<{ voice: SavedFishVoice; voices: SavedFishVoice[] }> {
  const current = await listSavedFishVoicesLocal();
  const now = new Date().toISOString();
  const next = current.map((v) => {
    if (v.id === id) return { ...v, ...params, updatedAt: now };
    if (params.isDefault) return { ...v, isDefault: false };
    return v;
  });
  await indexedDbStore.setKv(FISH_VOICES_KV_KEY, next);
  const found = next.find((v) => v.id === id);
  if (!found) throw new Error('Saved voice not found.');
  return { voice: found, voices: next };
}

export async function deleteSavedFishVoiceLocal(
  id: string
): Promise<{ deleted: boolean; voices: SavedFishVoice[] }> {
  const current = await listSavedFishVoicesLocal();
  const next = current.filter((v) => v.id !== id);
  await indexedDbStore.setKv(FISH_VOICES_KV_KEY, next);
  return { deleted: next.length < current.length, voices: next };
}

// Subtitle SRT / VTT client-side parsers & exporters
function parseTimestampSec(tc: string): number {
  const clean = tc.trim().replace(',', '.');
  const parts = clean.split(':').map((p) => Number(p));
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return Number(clean) || 0;
}

export function parseSrtOrVtt(content: string): CaptionSegment[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/^WEBVTT[^\n]*\n*/i, '').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const segments: CaptionSegment[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    let tcIdx = lines.findIndex((l) => l.includes('-->'));
    if (tcIdx < 0) continue;
    const [rawStart, rawEnd] = lines[tcIdx].split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTimestampSec(rawStart);
    const end = Math.max(start + 0.2, parseTimestampSec(rawEnd));
    const text = lines.slice(tcIdx + 1).join(' ').trim();
    if (!text) continue;

    segments.push({
      id: uuidv4(),
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text,
      translatedText: text,
    });
  }

  return segments;
}

function formatSrtTc(sec: number): string {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(
    2,
    '0'
  )},${String(ms).padStart(3, '0')}`;
}

export function generateSrtContent(captions: CaptionSegment[]): string {
  return captions
    .map((seg, i) => {
      const text = (seg.translatedText || '').trim();
      return `${i + 1}\n${formatSrtTc(seg.start)} --> ${formatSrtTc(seg.end)}\n${text}`;
    })
    .join('\n\n');
}

export function generateVttContent(captions: CaptionSegment[]): string {
  const body = captions
    .map((seg) => {
      const text = (seg.translatedText || '').trim();
      return `${formatSrtTc(seg.start).replace(',', '.')} --> ${formatSrtTc(seg.end).replace(
        ',',
        '.'
      )}\n${text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}`;
}
