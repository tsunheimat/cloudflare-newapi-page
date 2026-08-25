import {
  createContentAdapter,
  CONTENT_ADAPTER_LIVE,
  createDocsNavigationAdapter,
  PUBLIC_DOCS_NAVIGATION_ROUTE,
} from './adapters/content-adapter.js';
import {
  discoverDownloadSoftware,
  downloadServiceStatus,
  forwardToDownloadService,
  isDownloadServiceRoute,
} from './adapters/download-service.js';
import {
  errorResponse,
  HttpError,
  json,
  withDownstreamSecurityHeaders,
  withSecurityHeaders,
} from './http.js';
import { createStatusAdapter } from './adapters/status.js';
import { createDocsHubAdapter } from './adapters/docs-hub.js';

const PHASE = '2';

export default {
  async fetch(request, env = {}) {
    try {
      return await route(request, env);
    } catch (error) {
      return errorResponse(error);
    }
  },
};

export async function route(request, env = {}) {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);

  if (request.method === 'GET' && pathname === '/api/health') {
    const content = await liveContentHealth(env);
    return json({
      status: content.mode === CONTENT_ADAPTER_LIVE && !content.healthy
        ? 'degraded'
        : 'ok',
      service: 'cloudflare-newapi-page',
      phase: PHASE,
      content_adapter: content.mode,
      content_adapter_selected: content.mode,
      content_adapter_configured: content.configured,
      live_newapi: content.healthy,
      live_newapi_healthy: content.healthy,
      downloads: downloadServiceStatus(env),
    });
  }

  if (request.method === 'GET' && pathname === '/api/integrations/downloads') {
    return json({ success: true, data: downloadServiceStatus(env) });
  }

  // Discovery stays bound to the downstream landing page. The browser then
  // reads each public aggregate through the existing mounted `/downloads/api`
  // routes; this endpoint never carries a service token or browser headers.
  if (request.method === 'GET' && pathname === '/api/downloads/catalog') {
    return json({
      success: true,
      data: { software: await discoverDownloadSoftware(request, env) },
    }, 200, { 'cache-control': 'no-store' });
  }

  // Canonical NewAPI status is a public read-only bootstrap. The adapter
  // reconstructs a fixed token-authenticated request and never forwards
  // browser credentials or arbitrary headers to the private service binding.
  if (request.method === 'GET' && pathname === '/api/status') {
    const adapter = createStatusAdapter(env);
    const result = await adapter.getResponse();
    if (!result || result.status !== 200) {
      throw new HttpError(503, 'Status is temporarily unavailable.');
    }
    return json(result.payload, 200, { 'cache-control': 'no-store' });
  }

  // The compatibility URL is public, but navigation is fetched through the
  // Worker-held service token. Browser cookies, identity, and credentials are
  // intentionally irrelevant to this route.
  if (
    request.method === 'GET' &&
    pathname === PUBLIC_DOCS_NAVIGATION_ROUTE
  ) {
    const adapter = createDocsNavigationAdapter(env);
    return publicContentResponse(
      await adapter.getDocsNavigationResponse({
        ifNoneMatch: conditionalValidator(request),
      }),
      (payload) => payload,
    );
  }

  if (request.method === 'GET' && pathname.startsWith('/api/docs/v2/')) {
    return handleDocsHubRoute(request, env, url, pathname);
  }


  if (request.method === 'GET' && pathname === '/api/content/docs') {
    const adapter = createContentAdapter(env);
    return publicContentResponse(
      await adapter.getDocsCatalogResponse({
        ifNoneMatch: conditionalValidator(request),
      }),
      (payload) => ({ success: true, data: payload }),
    );
  }

  if (request.method === 'GET' && pathname.startsWith('/api/content/docs/')) {
    const slug = decodeDocSlug(pathname.slice('/api/content/docs/'.length));
    const adapter = createContentAdapter(env);
    return publicContentResponse(
      await adapter.getDocPageResponse(slug, {
        ifNoneMatch: conditionalValidator(request),
      }),
      (payload) => ({ success: true, data: payload }),
    );
  }

  if (request.method === 'GET' && pathname === '/api/content/pricing') {
    const adapter = createContentAdapter(env);
    return publicContentResponse(
      await adapter.getPricingResponse({
        ifNoneMatch: conditionalValidator(request),
      }),
      (payload) => payload,
    );
  }

  // Canonical NewAPI Pricing path. The live adapter consumes the dedicated
  // token endpoint, which delegates to `/api/pricing`; its response body is
  // passed through without Worker-side sorting, filtering, or reconstruction.
  if (request.method === 'GET' && pathname === '/api/pricing') {
    const adapter = createContentAdapter(env);
    return publicContentResponse(
      await adapter.getPricingResponse({
        ifNoneMatch: conditionalValidator(request),
      }),
      (payload) => payload,
    );
  }


  if (pathname.startsWith('/api/content/')) {
    throw new HttpError(404, 'Content API route not found.');
  }

  if (
    request.method === 'GET' &&
    isDownloadsSpaRoute(pathname)
  ) {
    if (!env.ASSETS?.fetch) {
      throw new HttpError(503, 'Static asset binding is not configured.');
    }
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }

  if (isDownloadServiceRoute(pathname)) {
    return withDownstreamSecurityHeaders(
      await forwardToDownloadService(request, env),
    );
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    throw new HttpError(404, 'API route not found.');
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    throw new HttpError(405, 'Method not allowed.');
  }

  if (!env.ASSETS?.fetch) {
    throw new HttpError(503, 'Static asset binding is not configured.');
  }

  return withSecurityHeaders(await env.ASSETS.fetch(request));
}

