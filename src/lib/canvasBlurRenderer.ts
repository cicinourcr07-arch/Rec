/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BlurEffect, TrackingKeyframe } from '../types/studio';

export function interpolateBlurStateAtTime(blur: BlurEffect, time: number): BlurEffect {
  const kfs = blur.keyframes;
  if (!kfs || kfs.length === 0) return blur;

  const sorted = [...kfs].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) {
    return { ...blur, x: sorted[0].x, y: sorted[0].y, width: sorted[0].width, height: sorted[0].height };
  }
  if (time >= sorted[sorted.length - 1].time) {
    const last = sorted[sorted.length - 1];
    return { ...blur, x: last.x, y: last.y, width: last.width, height: last.height };
  }

  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const ratio = (time - a.time) / Math.max(0.001, b.time - a.time);
      return {
        ...blur,
        x: a.x + (b.x - a.x) * ratio,
        y: a.y + (b.y - a.y) * ratio,
        width: a.width + (b.width - a.width) * ratio,
        height: a.height + (b.height - a.height) * ratio,
        rotation: (blur.rotation || 0),
        opacity: blur.opacity ?? 1,
        intensity: blur.intensity,
      };
    }
  }
  return blur;
}

export function renderBlurLayerOnCanvas(params: {
  ctx: CanvasRenderingContext2D;
  sourceCanvasOrVideo: HTMLCanvasElement | HTMLVideoElement;
  blur: BlurEffect;
  currentTime: number;
  canvasWidth: number;
  canvasHeight: number;
}) {
  const { ctx, sourceCanvasOrVideo, blur, currentTime, canvasWidth, canvasHeight } = params;
  if (!blur.enabled || currentTime < blur.startTime || (blur.endTime > 0 && currentTime > blur.endTime)) {
    return;
  }

  const state = interpolateBlurStateAtTime(blur, currentTime);
  const bx = state.x * canvasWidth;
  const by = state.y * canvasHeight;
  const bw = Math.max(16, state.width * canvasWidth);
  const bh = Math.max(16, state.height * canvasHeight);

  ctx.save();
  ctx.globalAlpha = state.opacity ?? 1;

  // Build mask path according to shape
  ctx.beginPath();
  const shape = state.shape || 'rect';
  const expandPx = state.expandPx || 0;
  const exX = bx - expandPx;
  const exY = by - expandPx;
  const exW = bw + expandPx * 2;
  const exH = bh + expandPx * 2;

  if (shape === 'circle' || shape === 'ellipse') {
    const rx = exW / 2;
    const ry = exH / 2;
    ctx.ellipse(exX + rx, exY + ry, Math.max(8, rx), Math.max(8, ry), (blur.rotation || 0) * (Math.PI / 180), 0, Math.PI * 2);
  } else if (shape === 'polygon' && state.points && state.points.length >= 3) {
    const pts = state.points;
    ctx.moveTo(pts[0].x * canvasWidth, pts[0].y * canvasHeight);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x * canvasWidth, pts[i].y * canvasHeight);
    }
    ctx.closePath();
  } else {
    // Default rect with rounded corners if radius
    ctx.rect(exX, exY, exW, exH);
  }

  if (state.invertMask) {
    // Invert clip: clip outside region
    ctx.rect(0, 0, canvasWidth, canvasHeight);
    ctx.clip('evenodd');
  } else {
    ctx.clip();
  }

  // Apply specific blur type rendering
  const radius = Math.max(2, state.radius || state.intensity || 16);
  if (blur.type === 'pixelate') {
    // Mosaic pixelation effect
    const blockSize = Math.max(4, Math.round(radius * 0.75));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sourceCanvasOrVideo, exX, exY, exW, exH, exX, exY, Math.max(4, exW / blockSize), Math.max(4, exH / blockSize));
    ctx.drawImage(sourceCanvasOrVideo, exX, exY, Math.max(4, exW / blockSize), Math.max(4, exH / blockSize), exX, exY, exW, exH);
    ctx.imageSmoothingEnabled = true;
  } else if (blur.type === 'motion' || blur.type === 'directional') {
    const angle = (blur.directionAngle || 0) * (Math.PI / 180);
    const steps = Math.min(12, Math.max(3, Math.round(radius * 0.4)));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ctx.globalAlpha = (state.opacity ?? 1) / steps;
    for (let s = 0; s < steps; s++) {
      const dist = (s - steps / 2) * (radius / steps);
      ctx.drawImage(sourceCanvasOrVideo, exX + cos * dist, exY + sin * dist, exW, exH);
    }
  } else {
    // Gaussian / Standard Blur
    ctx.filter = `blur(${Math.max(2, radius * 0.65)}px)`;
    ctx.drawImage(sourceCanvasOrVideo, 0, 0, canvasWidth, canvasHeight);
    ctx.filter = 'none';
  }

  ctx.restore();
}
