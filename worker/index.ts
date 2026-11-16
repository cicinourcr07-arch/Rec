/**
 * Cloudflare Worker Backend + Static Asset Handler
 *
 * Serves Vite static assets from ./dist via env.ASSETS and executes
 * key-protected Fish Audio & Gemini API calls cleanly at the edge using
 * Worker environment secrets (env.FISH_AUDIO_API_KEY, env.GEMINI_API_KEY).
 */

export interface Env {
  ASSETS: {
    fetch(request: Request | string): Promise<Response>;
  };
  FISH_AUDIO_API_KEY?: string;
  FISH_API_KEY?: string;
  FISH_API_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  CORS_ORIGINS?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const PLACEHOLDER_KEYS = new Set([
  'your_key_here',
  'my_fish_api_key',
  'my_fish_audio_api_key',
  'my_gemini_api_key',
]);

const LANGUAGE_TO_ISO: Record<string, string> = {
  English: 'en',
  French: 'fr',
  Arabic: 'ar',
  Spanish: 'es',
  German: 'de',
  Portuguese: 'pt',
  Italian: 'it',
  Turkish: 'tr',
  Hindi: 'hi',
};

function readFishKey(env: Env): string {
  const raw = (env.FISH_AUDIO_API_KEY || env.FISH_API_KEY || '').trim();
  if (!raw || PLACEHOLDER_KEYS.has(raw.toLowerCase())) return '';
  return raw;
}

function readGeminiKey(env: Env): string {
  const raw = (env.GEMINI_API_KEY || '').trim();
  if (!raw || PLACEHOLDER_KEYS.has(raw.toLowerCase())) return '';
  return raw;
}

function getFishBase(env: Env): string {
  return (env.FISH_API_BASE_URL || 'https://api.fish.audio').trim().replace(/\/+$/, '');
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '*';
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(
  request: Request,
  body: unknown,
  status = 200
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function parseFishError(rawText: string, status: number): string {
  let msg = `Fish Audio API error (${status})`;
  try {
    const parsed = JSON.parse(rawText) as { message?: string; detail?: string; error?: string };
    msg = parsed.message || parsed.detail || parsed.error || msg;
  } catch {
    if (rawText.trim()) {
      msg = `${msg}: ${rawText.trim().slice(0, 220)}`;
    }
  }
  return msg;
}

async function handleFishTts(request: Request, env: Env): Promise<Response> {
  const apiKey = readFishKey(env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'FISH_AUDIO_API_KEY is not configured in Cloudflare Worker Variables/Secrets.',
      },
      503
    );
  }

  let body: {
    text?: string;
    referenceId?: string;
    reference_id?: string;
    format?: string;
    model?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(request, { error: 'Invalid JSON request body.' }, 400);
  }

  const text = String(body?.text || '').trim();
  if (!text) {
    return jsonResponse(request, { error: 'text is required for Fish Audio generation.' }, 400);
  }

  const rawFormat = String(body?.format || 'mp3').toLowerCase();
  const format = ['mp3', 'wav', 'pcm', 'opus'].includes(rawFormat) ? rawFormat : 'mp3';
  const referenceId = (body?.referenceId || body?.reference_id || '').trim();
  const model = (body?.model || 's2.1-pro-free').trim();

  const fishPayload: Record<string, unknown> = {
    text,
    format,
    normalize: true,
    latency: 'balanced',
    chunk_length: 250,
    prosody: {
      speed: 1.0,
      volume: 0.0,
    },
  };
  if (referenceId) {
    fishPayload.reference_id = referenceId;
  }

  const upstream = await fetch(`${getFishBase(env)}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      model,
    },
    body: JSON.stringify(fishPayload),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseFishError(errText, upstream.status) },
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  const audioBytes = await upstream.arrayBuffer();
  if (audioBytes.byteLength < 128) {
    return jsonResponse(
      request,
      { error: 'Fish Audio TTS returned an empty audio stream.' },
      502
    );
  }

  const contentTypeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
    opus: 'audio/ogg',
  };

  return new Response(audioBytes, {
    status: 200,
    headers: {
      'Content-Type': contentTypeMap[format] || 'audio/mpeg',
      'Content-Length': String(audioBytes.byteLength),
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

async function handleFishVoices(request: Request, env: Env, url: URL): Promise<Response> {
  const apiKey = readFishKey(env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'FISH_AUDIO_API_KEY is not configured in Cloudflare Worker Variables/Secrets.',
      },
      503
    );
  }

  const qs = new URLSearchParams();
  qs.set('page_size', url.searchParams.get('page_size') || '24');
  qs.set('sort_by', 'task_count');
  if (url.searchParams.get('self') === 'true') {
    qs.set('self', 'true');
  }
  const q = url.searchParams.get('q')?.trim();
  if (q) {
    qs.set('title', q);
  }
  const lang = url.searchParams.get('language');
  if (lang && LANGUAGE_TO_ISO[lang]) {
    qs.set('language', LANGUAGE_TO_ISO[lang]);
  }

  const upstream = await fetch(`${getFishBase(env)}/model?${qs.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseFishError(errText, upstream.status) },
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  const payload = (await upstream.json()) as {
    total?: number;
    items?: Array<{
      _id?: string;
      id?: string;
      title?: string;
      description?: string;
      languages?: string[];
      tags?: string[];
      visibility?: string;
      cover_image?: string;
      author?: { nickname?: string; name?: string };
    }>;
  };

  const voices = (payload.items || [])
    .map((item) => ({
      id: item._id || item.id || '',
      title: item.title || 'Untitled Voice',
      description: item.description || '',
      languages: Array.isArray(item.languages) ? item.languages : [],
      author: item.author?.nickname || item.author?.name || 'Fish Audio',
      tags: Array.isArray(item.tags) ? item.tags : [],
      visibility: item.visibility,
      coverImage: item.cover_image,
    }))
    .filter((v) => Boolean(v.id));

  return jsonResponse(request, {
    voices,
    total: Number(payload.total || voices.length),
  });
}

function mapIsoToLanguageName(code?: string): string {
  if (!code) return 'Auto';
  const clean = code.toLowerCase().slice(0, 2);
  for (const [name, iso] of Object.entries(LANGUAGE_TO_ISO)) {
    if (iso === clean) return name;
  }
  return code;
}

function distributeWordsEvenly(text: string, start: number, end: number) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const step = Math.max(0.05, (end - start) / tokens.length);
  return tokens.map((word, idx) => ({
    word,
    start: Math.round((start + idx * step) * 100) / 100,
    end: Math.round((start + (idx + 1) * step) * 100) / 100,
  }));
}

async function handleFishAsr(
  request: Request,
  env: Env,
  projectId: string | null
): Promise<Response> {
  const apiKey = readFishKey(env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'FISH_AUDIO_API_KEY is not configured in Cloudflare Worker Variables/Secrets.',
      },
      503
    );
  }

  let incomingForm: FormData;
  try {
    incomingForm = await request.formData();
  } catch {
    return jsonResponse(
      request,
      { error: 'Expected multipart/form-data with an "audio" file field.' },
      400
    );
  }

  const audioField = incomingForm.get('audio');
  if (!(audioField instanceof Blob) || audioField.size === 0) {
    return jsonResponse(
      request,
      { error: 'Missing or empty audio file ("audio") for Fish Audio ASR.' },
      400
    );
  }

  const durationInput = Number(incomingForm.get('duration')) || 10;
  const sourceLanguage = String(incomingForm.get('sourceLanguage') || '').trim();
  const isoLang =
    sourceLanguage && sourceLanguage !== 'Auto' ? LANGUAGE_TO_ISO[sourceLanguage] : undefined;

  const outForm = new FormData();
  const filename = audioField instanceof File && audioField.name ? audioField.name : 'audio.wav';
  outForm.append('audio', audioField, filename);
  outForm.append('ignore_timestamps', 'false');
  if (isoLang) {
    outForm.append('language', isoLang);
  }

  const upstream = await fetch(`${getFishBase(env)}/v1/asr`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      model: 'transcribe-1-pro',
    },
    body: outForm,
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseFishError(errText, upstream.status) },
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  const data = (await upstream.json()) as {
    text?: string;
    duration?: number;
    language?: string;
    segments?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker?: string | number;
      speaker_id?: string | number;
    }>;
    speaker_turns?: Array<{
      text?: string;
      start?: number;
      end?: number;
      speaker?: string | number;
      speaker_id?: string | number;
    }>;
  };

  const totalDur = Math.max(0.5, Number(data.duration) || durationInput || 10);
  const rawSegs =
    Array.isArray(data.segments) && data.segments.length > 0
      ? data.segments
      : Array.isArray(data.speaker_turns) && data.speaker_turns.length > 0
      ? data.speaker_turns
      : [];

  let segments = rawSegs
    .filter((s) => s.text && s.text.trim().length > 0)
    .map((s) => {
      const start = Math.max(0, Math.min(totalDur, Number(s.start) || 0));
      const end = Math.max(start + 0.25, Math.min(totalDur, Number(s.end) || start + 2));
      const text = s.text!.trim();
      const rawSpeaker = s.speaker ?? s.speaker_id;
      const speaker =
        rawSpeaker !== undefined && rawSpeaker !== null && String(rawSpeaker).trim() !== ''
          ? String(rawSpeaker).startsWith('Speaker')
            ? String(rawSpeaker)
            : `Speaker ${rawSpeaker}`
          : undefined;

      return {
        id: crypto.randomUUID(),
        start: Math.round(start * 100) / 100,
        end: Math.round(end * 100) / 100,
        text,
        speaker,
        words: distributeWordsEvenly(text, start, end),
      };
    });

  if (segments.length === 0 && data.text && data.text.trim().length > 0) {
    const sentences = data.text
      .trim()
      .split(/(?<=[.!?؟])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const step = totalDur / Math.max(1, sentences.length);
    segments = sentences.map((sentence, idx) => {
      const start = Math.round(idx * step * 100) / 100;
      const end = Math.round(Math.min(totalDur, (idx + 1) * step) * 100) / 100;
      return {
        id: crypto.randomUUID(),
        start,
        end: Math.max(start + 0.3, end),
        text: sentence,
        speaker: undefined,
        words: distributeWordsEvenly(sentence, start, end),
      };
    });
  }

  if (segments.length === 0) {
    return jsonResponse(
      request,
      { error: 'Fish Audio ASR returned no spoken segments for this audio track.' },
      422
    );
  }

  const detectedLanguage =
    sourceLanguage && sourceLanguage !== 'Auto'
      ? sourceLanguage
      : mapIsoToLanguageName(data.language);

  if (projectId) {
    return jsonResponse(request, {
      project: {
        id: projectId,
        captions: segments,
        translation: {
          sourceLanguage: detectedLanguage,
          targetLanguage: 'French',
          preserveProperNouns: true,
          lastTranslatedAt: null,
        },
      },
      detectedLanguage,
      segmentCount: segments.length,
    });
  }

  return jsonResponse(request, {
    segments,
    detectedLanguage,
  });
}

