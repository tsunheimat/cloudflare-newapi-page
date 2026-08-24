import { docsFixture } from '../fixtures/docs.js';
import { pricingFixture } from '../fixtures/pricing.js';
import { HttpError } from '../http.js';

export const CONTENT_ADAPTER_FIXTURE = 'fixture';
export const CONTENT_ADAPTER_LIVE = 'newapi';
export const LIVE_CONTENT_VPC_BINDING = 'NEWAPI_VPC_SERVICE';
export const LIVE_CONTENT_ADAPTER_TOKEN = 'LIVE_CONTENT_ADAPTER_TOKEN';
export const LIVE_CONTENT_CONTRACT_VERSION = 'v1';
export const LIVE_CONTENT_DOCS_SCHEMA_VERSION = 1;
export const LIVE_CONTENT_DOCS_RENDERER_VERSION = 1;
export const LIVE_CONTENT_ORIGIN = 'http://newapi-api.newapi:3000';
export const LIVE_CONTENT_TIMEOUT_MS = 5_000;
export const LIVE_CONTENT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const LIVE_CONTENT_DOCS_NAVIGATION_PATH = '/api/internal/live-content/v1/docs/v2/navigation?locale=zh';
export const LIVE_CONTENT_DOCS_NAVIGATION_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const LIVE_CONTENT_DOCS_V2_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const PUBLIC_DOCS_NAVIGATION_ROUTE = '/api/front-door/v1/docs/v2/navigation';
export const DOCS_NAVIGATION_MAX_NODES = 50_000;
export const DOCS_NAVIGATION_MAX_DEPTH = 100;

export function createContentAdapter(env = {}) {
  const mode = String(env.CONTENT_ADAPTER || CONTENT_ADAPTER_FIXTURE)
    .trim()
    .toLowerCase();

  if (mode === CONTENT_ADAPTER_FIXTURE) {
    return createFixtureAdapter();
  }

  if (mode === CONTENT_ADAPTER_LIVE) {
    return createLiveContentAdapter(env);
  }

  throw new HttpError(
    503,
    `Content adapter "${mode}" is not configured.`,
    {
      configured_adapter: mode,
      live_integration: false,
    },
  );
}

/**
 * Public Docs navigation adapter. The public Worker URL is retained for
 * client compatibility, but this adapter is service-token-only: it never
 * accepts a browser Request and never reads browser cookies or identity.
 */
export function createDocsNavigationAdapter(
  env = {},
  {
    timeoutMs = LIVE_CONTENT_TIMEOUT_MS,
    maxBodyBytes = LIVE_CONTENT_DOCS_NAVIGATION_MAX_BODY_BYTES,
  } = {},
) {
  const mode = String(env.CONTENT_ADAPTER || CONTENT_ADAPTER_FIXTURE).trim().toLowerCase();
  if (mode === CONTENT_ADAPTER_FIXTURE) return createFixtureDocsNavigationAdapter();
  if (mode !== CONTENT_ADAPTER_LIVE) {
    throw new HttpError(503, `Content adapter "${mode}" is not configured.`, {
      configured_adapter: mode,
      live_integration: false,
    });
  }
  const token = getLiveContentToken(env);
  if (typeof env[LIVE_CONTENT_VPC_BINDING]?.fetch !== 'function') {
    throw liveUnavailable('missing_vpc_binding');
  }
  return {
    name: 'docs-navigation-token',
    live: true,
    getDocsNavigationResponse(options = {}) {
      return fetchAndValidateNavigation(options);
    },
  };

  function fetchAndValidateNavigation(options = {}) {
    return fetchLivePayload(
      env,
      token,
      LIVE_CONTENT_DOCS_NAVIGATION_PATH,
      'docs_navigation',
      {
        timeoutMs,
        maxBodyBytes,
        ifNoneMatch: options.ifNoneMatch,
        transform: (payload) => clone(assertDocsNavigation(payload)),
      },
    );
  }
}

