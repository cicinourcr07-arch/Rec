/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ColorAdjustments,
  DEFAULT_VIDEO_CANVAS,
  VideoCanvasConfig,
  VideoEffectsConfig,
  VideoMetadata,
} from '../types/studio';
import {
  getMediaBlob,
  isLocalMediaUri,
  resolveBrowserMediaUrl,
  saveMediaBlob,
} from './browserMediaStore';

export const MAX_VIDEO_SIZE_BYTES = 2048 * 1024 * 1024; // 2 GB
const WAVEFORM_RAM_LIMIT_BYTES = 80 * 1024 * 1024; // Avoid full-file arrayBuffer RAM load on >80 MB videos
const AUDIO_EXTRACT_RAM_LIMIT_BYTES = 140 * 1024 * 1024;

export function validateBrowserVideoFile(file: File): void {
  if (!file || file.size <= 0) {
    throw new Error('Selected video file is empty (0 bytes). Please select a valid video file.');
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['mp4', 'mov', 'mkv'].includes(ext)) {
    throw new Error(
      `Unsupported video format ".${ext || 'unknown'}". Supported formats: MP4, MOV, MKV.`
    );
  }
  if (file.size > MAX_VIDEO_SIZE_BYTES) {
    throw new Error('Video file exceeds the 2 GB (2048 MB) maximum supported size.');
  }
}