async function handleGeminiTranslate(
  request: Request,
  env: Env,
  projectId: string
): Promise<Response> {
  const apiKey = readGeminiKey(env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'GEMINI_API_KEY is not configured in Cloudflare Worker Variables/Secrets. Use External Gemini (No Key) mode or add GEMINI_API_KEY in Cloudflare Worker settings.',
      },
      503
    );
  }

  let body: {
    captions?: Array<{
      id: string;
      start: number;
      end: number;
      text: string;
      translatedText?: string;
    }>;
    sourceLanguage?: string;
    targetLanguage?: string;
    preserveProperNouns?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(request, { error: 'Invalid JSON body.' }, 400);
  }

  const captions = Array.isArray(body?.captions) ? body.captions : [];
  if (captions.length === 0) {
    return jsonResponse(request, { error: 'No caption segments provided to translate.' }, 400);
  }

  const targetLanguage = body?.targetLanguage || 'French';
  const sourceLanguage = body?.sourceLanguage || 'Auto';
  const preserveProperNouns = Boolean(body?.preserveProperNouns ?? true);

  const prompt = [
    `Translate the following movie recap script lines from ${sourceLanguage} to ${targetLanguage}.`,
    preserveProperNouns
      ? 'Preserve character names, movie titles, and proper nouns accurately.'
      : '',
    'Keep translations concise and natural for spoken voiceover narration fitting roughly the same segment duration.',
    'Return ONLY a JSON array of objects matching [{ "id": "...", "translatedText": "..." }].',
    JSON.stringify(captions.map((c) => ({ id: c.id, text: c.text }))),
  ]
    .filter(Boolean)
    .join('\n\n');

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
      apiKey
    )}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    return jsonResponse(
      request,
      { error: `Gemini translation error (${geminiRes.status}): ${errText.slice(0, 220)}` },
      geminiRes.status >= 400 && geminiRes.status < 500 ? geminiRes.status : 502
    );
  }

  const geminiJson = (await geminiRes.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  let translatedList: Array<{ id: string; translatedText: string }> = [];
  try {
    translatedList = JSON.parse(rawText) as Array<{ id: string; translatedText: string }>;
  } catch {
    return jsonResponse(
      request,
      { error: 'Failed to parse JSON translation returned by Gemini.' },
      502
    );
  }

  const byId = new Map(translatedList.map((item) => [item.id, item.translatedText]));
  const updatedCaptions = captions.map((seg) => ({
    ...seg,
    translatedText: byId.get(seg.id) || seg.translatedText || seg.text,
  }));

  return jsonResponse(request, {
    project: {
      id: projectId,
      captions: updatedCaptions,
      translation: {
        sourceLanguage,
        targetLanguage,
        preserveProperNouns,
        lastTranslatedAt: new Date().toISOString(),
      },
      subtitleStyle: {
        useTranslated: true,
      },
    },
  });
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if ((path === '/api/health' || path === '/health') && request.method === 'GET') {
    return jsonResponse(request, {
      ok: true,
      service: 'recap-studio-worker',
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/api/system/status' && request.method === 'GET') {
    return jsonResponse(request, {
      geminiConfigured: Boolean(readGeminiKey(env)),
      fishConfigured: Boolean(readFishKey(env)),
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      ffmpegVersion: 'Cloudflare Worker + Browser Web Audio/MediaRecorder',
      storageDir: 'Browser IndexedDB + File API',
      maxUploadSizeMb: 2048,
      tempRetentionHours: 24,
      supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
      supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
    });
  }

  if (path === '/api/fish/status' && request.method === 'GET') {
    return jsonResponse(request, {
      configured: Boolean(readFishKey(env)),
      ttsModel: 's2.1-pro-free',
      asrModel: 'transcribe-1-pro',
    });
  }

  // Primary requested endpoint: POST /api/fish-audio (forwards securely using env.FISH_AUDIO_API_KEY)
  if ((path === '/api/fish-audio' || path === '/api/fish/tts') && request.method === 'POST') {
    return handleFishTts(request, env);
  }

  if (path === '/api/fish/voices' && request.method === 'GET') {
    return handleFishVoices(request, env, url);
  }

  if (path === '/api/fish/asr' && request.method === 'POST') {
    return handleFishAsr(request, env, null);
  }

  const dubTranscribeMatch = path.match(/^\/api\/projects\/([^/]+)\/dubbing\/transcribe$/);
  if (dubTranscribeMatch && request.method === 'POST') {
    return handleFishAsr(request, env, dubTranscribeMatch[1]);
  }

  const dubPreviewMatch = path.match(/^\/api\/projects\/([^/]+)\/dubbing\/preview$/);
  if (dubPreviewMatch && request.method === 'POST') {
    return handleFishTts(request, env);
  }

  const dubGenerateMatch = path.match(/^\/api\/projects\/([^/]+)\/dubbing\/generate$/);
  if (dubGenerateMatch && request.method === 'POST') {
    if (!readFishKey(env)) {
      return jsonResponse(
        request,
        {
          error:
            'FISH_AUDIO_API_KEY is not configured in Cloudflare Worker Variables/Secrets.',
        },
        503
      );
    }
    return jsonResponse(request, { workerEdgeMode: true });
  }

  const translateMatch = path.match(/^\/api\/projects\/([^/]+)\/translate$/);
  if (translateMatch && request.method === 'POST') {
    return handleGeminiTranslate(request, env, translateMatch[1]);
  }

  return jsonResponse(
    request,
    { error: `Endpoint not found on Cloudflare Worker: ${request.method} ${path}` },
    404
  );
}

export default {
  async fetch(request: Request, env: Env, _ctx: WorkerExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      return handleApiRequest(request, env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Static assets binding (ASSETS) not configured.', { status: 404 });
  },
};
