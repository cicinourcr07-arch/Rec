/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import { CloudAssetKind, Project } from '../types/studio';

export const LOCAL_MEDIA_SCHEME = 'local-media://';
const DB_NAME = 'recap_studio_browser_media_v1';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

export interface BrowserMediaRecord {
  uri: string;
  bucket: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  createdAt: string;
}

// In-memory Blob registry & active Object URL registry.
// Large video File/Blob objects in IndexedDB & liveBlobMap remain file-backed handles
// and are streamed by browser <video> elements via URL.createObjectURL(blob) without loading bytes into JS arrays.
const liveBlobMap = new Map<string, BrowserMediaRecord>();
const objectUrlCache = new Map<string, string>();

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error('IndexedDB is not supported in this browser context.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'uri' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open media IndexedDB.'));
  });
}

async function withMediaStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openMediaDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB media operation failed.'));
  });
}

export function isLocalMediaUri(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.startsWith(LOCAL_MEDIA_SCHEME);
}

export function parseLocalMediaUri(uri: string): { bucket: string; filename: string } {
  const withoutScheme = uri.slice(LOCAL_MEDIA_SCHEME.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx < 0) {
    return { bucket: 'misc', filename: withoutScheme || 'asset.bin' };
  }
  return {
    bucket: withoutScheme.slice(0, slashIdx) || 'misc',
    filename: withoutScheme.slice(slashIdx + 1) || 'asset.bin',
  };
}

export function sanitizeFilename(name: string): string {
  return (name || 'asset.bin')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || 'asset.bin';
}

export function getCachedObjectUrl(uri: string): string {
  if (!uri) return '';
  if (!isLocalMediaUri(uri)) return uri;
  const cached = objectUrlCache.get(uri);
  if (cached) return cached;
  const mem = liveBlobMap.get(uri);
  if (mem && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const objUrl = URL.createObjectURL(mem.blob);
    objectUrlCache.set(uri, objUrl);
    return objUrl;
  }
  return uri;
}

export function revokeObjectUrlForUri(uri: string | null | undefined): void {
  if (!uri || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  if (uri.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(uri);
    } catch {
      // ignore
    }
    return;
  }
  const existing = objectUrlCache.get(uri);
  if (existing) {
    try {
      URL.revokeObjectURL(existing);
    } catch {
      // ignore
    }
    objectUrlCache.delete(uri);
  }
}

export async function getMediaRecord(uri: string): Promise<BrowserMediaRecord | null> {
  if (!uri || !isLocalMediaUri(uri)) return null;
  const mem = liveBlobMap.get(uri);
  if (mem) return mem;
  if (!hasIndexedDb()) return null;
  try {
    const row = await withMediaStore<BrowserMediaRecord | undefined>('readonly', (s) =>
      s.get(uri)
    );
    if (row && row.blob) {
      liveBlobMap.set(uri, row);
      return row;
    }
  } catch {
    // ignore IDB read failures
  }
  return null;
}

