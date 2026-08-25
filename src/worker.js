import {
  createContentAdapter,
  CONTENT_ADAPTER_LIVE,
  createDocsNavigationAdapter,
  PUBLIC_DOCS_NAVIGATION_ROUTE,
} from './adapters/content-adapter.js';
import {
  downloadsAuthorityStatus,
  hasDownloadsBinding,
  isProductionR2BindingMode,
  isDownloadsAuthorityRoute,
  routeDownloads,
} from './adapters/downloads.js';
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
const DOCS_CACHE_CONTROL = 'public, s-maxage=60, stale-while-revalidate=300';
const DOCS_CACHEABLE_METHODS = new Set(['GET', 'HEAD']);

export default {
  async fetch(request, env = {}, ctx = undefined) {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      return errorResponse(error, request);
    }
  },
};

export async function route(request, env = {}, ctx = undefined) {
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
      downloads: downloadsStatus(env),
    });
  }

  if (request.method === 'GET' && pathname === '/api/integrations/downloads') {
    return json({ success: true, data: downloadsStatus(env) });
  }

  // Discovery is a small public registry projection. Release/state authority
  // remains in R2 and is fetched by the detail/API routes below.
  if (request.method === 'GET' && pathname === '/api/downloads/catalog') {
    if (isProductionR2BindingMode(env) && !hasDownloadsBinding(env)) {
      throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
    }
    if (!hasDownloadsBinding(env)) {
      return json({
        success: true,
        data: { software: await discoverDownloadSoftware(request, env) },
      }, 200, { 'cache-control': 'no-store' });
    }
    return json({
      success: true,
      data: { software: downloadCatalog() },
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
    DOCS_CACHEABLE_METHODS.has(request.method) &&
    pathname === PUBLIC_DOCS_NAVIGATION_ROUTE
  ) {
    const adapter = createDocsNavigationAdapter(env);
    return handleCachedDocsResponse(
      request,
      env,
      ctx,
      docsCacheKey(request, pathname, docsNavigationCacheSearch(url)),
      async () => publicContentResponse(
        await adapter.getDocsNavigationResponse({
          ifNoneMatch: conditionalValidator(request),
        }),
        (payload) => payload,
      ),
    );
  }

  if (DOCS_CACHEABLE_METHODS.has(request.method) && pathname.startsWith('/api/docs/v2/')) {
    return handleDocsHubRoute(request, env, url, pathname, ctx);
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

  if (isProductionR2BindingMode(env) && isDownloadsAuthorityRoute(pathname) && !hasDownloadsBinding(env)) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }

  if (request.method === 'GET' && isDownloadsSpaRoute(pathname) && !hasDownloadsBinding(env)) {
    if (!env.ASSETS?.fetch) throw new HttpError(503, 'Static asset binding is not configured.');
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  }

  if (isDownloadsAuthorityRoute(pathname) && hasDownloadsBinding(env)) {
    return withDownstreamSecurityHeaders(
      await routeDownloads(request, env, pathname),
    );
  }

  // The old service binding remains an explicit rollback path. It is never
  // consulted when the migrated R2 binding is present.
  if (isDownloadServiceRoute(pathname)) {
    return withDownstreamSecurityHeaders(await forwardToDownloadService(request, env));
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

function downloadsStatus(env) {
  return isProductionR2BindingMode(env) || hasDownloadsBinding(env)
    ? downloadsAuthorityStatus(env)
    : downloadServiceStatus(env);
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

async function handleDocsHubRoute(request, env, url, pathname, ctx = undefined) {
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
    if (result.status === 404) return headResponseIfNeeded(request, json({ success: false, message: 'asset not found' }, 404));
    const headers = new Headers({
      'cache-control': 'private, max-age=3600',
      'content-type': result.contentType || 'application/octet-stream',
    });
    if (result.etag) headers.set('etag', result.etag);
    if (result.disposition) headers.set('content-disposition', result.disposition);
    return headResponseIfNeeded(request, withSecurityHeaders(new Response(result.body, { status: 200, headers })));
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
  return handleCachedDocsResponse(
    request,
    env,
    ctx,
    docsCacheKey(request, pathname, new URL(upstreamPath, 'https://worker.invalid').search),
    async () => publicContentResponse(
      await adapter.getResponse(upstreamPath, { ifNoneMatch }),
      (payload) => payload,
    ),
  );
}

/**
 * Cache only the Worker-produced, schema-validated public Docs JSON. The
 * cache key is URL-only (never request headers), so browser cookies, API
 * keys, and the Worker-held VPC token can never partition or populate it.
 * Cache errors are disposable: an unavailable cache falls through to the
 * origin and never changes the fail-closed upstream behavior.
 */
async function handleCachedDocsResponse(request, env, ctx, cacheKey, produce) {
  const cache = docsCache(env);
  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached?.status === 200 && isPublicDocsJson(cached)) {
        return docsCachedResponse(request, cached);
      }
    } catch {
      // Cache API is an optimization only. Continue to the authoritative VPC
      // adapter when a platform/cache implementation is unavailable.
    }
  }

  const response = markDocsCacheable(await produce());
  if (cache && response.status === 200 && isPublicDocsJson(response)) {
    const cacheCopy = response.clone();
    const write = Promise.resolve().then(() => cache.put(cacheKey, cacheCopy)).catch(() => {});
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }
  return headResponseIfNeeded(request, response);
}

function docsCache(env) {
  if (env?.DOCS_CACHE && typeof env.DOCS_CACHE.match === 'function' && typeof env.DOCS_CACHE.put === 'function') {
    return env.DOCS_CACHE;
  }
  const cache = globalThis.caches?.default;
  return cache && typeof cache.match === 'function' && typeof cache.put === 'function'
    ? cache
    : null;
}

function docsCacheKey(request, pathname = new URL(request.url).pathname, search = new URL(request.url).search) {
  // A GET key is shared by GET and HEAD. Use only the route's validated,
  // semantically relevant query (rather than arbitrary query material that
  // could contain a browser secret), while retaining every safe dimension.
  const keyUrl = new URL(request.url);
  keyUrl.username = '';
  keyUrl.password = '';
  keyUrl.hash = '';
  keyUrl.pathname = pathname;
  keyUrl.search = search;
  return new Request(keyUrl.toString(), { method: 'GET' });
}

function docsNavigationCacheSearch(url) {
  const query = new URLSearchParams();
  const locale = url.searchParams.get('locale');
  // The compatibility adapter intentionally fixes the upstream locale to zh.
  // Retain a valid public locale in the key when callers provide one, but do
  // not turn its historical ignore-unknown-query behavior into a new error.
  if (locale !== null && locale.length <= 16 && /^[a-z-]+$/i.test(locale)) {
    query.set('locale', locale);
  }
  return query.toString() ? `?${query}` : '';
}

function markDocsCacheable(response) {
  if (!response || ![200, 304].includes(response.status)) return response;
  const headers = new Headers(response.headers);
  headers.set('cache-control', DOCS_CACHE_CONTROL);
  return withSecurityHeaders(new Response(response.body, { status: response.status, headers }));
}

function isPublicDocsJson(response) {
  const cacheControl = response?.headers?.get('cache-control') || '';
  return response?.status === 200
    && /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')
    && /(?:^|,)\s*public\b/i.test(cacheControl)
    && !/(?:^|,)\s*(?:private|no-store)\b/i.test(cacheControl)
    && response.headers.get('set-cookie') === null
    && response.headers.get('vary') !== '*';
}

function docsCachedResponse(request, cached) {
  const etag = cached.headers.get('etag');
  const validator = conditionalValidator(request);
  if (etag && entityTagMatches(validator, etag)) {
    const headers = new Headers({
      'cache-control': DOCS_CACHE_CONTROL,
      etag,
    });
    return withSecurityHeaders(new Response(null, { status: 304, headers }));
  }
  return headResponseIfNeeded(request, withSecurityHeaders(cached.clone()));
}

function headResponseIfNeeded(request, response) {
  if (request.method !== 'HEAD' || !response || response.status === 304) return response;
  return new Response(null, { status: response.status, headers: response.headers });
}

function entityTagMatches(value, current) {
  if (typeof value !== 'string' || !current) return false;
  const fieldValue = value.trim();
  if (fieldValue === '*') return true;
  return parseEntityTagList(fieldValue).some((candidate) => (
    verifiedEntityTag(candidate) && candidate.replace(/^W\//, '') === current.replace(/^W\//, '')
  ));
}

function parseEntityTagList(value) {
  const candidates = [];
  let start = 0;
  let inOpaqueTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') inOpaqueTag = !inOpaqueTag;
    else if (character === ',' && !inOpaqueTag) {
      candidates.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  candidates.push(value.slice(start).trim());
  return candidates;
}

function verifiedEntityTag(value) {
  return /^(?:W\/)?"(?:[\x21\x23-\x7e\x80-\xff])*"$/.test(value);
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

function downloadCatalog() {
  return [
    { id: 'codex-chat-record-migrator', label: 'Codex 聊天记录迁移器', href: '/downloads/software/codex-chat-record-migrator' },
    { id: 'codex-installer', label: 'Codex 安装器', href: '/downloads/software/codex-installer' },
  ];
}

function isDownloadsSpaRoute(pathname) {
  return /^\/downloads\/software\/[a-z0-9][a-z0-9-]{0,62}$/.test(pathname);
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
