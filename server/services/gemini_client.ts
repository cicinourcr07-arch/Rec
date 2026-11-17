import { GoogleGenAI } from '@google/genai';

const PLACEHOLDER_KEYS = new Set(['your_key_here', 'my_gemini_api_key']);

export function resolveGeminiApiKey(overrideKey?: string | null): string {
  const cleanOverride = (overrideKey || '').trim();
  if (cleanOverride && !PLACEHOLDER_KEYS.has(cleanOverride.toLowerCase())) {
    return cleanOverride;
  }
  const envKey = (process.env.GEMINI_API_KEY || '').trim();
  if (envKey && !PLACEHOLDER_KEYS.has(envKey.toLowerCase())) {
    return envKey;
  }
  return '';
}

export function isGeminiConfigured(overrideKey?: string | null): boolean {
  return Boolean(resolveGeminiApiKey(overrideKey));
}

export function getGeminiClient(
  apiVersion: 'v1' | 'v1beta' = 'v1beta',
  overrideKey?: string | null
): GoogleGenAI {
  const apiKey = resolveGeminiApiKey(overrideKey);
  if (!apiKey) {
    const err = new Error(
      'GEMINI_API_KEY is not configured. Add your personal Gemini API key in Settings -> Gemini API Settings, or use the free External Gemini (No Key) workflow.'
    );
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }

  return new GoogleGenAI({
    apiKey,
    apiVersion,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}
