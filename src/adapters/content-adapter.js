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
export const LOCKED_PRICING_CONTEXT = Object.freeze({
  user_group: 'default',
  selected_group: 'default',
});

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
    assertOrdinaryUserPricingContext(pricingFixture);
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
  const token = typeof env[LIVE_CONTENT_ADAPTER_TOKEN] === 'string'
    ? env[LIVE_CONTENT_ADAPTER_TOKEN].trim()
    : '';
  if (
    new TextEncoder().encode(token).byteLength < 32 ||
    !/^[\x21-\x7e]+$/.test(token)
  ) {
    throw liveUnavailable('missing_adapter_token');
  }
  if (typeof env[LIVE_CONTENT_VPC_BINDING]?.fetch !== 'function') {
    throw liveUnavailable('missing_vpc_binding');
  }

  const fetchPayload = (path, kind, options = {}) =>
    fetchLivePayload(env, token, path, kind, {
      timeoutMs,
      maxBodyBytes,
      ifNoneMatch: options.ifNoneMatch,
      transform: options.transform,
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
  );
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

  async function fetchAndValidate(path, kind, options, validator) {
    return fetchPayload(path, kind, {
      ...options,
      transform: (payload) => clone(validator(payload)),
    });
  }
}

export function assertOrdinaryUserPricingContext(payload) {
  const userGroup = payload?.context?.user_group;
  const selectedGroup = payload?.context?.selected_group;
  if (
    userGroup !== LOCKED_PRICING_CONTEXT.user_group ||
    selectedGroup !== LOCKED_PRICING_CONTEXT.selected_group
  ) {
    throw new HttpError(500, 'Pricing adapter returned an invalid user context.');
  }
  if (payload?.context?.locked !== true) {
    throw new HttpError(500, 'Pricing adapter must lock the public pricing group.');
  }
  if (!(LOCKED_PRICING_CONTEXT.selected_group in (payload.group_ratio || {}))) {
    throw new HttpError(500, 'Pricing adapter omitted the default group ratio.');
  }
  const defaultGroupRatio = payload.group_ratio[LOCKED_PRICING_CONTEXT.selected_group];
  if (!isFiniteNumber(defaultGroupRatio) || defaultGroupRatio < 0) {
    throw new HttpError(
      500,
      'Pricing adapter returned an invalid default group ratio.',
    );
  }
  if (!(LOCKED_PRICING_CONTEXT.selected_group in (payload.usable_group || {}))) {
    throw new HttpError(500, 'Pricing adapter omitted the default usable group.');
  }
  return payload;
}

