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
export const LIVE_CONTENT_MAX_ENDPOINT_MAP_ENTRIES = 500;
// Match the finite coordinate limit already enforced by capability geometry.
export const LIVE_CONTENT_MAX_VIDEO_RESOLUTION_DIMENSION = 100_000;
// Seedance 2.5 currently publishes this inclusive request-size bound. Keep
// the compatibility limit finite so an upstream value cannot disable
// Worker-side validation entirely.
export const LIVE_CONTENT_MAX_SERIALIZED_REQUEST_BYTES = 64_000_000;
export const FRONT_DOOR_CONTENT_VPC_BINDING = LIVE_CONTENT_VPC_BINDING;
export const FRONT_DOOR_CONTENT_ORIGIN = LIVE_CONTENT_ORIGIN;
export const FRONT_DOOR_CONTENT_TIMEOUT_MS = LIVE_CONTENT_TIMEOUT_MS;
export const FRONT_DOOR_CONTENT_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const FRONT_DOOR_DOCS_NAVIGATION_PATH = '/api/front-door/v1/docs/v2/navigation?locale=zh';
export const FRONT_DOOR_PRICING_PATH = '/api/front-door/v1/pricing';
export const FRONT_DOOR_MAX_NAVIGATION_NODES = 50_000;
export const FRONT_DOOR_MAX_NAVIGATION_DEPTH = 100;
export const FRONT_DOOR_MAX_ENDPOINT_MAP_ENTRIES = 1_000;
export const FRONT_DOOR_MAX_QUERY_LENGTH = 2_048;
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

/**
 * Browser-session-only adapter for the approved normal-user front door.
 *
 * The private service binding is the only origin selector.  The upstream
 * request is deliberately assembled from the signed `session` cookie and the
 * matching `New-Api-User` identity; browser Authorization/API-key/provider
 * credentials and arbitrary browser headers never cross this boundary.
 */
export function createFrontDoorSessionAdapter(
  env = {},
  request,
  {
    timeoutMs = FRONT_DOOR_CONTENT_TIMEOUT_MS,
    maxBodyBytes = FRONT_DOOR_CONTENT_MAX_BODY_BYTES,
  } = {},
) {
  if (typeof env[FRONT_DOOR_CONTENT_VPC_BINDING]?.fetch !== 'function') {
    throw frontDoorUnavailable('missing_vpc_binding');
  }
  const credentials = extractFrontDoorCredentials(request);
  const fetchResponse = (path, kind) => fetchFrontDoorPayload(
    env,
    credentials,
    path,
    kind,
    { timeoutMs, maxBodyBytes },
  );
  return {
    name: 'front-door-session',
    live: true,
    async getPricingResponse() {
      return fetchResponse(FRONT_DOOR_PRICING_PATH, 'pricing');
    },
    async getDocsNavigationResponse() {
      return fetchResponse(
        FRONT_DOOR_DOCS_NAVIGATION_PATH,
        'docs_navigation',
      );
    },
  };
}

export function extractFrontDoorCredentials(request) {
  if (!(request instanceof Request)) {
    throw new HttpError(401, 'Browser session is required.');
  }
  if (hasFrontDoorCredentialQuery(request.url)) {
    throw new HttpError(401, 'Browser session is required.');
  }
  for (const header of FRONT_DOOR_REJECTED_HEADERS) {
    if (String(request.headers.get(header) || '').trim() !== '') {
      throw new HttpError(401, 'Browser session is required.');
    }
  }
  if (hasCredentialBearingHeader(request)) {
    throw new HttpError(401, 'Browser session is required.');
  }
  const cookie = extractSessionCookie(request.headers.get('cookie'));
  const identityHeader = request.headers.get('new-api-user');
  const identity = typeof identityHeader === 'string' ? identityHeader.trim() : '';
  const ifNoneMatch = extractSafeValidator(request.headers.get('if-none-match'));
  const acceptLanguage = extractSafeAcceptLanguage(request.headers.get('accept-language'));
  if (
    !cookie ||
    !identity ||
    identity.length > 255 ||
    identity !== identityHeader ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(identity)
  ) {
    throw new HttpError(401, 'Browser session is required.');
  }
  return Object.freeze({ cookie, identity, ifNoneMatch, acceptLanguage });
}

const FRONT_DOOR_REJECTED_HEADERS = Object.freeze([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'new-api-key',
  'x-newapi-live-content-token',
  'sec-websocket-protocol',
]);