export function validateImageFile(
  file: File,
  allowedExtensions: string[],
  maxBytes = 25 * 1024 * 1024
): void {
  if (!file || file.size <= 0) {
    throw new Error('Selected image file is empty (0 bytes).');
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(
      `Unsupported image format ".${ext || 'unknown'}". Supported: ${allowedExtensions.join(', ').toUpperCase()}.`
    );
  }
  if (file.size > maxBytes) {
    throw new Error(`Image exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  }
}

export function validateAudioFile(file: File, maxBytes = 100 * 1024 * 1024): void {
  if (!file || file.size <= 0) {
    throw new Error('Selected audio file is empty (0 bytes).');
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac', 'webm'].includes(ext)) {
    throw new Error(
      `Unsupported audio format ".${ext || 'unknown'}". Supported: MP3, WAV, AAC, M4A, OGG.`
    );
  }
  if (file.size > maxBytes) {
    throw new Error(`Audio file exceeds ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  }
}

export function validateFontFile(file: File, maxBytes = 20 * 1024 * 1024): void {
  if (!file || file.size <= 0) {
    throw new Error('Selected font file is empty (0 bytes).');
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['ttf', 'otf', 'woff', 'woff2'].includes(ext)) {
    throw new Error('Unsupported font format. Please upload a .ttf, .otf, .woff, or .woff2 file.');
  }
  if (file.size > maxBytes) {
    throw new Error('Font file exceeds 20 MB limit.');
  }
}

export function buildCanvasFilterCss(fx?: VideoEffectsConfig | null): string {
  if (!fx) return 'none';
  const parts: string[] = [];

  switch (fx.filterPreset) {
    case 'cinematic':
      parts.push('contrast(118%) saturate(112%) sepia(10%) hue-rotate(-5deg)');
      break;
    case 'vintage':
      parts.push('sepia(45%) contrast(92%) brightness(104%) saturate(75%)');
      break;
    case 'film':
      parts.push('contrast(112%) saturate(105%) sepia(8%)');
      break;
    case 'warm':
      parts.push('sepia(25%) saturate(115%) hue-rotate(-8deg)');
      break;
    case 'cool':
      parts.push('hue-rotate(15deg) saturate(95%) contrast(108%)');
      break;
    case 'black-white':
      parts.push('grayscale(100%) contrast(128%)');
      break;
    case 'high-contrast':
      parts.push('contrast(135%) brightness(97%) saturate(115%)');
      break;
    case 'moody':
      parts.push('contrast(122%) brightness(92%) saturate(82%) hue-rotate(10deg)');
      break;
    case 'faded':
      parts.push('contrast(86%) brightness(106%) saturate(82%)');
      break;
    case 'vibrant':
      parts.push('contrast(114%) brightness(101%) saturate(145%)');
      break;
    case 'natural':
      parts.push('contrast(105%) saturate(112%)');
      break;
  }

  const adj: ColorAdjustments | undefined = fx.adjustments;
  if (adj) {
    const b = 1 + ((adj.brightness || 0) + (adj.exposure || 0) * 0.7) / 100;
    if (Math.abs(b - 1) > 0.01) parts.push(`brightness(${Math.max(0.2, Math.min(2.0, b)).toFixed(3)})`);

    const c = 1 + (adj.contrast || 0) / 100;
    if (Math.abs(c - 1) > 0.01) parts.push(`contrast(${Math.max(0.2, Math.min(2.5, c)).toFixed(3)})`);

    let s = 1 + (adj.saturation || 0) / 100;
    if ((adj.fade || 0) > 0) s *= Math.max(0.4, 1 - ((adj.fade || 0) / 100) * 0.4);
    if (Math.abs(s - 1) > 0.01) parts.push(`saturate(${Math.max(0, Math.min(3.0, s)).toFixed(3)})`);

    if ((adj.temperature || 0) !== 0) {
      parts.push(
        adj.temperature > 0
          ? `sepia(${(adj.temperature * 0.35).toFixed(1)}%)`
          : `hue-rotate(${(adj.temperature * 0.3).toFixed(1)}deg)`
      );
    }
    if ((adj.tint || 0) !== 0) {
      parts.push(`hue-rotate(${(adj.tint * 0.25).toFixed(1)}deg)`);
    }
  }

  const blurFx = fx.effects?.find((e) => e.enabled && e.type === 'blur');
  if (blurFx) {
    parts.push(`blur(${Math.max(1, Math.round((blurFx.intensity / 100) * 12))}px)`);
  }

  return parts.length > 0 ? parts.join(' ') : 'none';
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

export async function probeAudioDuration(blob: Blob): Promise<number> {
  if (typeof document === 'undefined') return 0;
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise<number>((resolve) => {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      const cleanup = () => {
        audio.onloadedmetadata = null;
        audio.onerror = null;
        audio.removeAttribute('src');
        audio.load();
      };
      audio.onloadedmetadata = () => {
        const dur = Number.isFinite(audio.duration) ? audio.duration : 0;
        cleanup();
        resolve(dur);
      };
      audio.onerror = () => {
        cleanup();
        resolve(0);
      };
      audio.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function extractWaveformPeaksFromBlob(
  blob: Blob,
  peaksCount = 120
): Promise<{ peaks: number[]; hasDetectedAudio: boolean | null }> {
  const Ctor = getAudioContextCtor();
  if (!Ctor || blob.size > WAVEFORM_RAM_LIMIT_BYTES) {
    // Large files (>80 MB) bypass full-file arrayBuffer decode to guarantee zero browser OOM crashes.
    const fallback = Array.from({ length: peaksCount }, (_, i) => {
      const v = 0.28 + 0.22 * Math.abs(Math.sin(i * 0.37) * Math.cos(i * 0.13));
      return Number(v.toFixed(3));
    });
    return { peaks: fallback, hasDetectedAudio: null };
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    if (!audioBuffer || audioBuffer.numberOfChannels === 0 || audioBuffer.length === 0) {
      return { peaks: new Array(peaksCount).fill(0.1), hasDetectedAudio: false };
    }
    const channelData = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channelData.length / peaksCount));
    const peaks: number[] = [];
    let maxPeak = 0;

    for (let i = 0; i < peaksCount; i++) {
      const start = i * blockSize;
      const end = Math.min(channelData.length, start + blockSize);
      const step = Math.max(1, Math.floor((end - start) / 40));
      let sumSq = 0;
      let samples = 0;
      for (let j = start; j < end; j += step) {
        const v = channelData[j];
        sumSq += v * v;
        samples += 1;
      }
      const rms = samples > 0 ? Math.sqrt(sumSq / samples) : 0;
      if (rms > maxPeak) maxPeak = rms;
      peaks.push(rms);
    }

    const scale = maxPeak > 0.001 ? 1 / maxPeak : 1;
    return {
      peaks: peaks.map((p) => Number(Math.min(1, Math.max(0.04, p * scale)).toFixed(3))),
      hasDetectedAudio: maxPeak > 0.0005,
    };
  } catch {
    const fallback = Array.from({ length: peaksCount }, (_, i) =>
      Number((0.25 + 0.2 * Math.abs(Math.sin(i * 0.42))).toFixed(3))
    );
    return { peaks: fallback, hasDetectedAudio: null };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => {});
    }
  }
}

export async function probeVideoMetadataAndCover(
  blob: Blob,
  filename: string,
  onProgress?: (pct: number, stage: string) => void
): Promise<{
  metadata: VideoMetadata;
  coverBlob: Blob | null;
  waveformPeaks: number[];
}> {
  if (typeof document === 'undefined') {
    throw new Error('Browser DOM is required to probe video metadata.');
  }

  onProgress?.(20, 'Reading local video metadata via HTML5 Video Engine...');
  const tempObjectUrl = URL.createObjectURL(blob);

  try {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(
          new Error(
            'Timed out decoding video metadata in browser. Ensure the file uses a browser-supported codec (H.264/VP9/AV1 MP4 or WebM).'
          )
        );
      }, 25000);

      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        const mediaErr = video.error;
        reject(
          new Error(
            `Browser could not decode "${filename}" (${mediaErr?.message || 'unsupported codec/container'}). Try H.264 MP4 or WebM.`
          )
        );
      };
      video.src = tempObjectUrl;
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;

    onProgress?.(48, 'Extracting video frame thumbnail via Canvas 2D...');
    let coverBlob: Blob | null = null;
    try {
      const seekTarget = duration > 0.4 ? Math.min(2.0, duration * 0.15) : 0;
      await seekVideoElement(video, seekTarget);

      const maxCoverW = 640;
      const scale = width > maxCoverW ? maxCoverW / width : 1;
      const cw = Math.max(2, Math.round(width * scale));
      const ch = Math.max(2, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, cw, ch);
        coverBlob = await new Promise<Blob | null>((res) =>
          canvas.toBlob((b) => res(b), 'image/jpeg', 0.85)
        );
      }
    } catch {
      coverBlob = null;
    }

    onProgress?.(72, 'Analyzing audio stream & computing waveform peaks...');
    const { peaks: waveformPeaks, hasDetectedAudio } = await extractWaveformPeaksFromBlob(
      blob,
      120
    );

    const anyVideo = video as HTMLVideoElement & {
      mozHasAudio?: boolean;
      webkitAudioDecodedByteCount?: number;
      audioTracks?: { length: number };
    };
    const browserReportedAudio =
      anyVideo.mozHasAudio === true ||
      (typeof anyVideo.webkitAudioDecodedByteCount === 'number' &&
        anyVideo.webkitAudioDecodedByteCount > 0) ||
      (anyVideo.audioTracks && anyVideo.audioTracks.length > 0);

    const hasAudio =
      hasDetectedAudio !== null
        ? hasDetectedAudio
        : browserReportedAudio !== undefined
        ? browserReportedAudio
        : true;

    const ext = (filename.split('.').pop() || 'mp4').toUpperCase();
    const bitrate =
      duration > 0 ? Math.round((blob.size * 8) / duration) : Math.round(blob.size * 8);

    const metadata: VideoMetadata = {
      duration: Number(duration.toFixed(2)),
      width,
      height,
      fps: 30,
      videoCodec: ext === 'MKV' ? 'MKV Video' : ext === 'MOV' ? 'QuickTime' : 'H.264 / Browser',
      audioCodec: hasAudio ? 'AAC / Browser Audio' : null,
      bitrate,
      fileSize: blob.size,
      hasAudio,
      formatName: blob.type || ext.toLowerCase(),
    };

    video.pause();
    video.removeAttribute('src');
    video.load();

    onProgress?.(94, 'Saving disk-backed media handle in browser storage...');
    return { metadata, coverBlob, waveformPeaks };
  } finally {
    URL.revokeObjectURL(tempObjectUrl);
  }
}