function fetchLivePayload(
  env,
  token,
  path,
  kind,
  { timeoutMs, maxBodyBytes, ifNoneMatch = undefined, transform = (value) => value },
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
        !(response.status === 404 && kind === 'docs_page')
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
        if (!etag) throw liveUnavailable('invalid_upstream_etag');
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
      return { status: 200, payload: validated, etag };
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

function liveUnavailable(reason) {
  return new HttpError(503, 'Live content is temporarily unavailable.', {
    configured_adapter: CONTENT_ADAPTER_LIVE,
    live_integration: true,
    reason,
  });
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
  if (!isRecord(payload) || payload.success !== true) schemaFailure();
  assertLiveMeta(payload.meta, false);
  const context = payload.context;
  if (!isRecord(context) || context.user_group !== 'default' || context.selected_group !== 'default' || context.locked !== true) schemaFailure();
  if (!isRecord(payload.display)) schemaFailure();
  assertString(payload.display.quota_display_type, 40);
  assertString(payload.display.default_currency, 40);
  ['price', 'usd_exchange_rate', 'custom_currency_exchange_rate'].forEach((key) => {
    if (!isFiniteNumber(payload.display[key]) || payload.display[key] <= 0) schemaFailure();
  });
  assertString(payload.display.custom_currency_symbol, 20, { allowEmpty: true });
  if (typeof payload.display.show_with_recharge !== 'boolean') schemaFailure();
  if (!Array.isArray(payload.data) || payload.data.length > 5_000) schemaFailure();
  payload.data.forEach((item) => {
    if (!isRecord(item)) schemaFailure();
    assertString(item.model_name, 300);
    ['description', 'tags', 'billing_mode', 'billing_expr'].forEach((field) => {
      if (item[field] !== undefined) assertString(item[field], field === 'billing_expr' ? 50_000 : 5_000, { allowEmpty: true });
    });
    if (item.vendor_id !== undefined && (!Number.isInteger(item.vendor_id) || item.vendor_id < 0)) schemaFailure();
    if (item.quota_type !== undefined && !Number.isInteger(item.quota_type)) schemaFailure();
    [
      'model_ratio',
      'model_price',
      'completion_ratio',
      'cache_ratio',
      'create_cache_ratio',
      'image_ratio',
      'audio_ratio',
      'audio_completion_ratio',
    ].forEach((field) => {
      if (item[field] !== undefined && !isFiniteNumber(item[field])) schemaFailure();
    });
    ['image_generation_model', 'video_generation_model'].forEach((field) => {
      if (item[field] !== undefined && typeof item[field] !== 'boolean') schemaFailure();
    });
    if (item.enable_groups !== undefined && (!Array.isArray(item.enable_groups) || item.enable_groups.some((group) => typeof group !== 'string'))) schemaFailure();
    if (item.supported_endpoint_types !== undefined && (!Array.isArray(item.supported_endpoint_types) || item.supported_endpoint_types.some((endpoint) => typeof endpoint !== 'string'))) schemaFailure();
    if (item.video_pricing !== undefined) assertLiveVideoPricing(item.video_pricing);
  });
  if (!Array.isArray(payload.vendors) || payload.vendors.length > 1_000) schemaFailure();
  payload.vendors.forEach((vendor) => {
    if (!isRecord(vendor)) schemaFailure();
    if (!Number.isInteger(vendor.id) || vendor.id < 0) schemaFailure();
    assertString(vendor.name, 300);
    if (vendor.description !== undefined) assertString(vendor.description, 5_000, { allowEmpty: true });
  });
  assertLiveGroupRatios(payload.group_ratio);
  if (!isRecord(payload.usable_group) || typeof payload.usable_group.default !== 'string' || payload.usable_group.default.trim() === '') schemaFailure();
  if (!isRecord(payload.supported_endpoint)) schemaFailure();
  Object.entries(payload.supported_endpoint).forEach(([key, endpoint]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(endpoint)) schemaFailure();
    assertString(endpoint.method, 20);
    assertString(endpoint.path, 500);
  });
  if (!Array.isArray(payload.auto_groups) || payload.auto_groups.some((group) => typeof group !== 'string')) schemaFailure();
  assertVideoResolutionDimensions(payload.video_resolution_dimensions);
  if (typeof payload.pricing_version !== 'string' || payload.pricing_version.trim() === '') schemaFailure();
  return projectLivePricing(payload);
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

function assertVideoResolutionDimensions(value) {
  if (!isRecord(value)) schemaFailure();
  Object.entries(value).forEach(([key, resolutionSet]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(resolutionSet)) schemaFailure();
    Object.entries(resolutionSet).forEach(([geometryKey, geometrySet]) => {
      if (!isPublicMapKey(geometryKey)) return;
      if (!isRecord(geometrySet)) schemaFailure();
      Object.entries(geometrySet).forEach(([dimensionKey, dimensions]) => {
        if (!isPublicMapKey(dimensionKey)) return;
        if (!Array.isArray(dimensions) || dimensions.length !== 2 || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) schemaFailure();
      });
    });
  });
}

function assertLiveVideoPricing(profile) {
  if (!isRecord(profile) || profile.version !== 1) schemaFailure();
  assertString(profile.currency, 20);
  assertString(profile.unit, 80);
  if (!isFiniteNumber(profile.rate_multiplier) || profile.rate_multiplier <= 0) schemaFailure();
  if (!isRecord(profile.resolution_rates)) schemaFailure();
  Object.entries(profile.resolution_rates).forEach(([key, rates]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(rates)) schemaFailure();
    ['without_video', 'with_video'].forEach((field) => {
      if (!isFiniteNumber(rates[field]) || rates[field] < 0) schemaFailure();
    });
  });
}

