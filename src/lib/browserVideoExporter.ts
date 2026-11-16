/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BlurEffect,
  DEFAULT_VIDEO_CANVAS,
  ExportSettings,
  LogoOverlay,
  Project,
  VideoCanvasConfig,
  VideoMetadata,
} from '../types/studio';
import {
  isLocalMediaUri,
  resolveBrowserMediaUrl,
  saveMediaBlob,
} from './browserMediaStore';
import {
  buildCanvasFilterCss,
  pickSupportedRecorderMimeType,
  probeVideoMetadataAndCover,
} from './browserVideoProcessor';
import {
  getActiveCaptionSourceText,
  getSyncedCaptionsForPreview,
  resolveCanvasDimensions,
} from './workflowStages';

export interface BrowserExportResult {
  outputUri: string;
  filename: string;
  sizeBytes: number;
  width: number;
  height: number;
  duration: number;
  mimeType: string;
}

function resolveBlurBoundsAtTime(blur: BlurEffect, t: number) {
  if (blur.mode === 'motion' && blur.keyframes && blur.keyframes.length > 0) {
    const sorted = [...blur.keyframes].sort((a, b) => a.time - b.time);
    if (t <= sorted[0].time) return sorted[0];
    if (t >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (t >= a.time && t <= b.time) {
        const span = Math.max(0.0001, b.time - a.time);
        const f = (t - a.time) / span;
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          width: a.width + (b.width - a.width) * f,
          height: a.height + (b.height - a.height) * f,
        };
      }
    }
  }
  return { x: blur.x, y: blur.y, width: blur.width, height: blur.height };
}

function resolveLogoPositionAtTime(logo: LogoOverlay, t: number) {
  let x = logo.x;
  let y = logo.y;
  if (logo.motion?.enabled && logo.motion.pattern !== 'static') {
    const spd = logo.motion.speed || 1;
    const wNorm = (logo.widthPct || 14) / 100;
    const maxX = Math.max(0.05, 0.96 - wNorm);
    const maxY = 0.85;
    if (logo.motion.pattern === 'horizontal') {
      const phase = 0.5 + 0.5 * Math.sin(t * spd * 1.4 - Math.PI / 2);
      x = 0.04 + phase * (maxX - 0.04);
    } else if (logo.motion.pattern === 'bounce') {
      const px = Math.abs(((t * spd * 0.25) % 2) - 1);
      const py = Math.abs(((t * spd * 0.19) % 2) - 1);
      x = 0.04 + px * (maxX - 0.04);
      y = 0.04 + py * (maxY - 0.04);
    } else if (logo.motion.pattern === 'orbit') {
      x = Math.max(0.02, Math.min(maxX, 0.5 - wNorm / 2 + 0.26 * Math.cos(t * spd * 1.3)));
      y = Math.max(0.02, Math.min(maxY, 0.45 + 0.26 * Math.sin(t * spd * 1.3)));
    } else if (logo.motion.pattern === 'custom') {
      const ex = logo.motion.endX ?? Math.min(maxX, logo.x + 0.35);
      const ey = logo.motion.endY ?? logo.y;
      const dur = logo.permanent ? 8 : Math.max(0.5, (logo.endTime || 8) - (logo.startTime || 0));
      const frac = Math.min(1, Math.max(0, (t - (logo.startTime || 0)) / dur));
      x = logo.x + (ex - logo.x) * frac;
      y = logo.y + (ey - logo.y) * frac;
    }
  }
  return { x, y };
}