function createFixtureDocsNavigationAdapter() {
  const sections = docsFixture.sections || [];
  return {
    name: CONTENT_ADAPTER_FIXTURE,
    live: false,
    async getDocsNavigationResponse() {
      const data = sections.map((section, sectionIndex) => ({
        type: 'group',
        id: sectionIndex + 1,
        slug: `fixture-${sectionIndex + 1}`,
        title: section.title,
        space_id: sectionIndex + 1,
        locale: 'zh',
        enabled: true,
        children: (section.items || []).map((item, itemIndex) => ({
          type: 'page',
          id: (sectionIndex + 1) * 10_000 + itemIndex + 1,
          slug: item.slug,
          path: item.slug,
          title: item.title,
          space_id: sectionIndex + 1,
          parent_id: 0,
          sort_key: itemIndex + 1,
          locale: 'zh',
          enabled: true,
          children: [],
        })),
      }));
      return { status: 200, payload: { success: true, data }, etag: null };
    },
  };
}

function assertDocsNavigation(payload) {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.data) || payload.data.length > 5_000) {
    schemaFailure();
  }
  let nodeCount = 0;
  const visit = (nodes, depth = 0) => {
    if (depth > DOCS_NAVIGATION_MAX_DEPTH || !Array.isArray(nodes) || nodes.length > 5_000 || nodeCount + nodes.length > DOCS_NAVIGATION_MAX_NODES) {
      schemaFailure();
    }
    nodeCount += nodes.length;
    for (const node of nodes) {
      if (!isRecord(node) || !['group', 'page'].includes(node.type) || !Number.isInteger(node.id) || node.id <= 0 || node.id > 2_147_483_647) {
        schemaFailure();
      }
      if (typeof node.title !== 'string' || node.title.trim() === '' || node.title.length > 300) {
        schemaFailure();
      }
      if (typeof node.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(node.slug)) {
        schemaFailure();
      }
      if (!Number.isInteger(node.space_id) || node.space_id <= 0 || typeof node.locale !== 'string' || node.locale.length > 40 || node.locale.trim() === '') schemaFailure();
      if (node.type === 'page' && (typeof node.path !== 'string' || node.path === '')) schemaFailure();
      if (node.path !== undefined && (typeof node.path !== 'string' || node.path.length > 500 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(node.path))) {
        schemaFailure();
      }
      for (const field of ['description', 'icon_key', 'locale']) {
        if (node[field] !== undefined && (typeof node[field] !== 'string' || node[field].length > 1_000)) schemaFailure();
      }
      for (const field of ['space_id', 'parent_id', 'sort_key']) {
        if (node[field] !== undefined && (!Number.isInteger(node[field]) || node[field] < 0)) schemaFailure();
      }
      if (node.enabled !== undefined && typeof node.enabled !== 'boolean') schemaFailure();
      visit(node.children || [], depth + 1);
    }
  };
  visit(payload.data);
  return { success: true, data: projectDocsNavigationNodes(payload.data) };
}

function projectDocsNavigationNodes(nodes) {
  return nodes.map((node) => {
    const projected = { type: node.type, id: node.id, slug: node.slug, title: node.title };
    ['path', 'description', 'icon_key', 'space_id', 'parent_id', 'sort_key', 'locale', 'enabled'].forEach((field) => {
      if (node[field] !== undefined) projected[field] = node[field];
    });
    if (Array.isArray(node.children)) projected.children = projectDocsNavigationNodes(node.children);
    return projected;
  });
}

// Dynamic public maps can contain credential-shaped identifiers. Keep the
// existing redaction contract shared by Pricing and Docs projections.
function isCredentialPublicIdentifier(value) {
  if (typeof value !== 'string') return false;
  const segments = normalizePublicIdentifier(value).split('_').filter(Boolean);
  if (segments.length === 0) return true;
  const bareCredentialWords = new Set([
    'authorization', 'cookie', 'password', 'passwd', 'credential',
    'credentials', 'secret', 'privatekey', 'privatesecret', 'apikey',
    'apitoken', 'accesstoken', 'privatetoken', 'admintoken', 'clientid',
    'clientkey', 'clientsecret', 'clienttoken', 'clientprivatekey',
    'clientapikey', 'providercredential', 'providerkey', 'providertoken',
    'servicecredential', 'servicekey', 'servicetoken', 'signingprivatekey',
    'oauthsecret', 'oauthkey', 'oauthtoken',
  ]);
  if (segments.length === 1 && bareCredentialWords.has(segments[0])) return true;
  const qualifiers = new Set([
    'access', 'admin', 'api', 'auth', 'authorization', 'bearer', 'client',
    'oauth', 'private', 'provider', 'service', 'signing',
  ]);
  const secrets = new Set([
    'credential', 'credentials', 'id', 'key', 'password', 'passwd',
    'secret', 'signature', 'token', 'header',
  ]);
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (qualifiers.has(segments[index]) && secrets.has(segments[index + 1])) return true;
  }
  const compact = segments.join('');
  const credentialWords = new Set([...qualifiers, ...secrets]);
  for (const qualifier of qualifiers) {
    if (!compact.startsWith(qualifier) || compact === qualifier) continue;
    let remainder = compact.slice(qualifier.length);
    let matchedSecret = false;
    while (remainder) {
      const secret = [...credentialWords]
        .filter((candidate) => remainder.startsWith(candidate))
        .sort((left, right) => right.length - left.length)[0];
      if (!secret) {
        matchedSecret = false;
        break;
      }
      matchedSecret = true;
      remainder = remainder.slice(secret.length);
    }
    if (matchedSecret && remainder === '') return true;
  }
  return false;
}