function extractSessionCookie(header) {
  if (
    typeof header !== 'string' ||
    header.length > 16_384 ||
    header.includes(',') ||
    /[\u0000-\u001f\u007f]/.test(header)
  ) return '';
  const pairs = header.split(';');
  const sessionValues = [];
  for (const rawPair of pairs) {
    const pair = rawPair.trim();
    if (!pair) return '';
    const separator = pair.indexOf('=');
    if (separator <= 0) return '';
    const name = pair.slice(0, separator);
    // Whitespace/case variants of the session name are malformed rather than
    // an unrelated cookie. This also catches duplicate forms such as
    // `session=a; session =b`.
    if (/^session\s*=/i.test(pair)) {
      if (!pair.startsWith('session=')) return '';
      sessionValues.push(pair.slice('session='.length));
    } else if (isCredentialIdentifier(name, { rejectBareKey: true })) {
      return '';
    }
  }
  if (sessionValues.length !== 1) return '';
  const value = sessionValues[0];
  if (!value || value !== value.trim() || /[;\s,"]/g.test(value)) return '';
  return `session=${value}`;
}

function hasFrontDoorCredentialQuery(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return true;
  }
  return [...url.searchParams.keys()].some((key) => {
    return isCredentialIdentifier(key, { rejectBareKey: true });
  });
}

function hasCredentialBearingHeader(request) {
  for (const [name, value] of request.headers.entries()) {
    const lower = name.toLowerCase();
    if (FRONT_DOOR_REJECTED_HEADERS.includes(lower)) continue;
    if (lower === 'cookie' || lower === 'new-api-user') continue;
    if (String(value).trim() !== '' && isCredentialIdentifier(name)) return true;
  }
  return false;
}

function isCredentialIdentifier(value, { rejectBareKey = false } = {}) {
  if (typeof value !== 'string') return false;
  const normalized = value
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const compact = normalized.replace(/_/g, '');
  if (rejectBareKey && ['key', 'apikey', 'clientid'].includes(compact)) return true;
  if (/(?:^|_)(?:auth|authorization|bearer|password|passwd|credential|credentials|key|secret|signature|token)(?:_|$)/.test(normalized)) return true;
  if (/(?:^|_)(?:api|access|client|provider|signing|private|admin)[_-]?(?:key|token|secret|credential|id)(?:_|$)/.test(normalized)) return true;
  return /^(?:authorization|proxyauthorization|accesstoken|clientsecret|clientid|providerkey|apikey|newapikey)$/.test(compact);
}

function extractSafeValidator(value) {
  if (typeof value !== 'string' || value.length > FRONT_DOOR_MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '*') return trimmed || null;
  return parseEntityTagList(trimmed).every((candidate) => Boolean(verifiedEtag(candidate)))
    ? trimmed
    : null;
}

function extractSafeAcceptLanguage(value) {
  if (typeof value !== 'string' || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value.trim() || null;
}

async function fetchFrontDoorPayload(
  env,
  credentials,
  path,
  kind,
  { timeoutMs, maxBodyBytes },
) {
  const binding = env[FRONT_DOOR_CONTENT_VPC_BINDING];
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let rejectTimeout;
  const timeout = new Promise((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout(frontDoorUnavailable('upstream_timeout'));
  }, timeoutMs);
  const headers = new Headers({
    Accept: 'application/json',
    Cookie: credentials.cookie,
    'New-Api-User': credentials.identity,
  });
  if (credentials.acceptLanguage) headers.set('Accept-Language', credentials.acceptLanguage);
  if (credentials.ifNoneMatch) headers.set('If-None-Match', credentials.ifNoneMatch);
  try {
    let response;
    try {
      const operation = binding.fetch(new Request(`${FRONT_DOOR_CONTENT_ORIGIN}${path}`, {
          method: 'GET',
          headers,
          signal: controller.signal,
        }));
      response = await Promise.race([operation, timeout]);
    } catch {
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw frontDoorUnavailable('upstream_timeout');
      }
      throw frontDoorUnavailable('upstream_transport');
    }
    if (!response || !response.headers || ![200, 304].includes(response.status)) {
      if (response?.status === 401 || response?.status === 403) {
        throw new HttpError(401, 'Browser session is required.');
      }
      throw frontDoorUnavailable('upstream_status');
    }
    const rawEtag = response.headers.get('etag');
    const etag = verifiedEtag(rawEtag);
    if (rawEtag !== null && !etag) {
      throw frontDoorUnavailable('invalid_upstream_etag');
    }
    if (response.status === 304) {
      // A front-door 304 is meaningful only when the upstream echoed the
      // exact browser validator that the Worker forwarded. Weak-equivalent or
      // unrelated validators are not accepted across this auth boundary.
      if (!etag || !credentials.ifNoneMatch || etag !== credentials.ifNoneMatch) {
        throw frontDoorUnavailable('invalid_upstream_etag');
      }
      return { status: 304, payload: null, etag };
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      throw frontDoorUnavailable('invalid_upstream_content_type');
    }
    let raw;
    try {
      raw = await readBoundedBody(
        response,
        maxBodyBytes,
        controller.signal,
        deadline,
      );
    } catch (error) {
      if (controller.signal.aborted) throw frontDoorUnavailable('upstream_timeout');
      throw frontDoorUnavailable(
        error?.message === 'upstream response too large'
          ? 'upstream_body_too_large'
          : 'invalid_upstream_body',
      );
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw frontDoorUnavailable('invalid_upstream_json');
    }
    if (!payload || payload.success !== true || !Object.hasOwn(payload, 'data')) {
      throw frontDoorUnavailable('invalid_upstream_schema');
    }
    let projected;
    if (kind === 'pricing') projected = assertFrontDoorPricing(payload);
    else if (kind === 'docs_navigation') projected = assertFrontDoorNavigation(payload);
    else throw frontDoorUnavailable('invalid_upstream_schema');
    // Preserve a validated canonical validator when NewAPI supplies one so a
    // browser's next request can participate in the upstream 304 contract.
    // If it is absent, derive a deterministic Worker-owned validator from the
    // projected body instead of emitting an unstable or arbitrary value.
    const responseEtag = etag || stableFrontDoorEtag(kind, projected);
    if (credentials.ifNoneMatch && responseEtag === credentials.ifNoneMatch) {
      return { status: 304, payload: null, etag: responseEtag };
    }
    return { status: 200, payload: projected, etag: responseEtag };
  } finally {
    clearTimeout(timer);
  }
}

function assertFrontDoorPricing(payload) {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.data) || payload.data.length > 5_000 || !isRecord(payload.group_ratio) || !isRecord(payload.usable_group)) {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
  if (Object.keys(payload.group_ratio).length === 0 || Object.keys(payload.usable_group).length === 0 || Object.keys(payload.group_ratio).length > 500 || Object.keys(payload.usable_group).length > 500) {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
  for (const [key, ratio] of Object.entries(payload.group_ratio)) {
    if (!isCanonicalPublicIdentifier(key)) continue;
    if (!isFiniteNumber(ratio) || ratio < 0) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  for (const [key, label] of Object.entries(payload.usable_group)) {
    if (!isCanonicalPublicIdentifier(key)) continue;
    if (typeof label !== 'string' || label.length > 300 || label.trim() === '') throw frontDoorUnavailable('invalid_upstream_schema');
  }
  const publicGroupRatios = projectFrontDoorMap(payload.group_ratio, (value) => value);
  const publicUsableGroups = projectFrontDoorMap(payload.usable_group, (value) => value);
  if (Object.keys(publicGroupRatios).length === 0 || Object.keys(publicUsableGroups).length === 0) throw frontDoorUnavailable('invalid_upstream_schema');
  for (const group of Object.keys(publicUsableGroups)) {
    if (!Object.hasOwn(publicGroupRatios, group)) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  payload.data.forEach(assertFrontDoorPricingModel);
  if (!Array.isArray(payload.vendors) || payload.vendors.length > 1_000) throw frontDoorUnavailable('invalid_upstream_schema');
  payload.vendors.forEach(assertFrontDoorVendor);
  if (!isRecord(payload.supported_endpoint) || Object.keys(payload.supported_endpoint).length > FRONT_DOOR_MAX_ENDPOINT_MAP_ENTRIES) throw frontDoorUnavailable('invalid_upstream_schema');
  assertFrontDoorEndpointMap(payload.supported_endpoint);
  if (!Array.isArray(payload.auto_groups) || payload.auto_groups.length > 500) throw frontDoorUnavailable('invalid_upstream_schema');
  assertFrontDoorIdentifierArray(payload.auto_groups);
  if (!isRecord(payload.video_resolution_dimensions)) throw frontDoorUnavailable('invalid_upstream_schema');
  assertFrontDoorVideoDimensions(payload.video_resolution_dimensions);
  if (typeof payload.pricing_version !== 'string' || payload.pricing_version.length > 300 || payload.pricing_version.trim() === '') throw frontDoorUnavailable('invalid_upstream_schema');
  const projected = {
    success: true,
    data: payload.data.map((model) => projectPricingModel(model, { preserveIdentifierOrder: true, frontDoor: true })),
    vendors: payload.vendors.map(projectFrontDoorVendor),
    group_ratio: publicGroupRatios,
    usable_group: publicUsableGroups,
    supported_endpoint: projectFrontDoorEndpointMap(payload.supported_endpoint),
    auto_groups: projectFrontDoorIdentifierArray(payload.auto_groups),
    video_resolution_dimensions: projectFrontDoorVideoDimensions(payload.video_resolution_dimensions),
    pricing_version: payload.pricing_version,
  };
  projectOptionalFrontDoorPricingFields(payload, projected);
  return projected;
}


function assertFrontDoorNavigation(payload) {
  if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.data) || payload.data.length > 5_000) {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
  let nodeCount = 0;
  const visit = (nodes, depth = 0) => {
    if (depth > FRONT_DOOR_MAX_NAVIGATION_DEPTH || !Array.isArray(nodes) || nodes.length > 5_000 || nodeCount + nodes.length > FRONT_DOOR_MAX_NAVIGATION_NODES) {
      throw frontDoorUnavailable('invalid_upstream_schema');
    }
    nodeCount += nodes.length;
    for (const node of nodes) {
      if (!isRecord(node) || !['group', 'page'].includes(node.type) || !Number.isInteger(node.id) || node.id <= 0 || node.id > 2_147_483_647) {
        throw frontDoorUnavailable('invalid_upstream_schema');
      }
      if (typeof node.title !== 'string' || node.title.trim() === '' || node.title.length > 300) {
        throw frontDoorUnavailable('invalid_upstream_schema');
      }
      if (typeof node.slug !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,199}$/.test(node.slug)) {
        throw frontDoorUnavailable('invalid_upstream_schema');
      }
      if (!Number.isInteger(node.space_id) || node.space_id <= 0 || typeof node.locale !== 'string' || node.locale.length > 40 || node.locale.trim() === '') throw frontDoorUnavailable('invalid_upstream_schema');
      if (node.type === 'page' && (typeof node.path !== 'string' || node.path === '')) throw frontDoorUnavailable('invalid_upstream_schema');
      if (node.path !== undefined && (typeof node.path !== 'string' || node.path.length > 500 || !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(node.path))) {
        throw frontDoorUnavailable('invalid_upstream_schema');
      }
      for (const field of ['description', 'icon_key', 'locale']) {
        if (node[field] !== undefined && (typeof node[field] !== 'string' || node[field].length > 1_000)) throw frontDoorUnavailable('invalid_upstream_schema');
      }
      for (const field of ['space_id', 'parent_id', 'sort_key']) {
        if (node[field] !== undefined && (!Number.isInteger(node[field]) || node[field] < 0)) throw frontDoorUnavailable('invalid_upstream_schema');
      }
      if (node.enabled !== undefined && typeof node.enabled !== 'boolean') throw frontDoorUnavailable('invalid_upstream_schema');
      visit(node.children || [], depth + 1);
    }
  };
  visit(payload.data);
  return { success: true, data: projectFrontDoorNavigationNodes(payload.data) };
}

function assertFrontDoorPricingModel(model) {
  if (!isRecord(model) || typeof model.model_name !== 'string' || model.model_name.length > 300 || model.model_name.trim() === '') {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
  const stringFields = ['description', 'icon', 'tags', 'owner_by', 'billing_mode', 'billing_expr', 'codex_fast_base_model', 'video_geometry_contract', 'video_route_contract', 'video_input_duration_policy', 'pricing_version'];
  for (const field of stringFields) {
    if (model[field] !== undefined && (typeof model[field] !== 'string' || model[field].length > (field === 'billing_expr' ? 50_000 : 5_000))) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  for (const field of ['quota_type', 'model_ratio', 'model_price', 'owner_by', 'completion_ratio', 'enable_groups', 'supported_endpoint_types']) {
    if (!Object.hasOwn(model, field)) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  if (model.vendor_id !== undefined && (!Number.isInteger(model.vendor_id) || model.vendor_id < 0)) throw frontDoorUnavailable('invalid_upstream_schema');
  if (model.quota_type !== undefined && !Number.isInteger(model.quota_type)) throw frontDoorUnavailable('invalid_upstream_schema');
  for (const field of ['model_ratio', 'model_price', 'completion_ratio', 'cache_ratio', 'create_cache_ratio', 'image_ratio', 'audio_ratio', 'audio_completion_ratio']) {
    if (model[field] !== undefined && (!isFiniteNumber(model[field]) || model[field] < 0)) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  for (const field of ['image_generation_model', 'video_generation_model']) {
    if (model[field] !== undefined && typeof model[field] !== 'boolean') throw frontDoorUnavailable('invalid_upstream_schema');
  }
  if (model.enable_groups !== undefined) assertFrontDoorIdentifierArray(model.enable_groups);
  if (model.supported_endpoint_types !== undefined) assertFrontDoorIdentifierArray(model.supported_endpoint_types);
  if (model.endpoint_map !== undefined) assertFrontDoorEndpointMap(model.endpoint_map);
  if (model.video_pricing !== undefined) assertFrontDoorVideoPricing(model.video_pricing);
  if (model.codex_fast_pricing !== undefined) assertFrontDoorCodexPricing(model.codex_fast_pricing);
  if (model.video_capability !== undefined) assertFrontDoorVideoCapability(model.video_capability);
}

function assertFrontDoorVendor(vendor) {
  if (!isRecord(vendor) || !Number.isInteger(vendor.id) || vendor.id < 0 || typeof vendor.name !== 'string' || vendor.name.length > 300 || vendor.name.trim() === '') throw frontDoorUnavailable('invalid_upstream_schema');
  for (const field of ['description', 'icon']) {
    if (vendor[field] !== undefined && (typeof vendor[field] !== 'string' || vendor[field].length > 5_000)) throw frontDoorUnavailable('invalid_upstream_schema');
  }
}

function assertFrontDoorIdentifierArray(value) {
  if (!Array.isArray(value) || value.length > 1_000 || value.some((entry) => typeof entry !== 'string' || entry.length > 300 || !isCanonicalPublicIdentifier(entry))) throw frontDoorUnavailable('invalid_upstream_schema');
}

function assertFrontDoorEndpointMap(value) {
  if (!isRecord(value) || Object.keys(value).length > FRONT_DOOR_MAX_ENDPOINT_MAP_ENTRIES) throw frontDoorUnavailable('invalid_upstream_schema');
  for (const [key, endpoint] of Object.entries(value)) {
    if (!isCanonicalPublicIdentifier(key)) continue;
    if (!isRecord(endpoint) || typeof endpoint.method !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,19}$/.test(endpoint.method) || typeof endpoint.path !== 'string' || endpoint.path.length > 500 || !endpoint.path.startsWith('/')) throw frontDoorUnavailable('invalid_upstream_schema');
  }
}

function assertFrontDoorVideoPricing(profile) {
  if (!isRecord(profile) || profile.version !== 1 || !['USD', 'CNY'].includes(profile.currency) || profile.unit !== 'per_1m_completion_tokens' || !isFiniteNumber(profile.rate_multiplier) || profile.rate_multiplier <= 0 || !isRecord(profile.resolution_rates)) throw frontDoorUnavailable('invalid_upstream_schema');
  for (const [key, rates] of Object.entries(profile.resolution_rates)) {
    if (!isCanonicalPublicIdentifier(key)) continue;
    if (!isRecord(rates) || !isFiniteNumber(rates.without_video) || rates.without_video < 0 || !isFiniteNumber(rates.with_video) || rates.with_video < 0) throw frontDoorUnavailable('invalid_upstream_schema');
  }
}

function assertFrontDoorCodexPricing(profile) {
  if (!isRecord(profile) || profile.version !== 1 || !['multiplier', 'prices'].includes(profile.mode)) throw frontDoorUnavailable('invalid_upstream_schema');
  if (profile.mode === 'multiplier') {
    if (!isFiniteNumber(profile.multiplier) || profile.multiplier <= 0 || Object.hasOwn(profile, 'input_price') || Object.hasOwn(profile, 'output_price') || Object.hasOwn(profile, 'cached_input_price')) throw frontDoorUnavailable('invalid_upstream_schema');
  } else if (Object.hasOwn(profile, 'multiplier') || ['input_price', 'cached_input_price', 'output_price'].some((field) => !isFiniteNumber(profile[field]) || profile[field] < 0)) throw frontDoorUnavailable('invalid_upstream_schema');
}

function assertFrontDoorVideoCapability(value) {
  // The live-content schema validators are deliberately shared here: both
  // contracts expose the same bounded capability fields. Convert any failure
  // to the front-door's generic integration error below.
  try {
    assertLiveVideoCapability(value);
  } catch {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
}

function assertFrontDoorVideoDimensions(value) {
  try {
    assertVideoResolutionDimensions(value);
  } catch {
    throw frontDoorUnavailable('invalid_upstream_schema');
  }
}

function projectFrontDoorVendor(vendor) {
  const result = { id: vendor.id, name: vendor.name };
  if (vendor.description !== undefined) result.description = vendor.description;
  if (vendor.icon !== undefined) result.icon = vendor.icon;
  return result;
}

function projectFrontDoorMap(value, projectValue, { publicIdentifiers = false } = {}) {
  const projected = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!(publicIdentifiers ? isCanonicalPublicIdentifier(key) : isPublicMapKey(key))) return;
    projected[key] = projectValue(item);
  });
  return projected;
}

function projectFrontDoorIdentifierArray(values) {
  return values.filter((value) => isCanonicalPublicIdentifier(value)).slice();
}

function projectFrontDoorEndpointMap(value) {
  return projectFrontDoorMap(value, (endpoint) => ({ method: endpoint.method, path: endpoint.path }));
}

function projectFrontDoorVideoDimensions(value) {
  const options = { publicIdentifiers: true };
  return projectFrontDoorMap(value, (resolutionSet) => projectFrontDoorMap(
    resolutionSet,
    (geometrySet) => projectFrontDoorMap(geometrySet, (dimensions) => [...dimensions], options),
    options,
  ), options);
}

function projectFrontDoorNavigationNodes(nodes) {
  return nodes.map((node) => {
    const projected = { type: node.type, id: node.id, slug: node.slug, title: node.title };
    ['path', 'description', 'icon_key', 'space_id', 'parent_id', 'sort_key', 'locale', 'enabled'].forEach((field) => {
      if (node[field] !== undefined) projected[field] = node[field];
    });
    if (Array.isArray(node.children)) projected.children = projectFrontDoorNavigationNodes(node.children);
    return projected;
  });
}

function projectOptionalFrontDoorPricingFields(payload, projected) {
  const topLevelContextFields = ['user_group', 'selected_group', 'locked'];
  const topLevelContextCount = topLevelContextFields.filter((field) => Object.hasOwn(payload, field)).length;
  if (topLevelContextCount > 0 && topLevelContextCount < topLevelContextFields.length) throw frontDoorUnavailable('invalid_upstream_schema');
  if (isRecord(payload.context)) {
    if (typeof payload.context.user_group !== 'string' || typeof payload.context.selected_group !== 'string' || typeof payload.context.locked !== 'boolean') throw frontDoorUnavailable('invalid_upstream_schema');
    projected.context = { user_group: payload.context.user_group, selected_group: payload.context.selected_group, locked: payload.context.locked };
  }
  for (const field of ['user_group', 'selected_group']) {
    if (payload[field] !== undefined && (typeof payload[field] !== 'string' || payload[field].length > 300)) throw frontDoorUnavailable('invalid_upstream_schema');
    if (payload[field] !== undefined) projected[field] = payload[field];
  }
  if (payload.locked !== undefined) {
    if (typeof payload.locked !== 'boolean') throw frontDoorUnavailable('invalid_upstream_schema');
    projected.locked = payload.locked;
  }
  if (projected.user_group !== undefined && !Object.hasOwn(projected.usable_group, projected.user_group)) throw frontDoorUnavailable('invalid_upstream_schema');
  if (projected.selected_group !== undefined && (!Object.hasOwn(projected.usable_group, projected.selected_group) || !Object.hasOwn(projected.group_ratio, projected.selected_group))) throw frontDoorUnavailable('invalid_upstream_schema');
  const context = projected.context;
  if (context) {
    if (!Object.hasOwn(projected.usable_group, context.user_group) || !Object.hasOwn(projected.usable_group, context.selected_group) || !Object.hasOwn(projected.group_ratio, context.selected_group)) throw frontDoorUnavailable('invalid_upstream_schema');
    if (projected.user_group !== undefined && projected.user_group !== context.user_group) throw frontDoorUnavailable('invalid_upstream_schema');
    if (projected.selected_group !== undefined && projected.selected_group !== context.selected_group) throw frontDoorUnavailable('invalid_upstream_schema');
    if (projected.locked !== undefined && projected.locked !== context.locked) throw frontDoorUnavailable('invalid_upstream_schema');
  }
  if (isRecord(payload.display)) {
    const display = {};
    for (const field of ['quota_display_type', 'default_currency', 'custom_currency_symbol']) {
      if (payload.display[field] !== undefined && typeof payload.display[field] !== 'string') throw frontDoorUnavailable('invalid_upstream_schema');
      if (payload.display[field] !== undefined) display[field] = payload.display[field];
    }
    for (const field of ['price', 'usd_exchange_rate', 'custom_currency_exchange_rate']) {
      if (payload.display[field] !== undefined && !isFiniteNumber(payload.display[field])) throw frontDoorUnavailable('invalid_upstream_schema');
      if (payload.display[field] !== undefined) display[field] = payload.display[field];
    }
    if (payload.display.show_with_recharge !== undefined) {
      if (typeof payload.display.show_with_recharge !== 'boolean') throw frontDoorUnavailable('invalid_upstream_schema');
      display.show_with_recharge = payload.display.show_with_recharge;
    }
    projected.display = display;
  }
  if (isRecord(payload.meta)) {
    if (payload.meta.source !== 'newapi' || payload.meta.fixture !== false || payload.meta.live !== true) throw frontDoorUnavailable('invalid_upstream_schema');
    const meta = {};
    ['source', 'fixture', 'live', 'label', 'updated_at', 'contract_version', 'notice'].forEach((field) => {
      if (payload.meta[field] !== undefined && (typeof payload.meta[field] !== 'string' && typeof payload.meta[field] !== 'boolean' && typeof payload.meta[field] !== 'number' && payload.meta[field] !== null)) throw frontDoorUnavailable('invalid_upstream_schema');
      if (payload.meta[field] !== undefined) meta[field] = payload.meta[field];
    });
    projected.meta = meta;
  }
}

function stableFrontDoorEtag(kind, payload) {
  return `"front-door-${kind}-${fnv1a64(canonicalJson(payload))}"`;
}



function frontDoorUnavailable(reason) {
  return new HttpError(503, 'Live content is temporarily unavailable.', {
    configured_adapter: 'front-door-session',
    live_integration: true,
    reason,
  });
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
      etag: options.etag,
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
    stablePricingEtag,
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

  async function fetchAndValidate(path, kind, options, validator, etag) {
    return fetchPayload(path, kind, {
      ...options,
      transform: (payload) => clone(validator(payload)),
      etag,
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
  {
    timeoutMs,
    maxBodyBytes,
    ifNoneMatch = undefined,
    transform = (value) => value,
    etag: projectEtag = undefined,
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
      return { status: 200, payload: validated, etag: publicEtag };
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
    ['description', 'icon', 'tags', 'owner_by', 'billing_mode', 'billing_expr', 'codex_fast_base_model', 'video_geometry_contract', 'video_route_contract', 'video_input_duration_policy', 'pricing_version'].forEach((field) => {
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
    if (item.enable_groups !== undefined) assertLiveIdentifierArray(item.enable_groups);
    if (item.supported_endpoint_types !== undefined) assertLiveIdentifierArray(item.supported_endpoint_types);
    if (item.endpoint_map !== undefined) assertLiveEndpointMap(item.endpoint_map);
    if (item.video_pricing !== undefined) assertLiveVideoPricing(item.video_pricing);
    if (item.codex_fast_pricing !== undefined) assertLiveCodexFastPricing(item.codex_fast_pricing);
    if (item.video_capability !== undefined) assertLiveVideoCapability(item.video_capability);
  });
  if (!Array.isArray(payload.vendors) || payload.vendors.length > 1_000) schemaFailure();
  payload.vendors.forEach((vendor) => {
    if (!isRecord(vendor)) schemaFailure();
    if (!Number.isInteger(vendor.id) || vendor.id < 0) schemaFailure();
    assertString(vendor.name, 300);
    if (vendor.description !== undefined) assertString(vendor.description, 5_000, { allowEmpty: true });
    if (vendor.icon !== undefined) assertString(vendor.icon, 5_000, { allowEmpty: true });
  });
  assertLiveGroupRatios(payload.group_ratio);
  if (!isRecord(payload.usable_group) || typeof payload.usable_group.default !== 'string' || payload.usable_group.default.trim() === '') schemaFailure();
  if (!isRecord(payload.supported_endpoint)) schemaFailure();
  if (Object.keys(payload.supported_endpoint).length > LIVE_CONTENT_MAX_ENDPOINT_MAP_ENTRIES) schemaFailure();
  Object.entries(payload.supported_endpoint).forEach(([key, endpoint]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(endpoint)) schemaFailure();
    assertString(endpoint.method, 20);
    assertString(endpoint.path, 500);
  });
  assertLiveIdentifierArray(payload.auto_groups);
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
  if (Object.keys(value).length > 500) schemaFailure();
  Object.entries(value).forEach(([key, resolutionSet]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(resolutionSet)) schemaFailure();
    if (Object.keys(resolutionSet).length > 100) schemaFailure();
    Object.entries(resolutionSet).forEach(([geometryKey, geometrySet]) => {
      if (!isPublicMapKey(geometryKey)) return;
      if (!isRecord(geometrySet)) schemaFailure();
      if (Object.keys(geometrySet).length > 100) schemaFailure();
      Object.entries(geometrySet).forEach(([dimensionKey, dimensions]) => {
        if (!isPublicMapKey(dimensionKey)) return;
        if (!Array.isArray(dimensions) || dimensions.length !== 2 || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0 || dimension > LIVE_CONTENT_MAX_VIDEO_RESOLUTION_DIMENSION)) schemaFailure();
      });
    });
  });
}

function assertLiveVideoPricing(profile) {
  if (!isRecord(profile) || profile.version !== 1) schemaFailure();
  assertString(profile.currency, 20);
  assertString(profile.unit, 80);
  if (!['USD', 'CNY'].includes(profile.currency) || profile.unit !== 'per_1m_completion_tokens') schemaFailure();
  if (!isFiniteNumber(profile.rate_multiplier) || profile.rate_multiplier <= 0) schemaFailure();
  if (!isRecord(profile.resolution_rates)) schemaFailure();
  if (Object.keys(profile.resolution_rates).length > 100) schemaFailure();
  Object.entries(profile.resolution_rates).forEach(([key, rates]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(rates)) schemaFailure();
    ['without_video', 'with_video'].forEach((field) => {
      if (!isFiniteNumber(rates[field]) || rates[field] < 0) schemaFailure();
    });
  });
}

function assertLiveIdentifierArray(value, maxLength = 500) {
  if (!Array.isArray(value) || value.length > maxLength || value.some((entry) => typeof entry !== 'string' || entry.length > 200)) schemaFailure();
}

function assertLiveEndpointMap(value) {
  if (!isRecord(value) || Object.keys(value).length > LIVE_CONTENT_MAX_ENDPOINT_MAP_ENTRIES) schemaFailure();
  Object.entries(value).forEach(([key, endpoint]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(endpoint)) schemaFailure();
    assertString(endpoint.method, 20);
    assertString(endpoint.path, 500);
  });
}

function assertLiveCodexFastPricing(profile) {
  if (!isRecord(profile) || profile.version !== 1 || !['multiplier', 'prices'].includes(profile.mode)) schemaFailure();
  const hasMultiplier = Object.hasOwn(profile, 'multiplier');
  const hasExplicit = ['input_price', 'cached_input_price', 'output_price'].some((field) => Object.hasOwn(profile, field));
  if (profile.mode === 'multiplier') {
    if (!hasMultiplier || !isFiniteNumber(profile.multiplier) || profile.multiplier <= 0 || hasExplicit) schemaFailure();
  } else {
    if (hasMultiplier || ['input_price', 'cached_input_price', 'output_price'].some((field) => !isFiniteNumber(profile[field]) || profile[field] < 0)) schemaFailure();
  }
}

function assertLiveVideoCapability(value) {
  if (!isRecord(value)) schemaFailure();
  assertString(value.model, 300);
  assertLiveIdentifierArray(value.mapped_upstream_models);
  if (!Number.isInteger(value.schema_version) || value.schema_version < 1 || value.schema_version > 100) schemaFailure();
  if (!isRecord(value.profile)) schemaFailure();
  assertString(value.profile.name, 300);
  assertString(value.profile.label, 1_000, { allowEmpty: true });
  if (!Number.isInteger(value.profile.revision) || value.profile.revision < 1) schemaFailure();
  assertString(value.profile.checksum, 300);
  assertLiveVideoCapabilityOutput(value.output);
  if (!isRecord(value.audio) || typeof value.audio.generate_audio_supported !== 'boolean') schemaFailure();
  if (value.audio.generate_audio_default !== undefined && typeof value.audio.generate_audio_default !== 'boolean') schemaFailure();
  assertLiveVideoCapabilityMedia(value.media);
  assertLiveVideoGeometry(value.geometry);
  if (value.image_size !== undefined) {
    const image = value.image_size;
    if (!isRecord(image) || !Number.isInteger(image.max_single_decoded_bytes) || image.max_single_decoded_bytes < 0 || image.max_single_decoded_bytes > 100 * 1024 * 1024 || typeof image.single_limit_exclusive !== 'boolean') schemaFailure();
    if (image.single_limit_label !== undefined) assertString(image.single_limit_label, 200, { allowEmpty: true });
    if (image.max_total_decoded_bytes !== undefined && (!Number.isInteger(image.max_total_decoded_bytes) || image.max_total_decoded_bytes < 0 || image.max_total_decoded_bytes > 500 * 1024 * 1024)) schemaFailure();
    if (image.total_limit_label !== undefined) assertString(image.total_limit_label, 200, { allowEmpty: true });
  }
  if (
    value.max_serialized_request_bytes !== undefined &&
    (!Number.isInteger(value.max_serialized_request_bytes) ||
      value.max_serialized_request_bytes < 0 ||
      value.max_serialized_request_bytes > LIVE_CONTENT_MAX_SERIALIZED_REQUEST_BYTES)
  ) schemaFailure();
}

function assertLiveVideoCapabilityOutput(value) {
  if (!isRecord(value)) schemaFailure();
  assertLiveIdentifierArray(value.resolutions);
  assertString(value.default_resolution, 100);
  if (value.known_unsupported_resolutions !== undefined) assertLiveIdentifierArray(value.known_unsupported_resolutions);
  assertLiveIdentifierArray(value.ratios);
  assertString(value.default_ratio, 100);
  ['duration_min', 'duration_max'].forEach((field) => {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 100_000) schemaFailure();
  });
  if (!Number.isInteger(value.default_duration) || value.default_duration < -1 || value.default_duration > 100_000) schemaFailure();
  if (typeof value.allow_auto_duration !== 'boolean') schemaFailure();
  assertLiveIdentifierArray(value.output_formats);
  if (value.default_output_format !== undefined) assertString(value.default_output_format, 100, { allowEmpty: true });
}

