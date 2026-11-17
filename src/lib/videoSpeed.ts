/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DurationMismatchMode, VideoSpeedConfig, VideoSpeedSection } from '../types/studio';

export const VIDEO_SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

export function clampVideoSpeed(val: number): number {
  return Number(Math.max(0.25, Math.min(4.0, val)).toFixed(2));
}

export function getSpeedAtTime(config: VideoSpeedConfig, timelineTime: number): number {
  const global = clampVideoSpeed(config.globalSpeed ?? 1.0);
  const sections = config.sections || [];
  if (sections.length === 0) return global;

  const matched = sections.find(
    (sec) => timelineTime >= sec.startTime && timelineTime <= sec.endTime
  );
  if (!matched) return global;
  return clampVideoSpeed(matched.speed);
}

// Map timeline elapsed time to source video time via cumulative piecewise integration of speed
export function mapTimelineToSourceVideoTime(
  config: VideoSpeedConfig,
  timelineTime: number,
  sourceDuration: number
): { sourceTime: number; isFrozen: boolean; isLooped: boolean } {
  const mode: DurationMismatchMode = config.mismatchMode || 'keep-audio-freeze-last';
  const global = clampVideoSpeed(config.globalSpeed ?? 1.0);
  const sections = [...(config.sections || [])].sort((a, b) => a.startTime - b.startTime);

  if (sections.length === 0) {
    const rawSrcTime = timelineTime * global;
    if (rawSrcTime <= sourceDuration) {
      return { sourceTime: rawSrcTime, isFrozen: false, isLooped: false };
    }
    if (mode === 'loop-visual') {
      const looped = sourceDuration > 0 ? rawSrcTime % sourceDuration : 0;
      return { sourceTime: looped, isFrozen: false, isLooped: true };
    }
    if (mode === 'trim-video-to-audio') {
      return { sourceTime: Math.min(sourceDuration, rawSrcTime), isFrozen: false, isLooped: false };
    }
    // Default keep-audio-freeze-last
    return { sourceTime: sourceDuration, isFrozen: true, isLooped: false };
  }

  // Piecewise integration across sections
  let curT = 0;
  let curSrc = 0;
  let lastSpeed = global;

  for (const sec of sections) {
    const segStart = Math.max(0, sec.startTime);
    const segEnd = Math.max(segStart, sec.endTime);
    const secSpeed = clampVideoSpeed(sec.speed);

    if (timelineTime <= segStart) {
      break;
    }

    const span = Math.min(timelineTime, segEnd) - curT;
    if (span > 0) {
      curSrc += span * lastSpeed;
      curT = Math.min(timelineTime, segEnd);
    }
    lastSpeed = secSpeed;
    if (timelineTime <= segEnd) break;
  }

  if (timelineTime > curT) {
    curSrc += (timelineTime - curT) * lastSpeed;
  }

  if (curSrc <= sourceDuration) {
    return { sourceTime: curSrc, isFrozen: false, isLooped: false };
  }

  if (mode === 'loop-visual') {
    return { sourceTime: sourceDuration > 0 ? curSrc % sourceDuration : 0, isFrozen: false, isLooped: true };
  }
  if (mode === 'trim-video-to-audio') {
    return { sourceTime: Math.min(sourceDuration, curSrc), isFrozen: false, isLooped: false };
  }
  return { sourceTime: sourceDuration, isFrozen: true, isLooped: false };
}

export function computeEffectiveVisualDuration(config: VideoSpeedConfig, sourceDuration: number): number {
  if (sourceDuration <= 0) return 0;
  const global = clampVideoSpeed(config.globalSpeed ?? 1.0);
  const sections = [...(config.sections || [])].sort((a, b) => a.startTime - b.startTime);

  if (sections.length === 0) {
    return Number((sourceDuration / global).toFixed(3));
  }

  let timelineAccum = 0;
  let remainingSrc = sourceDuration;
  let lastT = 0;
  let lastSpeed = global;

  for (const sec of sections) {
    const segStart = Math.max(lastT, sec.startTime);
    const segEnd = Math.max(segStart, sec.endTime);
    const secSpeed = clampVideoSpeed(sec.speed);

    const gap = segStart - lastT;
    if (gap > 0) {
      const neededTimeline = gap / lastSpeed;
      timelineAccum += neededTimeline;
      remainingSrc -= gap;
    }

    if (remainingSrc <= 0) break;

    const segSpanSrc = segEnd - segStart;
    const consumedSrc = Math.min(remainingSrc, segSpanSrc);
    if (consumedSrc > 0) {
      timelineAccum += consumedSrc / secSpeed;
      remainingSrc -= consumedSrc;
    }

    lastT = segEnd;
    lastSpeed = secSpeed;
  }

  if (remainingSrc > 0) {
    timelineAccum += remainingSrc / lastSpeed;
  }

  return Number(timelineAccum.toFixed(3));
}