function normalizePublicIdentifier(value) {
  return value
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function createFixtureAdapter() {
  const docsCatalog = () => clone({
    meta: docsFixture.meta,
    sections: docsFixture.sections,
    search_index: docsFixture.search_index,
  });
  const docPage = (slug) => {
    const page = docsFixture.pages.find((candidate) => candidate.slug === slug);
    if (!page) {
      throw new HttpError(404, 'Document page not found.');
    }
    return clone({ meta: docsFixture.meta, page });
  };
  const pricing = () => {
    return clone(pricingFixture);
  };
  return {
    name: CONTENT_ADAPTER_FIXTURE,
    live: false,

    async getDocsCatalog() {
      return docsCatalog();
    },

    async getDocsCatalogResponse() {
      return { status: 200, payload: docsCatalog(), etag: null };
    },

    async getDocPage(slug) {
      return docPage(slug);
    },

    async getDocPageResponse(slug) {
      return { status: 200, payload: docPage(slug), etag: null };
    },

    async getPricing() {
      return pricing();
    },

    async getPricingResponse() {
      return { status: 200, payload: pricing(), etag: null };
    },
  };
}

/**
 * Read-only adapter for the private NewAPI content contract. The service
 * binding is intentionally the only origin selector: no public hostname or
 * user-provided URL can influence this request.
 */
export function createLiveContentAdapter(
  env = {},
  {
    timeoutMs = LIVE_CONTENT_TIMEOUT_MS,
    maxBodyBytes = LIVE_CONTENT_MAX_BODY_BYTES,
  } = {},
) {
  const token = getLiveContentToken(env);
  if (typeof env[LIVE_CONTENT_VPC_BINDING]?.fetch !== 'function') {
    throw liveUnavailable('missing_vpc_binding');
  }

  const fetchPayload = (path, kind, options = {}) =>
    fetchLivePayload(env, token, path, kind, {
      timeoutMs,
      maxBodyBytes,
      ifNoneMatch: options.ifNoneMatch,
      transform: options.transform,
      etag: options.etag,
      preserveBody: options.preserveBody,
    });
  const getDocsCatalogResponse = (options = {}) => fetchAndValidate(
    '/api/internal/live-content/v1/docs?locale=zh',
    'docs_catalog',
    options,
    assertLiveDocsCatalog,
  );
  const getDocPageResponse = (slug, options = {}) => {
    if (!isSafeSlug(slug)) throw new HttpError(400, 'Invalid document slug.');
    return fetchAndValidate(
      `/api/internal/live-content/v1/docs/${encodeURIComponent(slug)}?locale=zh`,
      'docs_page',
      options,
      assertLiveDocsPage,
    );
  };
  const getPricingResponse = (options = {}) => fetchAndValidate(
    '/api/internal/live-content/v1/pricing',
    'pricing',
    options,
    assertLivePricing,
    undefined,
    { preserveBody: true },
  );
  const getDocsV2Response = (path, options = {}) => {
    if (typeof path !== 'string' || !path.startsWith('/api/internal/live-content/v1/docs/v2/')) {
      throw new HttpError(400, 'Invalid DocsHub route.');
    }
    return fetchAndValidateDocsV2(path, options);
  };
  const getDocsV2AssetResponse = (id, options = {}) => {
    if (!/^[1-9][0-9]{0,10}$/.test(String(id))) {
      throw new HttpError(400, 'Invalid documentation asset.');
    }
    return fetchLiveAsset(
      env,
      token,
      `/api/internal/live-content/v1/docs/v2/assets/${id}`,
      options,
    );
  };
  return {
    name: CONTENT_ADAPTER_LIVE,
    live: true,

    async getDocsCatalog() {
      return (await getDocsCatalogResponse()).payload;
    },

    getDocsCatalogResponse,

    async getDocPage(slug) {
      return (await getDocPageResponse(slug)).payload;
    },

    getDocPageResponse,

    async getPricing() {
      return (await getPricingResponse()).payload;
    },

    getPricingResponse,

    getDocsV2Response,

    getDocsV2AssetResponse,

    async checkHealth() {
      try {
        await fetchAndValidate(
          '/api/internal/live-content/v1/health',
          'health',
          {},
          assertLiveHealth,
        );
        return true;
      } catch {
        return false;
      }
    },
  };

  async function fetchAndValidate(path, kind, options, validator, etag, extra = {}) {
    return fetchPayload(path, kind, {
      ...options,
      transform: (payload) => clone(validator(payload)),
      etag,
      ...extra,
    });
  }

  async function fetchAndValidateDocsV2(path, options = {}) {
    return fetchLivePayload(env, token, path, 'docs_v2', {
      timeoutMs,
      maxBodyBytes: LIVE_CONTENT_DOCS_V2_MAX_BODY_BYTES,
      ifNoneMatch: options.ifNoneMatch,
      transform: (payload) => clone(assertLiveDocsV2Payload(payload)),
    });
  }
}

function fetchLivePayload(
  env,
  token,
  path,
  kind,
  {
    timeoutMs,
    maxBodyBytes,
    ifNoneMatch = undefined,
    transform = (value) => value,
    etag: projectEtag = undefined,
    preserveBody = false,
  },
) {
  const binding = env[LIVE_CONTENT_VPC_BINDING];
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let upstreamResponse;
  let timedOut = false;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    void Promise.resolve(upstreamResponse?.body?.cancel?.('deadline exceeded')).catch(() => {});
    rejectTimeout(liveUnavailable('upstream_timeout'));
  }, timeoutMs);

  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() !== '') {
    headers['If-None-Match'] = ifNoneMatch;
  }
  const request = new Request(`${LIVE_CONTENT_ORIGIN}${path}`, {
    method: 'GET',
    headers,
    signal: controller.signal,
  });

  const operation = (async () => {
      assertBeforeDeadline(deadline, controller);
      const response = await binding.fetch(request);
      upstreamResponse = response;
      if (Date.now() >= deadline) {
        await Promise.resolve(response?.body?.cancel?.('deadline exceeded')).catch(() => {});
      }
      assertBeforeDeadline(deadline, controller);
      if (
        !response ||
        typeof response.status !== 'number' ||
        !response.headers ||
        typeof response.headers.get !== 'function'
      ) {
        throw liveUnavailable('invalid_upstream_response');
      }
      if (kind === 'health' && response.status !== 200) {
        throw liveUnavailable('upstream_status');
      }
      if (
        kind !== 'health' &&
        ![200, 304].includes(response.status) &&
        !(response.status === 404 && (kind === 'docs_page' || kind === 'docs_v2'))
      ) {
        throw liveUnavailable('upstream_status');
      }
      if (response.headers.get('x-newapi-content-contract') !== LIVE_CONTENT_CONTRACT_VERSION) {
        throw liveUnavailable('invalid_upstream_contract');
      }
      const rawEtag = response.headers.get('etag');
      const etag = verifiedEtag(rawEtag);
      if (rawEtag !== null && !etag) {
        throw liveUnavailable('invalid_upstream_etag');
      }
      if (response.status === 304) {
        // An upstream 304 is valid only for the browser validator forwarded by
        // this request, including on Docs paths without a projected ETag.
        if (!etag || !etagMatches(ifNoneMatch, etag)) {
          throw liveUnavailable('invalid_upstream_etag');
        }
        return { status: 304, payload: null, etag };
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw liveUnavailable('invalid_upstream_content_type');
      }
      let raw;
      try {
        raw = await readBoundedBody(
          response,
          maxBodyBytes,
          controller.signal,
          deadline,
        );
      } catch {
        if (controller.signal.aborted || Date.now() >= deadline) {
          throw liveUnavailable('upstream_timeout');
        }
        throw liveUnavailable('invalid_upstream_body');
      }
      let payload;
      try {
        assertBeforeDeadline(deadline, controller);
        payload = JSON.parse(raw);
        assertBeforeDeadline(deadline, controller);
      } catch {
        if (controller.signal.aborted || Date.now() >= deadline) {
          throw liveUnavailable('upstream_timeout');
        }
        throw liveUnavailable('invalid_upstream_json');
      }
      if (response.status === 404 && kind === 'docs_page') {
        assertLiveDocsPageNotFound(payload);
        throw new HttpError(404, 'Document page not found.');
      }
      if (response.status === 404 && kind === 'docs_v2') {
        if (!isRecord(payload) || payload.success !== false || typeof payload.message !== 'string') {
          schemaFailure();
        }
        return { status: 404, payload, etag };
      }
      let validated;
      try {
        assertBeforeDeadline(deadline, controller);
        validated = transform(payload);
      } catch (error) {
        if (controller.signal.aborted || Date.now() >= deadline) {
          throw liveUnavailable('upstream_timeout');
        }
        throw error;
      }
      assertBeforeDeadline(deadline, controller);
      const publicEtag = projectEtag ? projectEtag(validated) : etag;
      assertBeforeDeadline(deadline, controller);
      if (projectEtag && publicEtag && etagMatches(ifNoneMatch, publicEtag)) {
        return { status: 304, payload: null, etag: publicEtag };
      }
      return {
        status: 200,
        payload: validated,
        etag: publicEtag,
        ...(preserveBody ? { body: raw } : {}),
      };
    })();
  return Promise.race([operation, timeout])
    .catch((error) => {
      if (error instanceof HttpError) throw error;
      throw liveUnavailable(timedOut ? 'upstream_timeout' : 'upstream_transport');
    })
    .finally(() => {
      clearTimeout(timer);
    });
}

