/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';
import { CaptionSegment, Project, SpeakerProfile, VoiceConfig } from '../types/studio';

export const SPEAKER_COLOR_PALETTE = [
  '#8B5CF6', // Violet
  '#0EA5E9', // Sky
  '#10B981', // Emerald
  '#F59E0B', // Amber
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#6366F1', // Indigo
];

export function normalizeSpeakerName(raw?: string | null): string {
  return String(raw || '').trim();
}

export function pickSpeakerColor(index: number): string {
  return SPEAKER_COLOR_PALETTE[Math.abs(index) % SPEAKER_COLOR_PALETTE.length];
}

/**
 * Synchronizes project.speakers strictly from speaker labels genuinely present on captions
 * while preserving all existing speaker voice assignments and manually added speakers.
 * Never fabricates speakers if captions have no speaker tags.
 */
export function syncSpeakersFromCaptions(
  existingSpeakers: SpeakerProfile[] | undefined,
  captions: CaptionSegment[]
): SpeakerProfile[] {
  const existing = Array.isArray(existingSpeakers) ? [...existingSpeakers] : [];
  const byNormalizedName = new Map<string, SpeakerProfile>();

  for (const sp of existing) {
    const key = normalizeSpeakerName(sp.name).toLowerCase();
    if (key && !byNormalizedName.has(key)) {
      byNormalizedName.set(key, sp);
    }
  }

  for (const seg of captions) {
    const name = normalizeSpeakerName(seg.speaker);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byNormalizedName.has(key)) {
      const profile: SpeakerProfile = {
        id: uuidv4(),
        name,
        color: pickSpeakerColor(byNormalizedName.size),
      };
      byNormalizedName.set(key, profile);
      existing.push(profile);
    }
  }

  return existing;
}

export function addSpeakerProfile(
  existingSpeakers: SpeakerProfile[] | undefined,
  name: string,
  fishReferenceId?: string,
  fishVoiceTitle?: string
): SpeakerProfile[] {
  const cleanName = normalizeSpeakerName(name);
  if (!cleanName) {
    throw new Error('Speaker name cannot be empty.');
  }
  const existing = Array.isArray(existingSpeakers) ? [...existingSpeakers] : [];
  const dup = existing.find((s) => normalizeSpeakerName(s.name).toLowerCase() === cleanName.toLowerCase());
  if (dup) {
    throw new Error(`Speaker "${dup.name}" already exists.`);
  }
  return [
    ...existing,
    {
      id: uuidv4(),
      name: cleanName,
      fishReferenceId: fishReferenceId?.trim() || undefined,
      fishVoiceTitle: fishVoiceTitle?.trim() || undefined,
      color: pickSpeakerColor(existing.length),
    },
  ];
}

export function renameSpeakerAndSegments(params: {
  speakers: SpeakerProfile[] | undefined;
  captions: CaptionSegment[];
  speakerId: string;
  nextName: string;
}): { speakers: SpeakerProfile[]; captions: CaptionSegment[] } {
  const cleanNext = normalizeSpeakerName(params.nextName);
  if (!cleanNext) {
    throw new Error('Speaker name cannot be empty.');
  }
  const list = Array.isArray(params.speakers) ? params.speakers : [];
  const target = list.find((s) => s.id === params.speakerId);
  if (!target) {
    throw new Error('Speaker not found.');
  }

  const conflict = list.find(
    (s) =>
      s.id !== params.speakerId &&
      normalizeSpeakerName(s.name).toLowerCase() === cleanNext.toLowerCase()
  );
  if (conflict) {
    throw new Error(`Another speaker named "${conflict.name}" already exists.`);
  }

  const prevKey = normalizeSpeakerName(target.name).toLowerCase();
  const nextSpeakers = list.map((s) =>
    s.id === params.speakerId ? { ...s, name: cleanNext } : s
  );
  const nextCaptions = params.captions.map((seg) =>
    normalizeSpeakerName(seg.speaker).toLowerCase() === prevKey
      ? { ...seg, speaker: cleanNext }
      : seg
  );

  return { speakers: nextSpeakers, captions: nextCaptions };
}

export function deleteSpeakerAndClearSegments(params: {
  speakers: SpeakerProfile[] | undefined;
  captions: CaptionSegment[];
  speakerId: string;
}): { speakers: SpeakerProfile[]; captions: CaptionSegment[] } {
  const list = Array.isArray(params.speakers) ? params.speakers : [];
  const target = list.find((s) => s.id === params.speakerId);
  if (!target) {
    return { speakers: list, captions: params.captions };
  }
  const targetKey = normalizeSpeakerName(target.name).toLowerCase();
  const nextSpeakers = list.filter((s) => s.id !== params.speakerId);
  const nextCaptions = params.captions.map((seg) =>
    normalizeSpeakerName(seg.speaker).toLowerCase() === targetKey
      ? { ...seg, speaker: undefined }
      : seg
  );
  return { speakers: nextSpeakers, captions: nextCaptions };
}

export function countSegmentsPerSpeaker(captions: CaptionSegment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const seg of captions) {
    const key = normalizeSpeakerName(seg.speaker).toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

export function resolveSpeakerVoice(
  seg: CaptionSegment,
  project: Pick<Project, 'speakers' | 'voice'>,
  voiceConfigOverride?: VoiceConfig
): {
  referenceId?: string;
  voiceTitle: string;
  speakerName?: string;
  fromSpeakerOverride: boolean;
} {
  const activeVoice = voiceConfigOverride || project.voice;
  const fallbackRef = activeVoice.fishReferenceId?.trim() || undefined;
  const fallbackTitle =
    activeVoice.fishVoiceTitle ||
    (fallbackRef ? `Voice ${fallbackRef.slice(0, 8)}...` : 'Default Fish Audio Voice');

  const segSpeakerKey = normalizeSpeakerName(seg.speaker).toLowerCase();
  if (segSpeakerKey && Array.isArray(project.speakers)) {
    const profile = project.speakers.find(
      (sp) => normalizeSpeakerName(sp.name).toLowerCase() === segSpeakerKey
    );
    if (profile && profile.fishReferenceId?.trim()) {
      return {
        referenceId: profile.fishReferenceId.trim(),
        voiceTitle: profile.fishVoiceTitle || `Speaker Voice (${profile.name})`,
        speakerName: profile.name,
        fromSpeakerOverride: true,
      };
    }
    if (profile) {
      return {
        referenceId: fallbackRef,
        voiceTitle: fallbackTitle,
        speakerName: profile.name,
        fromSpeakerOverride: false,
      };
    }
  }

  return {
    referenceId: fallbackRef,
    voiceTitle: fallbackTitle,
    speakerName: normalizeSpeakerName(seg.speaker) || undefined,
    fromSpeakerOverride: false,
  };
}
