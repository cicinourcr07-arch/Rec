/**
 * Cloudflare Pages Function fallback for /api/* requests.
 * If BACKEND_URL is not configured, executes the built-in Edge Worker handler
 * (including /api/fish-audio using env.FISH_AUDIO_API_KEY) directly.
 */

import { Env, handleApiRequest } from '../../worker/index.ts';

interface PagesEnv extends Env {
  BACKEND_URL?: string;
  VITE_API_BASE_URL?: string;
  API_URL?: string;
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
    return handleApiRequest(request, env);
  }

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