function assertLiveDocsV2Payload(payload) {
  if (!isRecord(payload) || payload.success !== true || !Object.hasOwn(payload, 'data')) {
    schemaFailure();
  }
  // The canonical NewAPI DocsHub handlers are already public/published DTOs.
  // Keep their complete shape while recursively dropping credential-shaped
  // keys if a future handler accidentally adds one.
  return redactDocsHubValue(payload, 0);
}

function redactDocsHubValue(value, depth) {
  if (depth > 24) schemaFailure();
  if (typeof value === 'string') {
    if (value.length > 200_000) schemaFailure();
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (value.length > 50_000) schemaFailure();
    return value.map((item) => redactDocsHubValue(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 2_000) schemaFailure();
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isCredentialPublicIdentifier(key)) continue;
    result[key] = redactDocsHubValue(item, depth + 1);
  }
  return result;
}

async function fetchLiveAsset(env, token, path, { timeoutMs = LIVE_CONTENT_TIMEOUT_MS, maxBodyBytes = 16 * 1024 * 1024, ifNoneMatch } = {}) {
  const binding = env[LIVE_CONTENT_VPC_BINDING];
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let upstreamResponse;
  let timedOut = false;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    void Promise.resolve(upstreamResponse?.body?.cancel?.('deadline exceeded')).catch(() => {});
    rejectTimeout(liveUnavailable('upstream_timeout'));
  }, timeoutMs);
  const headers = {
    Accept: 'application/octet-stream, image/*, video/*',
    Authorization: `Bearer ${token}`,
  };
  if (typeof ifNoneMatch === 'string' && ifNoneMatch.trim() !== '') headers['If-None-Match'] = ifNoneMatch;
  const operation = (async () => {
    assertBeforeDeadline(deadline, controller);
    upstreamResponse = await binding.fetch(new Request(`${LIVE_CONTENT_ORIGIN}${path}`, {
      method: 'GET', headers, signal: controller.signal,
    }));
    assertBeforeDeadline(deadline, controller);
    if (!upstreamResponse || ![200, 304, 404].includes(upstreamResponse.status)) throw liveUnavailable('upstream_status');
    // NewAPI's binary Docs asset handler intentionally carries the asset
    // ETag/content-type contract but not the JSON contract header.
    if (upstreamResponse.status === 200 && !(upstreamResponse.headers.get('content-type') || '').trim()) throw liveUnavailable('invalid_upstream_content_type');
    const rawEtag = upstreamResponse.headers.get('etag');
    const etag = verifiedEtag(rawEtag);
    if (rawEtag !== null && !etag) throw liveUnavailable('invalid_upstream_etag');
    if (upstreamResponse.status === 304) {
      if (!etag || !etagMatches(ifNoneMatch, etag)) throw liveUnavailable('invalid_upstream_etag');
      return { status: 304, body: null, etag, contentType: upstreamResponse.headers.get('content-type') || 'application/octet-stream' };
    }
    if (upstreamResponse.status === 404) return { status: 404, body: null, etag: null, contentType: 'application/json' };
    const body = await readBoundedBytes(upstreamResponse, maxBodyBytes, controller.signal, deadline);
    return {
      status: 200,
      body,
      etag,
      contentType: upstreamResponse.headers.get('content-type') || 'application/octet-stream',
      disposition: upstreamResponse.headers.get('content-disposition') || '',
    };
  })();
  return Promise.race([operation, timeout])
    .catch((error) => { if (error instanceof HttpError) throw error; throw liveUnavailable(timedOut ? 'upstream_timeout' : 'upstream_transport'); })
    .finally(() => clearTimeout(timer));
}

