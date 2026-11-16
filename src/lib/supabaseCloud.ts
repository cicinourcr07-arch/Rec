/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Project, CloudAssetManifestEntry } from '../types/studio';
import { resolveApiUrl } from './api';

export function isSupabaseConfigured(): boolean {
  return false;
}

export function getSupabaseClient() {
  return {
    auth: {
      onAuthStateChange: (_callback: (evt: string, session: any) => void) => {
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  };
}

export async function getCloudSession(): Promise<{ user: { id: string; email: string } | null }> {
  return { user: null };
}

export async function resolvePlayableAssetUrl(
  url: string | null,
  _cloudAssets?: Record<string, CloudAssetManifestEntry>
): Promise<string | null> {
  if (!url) return null;
  return resolveApiUrl(url);
}

export async function downloadProjectAsset(opts: {
  url?: string | null;
  localUrl?: string | null;
  filename: string;
  cloudAssets?: Record<string, CloudAssetManifestEntry>;
}): Promise<void> {
  const rawTarget = opts.url || opts.localUrl;
  if (!rawTarget) return;
  const targetUrl = resolveApiUrl(rawTarget);
  try {
    const res = await fetch(targetUrl);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = opts.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  } catch (err) {
    console.error('Download error:', err);
    window.open(targetUrl, '_blank');
  }
}

export async function hydrateProjectAssetsFromCloud(_project: Project): Promise<Project> {
  return _project;
}

export function queueDebouncedMetadataSync(
  project: Project,
  callback?: (synced: Project) => void
): void {
  if (callback) callback(project);
}

export function subscribeToCloudProjectsRealtime(
  _userId: string,
  _onEvent: (evt: { eventType: string; projectId?: string; project?: Project }) => void
): () => void {
  return () => {};
}

export async function uploadSingleProjectAssetToCloud(
  project: Project,
  _localUrl: string,
  _opts?: { signal?: AbortSignal; onProgress?: (pct: number, stage: string) => void }
): Promise<{
  project: Project;
  message: string;
  failedUploads: Array<{ filename: string; sizeBytes: number; reason: string }>;
  skippedLargeAssets: Array<{ filename: string; sizeBytes: number; reason: string }>;
  cancelled: boolean;
}> {
  return {
    project,
    message: 'Saved locally (100% local mode).',
    failedUploads: [],
    skippedLargeAssets: [],
    cancelled: false,
  };
}
