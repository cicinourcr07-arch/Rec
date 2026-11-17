/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import {
  CaptionSegment,
  GeneratedVoiceClip,
  Project,
  TimelineSyncPlan,
  VoiceConfig,
} from '../types/studio';
import { getMediaBlob, isLocalMediaUri, saveMediaBlob } from './browserMediaStore';
import {
  applySyncPlanToClips,
  buildTimelineSyncPlan,
  clampContinuousPauseMs,
  normalizeSyncMode,
} from '../../server/services/timeline_sync_service';
import { getPersonalFishApiKey } from './fishKeyStore';

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

function getOfflineAudioContextCtor(): typeof OfflineAudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.OfflineAudioContext ||
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext ||
    null
  );
}

function encodeAudioBufferToWavBlob(audioBuffer: AudioBuffer): Blob {
  const numChannels = Math.min(2, audioBuffer.numberOfChannels || 1);
  const sampleRate = audioBuffer.sampleRate || 44100;
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
  view.setUint16(20, 1, true);
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

async function analyzeClipAudioBlob(blob: Blob): Promise<{
  audioBuffer: AudioBuffer;
  duration: number;
  speechDuration: number;
  leadingSilence: number;
  trailingSilence: number;
}> {
  const Ctor = getAudioContextCtor();
  if (!Ctor) {
    throw new Error('Web Audio API is required to process synthesized Fish Audio clips.');
  }
  const ctx = new Ctor();
  try {
    const ab = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(ab);
    const ch0 = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate || 44100;
    const dur = Math.max(0.1, audioBuffer.duration);

    const threshold = 0.015;
    let firstNonSilent = 0;
    let lastNonSilent = ch0.length - 1;
    while (firstNonSilent < ch0.length && Math.abs(ch0[firstNonSilent]) < threshold) {
      firstNonSilent++;
    }
    while (lastNonSilent > firstNonSilent && Math.abs(ch0[lastNonSilent]) < threshold) {
      lastNonSilent--;
    }

    const leadingSilence = Math.round((firstNonSilent / sr) * 100) / 100;
    const trailingSilence = Math.round(((ch0.length - 1 - lastNonSilent) / sr) * 100) / 100;
    const speechDuration = Math.max(
      0.05,
      Math.round(((lastNonSilent - firstNonSilent) / sr) * 100) / 100
    );

    return {
      audioBuffer,
      duration: Math.round(dur * 100) / 100,
      speechDuration,
      leadingSilence,
      trailingSilence,
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function fetchFishAudioFromEndpoint(params: {
  endpointUrl: string;
  text: string;
  referenceId?: string;
  format?: 'mp3' | 'wav' | 'pcm' | 'opus';
  model?: string;
  speakingSpeed?: number;
  latency?: 'normal' | 'balanced';
  normalize?: boolean;
  apiKey?: string | null;
}): Promise<Blob> {
  const payload: Record<string, unknown> = {
    text: params.text,
    format: params.format || 'mp3',
  };
  if (params.referenceId?.trim()) {
    payload.referenceId = params.referenceId.trim();
    payload.reference_id = params.referenceId.trim();
  }
  if (params.model?.trim()) {
    payload.model = params.model.trim();
  }
  if (params.speakingSpeed !== undefined) {
    payload.speakingSpeed = params.speakingSpeed;
  }
  if (params.latency) {
    payload.latency = params.latency;
  }
  if (params.normalize !== undefined) {
    payload.normalize = params.normalize;
  }

  const resolvedKey =
    (params.apiKey !== undefined ? params.apiKey : await getPersonalFishApiKey())?.trim() || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (resolvedKey) {
    headers.Authorization = `Bearer ${resolvedKey}`;
  }

  const res = await fetch(params.endpointUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let msg = `Fish Audio request failed (${res.status})`;
    const textBody = await res.text().catch(() => '');
    try {
      const parsed = JSON.parse(textBody) as { error?: string };
      if (parsed?.error) msg = parsed.error;
    } catch {
      if (textBody.trim()) msg = textBody.trim();
    }
    if (resolvedKey && resolvedKey.length >= 4) {
      msg = msg.split(resolvedKey).join('[redacted]');
    }
    throw new Error(msg);
  }

  const blob = await res.blob();
  if (blob.size < 128) {
    throw new Error('Fish Audio endpoint returned an empty audio stream.');
  }
  return blob;
}

export async function renderMergedDubWavFromClips(params: {
  projectId: string;
  clipEntries: Array<{ audioUri: string; startSec: number }>;
  totalDuration: number;
}): Promise<{ fullDubUrl: string }> {
  const OfflineCtor = getOfflineAudioContextCtor();
  const AudioCtor = getAudioContextCtor();
  if (!OfflineCtor || !AudioCtor) {
    throw new Error('Web Audio OfflineAudioContext is unavailable in this browser.');
  }

  const sampleRate = 44100;
  const totalSec = Math.max(0.5, params.totalDuration);
  const offline = new OfflineCtor(2, Math.ceil(totalSec * sampleRate), sampleRate);
  const decodeCtx = new AudioCtor();

  try {
    for (const entry of params.clipEntries) {
      const blob = isLocalMediaUri(entry.audioUri) ? await getMediaBlob(entry.audioUri) : null;
      if (!blob) continue;
      const ab = await blob.arrayBuffer();
      const decoded = await decodeCtx.decodeAudioData(ab);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start(Math.max(0, entry.startSec));
    }
  } finally {
    await decodeCtx.close().catch(() => {});
  }

  const renderedBuffer = await offline.startRendering();
  const wavBlob = encodeAudioBufferToWavBlob(renderedBuffer);
  const saved = await saveMediaBlob({
    bucket: 'audio',
    filename: `fish_full_dub_${params.projectId.slice(0, 8)}_${Date.now()}.wav`,
    blob: wavBlob,
    mimeType: 'audio/wav',
  });

  return { fullDubUrl: saved.uri };
}

export async function generateEdgeFishDubbing(params: {
  project: Project;
  captions: CaptionSegment[];
  voiceConfig: VoiceConfig;
  useTranslated: boolean;
  fishEndpointUrl: string;
  apiKey?: string | null;
  targetSegmentIds?: Set<string>;
  onProgress?: (progress: number, stage: string, etaSeconds: number | null) => void;
}): Promise<{
  clips: GeneratedVoiceClip[];
  fullDubUrl: string;
  syncPlan: TimelineSyncPlan;
  regeneratedIds: string[];
}> {
  const {
    project,
    captions,
    voiceConfig,
    useTranslated,
    fishEndpointUrl,
    apiKey,
    targetSegmentIds,
    onProgress,
  } = params;

  const resolvedKey =
    (apiKey !== undefined ? apiKey : await getPersonalFishApiKey())?.trim() || '';

  const existingClipsById = new Map(
    (voiceConfig.generatedClips || []).map((c) => [c.segmentId, c])
  );
  const lockedRef = voiceConfig.fishReferenceId?.trim() || undefined;
  const workItems = captions
    .map((seg, index) => {
      const spokenText = (
        useTranslated && seg.translatedText ? seg.translatedText : seg.text
      ).trim();
      return { seg, index, spokenText };
    })
    .filter((item) => item.spokenText.length > 0 && /[\p{L}\p{N}]/u.test(item.spokenText));

  if (workItems.length === 0) {
    throw new Error('No speakable transcript or translation segments found.');
  }

  const startedAt = Date.now();
  const rawClips: GeneratedVoiceClip[] = [];
  const regeneratedIds: string[] = [];

  for (let i = 0; i < workItems.length; i++) {
    const { seg, index, spokenText } = workItems[i];
    const existing = existingClipsById.get(seg.id);
    const shouldGenerate =
      !targetSegmentIds || targetSegmentIds.has(seg.id) || !existing || !isLocalMediaUri(existing.audioUrl);

    if (!shouldGenerate && existing && (await getMediaBlob(existing.audioUrl))) {
      const slotDur = Math.max(0.2, seg.end - seg.start);
      const overflowSec =
        existing.duration > slotDur + 0.15
          ? Math.round((existing.duration - slotDur) * 100) / 100
          : 0;
      rawClips.push({
        ...existing,
        start: seg.start,
        end: seg.end,
        slotDuration: Math.round(slotDur * 100) / 100,
        overflowSeconds: overflowSec,
        text: spokenText,
        speaker: seg.speaker,
      });
      continue;
    }

    const ratio = i / workItems.length;
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const eta = i >= 2 && ratio > 0 ? Math.max(1, Math.round((elapsedSec / ratio) * (1 - ratio) + 2)) : null;
    onProgress?.(
      Math.min(86, Math.round(6 + ratio * 80)),
      `Synthesizing segment ${i + 1}/${workItems.length} via /api/fish-audio...`,
      eta
    );

    const mp3Blob = await fetchFishAudioFromEndpoint({
      endpointUrl: fishEndpointUrl,
      text: spokenText,
      referenceId: lockedRef,
      format: 'mp3',
      apiKey: resolvedKey,
    });

    const analyzed = await analyzeClipAudioBlob(mp3Blob);
    const clipName = `fish_dub_seg_${project.id.slice(0, 8)}_${index}_${uuidv4().slice(0, 6)}.mp3`;
    const savedClip = await saveMediaBlob({
      bucket: 'audio',
      filename: clipName,
      blob: mp3Blob,
      mimeType: 'audio/mpeg',
    });

    const slotDur = Math.max(0.2, seg.end - seg.start);
    const overflowSec =
      analyzed.duration > slotDur + 0.15
        ? Math.round((analyzed.duration - slotDur) * 100) / 100
        : 0;

    rawClips.push({
      segmentId: seg.id,
      audioUrl: savedClip.uri,
      start: seg.start,
      end: seg.end,
      duration: analyzed.duration,
      speechDuration: analyzed.speechDuration,
      leadingSilence: analyzed.leadingSilence,
      trailingSilence: analyzed.trailingSilence,
      speechStartOffset: analyzed.leadingSilence,
      speechEndOffset: Math.max(0.05, analyzed.duration - analyzed.trailingSilence),
      slotDuration: Math.round(slotDur * 100) / 100,
      overflowSeconds: overflowSec,
      text: spokenText,
      speaker: seg.speaker,
    });

    if (targetSegmentIds?.has(seg.id)) {
      regeneratedIds.push(seg.id);
    }
  }

  onProgress?.(90, 'Synchronizing narration clips & mixing audio track...', 2);
  const maxSegEnd = captions.reduce((m, s) => Math.max(m, s.end || 0), 10);
  const originalVideoDuration = Math.max(1, project.metadata?.duration || maxSegEnd);
  const syncMode = normalizeSyncMode(voiceConfig.syncMode);
  const continuousPauseMs = clampContinuousPauseMs(voiceConfig.continuousPauseMs);

  const syncPlan = buildTimelineSyncPlan({
    captions,
    measuredClips: rawClips.map((c) => ({
      segmentId: c.segmentId,
      start: c.start,
      end: c.end,
      duration: c.duration,
      speechDuration: c.speechDuration,
      leadingSilence: c.leadingSilence,
      trailingSilence: c.trailingSilence,
    })),
    originalVideoDuration,
    syncMode,
    continuousPauseMs,
  });

  const clips = applySyncPlanToClips(rawClips, syncPlan);
  const merged = await renderMergedDubWavFromClips({
    projectId: project.id,
    clipEntries: clips.map((c) => ({ audioUri: c.audioUrl, startSec: c.start })),
    totalDuration: syncPlan.estimatedFinalDuration,
  });

  onProgress?.(100, `Generated all ${clips.length} synchronized segments`, 0);

  return {
    clips,
    fullDubUrl: merged.fullDubUrl,
    syncPlan,
    regeneratedIds,
  };
}
