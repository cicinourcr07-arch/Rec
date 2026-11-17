import { Type } from '@google/genai';
import { CaptionSegment, SupportedLanguage } from '../../src/types/studio.ts';
import { getGeminiClient } from './gemini_client.ts';
import { distributeWordsEvenly } from './transcription_service.ts';

export async function translateCaptionsWithGemini(params: {
  captions: CaptionSegment[];
  sourceLanguage: string;
  targetLanguage: SupportedLanguage;
  preserveProperNouns: boolean;
  apiKey?: string | null;
}): Promise<CaptionSegment[]> {
  if (!params.captions || params.captions.length === 0) {
    throw new Error('No caption segments available to translate. Generate or add captions first.');
  }

  const ai = getGeminiClient('v1beta', params.apiKey);

  const payload = params.captions.map((c) => ({
    id: c.id,
    start: c.start,
    end: c.end,
    speaker: c.speaker || undefined,
    text: c.text,
  }));

  const models = ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-2.5-flash'] as const;
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      response = await ai.models.generateContent({
        model,
        contents: `Translate the following movie recap subtitle segments from ${params.sourceLanguage} into ${params.targetLanguage}.
Rules:
1. Preserve the complete meaning, story facts, chronology, and dramatic tone. Improve wording naturally in ${params.targetLanguage}, but do NOT force unnecessary shortening or omit important details to match original segment length. If tightening is ever needed for flow, retain 100% of essential information.
2. ${params.preserveProperNouns ? 'Do NOT translate character names, actor names, movie titles, key locations, or iconic movie terminology; transliterate only if writing script requires it (e.g. Arabic/Hindi) while keeping the name recognizable.' : 'Preserve key character names and major locations accurately while translating naturally.'}
3. Keep each segment aligned to its exact id and timing; return one translated entry per input segment.
Input segments JSON:
${JSON.stringify(payload)}`,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              translations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    translatedText: { type: Type.STRING },
                  },
                  required: ['id', 'translatedText'],
                },
              },
            },
            required: ['translations'],
          },
        },
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/404|not found|no longer available/i.test(msg)) {
        throw err;
      }
    }
  }
  if (!response) {
    throw lastErr instanceof Error ? lastErr : new Error('Gemini translation model unavailable.');
  }

  const rawText = (response.text || '{}')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const parsed = JSON.parse(rawText) as {
    translations?: Array<{ id: string; translatedText: string }>;
  };

  const map = new Map<string, string>();
  for (const item of parsed.translations || []) {
    if (item && typeof item.id === 'string' && typeof item.translatedText === 'string') {
      map.set(item.id, item.translatedText.trim());
    }
  }

  return params.captions.map((seg) => {
    const translatedText = map.get(seg.id) || seg.translatedText || seg.text;
    return {
      ...seg,
      speaker: seg.speaker,
      translatedText,
      words: distributeWordsEvenly(translatedText, seg.start, seg.end),
    };
  });
}
