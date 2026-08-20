import { HttpError } from '../http.js';

const DIRECT_ROUTE_PREFIXES = [
  '/admin',
  '/assets',
  '/download',
  '/software',
  '/wechat-group-qrcode',
];

const DOWNLOAD_API_PREFIXES = [
  '/api/latest',
  '/api/public',
  '/api/previous',
  '/api/wechat-group-qrcode',
];

export function isDownloadServiceRoute(pathname) {
  if (pathname === '/downloads' || pathname.startsWith('/downloads/')) {
    return true;
  }
  if (
    DIRECT_ROUTE_PREFIXES.some((prefix) =>
      hasSegmentPrefix(pathname, prefix),
    )
  ) {
    return true;
  }
  return (
    DOWNLOAD_API_PREFIXES.some((prefix) => hasSegmentPrefix(pathname, prefix)) ||
    /^\/api\/[a-z0-9][a-z0-9-]{0,62}\/(?:latest|public|previous)(?:\/|$)/.test(
      pathname,
    )
  );
}

export function downloadServiceStatus(env = {}) {
  const configured = Object.prototype.hasOwnProperty.call(
    env,
    'DOWNLOADS_SERVICE',
  );
  const bound = typeof env.DOWNLOADS_SERVICE?.fetch === 'function';
  return {
    configured,
    bound,
    healthy: null,
    transport: 'cloudflare-service-binding',
    live: false,
    phase: bound
      ? 'bound-unverified'
      : configured
        ? 'invalid-binding'
        : 'reserved',
    capabilities: [
      'downloads',
      'admin',
      'r2',
      'rollback',
      'wechat_qr',
    ],
  };
}

export async function forwardToDownloadService(request, env = {}) {
  if (typeof env.DOWNLOADS_SERVICE?.fetch !== 'function') {
    throw new HttpError(
      503,
      'Download service binding is not configured in phase 1.',
      downloadServiceStatus(env),
    );
  }

  const incomingUrl = new URL(request.url);
  const downstreamUrl = new URL(request.url);
  downstreamUrl.pathname = mapDownloadPath(incomingUrl.pathname);

  const downstreamRequest = new Request(downstreamUrl, request);
  downstreamRequest.headers.set('x-forwarded-prefix', '/downloads');
  const response = await env.DOWNLOADS_SERVICE.fetch(downstreamRequest);
  return rewriteDownloadLocation(response, incomingUrl.origin);
}

function hasSegmentPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function mapDownloadPath(pathname) {
  if (pathname === '/downloads') return '/';
  if (pathname.startsWith('/downloads/')) {
    return pathname.slice('/downloads'.length) || '/';
  }
  return pathname;
}

function rewriteDownloadLocation(response, incomingOrigin) {
  const location = response.headers.get('location');
  if (!location) return response;

  let parsed;
  try {
    parsed = new URL(location, incomingOrigin);
  } catch {
    return response;
  }

  if (parsed.origin !== incomingOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set('location', `${parsed.pathname}${parsed.search}${parsed.hash}`);
  return new Response(response.body, { status: response.status, headers });
}
