import { HttpError } from '../http.js';

export const DOWNLOADS_INTEGRATION_MODES = Object.freeze({
  DISABLED: 'disabled',
  STAGING_SERVICE_BINDING: 'staging-service-binding',
  PRODUCTION_SERVICE_BINDING: 'production-service-binding',
});

const ENABLED_DOWNLOADS_INTEGRATION_MODES = new Set([
  DOWNLOADS_INTEGRATION_MODES.STAGING_SERVICE_BINDING,
  DOWNLOADS_INTEGRATION_MODES.PRODUCTION_SERVICE_BINDING,
]);

const MOUNTED_ROUTE_PREFIX = '/downloads';

const DIRECT_ROUTE_PREFIXES = Object.freeze([
  '/admin',
  '/assets',
  '/download',
  '/software',
  '/wechat-group-qrcode',
]);

const DOWNLOAD_API_PREFIXES = Object.freeze([
  '/api/latest',
  '/api/public',
  '/api/previous',
  '/api/wechat-group-qrcode',
]);

export const DOWNLOAD_ROUTE_MODES = Object.freeze({
  mounted: Object.freeze({
    public_prefix: MOUNTED_ROUTE_PREFIX,
    downstream_prefix: '/',
    forwarded_prefix: MOUNTED_ROUTE_PREFIX,
  }),
  direct: Object.freeze({
    prefixes: Object.freeze([
      ...DIRECT_ROUTE_PREFIXES,
      ...DOWNLOAD_API_PREFIXES,
      '/api/:software/(latest|public|previous)',
    ]),
    forwarded_prefix: null,
  }),
});

export function isDownloadServiceRoute(pathname) {
  return downloadServiceRouteMetadata(pathname) !== null;
}

export function downloadServiceRouteMetadata(pathname) {
  if (
    pathname === MOUNTED_ROUTE_PREFIX ||
    pathname.startsWith(`${MOUNTED_ROUTE_PREFIX}/`)
  ) {
    return {
      mode: 'mounted',
      downstream_path: mapDownloadPath(pathname),
      forwarded_prefix: MOUNTED_ROUTE_PREFIX,
    };
  }
  if (
    DIRECT_ROUTE_PREFIXES.some((prefix) =>
      hasSegmentPrefix(pathname, prefix),
    )
  ) {
    return {
      mode: 'direct',
      downstream_path: pathname,
      forwarded_prefix: null,
    };
  }
  const isApiRoute =
    DOWNLOAD_API_PREFIXES.some((prefix) => hasSegmentPrefix(pathname, prefix)) ||
    /^\/api\/[a-z0-9][a-z0-9-]{0,62}\/(?:latest|public|previous)(?:\/|$)/.test(
      pathname,
    );
  return isApiRoute
    ? {
        mode: 'direct',
        downstream_path: pathname,
        forwarded_prefix: null,
      }
    : null;
}

export function downloadServiceStatus(env = {}) {
  const mode = String(
    env.DOWNLOADS_INTEGRATION || DOWNLOADS_INTEGRATION_MODES.DISABLED,
  );
  const enabled = ENABLED_DOWNLOADS_INTEGRATION_MODES.has(mode);
  const bindingPresent = Object.prototype.hasOwnProperty.call(
    env,
    'DOWNLOADS_SERVICE',
  );
  const bindingCallable = typeof env.DOWNLOADS_SERVICE?.fetch === 'function';
  const active = enabled && bindingCallable;
  return {
    mode,
    enabled,
    configured: bindingPresent,
    binding_present: bindingPresent,
    bound: bindingCallable,
    active,
    healthy: null,
    transport: 'cloudflare-service-binding',
    live: false,
    phase: statusPhase({ mode, enabled, bindingPresent, bindingCallable }),
    capabilities: [
      'downloads',
      'admin',
      'r2',
      'rollback',
      'wechat_qr',
    ],
    routes: DOWNLOAD_ROUTE_MODES,
  };
}

export async function forwardToDownloadService(request, env = {}) {
  const status = downloadServiceStatus(env);
  if (!status.active) {
    throw new HttpError(
      503,
      'Download service integration is unavailable.',
      status,
    );
  }

  const incomingUrl = new URL(request.url);
  const routeMetadata = downloadServiceRouteMetadata(incomingUrl.pathname);
  if (!routeMetadata) {
    throw new HttpError(404, 'Download service route not found.');
  }
  const downstreamUrl = new URL(request.url);
  downstreamUrl.pathname = routeMetadata.downstream_path;

  const downstreamRequest = new Request(downstreamUrl, request);
  if (routeMetadata.mode === 'mounted') {
    downstreamRequest.headers.set(
      'x-forwarded-prefix',
      routeMetadata.forwarded_prefix,
    );
  } else {
    downstreamRequest.headers.delete('x-forwarded-prefix');
  }
  return env.DOWNLOADS_SERVICE.fetch(downstreamRequest);
}

function hasSegmentPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function mapDownloadPath(pathname) {
  if (pathname === MOUNTED_ROUTE_PREFIX) return '/';
  if (pathname.startsWith(`${MOUNTED_ROUTE_PREFIX}/`)) {
    return pathname.slice(MOUNTED_ROUTE_PREFIX.length) || '/';
  }
  return pathname;
}

function statusPhase({ mode, enabled, bindingPresent, bindingCallable }) {
  if (!enabled) {
    return mode === DOWNLOADS_INTEGRATION_MODES.DISABLED
      ? 'disabled'
      : 'invalid-mode';
  }
  if (!bindingPresent) return 'unbound';
  if (!bindingCallable) return 'invalid-binding';
  return 'bound-unverified';
}
