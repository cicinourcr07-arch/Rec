/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { Project, VideoMetadata } from '../../src/types/studio.ts';
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
  getAssetByUrl,
  registerAsset,
} from '../db.ts';
import { analyzeVideoFile } from './video_analysis_service.ts';

export type CompressionPreset = 'under-45mb' | '720p-compact' | '480p-compact';

const BUCKET_DIRS: Record<string, string> = {
  uploads: UPLOADS_DIR,
  exports: EXPORTS_DIR,
  audio: AUDIO_DIR,
  fonts: FONTS_DIR,
  thumbs: THUMBS_DIR,
  thumbnails: THUMBS_DIR,
  logos: LOGOS_DIR,
  masks: MASKS_DIR,
  backgrounds: BACKGROUNDS_DIR,
};

function resolveLocalPathFromUrl(url: string): string | null {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  const registered = getAssetByUrl(url);
  if (registered && fs.existsSync(registered.file_path)) {
    return registered.file_path;
  }

  const clean = url.split('?')[0];
  const mediaMatch = /^\/media\/([^/]+)\/(.+)$/.exec(clean);
  if (mediaMatch) {
    const [, bucket, filename] = mediaMatch;
    const baseDir = BUCKET_DIRS[bucket];
    if (baseDir) {
      return path.join(baseDir, path.basename(filename));
    }
  }

  const rel = clean.replace(/^\/+/, '');
  return path.resolve(STORAGE_DIR, rel);
}

export function computeLocalStorageUsage() {
  const buckets: Record<string, { bytes: number; files: number }> = {
    uploads: { bytes: 0, files: 0 },
    exports: { bytes: 0, files: 0 },
    audio: { bytes: 0, files: 0 },
    fonts: { bytes: 0, files: 0 },
    thumbnails: { bytes: 0, files: 0 },
  };

  let totalBytes = 0;

  function scanDir(dir: string, bucketName: string) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        scanDir(fullPath, bucketName);
      } else if (ent.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          totalBytes += stat.size;
          if (buckets[bucketName]) {
            buckets[bucketName].bytes += stat.size;
            buckets[bucketName].files += 1;
          }
        } catch {
          // ignore
        }
      }
    }
  }

  scanDir(UPLOADS_DIR, 'uploads');
  scanDir(EXPORTS_DIR, 'exports');
  scanDir(AUDIO_DIR, 'audio');
  scanDir(FONTS_DIR, 'fonts');
  scanDir(THUMBS_DIR, 'thumbnails');
  scanDir(LOGOS_DIR, 'thumbnails');
  scanDir(MASKS_DIR, 'thumbnails');
  scanDir(BACKGROUNDS_DIR, 'thumbnails');

  return { totalBytes, buckets };
}

