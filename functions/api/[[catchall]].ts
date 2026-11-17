/**
 * Self-contained Cloudflare Pages Function handler for /api/* routes
 * (e.g. /api/system/status, /api/fish/status, /api/fish/voices, /api/fish/asr,
 * /api/gemini/test, /api/projects/:id/dubbing/*, /api/projects/:id/translate, /api/health).
 *
 * Reads personal API keys from request headers first (Authorization Bearer for Fish Audio,
 * X-Gemini-Api-Key for Gemini — stored locally in the user's browser IndexedDB), with optional
 * fallback to Cloudflare environment bindings. Never persists or logs keys, and never returns HTML.
 */

interface PagesEnv {
  BACKEND_URL?: string;
  VITE_API_BASE_URL?: string;
  API_URL?: string;
  FISH_AUDIO_API_KEY?: string;
  FISH_API_KEY?: string;
  FISH_API_BASE_URL?: string;
  GEMINI_API_KEY?: string;
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

function sanitizeMessage(msg: string, secretToRedact?: string): string {
  let clean = String(msg || 'Request failed.');
  if (secretToRedact && secretToRedact.length >= 4) {
    clean = clean.split(secretToRedact).join('[redacted]');
  }
  clean = clean.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
  clean = clean.replace(/[?&]key=[^&\s"']+/gi, '?key=[redacted]');
  return clean;
}

function isHtmlBody(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html') || t.includes('</html>');
}

function readBearerFromRequest(request: Request): string {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return '';
  const token = m[1].trim();
  if (!token || /[\r\n\s]/.test(token) || PLACEHOLDER_KEYS.has(token.toLowerCase())) {
    return '';
  }
  return token;
}

function readPersonalGeminiFromRequest(request: Request): string {
  const headerVal = (request.headers.get('X-Gemini-Api-Key') || '').trim();
  if (!headerVal || /[\r\n\s]/.test(headerVal) || PLACEHOLDER_KEYS.has(headerVal.toLowerCase())) {
    return '';
  }
  return headerVal;
}

function readFishKey(request: Request, env: PagesEnv): string {
  const personal = readBearerFromRequest(request);
  if (personal) return personal;
  const raw = (env.FISH_AUDIO_API_KEY || env.FISH_API_KEY || '').trim();
  if (!raw || PLACEHOLDER_KEYS.has(raw.toLowerCase())) return '';
  return raw;
}

function readGeminiKey(request: Request, env: PagesEnv): string {
  const personal = readPersonalGeminiFromRequest(request);
  if (personal) return personal;
  const raw = (env.GEMINI_API_KEY || '').trim();
  if (!raw || PLACEHOLDER_KEYS.has(raw.toLowerCase())) return '';
  return raw;
}

function getFishBase(env: PagesEnv): string {
  return (env.FISH_API_BASE_URL || 'https://api.fish.audio').trim().replace(/\/+$/, '');
}

function isLocalHostname(hostname: string): boolean {
  const h = (hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function validateSameOriginIfAuthenticated(
  request: Request,
  requestUrl: URL
): { ok: boolean; status: number; error: string } {
  const hasAuth = Boolean(
    request.headers.get('Authorization') || request.headers.get('X-Gemini-Api-Key')
  );
  const forwardedProto = (request.headers.get('x-forwarded-proto') || '').toLowerCase();
  const isHttps = requestUrl.protocol === 'https:' || forwardedProto === 'https';

  if (hasAuth && !isHttps && !isLocalHostname(requestUrl.hostname)) {
    return {
      ok: false,
      status: 403,
      error: 'HTTPS is required when sending API credentials.',
    };
  }

  for (const keyParam of ['api_key', 'apikey', 'key', 'token', 'secret', 'authorization']) {
    if (requestUrl.searchParams.has(keyParam)) {
      return {
        ok: false,
        status: 400,
        error: 'API keys must never be passed in URL query parameters.',
      };
    }
  }

  if (hasAuth) {
    const secFetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
    if (secFetchSite === 'cross-site') {
      return { ok: false, status: 403, error: 'Cross-site requests are not permitted.' };
    }
    const originHeader = request.headers.get('Origin');
    if (originHeader && originHeader !== requestUrl.origin) {
      return { ok: false, status: 403, error: 'Cross-origin requests are not permitted.' };
    }
  }

  return { ok: true, status: 200, error: '' };
}

function corsHeaders(request: Request): Record<string, string> {
  const requestOrigin = new URL(request.url).origin;
  const hasAuth = Boolean(
    request.headers.get('Authorization') || request.headers.get('X-Gemini-Api-Key')
  );
  const origin = hasAuth ? requestOrigin : request.headers.get('Origin') || requestOrigin;
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers':
      'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Gemini-Api-Key, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(request: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function parseFishError(rawText: string, status: number, secretToRedact?: string): string {
  if (status === 401 || status === 403) {
    return 'Invalid Fish Audio API key or unauthorized access.';
  }
  if (status === 402) {
    return 'Fish Audio account balance or credits are insufficient.';
  }
  if (status === 429) {
    return 'Fish Audio API rate limit exceeded. Please wait and try again.';
  }
  let msg = `Fish Audio API error (${status})`;
  try {
    const parsed = JSON.parse(rawText) as { message?: string; detail?: string; error?: string };
    msg = parsed.message || parsed.detail || parsed.error || msg;
  } catch {
    const trimmed = (rawText || '').trim();
    if (trimmed && !isHtmlBody(trimmed) && status < 500) {
      msg = `${msg}: ${trimmed.slice(0, 220)}`;
    }
  }
  return sanitizeMessage(msg, secretToRedact);
}

function parseGeminiError(rawText: string, status: number, secretToRedact?: string): string {
  if (status === 401 || status === 403) {
    return 'Invalid Gemini API key or insufficient API permissions.';
  }
  if (status === 429) {
    return 'Gemini API quota or rate limit exceeded. Please wait or switch to External Gemini (No Key).';
  }
  let msg = `Gemini API error (${status})`;
  try {
    const parsed = JSON.parse(rawText) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed?.error === 'object' && parsed.error?.message) {
      msg = parsed.error.message;
    } else if (typeof parsed?.error === 'string') {
      msg = parsed.error;
    } else if (typeof parsed?.message === 'string') {
      msg = parsed.message;
    }
  } catch {
    const trimmed = (rawText || '').trim();
    if (trimmed && !isHtmlBody(trimmed) && status < 500) {
      msg = `${msg}: ${trimmed.slice(0, 220)}`;
    }
  }
  if (/api key not valid/i.test(msg)) {
    return 'Invalid Gemini API key. Check your key in Settings -> Gemini API Settings.';
  }
  return sanitizeMessage(msg, secretToRedact);
}

function extractJsonPayload(rawText: string): string {
  const cleaned = rawText.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    return fence[1].trim();
  }
  return cleaned;
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

async function handleFishVoices(request: Request, env: PagesEnv, url: URL): Promise<Response> {
  const apiKey = readFishKey(request, env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'Fish Audio API key is not configured. Add your personal API key in Settings -> Fish Audio API Settings.',
      },
      401
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

  let upstream: Response;
  try {
    upstream = await fetch(`${getFishBase(env)}/model?${qs.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch {
    return jsonResponse(request, { error: 'Unable to connect to Fish Audio API.' }, 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseFishError(errText, upstream.status, apiKey) },
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as {
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

async function handleFishAsr(
  request: Request,
  env: PagesEnv,
  projectId: string | null
): Promise<Response> {
  const apiKey = readFishKey(request, env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'Fish Audio API key is not configured. Add your personal API key in Settings -> Fish Audio API Settings.',
      },
      401
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

  let upstream: Response;
  try {
    upstream = await fetch(`${getFishBase(env)}/v1/asr`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        model: 'transcribe-1-pro',
      },
      body: outForm,
    });
  } catch {
    return jsonResponse(request, { error: 'Unable to reach Fish Audio ASR endpoint.' }, 502);
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseFishError(errText, upstream.status, apiKey) },
      upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  const data = (await upstream.json().catch(() => null)) as {
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
  } | null;

  if (!data) {
    return jsonResponse(request, { error: 'Fish Audio ASR returned an invalid JSON payload.' }, 502);
  }

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
          ? /^speaker/i.test(String(rawSpeaker).trim())
            ? String(rawSpeaker).trim()
            : `Speaker ${String(rawSpeaker).trim()}`
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

const GEMINI_FLASH_MODELS = ['gemini-3.8-flash', 'gemini-4-hydrogen', 'gemini-2.5-flash'] as const;

async function fetchGeminiGenerateContent(
  apiKey: string,
  payload: Record<string, unknown>
): Promise<{ response: Response; model: string }> {
  let lastRes: Response | null = null;
  let lastModel: string = GEMINI_FLASH_MODELS[0];
  for (const model of GEMINI_FLASH_MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
        apiKey
      )}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    lastRes = res;
    lastModel = model;
    if (res.ok || res.status !== 404) {
      return { response: res, model };
    }
  }
  return { response: lastRes!, model: lastModel };
}

async function handleGeminiTest(request: Request, env: PagesEnv): Promise<Response> {
  const apiKey = readGeminiKey(request, env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        ok: false,
        status: 'not_configured',
        error:
          'No Gemini API key configured. Add your personal Gemini API key in Settings -> Gemini API Settings, or use External Gemini (No Key) mode for free.',
      },
      401
    );
  }

  let upstream: Response;
  let connectedModel = GEMINI_FLASH_MODELS[0] as string;
  try {
    const result = await fetchGeminiGenerateContent(apiKey, {
      contents: [{ parts: [{ text: 'Reply with OK' }] }],
      generationConfig: { maxOutputTokens: 8 },
    });
    upstream = result.response;
    connectedModel = result.model;
  } catch {
    return jsonResponse(
      request,
      {
        ok: false,
        status: 'connection_error',
        error: 'Unable to reach Gemini API from Cloudflare Pages Function.',
      },
      502
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const parsedErr = parseGeminiError(errText, upstream.status, apiKey);
    const isAuthErr =
      upstream.status === 401 ||
      upstream.status === 403 ||
      /invalid gemini api key/i.test(parsedErr);
    return jsonResponse(
      request,
      {
        ok: false,
        status: isAuthErr ? 'invalid_key' : 'connection_error',
        error: parsedErr,
      },
      isAuthErr ? 401 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502
    );
  }

  return jsonResponse(request, {
    ok: true,
    status: 'connected',
    message: `Connected to Gemini API (${connectedModel}).`,
  });
}

async function handleGeminiTranslate(
  request: Request,
  env: PagesEnv,
  projectId: string
): Promise<Response> {
  const apiKey = readGeminiKey(request, env);
  if (!apiKey) {
    return jsonResponse(
      request,
      {
        error:
          'Gemini API key is not configured. Add your personal Gemini API key in Settings -> Gemini API Settings, or use the free External Gemini (No Key) workflow.',
      },
      401
    );
  }

  let body: {
    captions?: Array<{
      id: string;
      start: number;
      end: number;
      text: string;
      translatedText?: string;
      speaker?: string;
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
    'Keep translations complete, faithful, and natural for spoken voiceover narration at 1.0x speed.',
    'Return ONLY a JSON array of objects matching [{ "id": "...", "translatedText": "..." }].',
    JSON.stringify(
      captions.map((c) => ({
        id: c.id,
        speaker: c.speaker || undefined,
        text: c.text,
      }))
    ),
  ]
    .filter(Boolean)
    .join('\n\n');

  let geminiRes: Response;
  try {
    const result = await fetchGeminiGenerateContent(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    });
    geminiRes = result.response;
  } catch {
    return jsonResponse(
      request,
      { error: 'Unable to reach Gemini API for automatic translation.' },
      502
    );
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => '');
    return jsonResponse(
      request,
      { error: parseGeminiError(errText, geminiRes.status, apiKey) },
      geminiRes.status >= 400 && geminiRes.status < 500 ? geminiRes.status : 502
    );
  }

  const geminiJson = (await geminiRes.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

  let translatedList: Array<{ id?: string; translatedText?: string }> = [];
  try {
    const parsed = JSON.parse(extractJsonPayload(rawText)) as
      | Array<{ id?: string; translatedText?: string }>
      | {
          translations?: Array<{ id?: string; translatedText?: string }>;
          segments?: Array<{ id?: string; translatedText?: string }>;
        };
    if (Array.isArray(parsed)) {
      translatedList = parsed;
    } else if (parsed && Array.isArray(parsed.translations)) {
      translatedList = parsed.translations;
    } else if (parsed && Array.isArray(parsed.segments)) {
      translatedList = parsed.segments;
    }
  } catch {
    return jsonResponse(
      request,
      { error: 'Failed to parse JSON translation returned by Gemini.' },
      502
    );
  }

  const byId = new Map<string, string>();
  for (const item of translatedList) {
    if (item && typeof item.id === 'string' && typeof item.translatedText === 'string') {
      byId.set(item.id, item.translatedText.trim());
    }
  }

  const updatedCaptions = captions.map((seg) => {
    const nextTranslated = byId.get(seg.id) || seg.translatedText || seg.text;
    return {
      ...seg,
      speaker: seg.speaker,
      translatedText: nextTranslated,
      words: distributeWordsEvenly(nextTranslated, Number(seg.start) || 0, Number(seg.end) || 1),
    };
  });

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

async function handlePagesApiRequest(request: Request, env: PagesEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const security = validateSameOriginIfAuthenticated(request, url);
  if (!security.ok) {
    return jsonResponse(request, { error: security.error }, security.status);
  }

  if (path === '/api/health' && request.method === 'GET') {
    return jsonResponse(request, {
      ok: true,
      service: 'recap-studio-pages-functions',
      timestamp: new Date().toISOString(),
    });
  }

  if (path === '/api/system/status' && request.method === 'GET') {
    return jsonResponse(request, {
      geminiConfigured: Boolean(readGeminiKey(request, env)),
      fishConfigured: Boolean(readFishKey(request, env)),
      ffmpegAvailable: false,
      ffprobeAvailable: false,
      ffmpegVersion: 'Cloudflare Pages Functions + Browser Web Audio/MediaRecorder',
      storageDir: 'Browser IndexedDB + File API',
      maxUploadSizeMb: 2048,
      tempRetentionHours: 24,
      supportedVideoFormats: ['MP4', 'MOV', 'MKV'],
      supportedLogoFormats: ['PNG', 'SVG', 'JPG', 'WEBP'],
    });
  }

  if (path === '/api/gemini/test') {
    if (request.method !== 'POST') {
      return jsonResponse(
        request,
        { error: 'Method Not Allowed. Only POST requests are accepted at /api/gemini/test.' },
        405
      );
    }
    return handleGeminiTest(request, env);
  }

  if (path === '/api/fish/status' && request.method === 'GET') {
    return jsonResponse(request, {
      configured: Boolean(readFishKey(request, env)),
      ttsModel: 's2.1-pro-free',
      asrModel: 'transcribe-1-pro',
    });
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

  const dubGenerateMatch = path.match(/^\/api\/projects\/([^/]+)\/dubbing\/generate$/);
  if (dubGenerateMatch && request.method === 'POST') {
    if (!readFishKey(request, env)) {
      return jsonResponse(
        request,
        {
          error:
            'Fish Audio API key is not configured. Add your personal API key in Settings -> Fish Audio API Settings.',
        },
        401
      );
    }
    return jsonResponse(request, { workerEdgeMode: true });
  }

  if (
    /^\/api\/projects\/[^/]+\/dubbing\/(resync|regenerate-segments)$/.test(path) &&
    request.method === 'POST'
  ) {
    return jsonResponse(
      request,
      {
        error:
          'This audio clips timeline lives in your browser IndexedDB storage. Re-run synchronization or clip regeneration directly in the studio.',
      },
      400
    );
  }

  if (
    /^\/api\/projects\/[^/]+\/(transcribe|voice\/preview|voice\/generate|voice\/auto-dub)$/.test(
      path
    )
  ) {
    return jsonResponse(
      request,
      {
        error:
          'Legacy server-disk voice route is disabled on Cloudflare Pages. Use Fish Audio ASR (/api/fish/asr) and Fish Audio TTS (/api/fish-audio) instead.',
      },
      400
    );
  }

  const translateMatch = path.match(/^\/api\/projects\/([^/]+)\/translate$/);
  if (translateMatch && request.method === 'POST') {
    return handleGeminiTranslate(request, env, translateMatch[1]);
  }

  if (/^\/api\/jobs\/[^/]+$/.test(path)) {
    return jsonResponse(
      request,
      {
        error:
          'Browser-local dubbing or render job is no longer running (page was reloaded or job expired).',
      },
      404
    );
  }

  return jsonResponse(
    request,
    { error: `Endpoint not found on Cloudflare Pages Functions: ${request.method} ${path}` },
    404
  );
}

export const onRequest = async (context: {
  request: Request;
  env: PagesEnv;
  params: { catchall?: string[] };
}): Promise<Response> => {
  const { request, env } = context;
  const backendBase = (
    env.BACKEND_URL ||
    env.VITE_API_BASE_URL ||
    env.API_URL ||
    ''
  ).replace(/\/+$/, '');

  if (!backendBase) {
    return handlePagesApiRequest(request, env);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  const url = new URL(request.url);
  const targetUrl = `${backendBase}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host');
  forwardHeaders.set('x-forwarded-host', url.host);
  forwardHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    });

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('Vary', 'Origin');
    responseHeaders.set('Access-Control-Allow-Origin', request.headers.get('Origin') || '*');
    responseHeaders.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'
    );
    responseHeaders.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Accept-Ranges, Content-Disposition'
    );

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: `Failed to proxy request to backend at ${backendBase}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        code: 'UPSTREAM_PROXY_ERROR',
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
};