async function readBoundedBytes(response, maxBytes, signal, deadline) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('upstream response too large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      assertBeforeDeadline(deadline);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('upstream response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  assertBeforeDeadline(deadline);
  return bytes;
}

async function readBoundedBody(response, maxBytes, signal, deadline) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('upstream response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let cancelled = false;
  let completed = false;
  let cancelPromise = null;
  const abortReader = () => {
    cancelled = true;
    cancelPromise = reader.cancel('deadline exceeded').catch(() => {});
  };
  signal.addEventListener('abort', abortReader, { once: true });
  try {
    for (;;) {
      assertBeforeDeadline(deadline);
      const { done, value } = await reader.read();
      assertBeforeDeadline(deadline);
      if (done) {
        completed = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        cancelled = true;
        throw new Error('upstream response too large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', abortReader);
    if (cancelPromise) await cancelPromise;
    else if (!completed && !cancelled) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  assertBeforeDeadline(deadline);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assertBeforeDeadline(deadline);
  return decoded;
}

function assertBeforeDeadline(deadline, controller = undefined) {
  if (Date.now() < deadline) return;
  controller?.abort();
  throw liveUnavailable('upstream_timeout');
}

function verifiedEtag(value) {
  if (value === null) return null;
  // Only forward a single RFC 9110 entity-tag; never reflect arbitrary
  // upstream header text into the public response.
  return /^(?:W\/)?"(?:[\x21\x23-\x7e\x80-\xff])*"$/.test(value)
    ? value
    : null;
}

function etagMatches(value, current) {
  if (typeof value !== 'string' || !current) return false;
  const fieldValue = value.trim();
  if (fieldValue === '*') return true;
  return parseEntityTagList(fieldValue).some((candidate) => {
    if (candidate === '*') return true;
    if (!verifiedEtag(candidate)) return false;
    return candidate.replace(/^W\//, '') === current.replace(/^W\//, '');
  });
}

function parseEntityTagList(value) {
  const candidates = [];
  let start = 0;
  let inOpaqueTag = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      inOpaqueTag = !inOpaqueTag;
    } else if (character === ',' && !inOpaqueTag) {
      candidates.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  candidates.push(value.slice(start).trim());
  return candidates;
}

function liveUnavailable(reason) {
  return new HttpError(503, 'Live content is temporarily unavailable.', {
    configured_adapter: CONTENT_ADAPTER_LIVE,
    live_integration: true,
    reason,
  });
}

function getLiveContentToken(env) {
  const token = typeof env[LIVE_CONTENT_ADAPTER_TOKEN] === 'string'
    ? env[LIVE_CONTENT_ADAPTER_TOKEN].trim()
    : '';
  if (
    new TextEncoder().encode(token).byteLength < 32 ||
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    throw liveUnavailable('missing_adapter_token');
  }
  return token;
}

function schemaFailure() {
  throw liveUnavailable('invalid_upstream_schema');
}

function assertLiveDocsCatalog(payload) {
  const data = assertEnvelope(payload, 'docs_catalog');
  assertLiveMeta(data.meta, true);
  if (!Array.isArray(data.sections) || data.sections.length > 500) schemaFailure();
  data.sections.forEach((section) => {
    assertString(section?.title, 200);
    if (!Array.isArray(section.items) || section.items.length > 500) schemaFailure();
    section.items.forEach(assertDocsItem);
  });
  if (!Array.isArray(data.search_index) || data.search_index.length > 5_000) schemaFailure();
  data.search_index.forEach(assertSearchRecord);
  return projectLiveDocsCatalog(data);
}

function assertLiveDocsPage(payload) {
  const data = assertEnvelope(payload, 'docs_page');
  assertLiveMeta(data.meta, true);
  const page = data.page;
  assertDocsItem(page);
  assertString(page.section, 200);
  if (!Number.isInteger(page.updated_at) || page.updated_at < 0) schemaFailure();
  if (!Array.isArray(page.blocks) || page.blocks.length > 500) schemaFailure();
  page.blocks.forEach(assertDocsBlock);
  return projectLiveDocsPage(data);
}

function assertLivePricing(payload) {
  // The backend token endpoint delegates directly to the canonical public
  // `/api/pricing` handler.  Do not project, sort, redact, or synthesize any
  // pricing field here: the raw response body is returned by the Worker so
  // native ordering and future fields remain byte-for-byte intact.
  if (!isRecord(payload) || payload.success !== true) schemaFailure();
  return payload;
}

function assertLiveHealth(payload) {
  if (
    !isRecord(payload) ||
    payload.success !== true ||
    payload.service !== 'newapi-live-content' ||
    payload.contract_version !== LIVE_CONTENT_CONTRACT_VERSION ||
    payload.read_only !== true
  ) {
    schemaFailure();
  }
  return payload;
}

function assertEnvelope(payload, kind) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) schemaFailure();
  return payload.data;
}

function assertLiveDocsPageNotFound(payload) {
  // NewAPI's 404 is a deliberately small, stable error envelope. Verify the
  // exact public contract before converting the upstream response to a 404;
  // arbitrary upstream 404 bodies must remain a generic 503.
  if (
    !isRecord(payload) ||
    payload.success !== false ||
    payload.message !== 'document page not found'
  ) {
    schemaFailure();
  }
}

function assertLiveMeta(meta, docs) {
  if (!isRecord(meta) || meta.source !== 'newapi' || meta.fixture !== false || meta.live !== true || meta.contract_version !== LIVE_CONTENT_CONTRACT_VERSION) schemaFailure();
  assertString(meta.label, 200);
  if (meta.updated_at !== null && (!Number.isInteger(meta.updated_at) || meta.updated_at < 0)) schemaFailure();
  if (meta.notice !== undefined) assertString(meta.notice, 2_000, { allowEmpty: true });
  if (
    docs &&
    (meta.schema_version !== LIVE_CONTENT_DOCS_SCHEMA_VERSION ||
      meta.renderer_version !== LIVE_CONTENT_DOCS_RENDERER_VERSION)
  ) schemaFailure();
}

function assertDocsItem(item) {
  if (!isRecord(item) || !isSafeSlug(item.slug)) schemaFailure();
  assertString(item.title, 300);
  assertString(item.summary, 2_000, { allowEmpty: true });
  if (!Array.isArray(item.keywords) || item.keywords.length > 100 || item.keywords.some((keyword) => typeof keyword !== 'string' || keyword.length > 200)) schemaFailure();
}

function assertSearchRecord(record) {
  if (!isRecord(record) || !isSafeSlug(record.slug)) schemaFailure();
  if (record.anchor !== null && record.anchor !== undefined) assertString(record.anchor, 200);
  assertString(record.title, 300);
  assertString(record.target_title, 500);
  assertString(record.text, 10_000);
}

function assertDocsBlock(block) {
  if (!isRecord(block) || !['lead', 'paragraph', 'heading', 'callout', 'code', 'bullets', 'endpoint', 'table', 'link-cards'].includes(block.type)) schemaFailure();
  switch (block.type) {
    case 'lead':
    case 'paragraph':
      assertString(block.text, 20_000);
      break;
    case 'heading':
      assertString(block.id, 200);
      if (![2, 3].includes(block.level)) schemaFailure();
      assertString(block.text, 1_000, { allowEmpty: true });
      break;
    case 'callout':
      if (!['info', 'warning', 'danger'].includes(block.tone)) schemaFailure();
      assertString(block.title, 500, { allowEmpty: true });
      assertString(block.text, 20_000, { allowEmpty: true });
      break;
    case 'code':
      assertString(block.language, 80, { allowEmpty: true });
      assertString(block.label, 200, { allowEmpty: true });
      assertString(block.code, 50_000);
      break;
    case 'bullets':
      if (!Array.isArray(block.items) || block.items.length > 200 || block.items.some((item) => typeof item !== 'string' || item.length > 2_000)) schemaFailure();
      break;
    case 'endpoint':
      if (!/^[A-Z][A-Z0-9-]{0,15}$/.test(block.method)) schemaFailure();
      assertString(block.id, 100);
      assertString(block.path, 500);
      assertString(block.text, 2_000, { allowEmpty: true });
      break;
    case 'table':
      if (!Array.isArray(block.columns) || block.columns.length > 100 || block.columns.some((column) => typeof column !== 'string')) schemaFailure();
      if (!Array.isArray(block.rows) || block.rows.length > 1_000 || block.rows.some((row) => !Array.isArray(row) || row.length !== block.columns.length || row.some((cell) => typeof cell !== 'string'))) schemaFailure();
      break;
    case 'link-cards':
      if (!Array.isArray(block.items) || block.items.length > 100) schemaFailure();
      block.items.forEach((item) => {
        if (!isRecord(item) || !isSafeSlug(item.slug)) schemaFailure();
        assertString(item.title, 300);
        assertString(item.text, 2_000, { allowEmpty: true });
      });
      break;
    default:
      schemaFailure();
  }
}

function assertString(value, maxLength, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.length > maxLength) schemaFailure();
  if (!allowEmpty && value.trim() === '') schemaFailure();
}

function isSafeSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function projectLiveDocsCatalog(data) {
  return {
    meta: projectLiveMeta(data.meta, true),
    sections: data.sections.map((section) => ({
      title: section.title,
      items: section.items.map(projectDocsItem),
    })),
    search_index: data.search_index.map((record) => ({
      slug: record.slug,
      anchor: record.anchor ?? null,
      title: record.title,
      target_title: record.target_title,
      text: record.text,
    })),
  };
}

function projectLiveDocsPage(data) {
  return {
    meta: projectLiveMeta(data.meta, true),
    page: {
      slug: data.page.slug,
      title: data.page.title,
      summary: data.page.summary,
      section: data.page.section,
      keywords: [...data.page.keywords],
      updated_at: data.page.updated_at,
      blocks: data.page.blocks.map(projectDocsBlock),
    },
  };
}

function projectLiveMeta(meta, docs) {
  const projected = {
    source: meta.source,
    fixture: meta.fixture,
    live: meta.live,
    label: meta.label,
    updated_at: meta.updated_at,
    contract_version: meta.contract_version,
  };
  if (docs) {
    projected.schema_version = meta.schema_version;
    projected.renderer_version = meta.renderer_version;
  } else if (meta.notice !== undefined) {
    projected.notice = meta.notice;
  }
  return projected;
}

function projectDocsItem(item) {
  return {
    slug: item.slug,
    title: item.title,
    summary: item.summary,
    keywords: [...item.keywords],
  };
}

function projectDocsBlock(block) {
  switch (block.type) {
    case 'lead':
    case 'paragraph':
      return { type: block.type, text: block.text };
    case 'heading':
      return { type: block.type, id: block.id, level: block.level, text: block.text };
    case 'callout':
      return { type: block.type, tone: block.tone, title: block.title, text: block.text };
    case 'code':
      return { type: block.type, language: block.language, label: block.label, code: block.code };
    case 'bullets':
      return { type: block.type, items: [...block.items] };
    case 'endpoint':
      return { type: block.type, method: block.method, id: block.id, path: block.path, text: block.text };
    case 'table':
      return { type: block.type, columns: [...block.columns], rows: block.rows.map((row) => [...row]) };
    case 'link-cards':
      return {
        type: block.type,
        items: block.items.map((item) => ({ slug: item.slug, title: item.title, text: item.text })),
      };
    default:
      schemaFailure();
  }
}

function clone(value) {
  return structuredClone(value);
}
