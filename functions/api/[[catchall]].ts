/**
 * Cloudflare Pages Function: Proxy /api/* requests to the Node.js Express backend.
 *
 * Cloudflare Pages only hosts static frontend files. The Express + Multer + SQLite + FFmpeg
 * backend must run in a Node.js environment (e.g., Google Cloud Run, Railway, Render, Fly.io, or VPS).
 *
 * Configure BACKEND_URL (or VITE_API_BASE_URL) in your Cloudflare Pages dashboard under
 * Settings -> Environment Variables.
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

  // Handle CORS preflight directly at Cloudflare Edge
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': request.headers.get('Origin') || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
        'Access-Control-Allow-Headers':
          'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range',
        'Access-Control-Expose-Headers':
          'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // If no backend is configured, return an actionable JSON response instead of a static 405 error
  if (!backendBase) {
    return new Response(
      JSON.stringify({
        error:
          'Backend server URL is not configured. Cloudflare Pages only hosts the static frontend and cannot run Express, Multer, SQLite, or FFmpeg natively. Please configure the "BACKEND_URL" environment variable in your Cloudflare Pages project settings with the URL of your deployed Node.js backend server (e.g., Cloud Run, Render, or Railway).',
        code: 'BACKEND_NOT_CONFIGURED',
        path: url.pathname,
        method: request.method,
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }

  // Forward the request (including streaming video upload chunks and multipart data) to Express
  const targetUrl = `${backendBase}${url.pathname}${url.search}`;
  const forwardHeaders = new Headers(request.headers);
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
