import {
  createContentAdapter,
  CONTENT_ADAPTER_LIVE,
  createFrontDoorSessionAdapter,
  LOCKED_PRICING_CONTEXT,
} from './adapters/content-adapter.js';
import {
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
      pricing_context: LOCKED_PRICING_CONTEXT,
      live_newapi: content.healthy,
      live_newapi_healthy: content.healthy,
      downloads: downloadServiceStatus(env),
    });
  }

  if (request.method === 'GET' && pathname === '/api/integrations/downloads') {
    return json({ success: true, data: downloadServiceStatus(env) });
  }

  // Canonical NewAPI status is a public read-only bootstrap. The adapter
  // reconstructs a fixed request and never forwards browser credentials or
  // arbitrary headers to the private service binding.
  if (request.method === 'GET' && pathname === '/api/status') {
    const adapter = createStatusAdapter(env);
    const result = await adapter.getResponse();
    if (!result || result.status !== 200) {
      throw new HttpError(503, 'Status is temporarily unavailable.');
    }
    return json(result.payload, 200, { 'cache-control': 'no-store' });
  }

  // The normal-user clone is a separate browser-session boundary.  It is
  // intentionally not implemented by the internal service-token adapter:
  // NewAPI must evaluate the signed session, user identity, role, status,
  // usable groups, country filtering, and recursive Docs navigation itself.
  if (request.method === 'GET' && pathname === '/api/front-door/v1/pricing') {
    const adapter = createFrontDoorSessionAdapter(env, request);
    return frontDoorResponse(await adapter.getPricingResponse());
  }

  if (
    request.method === 'GET' &&
    pathname === '/api/front-door/v1/docs/v2/navigation'
  ) {
    const adapter = createFrontDoorSessionAdapter(env, request);
    return frontDoorResponse(await adapter.getDocsNavigationResponse());
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


  if (pathname.startsWith('/api/content/')) {
    throw new HttpError(404, 'Content API route not found.');
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
    throw new HttpError(503, 'Live content is temporarily unavailable.');
  }
  const headers = { 'cache-control': 'no-cache' };
  if (result.etag) headers.etag = result.etag;
  return json(envelope(result.payload), 200, headers);
}

function frontDoorResponse(result) {
  if (result?.status === 304) {
    const headers = new Headers({ 'cache-control': 'no-cache' });
    if (result.etag) headers.set('etag', result.etag);
    return withSecurityHeaders(new Response(null, { status: 304, headers }));
  }
  if (!result || result.status !== 200) {
    throw new HttpError(503, 'Live content is temporarily unavailable.');
  }
  const headers = { 'cache-control': 'no-cache' };
  if (result.etag) headers.etag = result.etag;
  // The adapter has already reconstructed the bounded public subset of the
  // canonical NewAPI envelope. Do not add Worker-owned labels or rewrite its
  // normal-user values here.
  return json(result.payload, 200, headers);
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
