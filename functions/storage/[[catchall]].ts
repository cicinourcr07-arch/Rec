/**
 * Cloudflare Pages Function: Proxy /storage/* requests to the Node.js Express backend.
 */

interface Env {
  BACKEND_URL?: string;
  VITE_API_BASE_URL?: string;
  API_URL?: string;
}

export const onRequest = async (context: {
  request: Request;
  env: Env;
  params: { catchall?: string[] };
}): Promise<Response> => {
  const { request, env } = context;
  const backendBase = (
    env.BACKEND_URL ||
    env.VITE_API_BASE_URL ||
    env.API_URL ||
    ''
  ).replace(/\/+$/, '');

  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Authorization',
      },
    });
  }

  if (!backendBase) {
    return new Response('Storage backend not configured', { status: 503 });
  }

  const targetUrl = `${backendBase}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.set('x-forwarded-host', url.host);

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      redirect: 'follow',
    });

    const headers = new Headers(upstream.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition');

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return new Response('Failed to proxy storage asset', { status: 502 });
  }
};
