/**
 * Cloudflare Pages Function: POST /api/fish-audio
 *
 * Accepts POST requests only from the same origin over HTTPS.
 * Reads the user's personal Fish Audio API key strictly from the
 * Authorization: Bearer <token> header (without persisting or logging it)
 * and forwards either connection verification or TTS synthesis to Fish Audio.
 */

const DEFAULT_FISH_API_BASE = 'https://api.fish.audio';
const DEFAULT_FISH_MODEL = 's2.1-pro-free';
const VALID_FORMATS = new Set(['mp3', 'wav', 'pcm', 'opus']);
const PLACEHOLDER_KEYS = new Set([
  'your_key_here',
  'my_fish_api_key',
  'my_fish_audio_api_key',
]);

const TEST_TIMEOUT_MS = 15000;
const TTS_TIMEOUT_MS = 45000;

const CONTENT_TYPE_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  opus: 'audio/ogg',
};

const SENSITIVE_QUERY_PARAMS = [
  'api_key',
  'apikey',
  'key',
  'token',
  'secret',
  'authorization',
  'auth',
];

function buildSameOriginHeaders(requestUrl) {
  return {
    Vary: 'Origin',
    'Access-Control-Allow-Origin': requestUrl.origin,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Type, Content-Disposition, Retry-After',
    'Cache-Control': 'no-store',
  };
}

function jsonResponse(requestUrl, payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...buildSameOriginHeaders(requestUrl),
      ...extraHeaders,
    },
  });
}

