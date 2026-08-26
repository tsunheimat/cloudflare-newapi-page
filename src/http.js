export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function json(data, status = 200, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('content-type', 'application/json; charset=utf-8');
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data), { status, headers });
}

export function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  applySecurityHeaders(secured.headers);
  return secured;
}

// Downstream Workers own their HTML/admin CSP. Applying this SPA's strict
// style-src policy to their inline-style documents would break them. Keep any
// downstream CSP byte-for-byte and add only response-agnostic headers that are
// absent.
export function withDownstreamSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  applyTransportSecurityHeaders(secured.headers, { preserveExisting: true });
  return secured;
}

export function applySecurityHeaders(headers) {
  applyTransportSecurityHeaders(headers);
  headers.set(
    'content-security-policy',
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
}

function applyTransportSecurityHeaders(
  headers,
  { preserveExisting = false } = {},
) {
  setHeader(headers, 'x-content-type-options', 'nosniff', preserveExisting);
  setHeader(
    headers,
    'referrer-policy',
    'strict-origin-when-cross-origin',
    preserveExisting,
  );
  setHeader(headers, 'x-frame-options', 'DENY', preserveExisting);
  setHeader(
    headers,
    'permissions-policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
    preserveExisting,
  );
}

function setHeader(headers, name, value, preserveExisting) {
  if (!preserveExisting || !headers.has(name)) headers.set(name, value);
}

export function errorResponse(error, request = undefined) {
  if (error instanceof HttpError) {
    if (request && new URL(request.url).pathname.startsWith('/admin') && request.method === 'POST') {
      return adminErrorHtml(error.status, error.message);
    }
    return json(
      {
        success: false,
        error: {
          code: statusCodeName(error.status),
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
      error.status,
    );
  }

  // Keep unexpected error logs secret-safe.  Runtime values can include
  // request/form material (including credentials); do not serialize them.
  console.error(error?.name || 'InternalError');
  return json(
    {
      success: false,
      error: {
        code: 'internal_error',
        message: 'Internal server error',
      },
    },
    500,
  );
}

function statusCodeName(status) {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 503:
      return 'integration_unavailable';
    default:
      return 'request_failed';
  }
}

function adminErrorHtml(status, message) {
  const safe = String(message || 'Request failed.')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  applySecurityHeaders(headers);
  return new Response(
    `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><title>管理员操作失败</title></head><body><main><h1>管理员操作失败</h1><p class="error">${safe}</p><p><a href="/admin">返回管理后台</a></p></main></body></html>`,
    { status, headers },
  );
}