function assertLiveGroupRatios(value) {
  if (!isRecord(value) || !Object.hasOwn(value, LOCKED_PRICING_CONTEXT.selected_group)) {
    schemaFailure();
  }
  Object.entries(value).forEach(([key, ratio]) => {
    if (!isPublicMapKey(key)) return;
    if (!isFiniteNumber(ratio) || ratio < 0) schemaFailure();
  });
  if (
    !isFiniteNumber(value[LOCKED_PRICING_CONTEXT.selected_group]) ||
    value[LOCKED_PRICING_CONTEXT.selected_group] < 0
  ) {
    schemaFailure();
  }
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
      assertString(block.text, 1_000);
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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const PUBLIC_PRICING_MODEL_FIELDS = [
  'model_name',
  'description',
  'tags',
  'vendor_id',
  'quota_type',
  'model_ratio',
  'model_price',
  'completion_ratio',
  'cache_ratio',
  'create_cache_ratio',
  'image_ratio',
  'audio_ratio',
  'audio_completion_ratio',
  'billing_mode',
  'billing_expr',
  'image_generation_model',
  'video_generation_model',
  'enable_groups',
  'supported_endpoint_types',
];

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

function projectLivePricing(payload) {
  return {
    success: true,
    meta: projectLiveMeta(payload.meta, false),
    context: {
      user_group: payload.context.user_group,
      selected_group: payload.context.selected_group,
      locked: payload.context.locked,
    },
    display: {
      quota_display_type: payload.display.quota_display_type,
      default_currency: payload.display.default_currency,
      price: payload.display.price,
      usd_exchange_rate: payload.display.usd_exchange_rate,
      custom_currency_exchange_rate: payload.display.custom_currency_exchange_rate,
      custom_currency_symbol: payload.display.custom_currency_symbol,
      show_with_recharge: payload.display.show_with_recharge,
    },
    data: payload.data.map(projectPricingModel),
    vendors: payload.vendors.map((vendor) => {
      const projected = { id: vendor.id, name: vendor.name };
      if (vendor.description !== undefined) projected.description = vendor.description;
      return projected;
    }),
    group_ratio: projectPublicMap(payload.group_ratio, (ratio) => ratio),
    usable_group: { default: payload.usable_group.default },
    supported_endpoint: projectEndpointMap(payload.supported_endpoint),
    auto_groups: projectPublicIdentifierArray(payload.auto_groups),
    video_resolution_dimensions: projectPublicMap(
      payload.video_resolution_dimensions,
      (value) => projectVideoDimensionSet(value),
    ),
    pricing_version: payload.pricing_version,
  };
}

function projectPricingModel(model) {
  const projected = {};
  PUBLIC_PRICING_MODEL_FIELDS.forEach((field) => {
    if (!Object.hasOwn(model, field)) return;
    if (field === 'enable_groups' || field === 'supported_endpoint_types') {
      projected[field] = projectPublicIdentifierArray(model[field]);
    } else {
      projected[field] = model[field];
    }
  });
  if (Object.hasOwn(model, 'video_pricing')) {
    projected.video_pricing = projectVideoPricing(model.video_pricing);
  }
  return projected;
}

function projectPublicIdentifierArray(values) {
  return values.filter((value) => isPublicMapKey(value));
}

function projectVideoPricing(profile) {
  if (!isRecord(profile)) return profile;
  const projected = {};
  ['version', 'currency', 'unit', 'rate_multiplier'].forEach((field) => {
    if (Object.hasOwn(profile, field)) projected[field] = profile[field];
  });
  if (isRecord(profile.resolution_rates)) {
    projected.resolution_rates = projectPublicMap(profile.resolution_rates, (rates) => {
      if (!isRecord(rates)) return rates;
      const projectedRates = {};
      ['without_video', 'with_video'].forEach((field) => {
        if (Object.hasOwn(rates, field)) projectedRates[field] = rates[field];
      });
      return projectedRates;
    });
  }
  return projected;
}

function projectEndpointMap(endpoints) {
  return projectPublicMap(endpoints, (endpoint) => {
    if (!isRecord(endpoint)) return undefined;
    return { method: endpoint.method, path: endpoint.path };
  });
}

function projectVideoDimensionSet(value) {
  if (!isRecord(value)) return value;
  return projectPublicMap(value, (geometrySet) => {
    if (!isRecord(geometrySet)) return undefined;
    return projectPublicMap(geometrySet, (dimensions) => (
      Array.isArray(dimensions) ? [...dimensions] : undefined
    ));
  });
}

function projectPublicMap(value, projectValue) {
  if (!isRecord(value)) return value;
  const projected = {};
  Object.entries(value).forEach(([key, entry]) => {
    // Map keys are public identifiers, not free-form object fields. Restrict
    // them to the identifier shape used by the reviewed NewAPI contract so
    // names such as private_secret can never cross the public boundary.
    if (!isPublicMapKey(key)) return;
    const projectedValue = projectValue(entry);
    if (projectedValue === undefined) return;
    projected[key] = projectedValue;
  });
  return projected;
}

function isPublicMapKey(key) {
  return /^[A-Za-z0-9][A-Za-z0-9:./-]{0,79}$/.test(key);
}

function clone(value) {
  return structuredClone(value);
}