export function inspectProjectAssets(project: Project) {
  const assets: Array<{
    localUrl: string;
    bucket: string;
    filename: string;
    assetKind: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    exists: boolean;
    exceedsFree50MbCap: boolean;
    necessaryForCloudSync: boolean;
  }> = [];

  const checkUrl = (url: string | null | undefined, bucket: string, assetKind: string, mimeType: string) => {
    if (!url || url.startsWith('blob:') || url.startsWith('data:')) return;
    const absPath = resolveLocalPathFromUrl(url);
    if (!absPath) return;
    const exists = fs.existsSync(absPath);
    let sizeBytes = 0;
    let sha256 = 'local_hash';
    if (exists) {
      try {
        const stat = fs.statSync(absPath);
        sizeBytes = stat.size;
        if (stat.size <= 200 * 1024 * 1024) {
          const buf = fs.readFileSync(absPath);
          sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        }
      } catch {
        // ignore
      }
    }
    assets.push({
      localUrl: url,
      bucket,
      filename: path.basename(absPath),
      assetKind,
      mimeType,
      sizeBytes,
      sha256,
      exists,
      exceedsFree50MbCap: sizeBytes > 50 * 1024 * 1024,
      necessaryForCloudSync: true,
    });
  };

  checkUrl(project.sourceVideoUrl, 'uploads', 'video', 'video/mp4');
  checkUrl(project.lastExportUrl, 'exports', 'export', 'video/mp4');
  checkUrl(project.thumbnailUrl, 'thumbs', 'thumbnail', 'image/jpeg');
  if (project.voice.fullDubUrl) {
    checkUrl(project.voice.fullDubUrl, 'audio', 'audio', 'audio/wav');
  }
  if (project.voice.bgMusicUrl) {
    checkUrl(project.voice.bgMusicUrl, 'audio', 'audio', 'audio/mpeg');
  }
  if (project.voice.sfxUrl) {
    checkUrl(project.voice.sfxUrl, 'audio', 'audio', 'audio/mpeg');
  }
  for (const logo of project.logos || []) {
    checkUrl(logo.url, 'logos', 'logo', logo.url.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
  }

  const totalBytes = assets.reduce((acc, a) => acc + a.sizeBytes, 0);
  const necessaryBytes = totalBytes;
  const oversizedCount = assets.filter((a) => a.exceedsFree50MbCap).length;

  return { assets, totalBytes, necessaryBytes, oversizedCount };
}

export async function compressProjectVideoForFreeCloud(opts: {
  project: Project;
  preset: CompressionPreset;
  target: 'source' | 'final-export';
}) {
  const { project, preset, target } = opts;
  const targetUrl = target === 'final-export' ? project.lastExportUrl : project.sourceVideoUrl;
  if (!targetUrl) {
    throw new Error('No video URL found for compression.');
  }

  const inputPath = resolveLocalPathFromUrl(targetUrl);
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw new Error('Video file not found on local disk.');
  }

  const bucket = target === 'final-export' ? 'exports' : 'uploads';
  const targetDir = target === 'final-export' ? EXPORTS_DIR : UPLOADS_DIR;
  const outFilename = `compact_${project.id.slice(0, 8)}_${Date.now()}.mp4`;
  const outputPath = path.join(targetDir, outFilename);

  const { spawn } = await import('node:child_process');
  let vf = 'scale=-2:720';
  let crf = '28';
  if (preset === 'under-45mb') {
    vf = 'scale=-2:480';
    crf = '32';
  } else if (preset === '480p-compact') {
    vf = 'scale=-2:480';
    crf = '30';
  }

  await new Promise<void>((resolve, reject) => {
    const cp = spawn(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-crf',
        crf,
        '-preset',
        'fast',
        '-movflags',
        '+faststart',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderrTail = '';
    cp.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1500);
    });
    cp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg compression exited with code ${code}: ${stderrTail}`));
    });
    cp.on('error', (err) => reject(err));
  });

  const stat = fs.statSync(outputPath);
  const compressedBytes = stat.size;
  const originalStat = fs.statSync(inputPath);
  const originalBytes = originalStat.size;
  const metadata: VideoMetadata = await analyzeVideoFile(outputPath);

  const compressedUrl = `/media/${bucket}/${outFilename}`;
  registerAsset({
    id: uuidv4(),
    projectId: project.id,
    kind: target === 'final-export' ? 'export' : 'video',
    filename: outFilename,
    filePath: outputPath,
    url: compressedUrl,
    mimeType: 'video/mp4',
    sizeBytes: compressedBytes,
  });

  return {
    project,
    compressedUrl,
    filename: outFilename,
    originalSourceUrl: targetUrl,
    originalBytes,
    compressedBytes,
    metadata,
    target,
  };
}

export function hydrateAssetToLocalBucket(opts: {
  projectId: string;
  targetLocalUrl?: string;
  bucket: string;
  filename: string;
  assetKind: string;
  mimeType: string;
  buffer: Buffer;
}) {
  const safeBucket = opts.bucket === 'thumbnails' ? 'thumbs' : opts.bucket;
  const bucketDir = BUCKET_DIRS[safeBucket] || UPLOADS_DIR;
  fs.mkdirSync(bucketDir, { recursive: true });

  let safeName = path.basename(opts.filename).replace(/[^a-zA-Z0-9_.-]/g, '_');
  if (opts.targetLocalUrl) {
    const match = /^\/media\/([^/]+)\/(.+)$/.exec(opts.targetLocalUrl.split('?')[0]);
    if (match) {
      safeName = path.basename(match[2]).replace(/[^a-zA-Z0-9_.-]/g, '_');
    }
  }

  const filePath = path.join(bucketDir, safeName);
  fs.writeFileSync(filePath, opts.buffer);

  const resolvedBucket = safeBucket in BUCKET_DIRS ? safeBucket : 'uploads';
  const localUrl = `/media/${resolvedBucket}/${safeName}`;

  registerAsset({
    id: uuidv4(),
    projectId: opts.projectId,
    kind: opts.assetKind || resolvedBucket,
    filename: safeName,
    filePath,
    url: localUrl,
    mimeType: opts.mimeType || 'application/octet-stream',
    sizeBytes: opts.buffer.length,
  });

  return {
    success: true,
    localUrl,
    filePath,
    filename: safeName,
    sizeBytes: opts.buffer.length,
  };
}