function assertLiveVideoCapabilityMedia(value) {
  if (!isRecord(value)) schemaFailure();
  ['max_images', 'max_videos', 'max_audios'].forEach((field) => {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > 500) schemaFailure();
  });
  ['allow_video_only_reference', 'allow_audio_only_reference'].forEach((field) => {
    if (typeof value[field] !== 'boolean') schemaFailure();
  });
  if (!isRecord(value.modes) || Object.keys(value.modes).length > 100) schemaFailure();
  Object.entries(value.modes).forEach(([key, mode]) => {
    if (!isPublicMapKey(key)) return;
    if (!isRecord(mode)) schemaFailure();
    if (typeof mode.selectable !== 'boolean') schemaFailure();
    assertLiveIdentifierArray(mode.ratios);
    ['duration_min', 'duration_max', 'min_images', 'max_images', 'min_reference_videos'].forEach((field) => {
      if (mode[field] !== undefined && (!Number.isInteger(mode[field]) || mode[field] < 0 || mode[field] > 100_000)) schemaFailure();
    });
    ['allow_auto_duration', 'duration_upstream_validated'].forEach((field) => {
      if (mode[field] !== undefined && typeof mode[field] !== 'boolean') schemaFailure();
    });
    if (mode.required_video_roles !== undefined) assertLiveIdentifierArray(mode.required_video_roles);
  });
}

