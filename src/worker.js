import {
  createContentAdapter,
  CONTENT_ADAPTER_LIVE,
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
    return json({
      status: 'ok',
      service: 'cloudflare-newapi-page',
      phase: PHASE,
      content_adapter: String(env.CONTENT_ADAPTER || 'fixture'),
      pricing_context: LOCKED_PRICING_CONTEXT,
      live_newapi: isLiveContentMode(env),
      downloads: downloadServiceStatus(env),
    });
  }

  if (request.method === 'GET' && pathname === '/api/integrations/downloads') {
    return json({ success: true, data: downloadServiceStatus(env) });
  }

  if (request.method === 'GET' && pathname === '/api/content/docs') {
    const adapter = createContentAdapter(env);
    return json({ success: true, data: await adapter.getDocsCatalog() });
  }

  if (request.method === 'GET' && pathname.startsWith('/api/content/docs/')) {
    const slug = decodeDocSlug(pathname.slice('/api/content/docs/'.length));
    const adapter = createContentAdapter(env);
    return json({ success: true, data: await adapter.getDocPage(slug) });
  }

  if (request.method === 'GET' && pathname === '/api/content/pricing') {
    const adapter = createContentAdapter(env);
    return json(await adapter.getPricing());
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

function isLiveContentMode(env) {
  const mode = String(env.CONTENT_ADAPTER || 'fixture').trim().toLowerCase();
  return mode === CONTENT_ADAPTER_LIVE;
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