export function seekVideoElement(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const safeTime = Math.max(
      0,
      Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(timeSec, Math.max(0, video.duration - 0.05))
        : timeSec
    );

    if (video.readyState >= 2 && Math.abs(video.currentTime - safeTime) < 0.03) {
      resolve();
      return;
    }

    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onSeeked = () => done();
    const onError = () => done();
    const timeoutId = window.setTimeout(done, 4000);

    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try {
      video.currentTime = safeTime;
    } catch {
      done();
    }
  });
}

export function pickSupportedRecorderMimeType(): {
  mimeType: string;
  extension: 'mp4' | 'webm';
} {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder API is not supported in this browser.');
  }
  const candidates: Array<{ mime: string; ext: 'mp4' | 'webm' }> = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(c.mime)) {
      return { mimeType: c.mime, extension: c.ext };
    }
  }
  return { mimeType: '', extension: 'webm' };
}

export async function synthesizeBrowserSampleVideo(
  onProgress?: (pct: number, stage: string) => void
): Promise<{ blob: Blob; filename: string; mimeType: string }> {
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    throw new Error('Browser Canvas / MediaRecorder API is required to generate sample video.');
  }

  onProgress?.(10, 'Preparing browser Canvas + Web Audio sample generator...');
  const width = 1280;
  const height = 720;
  const fps = 30;
  const durationSec = 4.2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize 2D canvas context.');

  const Ctor = getAudioContextCtor();
  let audioCtx: AudioContext | null = null;
  const tracks: MediaStreamTrack[] = [];
  const canvasStream = canvas.captureStream(fps);
  tracks.push(...canvasStream.getVideoTracks());

  if (Ctor) {
    try {
      audioCtx = new Ctor();
      const dest = audioCtx.createMediaStreamDestination();
      const masterGain = audioCtx.createGain();
      masterGain.gain.setValueAtTime(0.01, audioCtx.currentTime);
      masterGain.gain.linearRampToValueAtTime(0.18, audioCtx.currentTime + 0.4);
      masterGain.gain.linearRampToValueAtTime(0.14, audioCtx.currentTime + durationSec - 0.5);
      masterGain.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + durationSec);

      const osc1 = audioCtx.createOscillator();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(110, audioCtx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(146.83, audioCtx.currentTime + durationSec * 0.5);
      osc1.frequency.exponentialRampToValueAtTime(98, audioCtx.currentTime + durationSec);

      const osc2 = audioCtx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(220, audioCtx.currentTime);
      osc2.frequency.linearRampToValueAtTime(293.66, audioCtx.currentTime + durationSec);

      osc1.connect(masterGain);
      osc2.connect(masterGain);
      masterGain.connect(dest);
      osc1.start();
      osc2.start();
      osc1.stop(audioCtx.currentTime + durationSec);
      osc2.stop(audioCtx.currentTime + durationSec);
      tracks.push(...dest.stream.getAudioTracks());
    } catch {
      // fallback to silent video stream if audio context blocked
    }
  }

  const combinedStream = new MediaStream(tracks);
  const { mimeType, extension } = pickSupportedRecorderMimeType();
  const chunks: Blob[] = [];
  const recorder = mimeType
    ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: 2_500_000 })
    : new MediaRecorder(combinedStream);

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const recordedPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const finalMime = recorder.mimeType || mimeType || `video/${extension}`;
      resolve(new Blob(chunks, { type: finalMime }));
    };
    recorder.onerror = () => reject(new Error('MediaRecorder error while generating sample clip.'));
  });

  recorder.start(250);

  const totalFrames = Math.round(durationSec * fps);
  const frameIntervalMs = 1000 / fps;

  const scenes = [
    { heading: 'ACT I · THE OBSERVATORY', sub: 'At 2:14 AM, the roof dome unlocked from inside.', c1: '#1E1B4B', c2: '#09090B', accent: '#A78BFA' },
    { heading: 'ACT II · THE FOOTAGE', sub: 'Fourteen minutes of security tape were missing.', c1: '#172554', c2: '#09090B', accent: '#38BDF8' },
    { heading: 'ACT III · THE REVEAL', sub: 'Nobody entered the vault—someone left it.', c1: '#3B0764', c2: '#09090B', accent: '#FACC15' },
  ];

  for (let f = 0; f < totalFrames; f++) {
    const t = f / fps;
    const progress = f / totalFrames;
    const sceneIdx = Math.min(scenes.length - 1, Math.floor(progress * scenes.length));
    const sc = scenes[sceneIdx];

    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, sc.c1);
    grad.addColorStop(1, sc.c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Subtle animated telemetry rings
    const cx = width * (0.28 + 0.44 * Math.sin(t * 0.7));
    const cy = height * 0.42;
    const rad = ctx.createRadialGradient(cx, cy, 10, cx, cy, 340);
    rad.addColorStop(0, `${sc.accent}33`);
    rad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.strokeRect(48, 48, width - 96, height - 96);

    ctx.fillStyle = sc.accent;
    ctx.font = 'bold 24px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sc.heading, width / 2, height * 0.36);

    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 42px sans-serif';
    ctx.fillText('OBSERVATORY MYSTERY RECAP', width / 2, height * 0.48);

    ctx.fillStyle = '#D4D4D8';
    ctx.font = '24px sans-serif';
    ctx.fillText(sc.sub, width / 2, height * 0.58);

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '16px monospace';
    ctx.fillText(`REC ● 00:0${t.toFixed(2)}s · BROWSER CANVAS DEMO`, width / 2, height - 72);

    onProgress?.(Math.round(15 + progress * 75), 'Encoding sample recap clip in browser...');
    await new Promise((r) => setTimeout(r, frameIntervalMs));
  }

  recorder.stop();
  const blob = await recordedPromise;
  tracks.forEach((tr) => tr.stop());
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
  }

  return {
    blob,
    filename: `observatory_sample_recap.${extension}`,
    mimeType: blob.type || `video/${extension}`,
  };
}