async function liveContentHealth(env) {
  const mode = String(env.CONTENT_ADAPTER || 'fixture').trim().toLowerCase();
  if (mode !== CONTENT_ADAPTER_LIVE) {
    return { mode, configured: mode === 'fixture', healthy: false };
  }
  try {
    const adapter = createContentAdapter(env);
    const healthy = await adapter.checkHealth();
    return { mode, configured: true, healthy: healthy === true };
  } catch {
    return { mode, configured: false, healthy: false };
  }
}

function publicContentResponse(result, envelope) {
  if (result?.status === 304) {
    const headers = new Headers({ 'cache-control': 'no-cache' });
    if (result.etag) headers.set('etag', result.etag);
    return withSecurityHeaders(new Response(null, { status: 304, headers }));
  }
  if (!result || result.status !== 200) {
    if (result?.status === 404) {
      return json(result.payload || { success: false, message: 'Not found.' }, 404, {
        'cache-control': 'no-store',
      });
    }
    throw new HttpError(503, 'Live content is temporarily unavailable.');
  }
  const headers = { 'cache-control': 'no-cache' };
  if (result.etag) headers.etag = result.etag;
  if (typeof result.body === 'string' || result.body instanceof Uint8Array) {
    headers['content-type'] = 'application/json; charset=utf-8';
    return withSecurityHeaders(new Response(result.body, { status: 200, headers }));
  }
  return json(envelope(result.payload), 200, headers);
}