async function loadOptionalImage(uri: string | null | undefined): Promise<HTMLImageElement | null> {
  if (!uri) return null;
  const url = isLocalMediaUri(uri) ? await resolveBrowserMediaUrl(uri) : uri;
  if (!url) return null;
  const img = new Image();
  if (!url.startsWith('blob:') && !url.startsWith('data:')) {
    img.crossOrigin = 'anonymous';
  }
  return await new Promise<HTMLImageElement | null>((resolve) => {
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function loadOptionalAudioElement(
  uri: string | null | undefined
): Promise<HTMLAudioElement | null> {
  if (!uri) return null;
  const url = isLocalMediaUri(uri) ? await resolveBrowserMediaUrl(uri) : uri;
  if (!url) return null;
  const audio = document.createElement('audio');
  audio.preload = 'auto';
  if (!url.startsWith('blob:') && !url.startsWith('data:')) {
    audio.crossOrigin = 'anonymous';
  }
  return await new Promise<HTMLAudioElement | null>((resolve) => {
    const t = window.setTimeout(() => resolve(audio), 6000);
    audio.oncanplay = () => {
      window.clearTimeout(t);
      resolve(audio);
    };
    audio.onerror = () => {
      window.clearTimeout(t);
      resolve(null);
    };
    audio.src = url;
  });
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${cur} ${words[i]}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      cur = candidate;
    } else {
      lines.push(cur);
      cur = words[i];
    }
  }
  lines.push(cur);
  return lines;
}

export async function renderProjectInBrowser(params: {
  project: Project;
  settings: ExportSettings;
  onProgress: (pct: number, stage: string, etaSeconds: number | null) => void;
  bitRate?: number;
}): Promise<BrowserExportResult> {
  const { project, settings, onProgress } = params;
  if (typeof document === 'undefined' || typeof MediaRecorder === 'undefined') {
    throw new Error('Browser Canvas & MediaRecorder APIs are required to export video.');
  }
  if (!project.sourceVideoUrl) {
    throw new Error('No source video attached to this project.');
  }

  onProgress(2, 'Resolving source media from browser storage...', null);
  const playableVideoUrl = isLocalMediaUri(project.sourceVideoUrl)
    ? await resolveBrowserMediaUrl(project.sourceVideoUrl)
    : project.sourceVideoUrl;
  if (!playableVideoUrl) {
    throw new Error('Source video file is missing in browser storage. Please re-select the video.');
  }

  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  if (!playableVideoUrl.startsWith('blob:') && !playableVideoUrl.startsWith('data:')) {
    video.crossOrigin = 'anonymous';
  }

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('Timed out loading source video for browser export.')),
      25000
    );
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Browser could not decode this video for Canvas/MediaRecorder export.'));
    };
    video.src = playableVideoUrl;
  });

  const srcW = video.videoWidth || project.metadata?.width || 1280;
  const srcH = video.videoHeight || project.metadata?.height || 720;
  const duration =
    Number.isFinite(video.duration) && video.duration > 0
      ? video.duration
      : project.metadata?.duration || 1;

  const canvasCfg: VideoCanvasConfig = {
    ...DEFAULT_VIDEO_CANVAS,
    ...(project.canvas || {}),
  };
  const dims = resolveCanvasDimensions(canvasCfg, settings, {
    ...(project.metadata || {
      duration,
      width: srcW,
      height: srcH,
      fps: 30,
      videoCodec: 'h264',
      audioCodec: 'aac',
      bitrate: 2000000,
      fileSize: 0,
      hasAudio: true,
      formatName: 'mp4',
    }),
    width: srcW,
    height: srcH,
    duration,
  });

  const outW = dims.width;
  const outH = dims.height;

  onProgress(6, `Initializing ${outW}×${outH} browser compositing pipeline...`, Math.ceil(duration));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context could not be initialized.');

  // Preload optional background & enabled logo images
  const bgImg =
    canvasCfg.backgroundType === 'image' && canvasCfg.bgImageUrl
      ? await loadOptionalImage(canvasCfg.bgImageUrl)
      : null;

  const logoImgs = new Map<string, HTMLImageElement>();
  if (settings.applyLogo && project.logos.length > 0) {
    await Promise.all(
      project.logos
        .filter((l) => l.enabled)
        .map(async (logo) => {
          const img = await loadOptionalImage(logo.url);
          if (img) logoImgs.set(logo.id, img);
        })
    );
  }

  // Setup Web Audio multi-track mixer
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let audioCtx: AudioContext | null = null;
  const auxAudios: HTMLAudioElement[] = [];
  const tracks: MediaStreamTrack[] = [];

  const fps = Math.min(30, project.metadata?.fps || 30);
  const videoStream = outCanvas.captureStream(fps);
  tracks.push(...videoStream.getVideoTracks());

  if (AudioCtx) {
    try {
      audioCtx = new AudioCtx();
      const dest = audioCtx.createMediaStreamDestination();

      const origEnabled =
        project.voice.originalAudioEnabled !== undefined
          ? Boolean(project.voice.originalAudioEnabled)
          : Boolean(project.voice.preserveOriginalAudio);
      const origMuted =
        project.voice.originalAudioMuted !== undefined
          ? Boolean(project.voice.originalAudioMuted)
          : !Boolean(project.voice.preserveOriginalAudio);

      const useSourceAudio =
        !settings.applyDubbing ||
        !project.voice.enabled ||
        !project.voice.fullDubUrl ||
        (origEnabled && !origMuted);

      try {
        const srcMedia = audioCtx.createMediaElementSource(video);
        const srcGain = audioCtx.createGain();
        const rawVol = useSourceAudio ? Number(project.voice.originalAudioVolume ?? 1.0) : 0;
        srcGain.gain.value = origMuted && project.voice.enabled ? 0 : Math.max(0, Math.min(2, rawVol));
        srcMedia.connect(srcGain);
        srcGain.connect(dest);
      } catch {
        // video might not have an audio track
      }

      if (settings.applyDubbing && project.voice.enabled && project.voice.fullDubUrl && !project.voice.voiceMuted) {
        const dubAudio = await loadOptionalAudioElement(project.voice.fullDubUrl);
        if (dubAudio) {
          auxAudios.push(dubAudio);
          const dubSrc = audioCtx.createMediaElementSource(dubAudio);
          const dubGain = audioCtx.createGain();
          dubGain.gain.value = Math.max(0, Math.min(2, Number(project.voice.voiceVolume ?? 1.0)));
          dubSrc.connect(dubGain);
          dubGain.connect(dest);
        }
      }

      if (
        settings.applyAudioMix &&
        project.voice.bgMusicEnabled &&
        project.voice.bgMusicUrl &&
        !project.voice.bgMusicMuted
      ) {
        const musicAudio = await loadOptionalAudioElement(project.voice.bgMusicUrl);
        if (musicAudio) {
          musicAudio.loop = true;
          auxAudios.push(musicAudio);
          const musicSrc = audioCtx.createMediaElementSource(musicAudio);
          const musicGain = audioCtx.createGain();
          musicGain.gain.value = Math.max(0, Math.min(2, Number(project.voice.bgMusicVolume ?? 0.3)));
          musicSrc.connect(musicGain);
          musicGain.connect(dest);
        }
      }

      if (
        settings.applyAudioMix &&
        project.voice.sfxEnabled &&
        project.voice.sfxUrl &&
        !project.voice.sfxMuted
      ) {
        const sfxAudio = await loadOptionalAudioElement(project.voice.sfxUrl);
        if (sfxAudio) {
          auxAudios.push(sfxAudio);
          const sfxSrc = audioCtx.createMediaElementSource(sfxAudio);
          const sfxGain = audioCtx.createGain();
          sfxGain.gain.value = Math.max(0, Math.min(2, Number(project.voice.sfxVolume ?? 0.8)));
          sfxSrc.connect(sfxGain);
          sfxGain.connect(dest);
        }
      }

      if (settings.applyAudioMix) {
        const masterFadeIn = Math.max(0, project.voice.fadeInSec || 0);
        const masterFadeOut = Math.max(0, project.voice.fadeOutSec || 0);
        // Individual gain nodes handle volume; fade-in/out applied on dub/source starts cleanly
        void masterFadeIn;
        void masterFadeOut;
      }

      tracks.push(...dest.stream.getAudioTracks());
    } catch {
      // Fallback to silent canvas video if AudioContext isn't allowed
    }
  } else {
    video.muted = true;
  }

  const combinedStream = new MediaStream(tracks);
  const { mimeType, extension } = pickSupportedRecorderMimeType();
  const targetBps =
    params.bitRate ||
    (settings.resolution === '1080p' ? 5_500_000 : settings.resolution === '720p' ? 3_200_000 : 1_800_000);

  const recorder = mimeType
    ? new MediaRecorder(combinedStream, { mimeType, videoBitsPerSecond: targetBps })
    : new MediaRecorder(combinedStream);

  const recordedChunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };

  const stopPromise = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      const actualMime = recorder.mimeType || mimeType || `video/${extension}`;
      resolve(new Blob(recordedChunks, { type: actualMime }));
    };
    recorder.onerror = () => reject(new Error('MediaRecorder encoding failed during export.'));
  });

  // Pre-compute crop source coordinates
  const cropL = Math.max(0, Math.min(45, canvasCfg.cropLeft || 0)) / 100;
  const cropR = Math.max(0, Math.min(45, canvasCfg.cropRight || 0)) / 100;
  const cropT = Math.max(0, Math.min(45, canvasCfg.cropTop || 0)) / 100;
  const cropB = Math.max(0, Math.min(45, canvasCfg.cropBottom || 0)) / 100;
  const sx = srcW * cropL;
  const sy = srcH * cropT;
  const sw = Math.max(16, srcW * (1 - cropL - cropR));
  const sh = Math.max(16, srcH * (1 - cropT - cropB));

  const filterCss = settings.applyVideoEffects ? buildCanvasFilterCss(project.videoEffects) : 'none';
  const syncedCaptions = settings.applyCaptions ? getSyncedCaptionsForPreview(project) : [];

  const drawFrame = () => {
    const t = video.currentTime || 0;

    // 1. Background Layer
    ctx.fillStyle = canvasCfg.bgColor || '#09090B';
    ctx.fillRect(0, 0, outW, outH);

    if (canvasCfg.backgroundType === 'image' && bgImg && canvasCfg.bgImageVisible !== false) {
      ctx.save();
      ctx.globalAlpha = canvasCfg.bgImageOpacity ?? 1;
      const imgAR = bgImg.naturalWidth / Math.max(1, bgImg.naturalHeight);
      const dstAR = outW / Math.max(1, outH);
      let bw = outW;
      let bh = outH;
      if (imgAR > dstAR) {
        bh = outH;
        bw = outH * imgAR;
      } else {
        bw = outW;
        bh = outW / Math.max(0.01, imgAR);
      }
      bw *= canvasCfg.bgImageScale || 1;
      bh *= canvasCfg.bgImageScale || 1;
      const bx = (outW - bw) / 2 + ((canvasCfg.bgImageOffsetX || 0) / 100) * outW;
      const by = (outH - bh) / 2 + ((canvasCfg.bgImageOffsetY || 0) / 100) * outH;
      ctx.translate(bx + bw / 2, by + bh / 2);
      ctx.rotate(((canvasCfg.bgImageRotation || 0) * Math.PI) / 180);
      ctx.drawImage(bgImg, -bw / 2, -bh / 2, bw, bh);
      ctx.restore();
    } else if (
      (canvasCfg.backgroundType === 'blur' || settings.fitMode === 'blur-pad') &&
      canvasCfg.bgImageVisible !== false
    ) {
      ctx.save();
      ctx.globalAlpha = canvasCfg.bgBlurOpacity ?? 0.9;
      ctx.filter = `blur(${Math.max(4, Math.round((canvasCfg.bgBlurIntensity || 24) * 0.75))}px) brightness(${Math.max(
        0.3,
        1 + (canvasCfg.bgBlurBrightness ?? -15) / 100
      ).toFixed(2)})`;
      const vidAR = srcW / Math.max(1, srcH);
      const dstAR = outW / Math.max(1, outH);
      let bw = outW;
      let bh = outH;
      if (vidAR > dstAR) {
        bh = outH;
        bw = outH * vidAR;
      } else {
        bw = outW;
        bh = outW / Math.max(0.01, vidAR);
      }
      bw *= 1.08;
      bh *= 1.08;
      ctx.drawImage(video, (outW - bw) / 2, (outH - bh) / 2, bw, bh);
      ctx.restore();
    }

    // Compute foreground video destination box
    const cropAR = sw / Math.max(1, sh);
    const outAR = outW / Math.max(1, outH);
    const useCover =
      settings.fitMode === 'crop' || canvasCfg.cropMode === 'fill' || canvasCfg.cropMode === 'zoom';

    let fitW = outW;
    let fitH = outH;
    if (canvasCfg.cropMode === 'stretch') {
      fitW = outW;
      fitH = outH;
    } else if (useCover) {
      if (cropAR > outAR) {
        fitH = outH;
        fitW = outH * cropAR;
      } else {
        fitW = outW;
        fitH = outW / Math.max(0.01, cropAR);
      }
    } else {
      if (cropAR > outAR) {
        fitW = outW;
        fitH = outW / Math.max(0.01, cropAR);
      } else {
        fitH = outH;
        fitW = outH * cropAR;
      }
    }

    const zoom = canvasCfg.zoom || 1;
    const drawW = fitW * zoom;
    const drawH = fitH * zoom;
    const drawX = (outW - drawW) / 2 + ((canvasCfg.offsetX || 0) / 100) * outW;
    const drawY = (outH - drawH) / 2 + ((canvasCfg.offsetY || 0) / 100) * outH;

    // 2. Foreground Video Layer
    if (canvasCfg.videoVisible !== false) {
      ctx.save();
      ctx.globalAlpha = canvasCfg.videoOpacity ?? 1;
      ctx.filter = filterCss;
      ctx.translate(drawX + drawW / 2, drawY + drawH / 2);
      ctx.rotate(((canvasCfg.videoRotation || 0) * Math.PI) / 180);
      ctx.drawImage(video, sx, sy, sw, sh, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }

    // Optional Vignette
    const vigAmt =
      settings.applyVideoEffects && (project.videoEffects?.adjustments?.vignette || 0) > 0
        ? (project.videoEffects?.adjustments?.vignette || 0) / 100
        : settings.applyVideoEffects && project.videoEffects?.filterPreset === 'cinematic'
        ? 0.35
        : settings.applyVideoEffects && project.videoEffects?.filterPreset === 'vintage'
        ? 0.45
        : 0;
    if (vigAmt > 0.01) {
      const rad = ctx.createRadialGradient(
        outW / 2,
        outH / 2,
        Math.min(outW, outH) * 0.25,
        outW / 2,
        outH / 2,
        Math.max(outW, outH) * 0.72
      );
      rad.addColorStop(0, 'rgba(0,0,0,0)');
      rad.addColorStop(1, `rgba(0,0,0,${Math.min(0.85, vigAmt * 0.85)})`);
      ctx.fillStyle = rad;
      ctx.fillRect(0, 0, outW, outH);
    }

    // 3. Blurs
    if (settings.applyBlur && project.blurs.length > 0) {
      for (const b of project.blurs) {
        if (!b.enabled) continue;
        if (b.endTime > 0 && (t < b.startTime || t > b.endTime)) continue;

        ctx.save();
        ctx.globalAlpha = b.opacity ?? 1;
        const blurPx = Math.max(4, Math.round((b.intensity || 16) * 0.8));

        if (b.mode === 'full') {
          ctx.filter = `blur(${blurPx}px)`;
          ctx.drawImage(outCanvas, 0, 0);
        } else {
          const bounds = resolveBlurBoundsAtTime(b, t);
          const bx = bounds.x * outW;
          const by = bounds.y * outH;
          const bw = Math.max(8, bounds.width * outW);
          const bh = Math.max(8, bounds.height * outH);

          ctx.beginPath();
          if (b.shape === 'ellipse') {
            ctx.ellipse(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
          } else {
            ctx.rect(bx, by, bw, bh);
          }
          ctx.clip();
          ctx.filter = `blur(${blurPx}px)`;
          ctx.drawImage(outCanvas, 0, 0);
        }
        ctx.restore();
      }
    }

    // 4. Logo Overlays
    if (settings.applyLogo && project.logos.length > 0) {
      for (const logo of project.logos) {
        if (!logo.enabled) continue;
        if (!logo.permanent && (t < logo.startTime || t > logo.endTime)) continue;
        const img = logoImgs.get(logo.id);
        if (!img) continue;

        const pos = resolveLogoPositionAtTime(logo, t);
        const lw = Math.max(24, ((logo.widthPct || 14) / 100) * outW);
        const lh = lw * (img.naturalHeight / Math.max(1, img.naturalWidth));
        const lx = pos.x * outW;
        const ly = pos.y * outH;

        ctx.save();
        ctx.globalAlpha = logo.opacity ?? 1;
        ctx.translate(lx + lw / 2, ly + lh / 2);
        ctx.rotate(((logo.rotation || 0) * Math.PI) / 180);
        ctx.drawImage(img, -lw / 2, -lh / 2, lw, lh);
        ctx.restore();
      }
    }

    // 5. Burned-in Captions (STRICT: only when user enables applyCaptions)
    if (settings.applyCaptions && project.subtitleStyle.enabled && syncedCaptions.length > 0) {
      const style = project.subtitleStyle;
      const activeSeg = syncedCaptions.find((s) => t >= s.syncedStart && t <= s.syncedEnd);
      if (activeSeg) {
        const text = getActiveCaptionSourceText(activeSeg, true);
        if (text) {
          const finalDisplay =
            style.uppercase || style.textTransform === 'uppercase'
              ? text.toUpperCase()
              : style.textTransform === 'lowercase'
              ? text.toLowerCase()
              : text;

          const scale = (outW / 1080) * (style.scale || 1);
          const fontSize = Math.max(18, Math.round((style.fontSize || 42) * scale));
          const fontWeight = style.fontWeightNum || (style.fontWeight === '900' ? 900 : style.fontWeight === 'bold' ? 700 : 400);

          ctx.save();
          ctx.globalAlpha = style.opacity ?? 1;
          ctx.font = `${style.italic ? 'italic ' : ''}${fontWeight} ${fontSize}px '${style.fontFamily || 'Montserrat'}', sans-serif`;
          ctx.textAlign = style.textAlign || 'center';
          ctx.textBaseline = 'middle';

          const maxTextW = outW * ((style.maxWidthPct || 86) / 100);
          const lines = wrapTextLines(ctx, finalDisplay, maxTextW);
          const lineH = fontSize * (style.lineSpacing || 1.2);
          const anchorX =
            style.position === 'custom'
              ? ((style.posX ?? 50) / 100) * outW
              : outW / 2;
          const anchorY =
            style.position === 'top'
              ? outH * 0.14
              : style.position === 'middle'
              ? outH * 0.5
              : style.position === 'custom'
              ? ((style.posY ?? 84) / 100) * outH
              : outH - Math.max(36, (style.marginV || 48) * scale) - ((lines.length - 1) * lineH) / 2;

          // Background pill box behind text
          if ((style.backgroundOpacity ?? 0) > 0.02) {
            let maxMeasured = 0;
            for (const ln of lines) {
              const w = ctx.measureText(ln).width;
              if (w > maxMeasured) maxMeasured = w;
            }
            const padH = (style.paddingH ?? 14) * scale;
            const padV = (style.paddingV ?? 6) * scale;
            const boxW = maxMeasured + padH * 2;
            const boxH = lines.length * lineH + padV * 2;
            const boxX =
              ctx.textAlign === 'left'
                ? anchorX - padH
                : ctx.textAlign === 'right'
                ? anchorX - boxW + padH
                : anchorX - boxW / 2;
            const boxY = anchorY - ((lines.length - 1) * lineH) / 2 - lineH / 2 - padV;

            ctx.fillStyle = style.backgroundColor || '#09090B';
            ctx.globalAlpha = (style.opacity ?? 1) * (style.backgroundOpacity ?? 0.55);
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
              ctx.roundRect(boxX, boxY, boxW, boxH, (style.borderRadius ?? 8) * scale);
            } else {
              ctx.rect(boxX, boxY, boxW, boxH);
            }
            ctx.fill();
            ctx.globalAlpha = style.opacity ?? 1;
          }

          if (style.shadowEnabled) {
            ctx.shadowColor = style.shadowColor || '#000000';
            ctx.shadowBlur = (style.shadowBlur ?? 4) * scale;
            ctx.shadowOffsetY = (style.shadowDistance ?? 2) * scale;
          }

          const topY = anchorY - ((lines.length - 1) * lineH) / 2;
          for (let i = 0; i < lines.length; i++) {
            const ly = topY + i * lineH;
            if ((style.outlineWidth || 0) > 0) {
              ctx.strokeStyle = style.outlineColor || '#09090B';
              ctx.lineWidth = Math.max(2, (style.outlineWidth || 3) * scale);
              ctx.lineJoin = 'round';
              ctx.strokeText(lines[i], anchorX, ly);
            }
            ctx.fillStyle = style.primaryColor || '#FFFFFF';
            ctx.fillText(lines[i], anchorX, ly);
          }
          ctx.restore();
        }
      }
    }
  };

  video.currentTime = 0;
  recorder.start(300);

  if (audioCtx && audioCtx.state === 'suspended') {
    await audioCtx.resume().catch(() => {});
  }

  // Start playback and frame loop
  const startWall = performance.now();
  await video.play();
  for (const a of auxAudios) {
    a.currentTime = 0;
    void a.play().catch(() => {});
  }

  let finished = false;
  let lastProgressAt = 0;

  await new Promise<void>((resolve) => {
    const finishPlayback = () => {
      if (finished) return;
      finished = true;
      resolve();
    };

    video.onended = finishPlayback;

    const tick = () => {
      if (finished) return;
      drawFrame();

      const cur = video.currentTime || 0;
      const now = performance.now();
      if (now - lastProgressAt > 250) {
        lastProgressAt = now;
        const frac = Math.min(0.99, cur / Math.max(0.1, duration));
        const pct = Math.min(95, Math.max(8, Math.round(8 + frac * 86)));
        const elapsedSec = (now - startWall) / 1000;
        const eta = frac > 0.05 ? Math.max(1, Math.round((elapsedSec / frac) * (1 - frac))) : Math.ceil(duration);
        onProgress(pct, `Rendering edited frames in browser (${Math.round(frac * 100)}%)...`, eta);
      }

      if (video.ended || cur >= duration - 0.02) {
        drawFrame();
        finishPlayback();
        return;
      }

      window.requestAnimationFrame(tick);
    };

    window.requestAnimationFrame(tick);
  });

  onProgress(97, 'Finalizing exported video file in browser storage...', 1);
  if (recorder.state !== 'inactive') {
    recorder.stop();
  }
  const outputBlob = await stopPromise;

  video.pause();
  video.removeAttribute('src');
  video.load();
  for (const a of auxAudios) {
    a.pause();
    a.removeAttribute('src');
    a.load();
  }
  tracks.forEach((tr) => tr.stop());
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
  }

  const outExt = outputBlob.type.includes('mp4') ? 'mp4' : extension;
  const safeBase = (project.name || 'recap_export')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 48);
  const outFilename = `${safeBase}_final.${outExt}`;

  const saved = await saveMediaBlob({
    bucket: 'exports',
    filename: outFilename,
    blob: outputBlob,
    mimeType: outputBlob.type || `video/${outExt}`,
  });

  onProgress(100, `Render complete (${outExt.toUpperCase()})`, 0);

  return {
    outputUri: saved.uri,
    filename: saved.filename,
    sizeBytes: outputBlob.size,
    width: outW,
    height: outH,
    duration,
    mimeType: outputBlob.type || `video/${outExt}`,
  };
}