export async function extractBrowserThumbnailFrames(params: {
  sourceUri: string;
  canvas?: VideoCanvasConfig;
  videoEffects?: VideoEffectsConfig;
}): Promise<string[]> {
  if (typeof document === 'undefined') {
    throw new Error('Browser Canvas API required for thumbnail extraction.');
  }
  const playableUrl = isLocalMediaUri(params.sourceUri)
    ? await resolveBrowserMediaUrl(params.sourceUri)
    : params.sourceUri;

  if (!playableUrl) {
    throw new Error('Source video file is unavailable in browser storage. Please re-select the video.');
  }

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  if (!playableUrl.startsWith('blob:') && !playableUrl.startsWith('data:')) {
    video.crossOrigin = 'anonymous';
  }

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error('Timed out loading video frames.')), 20000);
    video.onloadedmetadata = () => {
      window.clearTimeout(t);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(t);
      reject(new Error('Could not decode video to extract thumbnail frames.'));
    };
    video.src = playableUrl;
  });

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const srcW = video.videoWidth || 1280;
  const srcH = video.videoHeight || 720;

  const cv = { ...DEFAULT_VIDEO_CANVAS, ...(params.canvas || {}) };
  const cropL = Math.max(0, Math.min(45, cv.cropLeft || 0)) / 100;
  const cropR = Math.max(0, Math.min(45, cv.cropRight || 0)) / 100;
  const cropT = Math.max(0, Math.min(45, cv.cropTop || 0)) / 100;
  const cropB = Math.max(0, Math.min(45, cv.cropBottom || 0)) / 100;

  const sx = Math.round(srcW * cropL);
  const sy = Math.round(srcH * cropT);
  const sw = Math.max(16, Math.round(srcW * (1 - cropL - cropR)));
  const sh = Math.max(16, Math.round(srcH * (1 - cropT - cropB)));

  const maxOutW = 720;
  const outScale = sw > maxOutW ? maxOutW / sw : 1;
  const outW = Math.max(16, Math.round(sw * outScale));
  const outH = Math.max(16, Math.round(sh * outScale));

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const ratios = [0.12, 0.28, 0.48, 0.68, 0.84];
  const savedUris: string[] = [];

  for (let i = 0; i < ratios.length; i++) {
    const ts = Math.min(Math.max(0.05, duration * ratios[i]), Math.max(0.05, duration - 0.1));
    await seekVideoElement(video, ts);

    ctx.save();
    ctx.clearRect(0, 0, outW, outH);
    ctx.filter = buildCanvasFilterCss(params.videoEffects);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
    ctx.restore();

    const frameBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode video frame.'))),
        'image/jpeg',
        0.88
      );
    });

    const saved = await saveMediaBlob({
      bucket: 'thumbs',
      filename: `frame_${i + 1}.jpg`,
      blob: frameBlob,
      mimeType: 'image/jpeg',
    });
    savedUris.push(saved.uri);
  }

  video.pause();
  video.removeAttribute('src');
  video.load();

  return savedUris;
}

function encodeAudioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels);
  const sampleRate = audioBuffer.sampleRate;
  const numFrames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataByteLength = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  const ch0 = audioBuffer.getChannelData(0);
  const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const s0 = Math.max(-1, Math.min(1, ch0[i]));
    view.setInt16(offset, s0 < 0 ? s0 * 0x8000 : s0 * 0x7fff, true);
    offset += 2;
    if (numChannels > 1) {
      const s1 = Math.max(-1, Math.min(1, ch1[i]));
      view.setInt16(offset, s1 < 0 ? s1 * 0x8000 : s1 * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

export async function extractBrowserAudioTrack(params: {
  sourceUri: string;
  sourceFilename?: string | null;
}): Promise<{ audioUrl: string; downloadUrl: string; filename: string }> {
  const blob = await getMediaBlob(params.sourceUri);
  if (!blob) {
    throw new Error('Source video not found in browser storage.');
  }
  if (blob.size > AUDIO_EXTRACT_RAM_LIMIT_BYTES) {
    throw new Error(
      `Browser WAV extraction is capped at ${Math.round(
        AUDIO_EXTRACT_RAM_LIMIT_BYTES / (1024 * 1024)
      )} MB to avoid exceeding browser memory limits. Your file plays natively via streaming.`
    );
  }

  const Ctor = getAudioContextCtor();
  if (!Ctor) {
    throw new Error('Web Audio API (AudioContext) is not supported in this browser.');
  }

  const ctx = new Ctor();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const wavBlob = encodeAudioBufferToWavBlob(audioBuffer);
    const baseName = (params.sourceFilename || 'audio_track').replace(/\.[^.]+$/, '');
    const outName = `${baseName}_extracted.wav`;

    const saved = await saveMediaBlob({
      bucket: 'audio',
      filename: outName,
      blob: wavBlob,
      mimeType: 'audio/wav',
    });

    return {
      audioUrl: saved.uri,
      downloadUrl: saved.uri,
      filename: saved.filename,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header?.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const binary = atob(base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