function sanitizeMessage(message, secretToRedact) {
  let clean = String(message || 'Fish Audio request failed.');
  if (secretToRedact && secretToRedact.length >= 4) {
    clean = clean.split(secretToRedact).join('[redacted]');
  }
  return clean.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

function isLocalHostname(hostname) {
  const h = (hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

function validateHttpsAndOrigin(request, requestUrl) {
  const forwardedProto = (request.headers.get('x-forwarded-proto') || '').toLowerCase();
  const isHttps = requestUrl.protocol === 'https:' || forwardedProto === 'https';

  if (!isHttps && !isLocalHostname(requestUrl.hostname)) {
    return {
      ok: false,
      status: 403,
      error: 'HTTPS is required for Fish Audio API requests.',
    };
  }

  for (const key of requestUrl.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAMS.includes(key.toLowerCase())) {
      return {
        ok: false,
        status: 400,
        error: 'API keys must never be sent in URL query parameters.',
      };
    }
  }

  const secFetchSite = (request.headers.get('Sec-Fetch-Site') || '').toLowerCase();
  if (secFetchSite === 'cross-site') {
    return {
      ok: false,
      status: 403,
      error: 'Cross-site requests are not permitted.',
    };
  }

  const originHeader = request.headers.get('Origin');
  if (originHeader && originHeader !== requestUrl.origin) {
    return {
      ok: false,
      status: 403,
      error: 'Cross-origin requests are not permitted.',
    };
  }

  if (!originHeader) {
    const refererHeader = request.headers.get('Referer');
    if (refererHeader) {
      try {
        if (new URL(refererHeader).origin !== requestUrl.origin) {
          return {
            ok: false,
            status: 403,
            error: 'Cross-origin referer is not permitted.',
          };
        }
      } catch {
        return {
          ok: false,
          status: 403,
          error: 'Invalid referer header.',
        };
      }
    }
  }

  return { ok: true };
}

function readPersonalKeyFromAuthorization(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return '';
  }
  const token = match[1].trim();
  if (!token || /[\r\n\s]/.test(token) || PLACEHOLDER_KEYS.has(token.toLowerCase())) {
    return '';
  }
  return token;
}

function parseUpstreamError(rawText, status, secretToRedact) {
  if (status === 401 || status === 403) {
    return 'Invalid Fish Audio API key or unauthorized access.';
  }
  if (status === 402) {
    return 'Fish Audio account balance is insufficient.';
  }
  if (status === 429) {
    return 'Fish Audio rate limit exceeded. Please wait a moment and try again.';
  }

  let message = status >= 500
    ? `Fish Audio server error (${status}). Please try again.`
    : `Fish Audio API error (${status}).`;

  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === 'object') {
      const detail = parsed.message || parsed.detail || parsed.error;
      if (typeof detail === 'string' && detail.trim()) {
        message = detail.trim();
      }
    }
  } catch {
    const trimmed = (rawText || '').trim();
    const looksHtml = /^<!doctype/i.test(trimmed) || /^<html/i.test(trimmed) || /<\/html>/i.test(trimmed);
    if (trimmed && !looksHtml && status < 500) {
      message = `${message} ${trimmed.slice(0, 180)}`;
    }
  }

  return sanitizeMessage(message, secretToRedact);
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleConnectionTest(requestUrl, fishApiBase, apiKey) {
  let upstream;
  try {
    upstream = await fetchWithTimeout(
      `${fishApiBase}/v1/tts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model: DEFAULT_FISH_MODEL,
        },
        body: JSON.stringify({
          text: 'Connection test',
          format: 'mp3',
        }),
      },
      TEST_TIMEOUT_MS
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: isTimeout
          ? 'Connection to Fish Audio API timed out.'
          : 'Unable to connect to Fish Audio API.',
      },
      isTimeout ? 504 : 502
    );
  }

  if (upstream.status === 401 || upstream.status === 403) {
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'invalid_key',
        error: 'Invalid Fish Audio API key or unauthorized access.',
      },
      401
    );
  }

  if (upstream.status === 402) {
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: 'Fish Audio account balance or credits are insufficient.',
      },
      402
    );
  }

  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get('retry-after');
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: 'Fish Audio API rate limit exceeded. Please wait and try again.',
      },
      429,
      retryAfter ? { 'Retry-After': retryAfter } : {}
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: parseUpstreamError(errText, upstream.status, apiKey),
      },
      upstream.status >= 500 ? 502 : upstream.status
    );
  }

  const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/html')) {
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: 'Unexpected HTML response from Fish Audio API endpoint.',
      },
      502
    );
  }

  const responseBytes = await upstream.arrayBuffer().catch(() => new ArrayBuffer(0));
  if (responseBytes.byteLength === 0) {
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'connection_error',
        error: 'Fish Audio API returned an empty response.',
      },
      502
    );
  }

  return jsonResponse(requestUrl, {
    ok: true,
    status: 'connected',
    message: 'Connected to Fish Audio API.',
  });
}

async function handlePostRequest(context) {
  const { request, env } = context;
  const requestUrl = new URL(request.url);

  const security = validateHttpsAndOrigin(request, requestUrl);
  if (!security.ok) {
    return jsonResponse(requestUrl, { error: security.error }, security.status);
  }

  const personalKey = readPersonalKeyFromAuthorization(request);
  const fallbackEnvKey =
    typeof env?.FISH_AUDIO_API_KEY === 'string' &&
    !PLACEHOLDER_KEYS.has(env.FISH_AUDIO_API_KEY.trim().toLowerCase())
      ? env.FISH_AUDIO_API_KEY.trim()
      : '';
  const apiKey = personalKey || fallbackEnvKey;

  if (!apiKey) {
    return jsonResponse(
      requestUrl,
      {
        ok: false,
        status: 'not_configured',
        error:
          'Fish Audio API key is missing. Add your personal API key in Settings -> Fish Audio API Settings.',
      },
      401
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(requestUrl, { error: 'Invalid JSON request body.' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return jsonResponse(requestUrl, { error: 'Request body must be a JSON object.' }, 400);
  }

  const fishApiBase = (
    typeof env?.FISH_API_BASE_URL === 'string' && env.FISH_API_BASE_URL.trim()
      ? env.FISH_API_BASE_URL.trim()
      : DEFAULT_FISH_API_BASE
  ).replace(/\/+$/, '');

  if (body.action === 'test') {
    return handleConnectionTest(requestUrl, fishApiBase, apiKey);
  }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return jsonResponse(requestUrl, { error: 'text is required for Fish Audio generation.' }, 400);
  }

  const requestedFormat =
    typeof body.format === 'string' ? body.format.trim().toLowerCase() : 'mp3';
  if (!VALID_FORMATS.has(requestedFormat)) {
    return jsonResponse(
      requestUrl,
      { error: `Unsupported output format "${requestedFormat}". Use mp3, wav, pcm, or opus.` },
      400
    );
  }

  const referenceIdRaw =
    body.reference_id ?? body.referenceId ?? body.voiceId ?? body.voice_id ?? '';
  const referenceId = typeof referenceIdRaw === 'string' ? referenceIdRaw.trim() : '';

  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model.trim()
      : DEFAULT_FISH_MODEL;

  const chunkLengthNum = Number(body.chunk_length ?? body.chunkLength);
  const chunkLength = Number.isFinite(chunkLengthNum)
    ? Math.min(300, Math.max(100, Math.round(chunkLengthNum)))
    : 250;

  const latency =
    body.latency === 'normal' || body.latency === 'balanced' ? body.latency : 'balanced';

  const normalize = typeof body.normalize === 'boolean' ? body.normalize : true;

  const speedInput = body.prosody?.speed ?? body.speakingSpeed ?? body.speed ?? 1.0;
  const speedNum = Number(speedInput);
  const speed = Number.isFinite(speedNum) ? Math.min(2.0, Math.max(0.5, speedNum)) : 1.0;

  const volumeInput = body.prosody?.volume ?? body.volume ?? 0.0;
  const volumeNum = Number(volumeInput);
  const volume = Number.isFinite(volumeNum) ? Math.min(20.0, Math.max(-20.0, volumeNum)) : 0.0;

  const fishPayload = {
    text,
    format: requestedFormat,
    normalize,
    latency,
    chunk_length: chunkLength,
    prosody: {
      speed,
      volume,
    },
  };

  if (referenceId) {
    fishPayload.reference_id = referenceId;
  }
  if (Array.isArray(body.references) && body.references.length > 0) {
    fishPayload.references = body.references;
  }

  const mp3Bitrate = Number(body.mp3_bitrate ?? body.mp3Bitrate);
  if (requestedFormat === 'mp3' && [64, 128, 192].includes(mp3Bitrate)) {
    fishPayload.mp3_bitrate = mp3Bitrate;
  }

  const opusBitrate = Number(body.opus_bitrate ?? body.opusBitrate);
  if (requestedFormat === 'opus' && [-1000, 24, 32, 48, 64].includes(opusBitrate)) {
    fishPayload.opus_bitrate = opusBitrate;
  }

  const sampleRate = Number(body.sample_rate ?? body.sampleRate);
  if (Number.isFinite(sampleRate) && sampleRate >= 8000 && sampleRate <= 48000) {
    fishPayload.sample_rate = Math.round(sampleRate);
  }

  const temperature = Number(body.temperature);
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 1) {
    fishPayload.temperature = temperature;
  }

  const topP = Number(body.top_p ?? body.topP);
  if (Number.isFinite(topP) && topP > 0 && topP <= 1) {
    fishPayload.top_p = topP;
  }

  let upstream;
  try {
    upstream = await fetchWithTimeout(
      `${fishApiBase}/v1/tts`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          model,
        },
        body: JSON.stringify(fishPayload),
      },
      TTS_TIMEOUT_MS
    );
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    return jsonResponse(
      requestUrl,
      {
        error: isTimeout
          ? 'Fish Audio API request timed out. Please try again.'
          : 'Unable to connect to Fish Audio API.',
      },
      isTimeout ? 504 : 502
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    const status =
      upstream.status === 401 || upstream.status === 403
        ? 401
        : upstream.status === 429
        ? 429
        : upstream.status >= 400 && upstream.status < 500
        ? upstream.status
        : 502;
    const retryAfter = upstream.headers.get('retry-after');
    return jsonResponse(
      requestUrl,
      { error: parseUpstreamError(errText, upstream.status, apiKey) },
      status,
      retryAfter ? { 'Retry-After': retryAfter } : {}
    );
  }

  const audioBytes = await upstream.arrayBuffer();
  if (audioBytes.byteLength < 128) {
    return jsonResponse(
      requestUrl,
      { error: 'Fish Audio API returned an empty audio stream.' },
      502
    );
  }

  return new Response(audioBytes, {
    status: 200,
    headers: {
      'Content-Type': CONTENT_TYPE_BY_FORMAT[requestedFormat] || 'audio/mpeg',
      'Content-Length': String(audioBytes.byteLength),
      ...buildSameOriginHeaders(requestUrl),
    },
  });
}

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  try {
    if (context.request.method.toUpperCase() === 'POST') {
      return await handlePostRequest(context);
    }
    return jsonResponse(
      requestUrl,
      { error: 'Method Not Allowed. Only POST requests are accepted at /api/fish-audio.' },
      405,
      { Allow: 'POST' }
    );
  } catch (err) {
    return jsonResponse(
      requestUrl,
      {
        error: sanitizeMessage(
          err instanceof Error ? err.message : 'Unexpected Fish Audio proxy error.'
        ),
      },
      500
    );
  }
}