export async function getMediaBlob(uri: string): Promise<Blob | null> {
  if (!uri) return null;
  if (isLocalMediaUri(uri)) {
    const rec = await getMediaRecord(uri);
    return rec?.blob || null;
  }
  try {
    const res = await fetch(uri);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

export async function hasMediaAsset(uri: string | null | undefined): Promise<boolean> {
  if (!uri) return false;
  if (isLocalMediaUri(uri)) {
    if (liveBlobMap.has(uri)) return true;
    const rec = await getMediaRecord(uri);
    return Boolean(rec);
  }
  return true;
}

export async function resolveBrowserMediaUrl(uri: string | null | undefined): Promise<string | null> {
  if (!uri) return null;
  if (!isLocalMediaUri(uri)) return uri;
  const existing = objectUrlCache.get(uri);
  if (existing) return existing;

  const rec = await getMediaRecord(uri);
  if (!rec || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return null;
  }
  const created = URL.createObjectURL(rec.blob);
  objectUrlCache.set(uri, created);
  return created;
}

export async function saveMediaBlob(params: {
  bucket: string;
  filename: string;
  blob: Blob;
  mimeType?: string;
  targetUri?: string;
  existingUrlToRevoke?: string | null;
}): Promise<{ uri: string; objectUrl: string; sizeBytes: number; filename: string }> {
  const safeName = sanitizeFilename(params.filename);
  const uri =
    params.targetUri && isLocalMediaUri(params.targetUri)
      ? params.targetUri
      : `${LOCAL_MEDIA_SCHEME}${params.bucket}/${uuidv4().slice(0, 8)}_${safeName}`;

  if (params.existingUrlToRevoke && params.existingUrlToRevoke !== uri) {
    await deleteMediaAsset(params.existingUrlToRevoke);
  } else {
    revokeObjectUrlForUri(uri);
  }

  const objectUrl =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL.createObjectURL(params.blob)
      : uri;

  const record: BrowserMediaRecord = {
    uri,
    bucket: params.bucket,
    filename: safeName,
    mimeType: params.mimeType || params.blob.type || 'application/octet-stream',
    sizeBytes: params.blob.size,
    blob: params.blob,
    createdAt: new Date().toISOString(),
  };

  liveBlobMap.set(uri, record);
  if (objectUrl.startsWith('blob:')) {
    objectUrlCache.set(uri, objectUrl);
  }

  if (hasIndexedDb()) {
    try {
      await withMediaStore('readwrite', (s) => s.put(record));
    } catch {
      // If IndexedDB quota is exceeded for huge files (e.g. >1GB), keep liveBlobMap + ObjectURL active for session.
    }
  }

  return { uri, objectUrl, sizeBytes: params.blob.size, filename: safeName };
}

export async function deleteMediaAsset(uri: string | null | undefined): Promise<void> {
  if (!uri) return;
  revokeObjectUrlForUri(uri);
  if (!isLocalMediaUri(uri)) return;
  liveBlobMap.delete(uri);
  if (hasIndexedDb()) {
    try {
      await withMediaStore('readwrite', (s) => s.delete(uri));
    } catch {
      // ignore
    }
  }
}

export function collectProjectMediaUris(project: Project): Array<{
  uri: string;
  bucket: string;
  filename: string;
  assetKind: CloudAssetKind;
  necessary: boolean;
}> {
  const out: Array<{
    uri: string;
    bucket: string;
    filename: string;
    assetKind: CloudAssetKind;
    necessary: boolean;
  }> = [];
  const seen = new Set<string>();

  const pushUri = (
    uri: string | null | undefined,
    fallbackBucket: string,
    fallbackName: string,
    assetKind: CloudAssetKind,
    necessary: boolean
  ) => {
    if (!uri || !isLocalMediaUri(uri) || seen.has(uri)) return;
    seen.add(uri);
    const parsed = parseLocalMediaUri(uri);
    out.push({
      uri,
      bucket: parsed.bucket || fallbackBucket,
      filename: parsed.filename || fallbackName,
      assetKind,
      necessary,
    });
  };

  pushUri(project.sourceVideoUrl, 'video', project.sourceFilename || 'source_video.mp4', 'video', false);
  pushUri(project.thumbnailUrl, 'thumbs', 'cover.jpg', 'thumbnail', true);
  pushUri(project.lastExportUrl, 'exports', 'final_export.mp4', 'final-export', true);
  pushUri(project.canvas?.bgImageUrl, 'backgrounds', project.canvas?.bgImageFilename || 'background.png', 'background', true);
  pushUri(project.voice?.fullDubUrl, 'audio', 'full_dub.mp3', 'voice', true);
  pushUri(project.voice?.bgMusicUrl, 'audio', project.voice?.bgMusicFilename || 'music.mp3', 'music', true);
  pushUri(project.voice?.sfxUrl, 'audio', project.voice?.sfxFilename || 'sfx.mp3', 'sfx', true);
  pushUri(project.subtitleStyle?.customFontUrl, 'fonts', `${project.subtitleStyle?.fontFamily || 'custom'}.ttf`, 'font', true);

  for (const clip of project.voice?.generatedClips || []) {
    pushUri(clip.audioUrl, 'audio', `${clip.segmentId}.mp3`, 'voice-segment', false);
  }
  for (const logo of project.logos || []) {
    pushUri(logo.url, 'logos', logo.filename || 'logo.png', 'logo', true);
  }
  for (const blur of project.blurs || []) {
    pushUri(blur.maskAssetId, 'masks', `${blur.id}.png`, 'mask', true);
  }
  for (const thumb of project.savedThumbnails || []) {
    pushUri(thumb.url, 'thumbs', `${thumb.id}.${thumb.format}`, 'thumbnail', false);
  }

  return out;
}

export async function hydrateAllProjectMediaUrls(
  projects: Project[],
  extraUris: string[] = []
): Promise<void> {
  const uris = new Set<string>(extraUris.filter((u) => isLocalMediaUri(u)));
  for (const p of projects) {
    for (const item of collectProjectMediaUris(p)) {
      uris.add(item.uri);
    }
  }
  await Promise.all(Array.from(uris).map((uri) => resolveBrowserMediaUrl(uri)));
}

export async function deleteProjectMediaAssets(project: Project): Promise<void> {
  const items = collectProjectMediaUris(project).filter((item) => item.assetKind !== 'font');
  await Promise.all(items.map((item) => deleteMediaAsset(item.uri)));
}

export async function getBrowserMediaUsage(): Promise<{
  totalBytes: number;
  buckets: Record<string, { bytes: number; files: number }>;
}> {
  const seen = new Map<string, BrowserMediaRecord>();
  for (const [k, v] of liveBlobMap.entries()) {
    seen.set(k, v);
  }
  if (hasIndexedDb()) {
    try {
      const rows = await withMediaStore<BrowserMediaRecord[]>('readonly', (s) => s.getAll());
      for (const row of rows || []) {
        if (row && row.uri && !seen.has(row.uri)) {
          seen.set(row.uri, row);
        }
      }
    } catch {
      // ignore
    }
  }

  let totalBytes = 0;
  const buckets: Record<string, { bytes: number; files: number }> = {};
  for (const rec of seen.values()) {
    const size = rec.sizeBytes || rec.blob?.size || 0;
    const bucket = rec.bucket || 'misc';
    totalBytes += size;
    if (!buckets[bucket]) buckets[bucket] = { bytes: 0, files: 0 };
    buckets[bucket].bytes += size;
    buckets[bucket].files += 1;
  }

  return { totalBytes, buckets };
}

export async function listAllBrowserMediaRecords(): Promise<BrowserMediaRecord[]> {
  const seen = new Map<string, BrowserMediaRecord>();
  for (const [k, v] of liveBlobMap.entries()) {
    seen.set(k, v);
  }
  if (hasIndexedDb()) {
    try {
      const rows = await withMediaStore<BrowserMediaRecord[]>('readonly', (s) => s.getAll());
      for (const row of rows || []) {
        if (row && row.uri && !seen.has(row.uri)) {
          seen.set(row.uri, row);
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(seen.values());
}

export async function cleanupOrphanedBrowserMedia(
  projects: Project[],
  customFontUrls: string[]
): Promise<number> {
  const active = new Set<string>(customFontUrls.filter((u) => isLocalMediaUri(u)));
  for (const p of projects) {
    for (const item of collectProjectMediaUris(p)) {
      active.add(item.uri);
    }
  }
  const all = await listAllBrowserMediaRecords();
  let removed = 0;
  for (const rec of all) {
    if (!active.has(rec.uri)) {
      await deleteMediaAsset(rec.uri);
      removed += 1;
    }
  }
  return removed;
}

export async function clearAllBrowserMedia(): Promise<void> {
  for (const uri of Array.from(objectUrlCache.keys())) {
    revokeObjectUrlForUri(uri);
  }
  liveBlobMap.clear();
  if (hasIndexedDb()) {
    try {
      await withMediaStore('readwrite', (s) => s.clear());
    } catch {
      // ignore
    }
  }
}

export async function computeBlobSha256(blob: Blob): Promise<string> {
  // For very large files (> 64 MB), compute a fast deterministic fingerprint from header + tail + size
  // to avoid reading multi-hundred-MB or GB videos entirely into RAM.
  if (blob.size > 64 * 1024 * 1024) {
    const head = await blob.slice(0, 65536).arrayBuffer();
    const tail = await blob.slice(Math.max(0, blob.size - 65536), blob.size).arrayBuffer();
    const combined = new Uint8Array(head.byteLength + tail.byteLength + 16);
    combined.set(new Uint8Array(head), 0);
    combined.set(new Uint8Array(tail), head.byteLength);
    const view = new DataView(combined.buffer, head.byteLength + tail.byteLength, 16);
    view.setFloat64(0, blob.size);
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', combined);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return `fast_${blob.size}`;
  }

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  return `size_${blob.size}`;
}
