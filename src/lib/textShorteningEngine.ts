/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { CaptionSegment, SupportedLanguage } from '../types/studio';

export type ShorteningIntensity = 'light' | 'medium' | 'strong' | 'very-strong' | 'maximum';
export type ShorteningScope = 'all' | 'selected' | 'single';

export interface ShorteningVersionEntry {
  id: string;
  timestamp: string;
  intensity: ShorteningIntensity;
  scope: ShorteningScope;
  targetSegmentIds: string[];
  beforeSnapshot: Record<string, string>;
  afterSnapshot: Record<string, string>;
  note: string;
}

export const SHORTENING_INTENSITIES: Array<{
  id: ShorteningIntensity;
  name: string;
  targetRatio: number;
  desc: string;
}> = [
  { id: 'light', name: 'Light (90%)', targetRatio: 0.9, desc: 'Trim filler words and gentle redundancies' },
  { id: 'medium', name: 'Medium (75%)', targetRatio: 0.75, desc: 'Compress clauses and tighten phrasing' },
  { id: 'strong', name: 'Strong (60%)', targetRatio: 0.6, desc: 'Dense syntactic condensation keeping proper nouns' },
  { id: 'very-strong', name: 'Very Strong (45%)', targetRatio: 0.45, desc: 'High-compression spoken summary for tight slots' },
  { id: 'maximum', name: 'Maximum (30%)', targetRatio: 0.3, desc: 'Ultra-concise punchy headlines / flash recap style' },
];

export function computeSpeechMetrics(
  text: string,
  allocatedSec: number,
  minWps = 2.2,
  maxWps = 3.4
) {
  const clean = (text || '').trim();
  const words = clean ? clean.split(/\s+/) : [];
  const charCount = clean.length;
  const wordCount = words.length;
  const estDuration = wordCount / 2.7; // ~2.7 words/sec average spoken narration rate
  const minAllowedWords = Math.max(1, Math.round(allocatedSec * minWps));
  const maxAllowedWords = Math.max(minAllowedWords + 1, Math.round(allocatedSec * maxWps));
  const isOverflow = estDuration > allocatedSec + 0.15;
  const overflowSec = isOverflow ? estDuration - allocatedSec : 0;
  return {
    charCount,
    wordCount,
    estDuration: Number(estDuration.toFixed(2)),
    minAllowedWords,
    maxAllowedWords,
    isOverflow,
    overflowSec: Number(overflowSec.toFixed(2)),
  };
}

// Deterministic local text shortening operating on current translatedText
export function shortenSegmentTextLocally(params: {
  text: string;
  intensity: ShorteningIntensity;
  preserveProperNouns?: boolean;
}): string {
  const text = (params.text || '').trim();
  if (!text) return '';

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 3) return text;

  let ratio = 0.9;
  if (params.intensity === 'medium') ratio = 0.75;
  else if (params.intensity === 'strong') ratio = 0.6;
  else if (params.intensity === 'very-strong') ratio = 0.45;
  else if (params.intensity === 'maximum') ratio = 0.3;

  const targetCount = Math.max(2, Math.round(words.length * ratio));

  // Step 1: Remove filler words and redundant adverbs
  const fillers = new Set([
    'actually', 'basically', 'literally', 'really', 'very', 'just', 'suddenly',
    'completely', 'totally', 'simply', 'in order to', 'thus far', 'meanwhile',
    'en fait', 'vraiment', 'simplement', 'cependant', 'lorsque',
  ]);

  let filtered = words.filter((w) => !fillers.has(w.toLowerCase().replace(/[,.!?;:]/g, '')));
  if (filtered.length <= targetCount) {
    return filtered.join(' ');
  }

  // Step 2: Condense clause connectors while preserving capitalized proper nouns & numbers
  const kept: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const w = filtered[i];
    const isProperNoun = /^[A-Z][a-zà-ÿ]/.test(w) || /\d/.test(w);
    if (isProperNoun || i % Math.max(1, Math.round(filtered.length / targetCount)) === 0 || kept.length < targetCount) {
      kept.push(w);
    }
  }

  const result = kept.join(' ');
  return result || text;
}

export function buildMultiLevelShortenPrompt(params: {
  segments: CaptionSegment[];
  intensity: ShorteningIntensity;
  targetLanguage: SupportedLanguage;
  preserveProperNouns: boolean;
}): string {
  const levelMeta = SHORTENING_INTENSITIES.find((l) => l.id === params.intensity) || SHORTENING_INTENSITIES[1];
  return [
    `You are an expert movie recap translation and speech pacing editor.`,
    `Task: Shorten the translated narration text for the following caption segments to achieve ${levelMeta.name} (${levelMeta.desc}).`,
    `Target Language: ${params.targetLanguage}`,
    params.preserveProperNouns ? `CRITICAL RULE: Preserve all proper nouns, character names, movie titles, and numbers.` : '',
    `Maintain natural spoken phrasing, correct grammar, and dialogue consistency. NEVER change segment IDs, start/end timestamps, or speakers.`,
    `Return ONLY a JSON array of objects matching [{ "id": "...", "translatedText": "..." }].`,
    JSON.stringify(
      params.segments.map((s) => ({
        id: s.id,
        start: s.start,
        end: s.end,
        speaker: s.speaker || 'Narrator',
        currentTranslatedText: s.translatedText || s.text,
      })),
      null,
      2
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}