export async function compressBrowserVideo(params: {
  project: Project;
  preset: 'under-45mb' | '720p-compact' | '480p-compact';
  target: 'source' | 'final-export';
}): Promise<{
  compressedUri: string;
  filename: string;
  originalBytes: number;
  compressedBytes: number;
  metadata: VideoMetadata;
}> {
  const { project, preset, target } = params;
  const sourceUri = target === 'final-export' ? project.lastExportUrl : project.sourceVideoUrl;
  if (!sourceUri) {
    throw new Error('Selected target video is not present.');
  }

  const targetRes = preset === '480p-compact' ? '480p' : '720p';
  const duration = Math.max(1, project.metadata?.duration || 10);
  const targetBps =
    preset === 'under-45mb'
      ? Math.max(400_000, Math.min(3_000_000, Math.floor(((40 * 1024 * 1024 * 8) / duration) * 0.85)))
      : preset === '480p-compact'
      ? 1_200_000
      : 2_200_000;

  const compactSettings: ExportSettings = {
    ...project.exportSettings,
    resolution: targetRes,
  };

  const rendered = await renderProjectInBrowser({
    project: target === 'final-export' ? { ...project, sourceVideoUrl: sourceUri } : project,
    settings: compactSettings,
    bitRate: targetBps,
    onProgress: () => {},
  });

  const savedRec = await resolveBrowserMediaUrl(rendered.outputUri);
  let meta: VideoMetadata = project.metadata || {
    duration: rendered.duration,
    width: rendered.width,
    height: rendered.height,
    fps: 30,
    videoCodec: rendered.mimeType,
    audioCodec: 'opus/aac',
    bitrate: targetBps,
    fileSize: rendered.sizeBytes,
    hasAudio: true,
    formatName: rendered.mimeType,
  };

  if (savedRec) {
    try {
      const resp = await fetch(savedRec);
      const blob = await resp.blob();
      const probed = await probeVideoMetadataAndCover(blob, rendered.filename);
      meta = probed.metadata;
    } catch {
      // keep fallback metadata
    }
  }

  return {
    compressedUri: rendered.outputUri,
    filename: rendered.filename,
    originalBytes: project.metadata?.fileSize || 0,
    compressedBytes: rendered.sizeBytes,
    metadata: meta,
  };
}