function assertLiveVideoGeometry(value) {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length > 500) schemaFailure();
  Object.entries(value).forEach(([resolution, ratios]) => {
    if (!isPublicMapKey(resolution)) return;
    if (!isRecord(ratios) || Object.keys(ratios).length > 100) schemaFailure();
    Object.entries(ratios).forEach(([ratio, dimensions]) => {
      if (!isPublicMapKey(ratio)) return;
      if (!Array.isArray(dimensions) || dimensions.length !== 2 || dimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0 || dimension > LIVE_CONTENT_MAX_VIDEO_RESOLUTION_DIMENSION)) schemaFailure();
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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const PUBLIC_PRICING_MODEL_FIELDS = [
  'model_name',
  'description',
  'icon',
  'tags',
  'vendor_id',
  'owner_by',
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
  'codex_fast_base_model',
  'video_geometry_contract',
  'video_route_contract',
  'video_input_duration_policy',
  'pricing_version',
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
  const models = payload.data.map(projectPricingModel);
  models.sort(comparePricingModels);
  const vendors = payload.vendors.map((vendor) => {
    const projected = { id: vendor.id, name: vendor.name };
    if (vendor.description !== undefined) projected.description = vendor.description;
    if (vendor.icon !== undefined) projected.icon = vendor.icon;
    return projected;
  });
  vendors.sort(comparePricingVendors);
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
    data: models,
    vendors,
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

// NewAPI may serialize equivalent model sets in different array orders. Use
// the public model_name as the primary, locale-independent ordering key; the
// canonical projected model is only a deterministic tie-breaker for duplicate
// names. Neither step changes a model field or value.
function comparePricingModels(left, right) {
  const byName = compareStableStrings(left.model_name, right.model_name);
  if (byName !== 0) return byName;
  return compareStableStrings(canonicalJson(left), canonicalJson(right));
}

// Vendor ids are the stable public identity. The remaining comparisons make
// duplicate or malformed identities deterministic without changing values.
function comparePricingVendors(left, right) {
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  const byName = compareStableStrings(left.name, right.name);
  if (byName !== 0) return byName;
  return compareStableStrings(canonicalJson(left), canonicalJson(right));
}

function compareStableStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stablePricingEtag(payload) {
  return `"pricing-${fnv1a64(canonicalJson(payload))}"`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareStableStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 'null' : serialized;
}

function fnv1a64(value) {
  let hash = 14695981039346656037n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(16).padStart(16, '0');
}

function projectPricingModel(model, { preserveIdentifierOrder = false, frontDoor = false } = {}) {
  const projected = {};
  const projectIdentifiers = preserveIdentifierOrder
    ? projectFrontDoorIdentifierArray
    : projectPublicIdentifierArray;
  const projectMap = frontDoor
    ? (value, projectValue) => projectFrontDoorMap(value, projectValue, { publicIdentifiers: true })
    : projectPublicMap;
  PUBLIC_PRICING_MODEL_FIELDS.forEach((field) => {
    if (!Object.hasOwn(model, field)) return;
    if (field === 'enable_groups' || field === 'supported_endpoint_types') {
      projected[field] = projectIdentifiers(model[field]);
    } else {
      projected[field] = model[field];
    }
  });
  if (Object.hasOwn(model, 'video_pricing')) {
    projected.video_pricing = projectVideoPricing(model.video_pricing, projectMap);
  }
  if (Object.hasOwn(model, 'codex_fast_pricing')) {
    projected.codex_fast_pricing = projectCodexFastPricing(model.codex_fast_pricing);
  }
  if (Object.hasOwn(model, 'endpoint_map')) {
    projected.endpoint_map = projectEndpointMap(model.endpoint_map, projectMap);
  }
  if (Object.hasOwn(model, 'video_capability')) {
    projected.video_capability = projectVideoCapability(model.video_capability, projectIdentifiers, projectMap);
  }
  return projected;
}

function projectPublicIdentifierArray(values) {
  return values
    .filter((value) => isPublicMapKey(value))
    .sort(compareStableStrings);
}

function projectVideoPricing(profile, projectMap = projectPublicMap) {
  if (!isRecord(profile)) return profile;
  const projected = {};
  ['version', 'currency', 'unit', 'rate_multiplier'].forEach((field) => {
    if (Object.hasOwn(profile, field)) projected[field] = profile[field];
  });
  if (isRecord(profile.resolution_rates)) {
    projected.resolution_rates = projectMap(profile.resolution_rates, (rates) => {
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

function projectCodexFastPricing(profile) {
  const projected = { version: profile.version, mode: profile.mode };
  if (Object.hasOwn(profile, 'multiplier')) projected.multiplier = profile.multiplier;
  ['input_price', 'cached_input_price', 'output_price'].forEach((field) => {
    if (Object.hasOwn(profile, field)) projected[field] = profile[field];
  });
  return projected;
}

function projectVideoCapability(value, projectIdentifiers = projectPublicIdentifierArray, projectMap = projectPublicMap) {
  const projected = {
    model: value.model,
    mapped_upstream_models: projectIdentifiers(value.mapped_upstream_models),
    schema_version: value.schema_version,
    profile: {
      name: value.profile.name,
      label: value.profile.label,
      revision: value.profile.revision,
      checksum: value.profile.checksum,
    },
    output: {
      resolutions: projectIdentifiers(value.output.resolutions),
      default_resolution: value.output.default_resolution,
      ratios: projectIdentifiers(value.output.ratios),
      default_ratio: value.output.default_ratio,
      duration_min: value.output.duration_min,
      duration_max: value.output.duration_max,
      allow_auto_duration: value.output.allow_auto_duration,
      default_duration: value.output.default_duration,
      output_formats: projectIdentifiers(value.output.output_formats),
    },
    audio: {
      generate_audio_supported: value.audio.generate_audio_supported,
    },
    media: {
      max_images: value.media.max_images,
      max_videos: value.media.max_videos,
      max_audios: value.media.max_audios,
      allow_video_only_reference: value.media.allow_video_only_reference,
      allow_audio_only_reference: value.media.allow_audio_only_reference,
      modes: projectMap(value.media.modes, (mode) => projectVideoCapabilityMode(mode, projectIdentifiers, projectMap)),
    },
  };
  if (value.output.known_unsupported_resolutions !== undefined) projected.output.known_unsupported_resolutions = projectIdentifiers(value.output.known_unsupported_resolutions);
  if (value.output.default_output_format !== undefined) projected.output.default_output_format = value.output.default_output_format;
  if (Object.hasOwn(value.audio, 'generate_audio_default')) projected.audio.generate_audio_default = value.audio.generate_audio_default;
  if (value.geometry !== undefined) projected.geometry = projectVideoCapabilityGeometry(value.geometry, projectMap);
  if (value.image_size !== undefined) {
    projected.image_size = {
      max_single_decoded_bytes: value.image_size.max_single_decoded_bytes,
      single_limit_exclusive: value.image_size.single_limit_exclusive,
    };
    ['single_limit_label', 'max_total_decoded_bytes', 'total_limit_label'].forEach((field) => {
      if (Object.hasOwn(value.image_size, field)) projected.image_size[field] = value.image_size[field];
    });
  }
  if (value.max_serialized_request_bytes !== undefined) projected.max_serialized_request_bytes = value.max_serialized_request_bytes;
  return projected;
}

function projectVideoCapabilityMode(mode, projectIdentifiers = projectPublicIdentifierArray, projectMap = projectPublicMap) {
  const projected = {
    selectable: mode.selectable,
    ratios: projectIdentifiers(mode.ratios),
    min_images: mode.min_images,
    max_images: mode.max_images,
  };
  ['duration_min', 'duration_max', 'allow_auto_duration', 'min_reference_videos', 'duration_upstream_validated'].forEach((field) => {
    if (Object.hasOwn(mode, field)) projected[field] = mode[field];
  });
  if (mode.required_video_roles !== undefined) projected.required_video_roles = projectIdentifiers(mode.required_video_roles);
  return projected;
}

function projectVideoCapabilityGeometry(value, projectMap = projectPublicMap) {
  return projectMap(value, (ratios) => projectMap(ratios, (dimensions) => [...dimensions]));
}

function projectEndpointMap(endpoints, projectMap = projectPublicMap) {
  return projectMap(endpoints, (endpoint) => {
    if (!isRecord(endpoint)) return undefined;
    return { method: endpoint.method, path: endpoint.path };
  });
}

function projectVideoDimensionSet(value, projectMap = projectPublicMap) {
  if (!isRecord(value)) return value;
  return projectMap(value, (geometrySet) => {
    if (!isRecord(geometrySet)) return undefined;
    return projectMap(geometrySet, (dimensions) => (
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
  if (typeof key !== 'string' || key.startsWith('__')) return false;
  // Treat secret-bearing words as separator-delimited identifier segments,
  // including acronym-style and ordinary camel-case segments, without
  // rejecting public names such as tokenization or api_endpoint.
  // Split an acronym run before its final capitalized segment (`APIKey` ->
  // `API_Key`) before applying the ordinary lower-to-upper boundary.
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-:.\/]+/g, '_')
    .toLowerCase();
  const compact = normalized.replace(/_/g, '');
  if (/(?:^|_)(?:authorization|cookie|password|credential|secret|private_key)(?:_|$)/.test(normalized)) return false;
  if (/(?:^|_)(?:service|client|provider)_(?:secret|token|key)(?:_|$)/.test(normalized)) return false;
  if (/(?:^|_)api_(?:key|token)(?:_|$)/.test(normalized)) return false;
  // Preserve the previous exact-name coverage for historical spellings such
  // as `apikey` and `privatesecret`, while also covering their token/key
  // equivalents.
  if (/^(?:api(?:key|token)|private(?:key|secret))$/.test(compact)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_:.\/-]{0,79}$/.test(key);
}

// Front-door map keys are canonical public identifiers.  Unlike arbitrary
// upstream object fields, a group/vendor/endpoint identifier is user-visible
// data and may legitimately contain words such as "token".  Keep the
// credential/private classification limited to the reviewed field names above.
function isCanonicalPublicIdentifier(key) {
  if (typeof key !== 'string' || key.startsWith('__')) return false;
  const normalized = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-:.\/]+/g, '_')
    .toLowerCase();
  const compact = normalized.replace(/_/g, '');
  if (new Set([
    'authorization', 'authorizationheader', 'cookie', 'password', 'passwd',
    'credential', 'credentials', 'secret', 'privatesecret', 'privatekey',
    'apikey', 'apitoken', 'clientsecret', 'clientkey', 'clienttoken',
    'providersecret', 'providerkey', 'providertoken', 'servicesecret',
    'servicekey', 'servicetoken', 'oauthsecret', 'oauthkey', 'oauthtoken',
  ]).has(compact)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_:.\/-]{0,299}$/.test(key);
}

function clone(value) {
  return structuredClone(value);
}
