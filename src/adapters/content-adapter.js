import { docsFixture } from '../fixtures/docs.js';
import { pricingFixture } from '../fixtures/pricing.js';
import { HttpError } from '../http.js';

export const CONTENT_ADAPTER_FIXTURE = 'fixture';
export const CONTENT_ADAPTER_LIVE = 'newapi';
export const LIVE_CONTENT_VPC_BINDING = 'NEWAPI_VPC_SERVICE';
export const LIVE_CONTENT_ADAPTER_TOKEN = 'LIVE_CONTENT_ADAPTER_TOKEN';
export const LIVE_CONTENT_CONTRACT_VERSION = 'v1';
export const LIVE_CONTENT_ORIGIN = 'http://newapi-api.newapi:3000';
export const LIVE_CONTENT_TIMEOUT_MS = 5_000;
export const LIVE_CONTENT_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const PUBLIC_DEFAULT_GROUP_RATIO = 1.25;
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
  return {
    name: CONTENT_ADAPTER_FIXTURE,
    live: false,

    async getDocsCatalog() {
      return clone({
        meta: docsFixture.meta,
        sections: docsFixture.sections,
        search_index: docsFixture.search_index,
      });
    },

    async getDocPage(slug) {
      const page = docsFixture.pages.find((candidate) => candidate.slug === slug);
      if (!page) {
        throw new HttpError(404, 'Document page not found.');
      }
      return clone({ meta: docsFixture.meta, page });
    },

    async getPricing() {
      assertOrdinaryUserPricingContext(pricingFixture);
      return clone(pricingFixture);
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

  const fetchPayload = (path, kind) =>
    fetchLivePayload(env, token, path, kind, { timeoutMs, maxBodyBytes });
  return {
    name: CONTENT_ADAPTER_LIVE,
    live: true,

    async getDocsCatalog() {
      return clone(assertLiveDocsCatalog(await fetchPayload('/api/internal/live-content/v1/docs?locale=zh', 'docs_catalog')));
    },

    async getDocPage(slug) {
      if (!isSafeSlug(slug)) throw new HttpError(400, 'Invalid document slug.');
      const result = await fetchPayload(
        `/api/internal/live-content/v1/docs/${encodeURIComponent(slug)}?locale=zh`,
        'docs_page',
      );
      return clone(assertLiveDocsPage(result));
    },

    async getPricing() {
      return clone(assertLivePricing(await fetchPayload('/api/internal/live-content/v1/pricing', 'pricing')));
    },
  };
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
  const defaultGroupRatio = Number(
    payload.group_ratio[LOCKED_PRICING_CONTEXT.selected_group],
  );
  if (defaultGroupRatio !== PUBLIC_DEFAULT_GROUP_RATIO) {
    throw new HttpError(
      500,
      'Pricing adapter returned an invalid default group ratio; public pricing is fixed at 1.25.',
    );
  }
  if (!(LOCKED_PRICING_CONTEXT.selected_group in (payload.usable_group || {}))) {
    throw new HttpError(500, 'Pricing adapter omitted the default usable group.');
  }
  return payload;
}

function fetchLivePayload(env, token, path, kind, { timeoutMs, maxBodyBytes }) {
  const binding = env[LIVE_CONTENT_VPC_BINDING];
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(liveUnavailable('upstream_timeout'));
  }, timeoutMs);

  const request = new Request(`${LIVE_CONTENT_ORIGIN}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  });

  const upstream = Promise.resolve().then(() => binding.fetch(request));
  return Promise.race([upstream, timeout])
    .catch(() => {
      throw liveUnavailable(timedOut ? 'upstream_timeout' : 'upstream_transport');
    })
    .then(async (response) => {
      if (
        !response ||
        typeof response.status !== 'number' ||
        !response.headers ||
        typeof response.headers.get !== 'function'
      ) {
        throw liveUnavailable('invalid_upstream_response');
      }
      if (response.status === 404 && kind === 'docs_page') {
        throw new HttpError(404, 'Document page not found.');
      }
      if (!response.ok) {
        throw liveUnavailable('upstream_status');
      }
      if (response.headers.get('x-newapi-content-contract') !== LIVE_CONTENT_CONTRACT_VERSION) {
        throw liveUnavailable('invalid_upstream_contract');
      }
      const contentType = response.headers.get('content-type') || '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        throw liveUnavailable('invalid_upstream_content_type');
      }
      let raw;
      try {
        raw = await readBoundedBody(response, maxBodyBytes);
      } catch {
        throw liveUnavailable('invalid_upstream_body');
      }
      try {
        return JSON.parse(raw);
      } catch {
        throw liveUnavailable('invalid_upstream_json');
      }
    })
    .finally(() => clearTimeout(timer));
}

async function readBoundedBody(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error('upstream response too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('upstream response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
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
  return data;
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
  return data;
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
    if (item.enable_groups !== undefined && (!Array.isArray(item.enable_groups) || item.enable_groups.some((group) => typeof group !== 'string'))) schemaFailure();
  });
  if (!Array.isArray(payload.vendors) || payload.vendors.length > 1_000) schemaFailure();
  payload.vendors.forEach((vendor) => {
    if (!isRecord(vendor)) schemaFailure();
    if (!Number.isInteger(vendor.id) || vendor.id < 0) schemaFailure();
    assertString(vendor.name, 300);
  });
  if (!isRecord(payload.group_ratio) || payload.group_ratio.default !== PUBLIC_DEFAULT_GROUP_RATIO) schemaFailure();
  if (!isRecord(payload.usable_group) || typeof payload.usable_group.default !== 'string' || payload.usable_group.default.trim() === '') schemaFailure();
  if (!isRecord(payload.supported_endpoint)) schemaFailure();
  Object.values(payload.supported_endpoint).forEach((endpoint) => {
    if (!isRecord(endpoint)) schemaFailure();
    assertString(endpoint.method, 20);
    assertString(endpoint.path, 500);
  });
  if (!Array.isArray(payload.auto_groups) || payload.auto_groups.some((group) => typeof group !== 'string')) schemaFailure();
  assertVideoResolutionDimensions(payload.video_resolution_dimensions);
  if (typeof payload.pricing_version !== 'string' || payload.pricing_version.trim() === '') schemaFailure();
  return payload;
}

function assertVideoResolutionDimensions(value) {
  if (!isRecord(value)) schemaFailure();
  Object.values(value).forEach((resolutionSet) => {
    if (!isRecord(resolutionSet)) schemaFailure();
    Object.values(resolutionSet).forEach((geometrySet) => {
      if (!isRecord(geometrySet)) schemaFailure();
      Object.values(geometrySet).forEach((dimensions) => {
        if (!Array.isArray(dimensions) || dimensions.length !== 2 || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) schemaFailure();
      });
    });
  });
}

function assertEnvelope(payload, kind) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) schemaFailure();
  return payload.data;
}

function assertLiveMeta(meta, docs) {
  if (!isRecord(meta) || meta.source !== 'newapi' || meta.fixture !== false || meta.live !== true || meta.contract_version !== LIVE_CONTENT_CONTRACT_VERSION) schemaFailure();
  assertString(meta.label, 200);
  if (meta.updated_at !== null && (!Number.isInteger(meta.updated_at) || meta.updated_at < 0)) schemaFailure();
  if (docs && (!Number.isInteger(meta.schema_version) || !Number.isInteger(meta.renderer_version) || meta.schema_version < 1 || meta.renderer_version < 1)) schemaFailure();
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

function clone(value) {
  return structuredClone(value);
}