async function handleDocsHubRoute(request, env, url, pathname) {
  const adapter = createDocsHubAdapter(env);
  const ifNoneMatch = conditionalValidator(request);
  const assetMatch = pathname.match(/^\/api\/docs\/v2\/assets\/([1-9][0-9]{0,10})$/);
  if (assetMatch) {
    const result = await adapter.getAssetResponse(assetMatch[1], { ifNoneMatch });
    if (result?.status === 304) {
      const headers = new Headers({ 'cache-control': 'private, max-age=3600' });
      if (result.etag) headers.set('etag', result.etag);
      return withSecurityHeaders(new Response(null, { status: 304, headers }));
    }
    if (!result || ![200, 404].includes(result.status)) throw new HttpError(503, 'Live content is temporarily unavailable.');
    if (result.status === 404) return json({ success: false, message: 'asset not found' }, 404);
    const headers = new Headers({
      'cache-control': 'private, max-age=3600',
      'content-type': result.contentType || 'application/octet-stream',
    });
    if (result.etag) headers.set('etag', result.etag);
    if (result.disposition) headers.set('content-disposition', result.disposition);
    return withSecurityHeaders(new Response(result.body, { status: 200, headers }));
  }
  const supported = [
    'config', 'spaces', 'tree', 'navigation', 'search', 'featured', 'recent',
    'redirect',
  ];
  const isPage = pathname.includes('/pages/');
  if (!supported.some((name) => pathname.endsWith(`/api/docs/v2/${name}`)) && !isPage) {
    throw new HttpError(404, 'DocsHub route not found.');
  }
  const upstreamPath = buildDocsHubUpstreamPath(pathname, url);
  return publicContentResponse(
    await adapter.getResponse(upstreamPath, { ifNoneMatch }),
    (payload) => payload,
  );
}

function buildDocsHubUpstreamPath(pathname, url) {
  const relative = pathname.slice('/api/docs/v2'.length);
  const query = new URLSearchParams();
  const add = (name, { max = 300, pattern = null, required = false } = {}) => {
    const value = url.searchParams.get(name);
    if (value === null || value === '') {
      if (required) throw new HttpError(400, `Invalid DocsHub parameter: ${name}.`);
      return;
    }
    if (value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (pattern && !pattern.test(value))) {
      throw new HttpError(400, `Invalid DocsHub parameter: ${name}.`);
    }
    query.set(name, value);
  };
  if (relative === '/config') return '/api/internal/live-content/v1/docs/v2/config';
  if (relative === '/spaces') {
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
  } else if (relative === '/tree' || relative === '/navigation') {
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
    add('space', { max: 120, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
  } else if (relative === '/search') {
    add('q', { max: 500, required: true });
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
    add('space', { max: 120, pattern: /^[a-z0-9][a-z0-9._-]*$/i });
  } else if (relative === '/featured') {
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
  } else if (relative === '/recent') {
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
    add('limit', { max: 3, pattern: /^[1-9][0-9]?$/ });
  } else if (relative === '/redirect') {
    add('path', { max: 500, required: true, pattern: /^\/[a-z0-9._/-]+$/i });
  } else if (relative.startsWith('/pages/by-id/')) {
    if (!/^\/pages\/by-id\/[1-9][0-9]{0,10}$/.test(relative)) throw new HttpError(400, 'Invalid DocsHub page id.');
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
  } else if (relative.startsWith('/pages/')) {
    if (!/^\/pages\/[a-z0-9][a-z0-9._-]{0,199}$/i.test(relative)) throw new HttpError(400, 'Invalid DocsHub page slug.');
    add('space', { max: 120, pattern: /^[a-z0-9][a-z0-9._-]*$/i, required: true });
    add('locale', { max: 16, pattern: /^[a-z-]+$/i });
    add('path', { max: 500, pattern: /^[a-z0-9._/-]+$/i, required: true });
  } else {
    throw new HttpError(404, 'DocsHub route not found.');
  }
  const encoded = query.toString();
  return `/api/internal/live-content/v1/docs/v2${relative}${encoded ? `?${encoded}` : ''}`;
}

function conditionalValidator(request) {
  const value = request.headers.get('if-none-match');
  if (!value || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function isDownloadsSpaRoute(pathname) {
  return pathname === '/downloads'
    || /^\/downloads\/software\/[a-z0-9][a-z0-9-]{0,62}$/.test(pathname);
}

function decodeDocSlug(rawSlug) {
  let slug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    throw new HttpError(400, 'Invalid document slug.');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug)) {
    throw new HttpError(400, 'Invalid document slug.');
  }
  return slug;
}
