import { HttpError } from '../http.js';

export const STATUS_ORIGIN = 'http://newapi-api.newapi:3000';
export const STATUS_PATH = '/api/status';
export const STATUS_TIMEOUT_MS = 5_000;
export const STATUS_MAX_BODY_BYTES = 256 * 1024;
export const STATUS_MAX_DATA_FIELDS = 64;

const STATUS_STRING_LIMITS = Object.freeze({
  secure_api_public_key: 16_384,
  secure_api_key_id: 128,
  quota_display_type: 32,
  default_currency: 32,
  custom_currency_symbol: 32,
});

const STATUS_BOOLEAN_FIELDS = new Set([
  'secure_api_enabled',
  'display_in_currency',
]);

const STATUS_NUMBER_LIMITS = Object.freeze({
  server_time: [0, 4_294_967_295],
  secure_api_timestamp_window_seconds: [1, 86_400],
  price: [0, Number.MAX_SAFE_INTEGER],
  usd_exchange_rate: [0, Number.MAX_SAFE_INTEGER],
  custom_currency_exchange_rate: [0, Number.MAX_SAFE_INTEGER],
});

const STATUS_PUBLIC_FIELDS = new Set([
  ...Object.keys(STATUS_STRING_LIMITS),
  ...Object.keys(STATUS_NUMBER_LIMITS),
  ...STATUS_BOOLEAN_FIELDS,
  'model_marketplace_default',
]);

export function createStatusAdapter(
  env = {},
  {
    timeoutMs = STATUS_TIMEOUT_MS,
    maxBodyBytes = STATUS_MAX_BODY_BYTES,
  } = {},
) {
  if (typeof env.NEWAPI_VPC_SERVICE?.fetch !== 'function') {
    throw statusUnavailable('missing_vpc_binding');
  }

  const boundedTimeoutMs = boundedPositiveInteger(timeoutMs, STATUS_TIMEOUT_MS);
  const boundedBodyBytes = boundedPositiveInteger(maxBodyBytes, STATUS_MAX_BODY_BYTES);

  return {
    name: 'newapi-status',
    live: true,
    async getResponse(options = {}) {
      return fetchStatusPayload(env, {
        timeoutMs: boundedTimeoutMs,
        maxBodyBytes: boundedBodyBytes,
        frontDoor: options.frontDoor === true,
      });
    },
  };
}

async function fetchStatusPayload(env, { timeoutMs, maxBodyBytes, frontDoor = false }) {
  const binding = env.NEWAPI_VPC_SERVICE;
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
    rejectTimeout(statusUnavailable('upstream_timeout'));
  }, timeoutMs);

  // This is deliberately a newly constructed request. No browser Request or
  // headers are copied across the private service boundary.
  const upstreamRequest = new Request(`${STATUS_ORIGIN}${STATUS_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  });

  const operation = (async () => {
    assertBeforeDeadline(deadline, controller);
    let response;
    try {
      response = await binding.fetch(upstreamRequest);
    } catch {
      throw statusUnavailable(timedOut || controller.signal.aborted ? 'upstream_timeout' : 'upstream_transport');
    }
    upstreamResponse = response;
    assertBeforeDeadline(deadline, controller);
    if (!response || response.status !== 200 || !response.headers || typeof response.headers.get !== 'function') {
      throw statusUnavailable('upstream_status');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      throw statusUnavailable('invalid_upstream_content_type');
    }

    let raw;
    try {
      raw = await readBoundedBody(response, maxBodyBytes, controller.signal, deadline);
    } catch (error) {
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw statusUnavailable('upstream_timeout');
      }
      throw statusUnavailable(error?.message === 'upstream response too large'
        ? 'upstream_body_too_large'
        : 'invalid_upstream_body');
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw statusUnavailable('invalid_upstream_json');
    }
    return projectStatusPayload(payload, { frontDoor });
  })();

  return Promise.race([operation, timeout])
    .catch((error) => {
      if (error instanceof HttpError) throw error;
      throw statusUnavailable(timedOut || controller.signal.aborted ? 'upstream_timeout' : 'upstream_transport');
    })
    .finally(() => clearTimeout(timer));
}

function projectStatusPayload(payload, { frontDoor = false } = {}) {
  if (!isRecord(payload) || payload.success !== true || !isRecord(payload.data)) {
    throw statusUnavailable('invalid_upstream_schema');
  }
  if (Object.keys(payload.data).length > STATUS_MAX_DATA_FIELDS) {
    throw statusUnavailable('invalid_upstream_schema');
  }
  const data = {};
  for (const [field, value] of Object.entries(payload.data)) {
    if (!STATUS_PUBLIC_FIELDS.has(field)) continue;
    if (frontDoor && (
      field === 'secure_api_enabled' ||
      field === 'secure_api_public_key' ||
      field === 'secure_api_key_id' ||
      field === 'secure_api_timestamp_window_seconds'
    )) continue;
    if (STATUS_STRING_LIMITS[field] !== undefined) {
      if (typeof value !== 'string' || value.length > STATUS_STRING_LIMITS[field]) {
        throw statusUnavailable('invalid_upstream_schema');
      }
      data[field] = value;
      continue;
    }
    if (STATUS_BOOLEAN_FIELDS.has(field)) {
      if (typeof value !== 'boolean') throw statusUnavailable('invalid_upstream_schema');
      data[field] = value;
      continue;
    }
    if (STATUS_NUMBER_LIMITS[field] !== undefined) {
      const [minimum, maximum] = STATUS_NUMBER_LIMITS[field];
      if (!Number.isFinite(value) || value < minimum || value > maximum || (
        ['price', 'usd_exchange_rate', 'custom_currency_exchange_rate'].includes(field) && value <= 0
      )) {
        throw statusUnavailable('invalid_upstream_schema');
      }
      data[field] = value;
      continue;
    }
    if (field === 'model_marketplace_default') {
      data[field] = projectMarketplaceDefault(value);
    }
  }

  const response = { success: true };
  if (Object.hasOwn(payload, 'message')) {
    if (typeof payload.message !== 'string' || payload.message.length > 512) {
      throw statusUnavailable('invalid_upstream_schema');
    }
    response.message = payload.message;
  }
  if (frontDoor) {
    // The canonical same-origin bundle consumes this public bootstrap before
    // calling the authenticated front door. Explicitly disable its secure-API
    // interceptor and never expose key material or signing windows here.
    data.secure_api_enabled = false;
  }
  response.data = data;
  return { status: 200, payload: response };
}

function projectMarketplaceDefault(value) {
  if (!isRecord(value)) throw statusUnavailable('invalid_upstream_schema');
  const result = {};
  for (const field of ['vendor', 'group']) {
    if (value[field] !== undefined) {
      if (typeof value[field] !== 'string' || value[field].length > 300) {
        throw statusUnavailable('invalid_upstream_schema');
      }
      result[field] = value[field];
    }
  }
  if (Object.keys(result).length > 2) throw statusUnavailable('invalid_upstream_schema');
  return result;
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
  let completed = false;
  let cancelled = false;
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
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function assertBeforeDeadline(deadline, controller = undefined) {
  if (Date.now() < deadline) return;
  controller?.abort();
  throw statusUnavailable('upstream_timeout');
}

function boundedPositiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function statusUnavailable(reason) {
  return new HttpError(503, 'Status is temporarily unavailable.', {
    configured_adapter: 'newapi-status',
    live_integration: true,
    reason,
  });
}
