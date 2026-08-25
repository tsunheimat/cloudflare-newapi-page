import { HttpError } from '../http.js';

// Downloads is deliberately an R2-backed authority.  The metadata/state
// objects written by the existing download Worker remain the source of truth;
// this module only reads them (and performs the existing authenticated admin
// writes) through the production `DOWNLOADS` binding.
export const DEFAULT_SOFTWARE_ID = 'codex-installer';
const DEFAULT_PREFIX = 'codex-install';
const DEFAULT_QR_PREFIX = 'wechat-group-qrcode';
const COOKIE_NAME = 'tr_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SOFTWARE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]+$/;
const TARGET_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_FILENAME_PART = /^[^\p{C}\p{Zl}\p{Zp}/\\]+$/u;
const FILENAME_PART = /^[^/\\\u0000-\u001f\u007f]+$/;
const RESERVED = new Set(['admin', 'api', 'download', 'latest', 'previous', 'public', 'software', 'wechat-group-qrcode']);
const QR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const QR_EXTENSIONS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const QR_MAX_BYTES = 5 * 1024 * 1024;
const QR_MARKER_SCHEMA = 2;
const QR_MARKER_SCHEMAS = new Set([1, QR_MARKER_SCHEMA]);
const QR_GENERATION_FORMAT = 'qr-generation-v1';
const QR_IDENTITY_FIELDS = Object.freeze([
  'asset_id', 'generation_id', 'operation_id', 'version_id', 'format_version', 'r2_key',
  'sha256', 'size', 'content_type', 'filename', 'uploaded_at', 'source',
]);
// URL is derived from the reviewed public-base binding and is intentionally
// excluded. Every listed field is written immutably for a new publication and
// must be present in both latest records.
const QR_GENERATION_IDENTITY_FIELDS = QR_IDENTITY_FIELDS;
const QR_GENERATION_REQUIRED_FIELDS = Object.freeze(
  QR_GENERATION_IDENTITY_FIELDS.filter((field) => field !== 'format_version'),
);
const QR_MARKER_PHASES = new Set(['pending', 'committed', 'tombstone', 'aborted']);
const BRAND_ASSETS = { wordmark: '/assets/juapi-logo.png', mark: '/assets/juapi-mark.png', favicon: '/assets/favicon.png' };
const SITE_PROFILES = {
  tokenrouter: {
    displayName: 'JuAPI', origin: 'https://www.juaiapi.com', logoUrl: BRAND_ASSETS.mark,
    wordmarkUrl: BRAND_ASSETS.wordmark, appName: 'JuAPI-CodexSetup', systemLabel: 'JuAPI NewAPI 兼容账号',
  },
};
const SOFTWARE_PROFILES = {
  [DEFAULT_SOFTWARE_ID]: {
    displayName: 'Codex 安装器', title: 'Codex 安装器下载', subtitle: '为 JuAPI NewAPI 兼容账号安装 Codex 初始化客户端。',
    logoUrl: BRAND_ASSETS.wordmark, origin: SITE_PROFILES.tokenrouter.origin, originLabel: 'JuAPI 主站',
    prefix: DEFAULT_PREFIX, prefixEnvVar: 'R2_PREFIX', publicBaseUrlEnvVar: 'R2_PUBLIC_BASE_URL', appName: 'CodexSetup',
    systemLabel: 'JuAPI NewAPI 兼容账号', cardDescription: '当前默认软件。旧版 /api 和 /download 路由仍会解析到这个软件。',
  },
  'codex-chat-record-migrator': {
    displayName: 'Codex 聊天记录迁移器', title: 'Codex 聊天记录迁移器下载', subtitle: '迁移 Codex 聊天记录的工具。',
    logoUrl: BRAND_ASSETS.wordmark, origin: SITE_PROFILES.tokenrouter.origin, originLabel: 'JuAPI 主站',
    prefix: 'codex-chat-record-migrator', publicBaseUrlEnvVar: 'CODEX_CHAT_RECORD_MIGRATOR_R2_PUBLIC_BASE_URL',
    appName: 'Codex Chat Record Migrator', systemLabel: 'Codex 聊天记录迁移器', cardDescription: '用于迁移 Codex 聊天记录的工具下载页。',
  },
};

export function hasDownloadsBinding(env = {}) {
  return typeof env.DOWNLOADS?.get === 'function'
    && typeof env.DOWNLOADS?.put === 'function';
}

export function isProductionR2BindingMode(env = {}) {
  return String(env.DOWNLOADS_INTEGRATION || '').trim()
    === 'production-r2-binding';
}

export function downloadsAuthorityStatus(env = {}) {
  const configured = Object.prototype.hasOwnProperty.call(env, 'DOWNLOADS');
  const bound = hasDownloadsBinding(env);
  return {
    mode: 'r2-binding', enabled: true, configured, binding_present: configured, bound,
    active: bound, healthy: null, live: false, transport: 'cloudflare-r2-binding',
    phase: bound ? 'bound-unverified' : 'unbound',
    capabilities: ['downloads', 'admin', 'r2', 'rollback', 'wechat_qr'],
  };
}

export function isDownloadsAuthorityRoute(pathname) {
  if (pathname === '/downloads' || pathname.startsWith('/downloads/')) return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/assets' || pathname.startsWith('/assets/')) return true;
  if (pathname === '/software' || pathname.startsWith('/software/')) return true;
  if (pathname === '/download' || pathname.startsWith('/download/')) return true;
  if (pathname === '/wechat-group-qrcode' || pathname.startsWith('/wechat-group-qrcode/')) return true;
  if (pathname === '/api/latest' || pathname === '/api/public' || pathname === '/api/previous') return true;
  if (pathname.startsWith('/api/latest/') || pathname.startsWith('/api/public/')) return true;
  if (pathname.startsWith('/api/previous/')) return true;
  if (pathname === '/api/wechat-group-qrcode' || pathname.startsWith('/api/wechat-group-qrcode/')) return true;
  return /^\/api\/[a-z0-9][a-z0-9-]{0,62}\/(latest|public|previous)(?:\/|$)/.test(pathname);
}

export async function routeDownloads(request, env, pathname) {
  const mounted = pathname === '/downloads' || pathname.startsWith('/downloads/');
  const localPath = mounted ? (pathname === '/downloads' ? '/' : pathname.slice('/downloads'.length)) : pathname;
  const normalized = normalizePath(localPath);
  const parts = normalized.split('/').filter(Boolean);

  if (request.method === 'GET' && normalized === '/') return renderLandingPage(env);
  if (['GET', 'HEAD'].includes(request.method) && (normalized === '/assets' || normalized.startsWith('/assets/'))) {
    if (!env.ASSETS?.fetch) throw new HttpError(404, 'Asset not found.');
    const assetUrl = new URL(request.url);
    assetUrl.pathname = normalized;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }

  // The source Worker has no explicit HEAD handlers; retain its empty HTML
  // 404 contract instead of turning a probe into a successful GET.
  if (request.method === 'HEAD') return new Response(null, { status: 404, headers: { 'content-type': normalized.startsWith('/api/') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  if (request.method === 'GET' && normalized === '/wechat-group-qrcode') return serveQr(env);
  if (request.method === 'GET' && normalized === '/wechat-group-qrcode/latest') return serveQr(env);
  if (request.method === 'GET' && parts[0] === 'software' && parts.length === 2) return renderSoftwarePage(env, requireSoftware(parts[1]));
  if (request.method === 'GET' && parts[0] === 'api') {
    const response = await routeApi(env, parts);
    if (response) return response;
  }
  if (request.method === 'GET' && parts[0] === 'download') {
    const response = await routeDownload(env, parts);
    if (response) return response;
  }
  if (normalized === '/admin' && request.method === 'GET') return renderAdminV2(env, request);
  if (request.method === 'POST' && normalized === '/admin/login') return handleLogin(request, env);
  if (request.method === 'POST' && normalized === '/admin/logout') {
    const session = await requireAdmin(request, env);
    await requireCsrf(request, env, session);
    return redirect('/admin', clearSessionCookie());
  }
  if (request.method === 'POST' && normalized === '/admin/wechat-group-qrcode/upload') return handleQrUpload(request, env);
  if (request.method === 'POST' && parts[0] === 'admin') {
    const action = adminAction(parts);
    if (action) return handleAdminAction(request, env, action.softwareId, action.action);
  }
  throw new HttpError(404, 'Not found');
}

function normalizePath(pathname) {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

async function routeApi(env, parts) {
  const software = defaultSoftware();
  if (parts.length === 3 && parts[1] === 'wechat-group-qrcode' && parts[2] === 'latest') {
    return json(await latestQr(env));
  }
  if (parts.length === 2 && ['latest', 'public'].includes(parts[1])) return json(await aggregate(env, software, parts[1]));
  if (parts.length === 2 && parts[1] === 'previous') return json(await previous(env, software));
  if (parts.length === 5 && ['latest', 'public'].includes(parts[1])) return json(await target(env, software, parts[1], parseTarget(parts.slice(2))));
  if (parts.length === 3 && ['latest', 'public'].includes(parts[2])) return json(await aggregate(env, requireSoftware(parts[1]), parts[2]));
  if (parts.length === 3 && parts[2] === 'previous') return json(await previous(env, requireSoftware(parts[1])));
  if (parts.length === 6 && ['latest', 'public'].includes(parts[2])) return json(await target(env, requireSoftware(parts[1]), parts[2], parseTarget(parts.slice(3))));
  return null;
}

async function routeDownload(env, parts) {
  const software = defaultSoftware();
  if (parts.length === 5 && parts[1] === 'latest') return download(env, software, 'latest', parseTarget(parts.slice(2)));
  if (parts.length === 4) return download(env, software, 'public', parseTarget(parts.slice(1)));
  if (parts.length === 6 && parts[2] === 'latest') return download(env, requireSoftware(parts[1]), 'latest', parseTarget(parts.slice(3)));
  if (parts.length === 5) return download(env, requireSoftware(parts[1]), 'public', parseTarget(parts.slice(2)));
  return null;
}

function parseTarget(parts) {
  if (parts.length !== 3 || !parts.every((part) => TARGET_PART.test(part) && part !== '.' && part !== '..' && !part.includes('..'))) throw new HttpError(400, 'Invalid target.');
  return { site: parts[0], platform: parts[1], arch: parts[2] };
}

function adminAction(parts) {
  if (parts.length === 3 && parts[1] === 'public') return { softwareId: DEFAULT_SOFTWARE_ID, action: parts[2] };
  if (parts.length === 4 && parts[2] === 'public') return { softwareId: parts[1], action: parts[3] };
  return null;
}

function defaultSoftware() { return requireSoftware(DEFAULT_SOFTWARE_ID); }
function requireSoftware(id) {
  const value = String(id || '').trim();
  if (!SOFTWARE_ID.test(value) || RESERVED.has(value)) throw new HttpError(400, 'Invalid software id.');
  if (!SOFTWARE_PROFILES[value]) throw new HttpError(404, `Unknown software: ${value}`);
  return { ...SOFTWARE_PROFILES[value], id: value };
}
function profiles() { return Object.entries(SOFTWARE_PROFILES).map(([id, value]) => ({ ...value, id })); }
function configuredPrefix(value, fallback) {
  const normalized = String(value || fallback).replace(/^\/+|\/+$/g, '') || fallback;
  if (!normalized.split('/').every((part) => KEY_PART.test(part))) {
    throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  }
  return normalized;
}
function prefix(env, software) { return configuredPrefix(env[software.prefixEnvVar], software.prefix || DEFAULT_PREFIX); }
function objectKey(env, software, relative) {
  const base = prefix(env, software);
  const clean = String(relative || '').replace(/^\/+/, '');
  if (!safeRelativePath(clean)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  return `${base}/${clean}`;
}
function qrPrefix(env) { return configuredPrefix(env.WECHAT_GROUP_QR_PREFIX, DEFAULT_QR_PREFIX); }
function qrKey(env, relative) {
  const clean = String(relative || '').replace(/^\/+/, '');
  if (!safeRelativePath(clean)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  return `${qrPrefix(env)}/${clean}`;
}

async function readJson(env, key, { optional = false } = {}) {
  let object;
  try { object = await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) {
    if (optional) return null;
    throw new HttpError(404, `R2 object not found: ${key}`);
  }
  try { return JSON.parse(await object.text()); } catch { throw new HttpError(503, 'Downloads metadata is temporarily unavailable.'); }
}
async function writeJson(env, key, payload, cacheControl = 'no-store', onlyIf = undefined) {
  try {
    const options = { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl } };
    if (onlyIf) options.onlyIf = onlyIf;
    return await env.DOWNLOADS.put(key, `${JSON.stringify(payload, null, 2)}\n`, options);
  } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
}
async function aggregate(env, software, channel) {
  const metadata = await readJson(env, objectKey(env, software, `metadata/${channel}.json`));
  validateAggregateMetadata(env, software, metadata);
  return { ...metadata, files: metadata.files.map((item) => sanitizedArtifactMetadata(env, software, item)) };
}
async function target(env, software, channel, wanted) {
  const metadata = await readJson(env, objectKey(env, software, `${channel}/${wanted.site}/${wanted.platform}/${wanted.arch}.json`));
  return sanitizedArtifactMetadata(env, software, metadata);
}
async function state(env, software, name) { return readJson(env, objectKey(env, software, `state/${name}.json`), { optional: true }); }

function releaseId(payload) {
  if (typeof payload === 'string') return payload.trim();
  return payload && typeof payload === 'object' ? String(payload.release_id || payload.latest_release_id || '').trim() : '';
}
function validateArtifactMetadata(env, software, metadata, { invalidKeyStatus = 404 } = {}) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  for (const field of ['site', 'platform', 'arch']) {
    if (typeof metadata[field] !== 'string' || !TARGET_PART.test(metadata[field]) || metadata[field] === '.' || metadata[field] === '..' || metadata[field].includes('..')) {
      throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
    }
  }
  if (metadata.filename !== undefined && (typeof metadata.filename !== 'string' || !FILENAME_PART.test(metadata.filename) || metadata.filename.includes('..') || metadata.filename.trim() !== metadata.filename || metadata.filename.length > 255)) {
    throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  }
  const key = metadata.r2_key;
  if (!safeArtifactObjectKey(key, `${prefix(env, software)}/`)) throw new HttpError(invalidKeyStatus, invalidKeyStatus === 404 ? 'Selected artifact has no valid r2_key.' : 'Downloads metadata is temporarily unavailable.');
  return key;
}
function validateAggregateMetadata(env, software, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  for (const item of metadata.files) validateArtifactMetadata(env, software, item, { invalidKeyStatus: 503 });
  return metadata;
}
function sanitizedArtifactMetadata(env, software, item) {
  const key = validateArtifactMetadata(env, software, item, { invalidKeyStatus: 503 });
  const result = { ...item };
  const url = resolveDownloadUrl(env, software, item, key);
  if (url) result.url = url;
  else delete result.url;
  return result;
}
async function previous(env, software) {
  const current = await state(env, software, 'previous');
  const id = releaseId(current);
  if (id && !RELEASE_ID.test(id)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  if (!id) return { state: null, metadata: null };
  const metadata = await readJson(env, objectKey(env, software, `releases/${id}/metadata/latest.json`), { optional: true });
  if (metadata) {
    validateAggregateMetadata(env, software, metadata);
    return { state: current, metadata: { ...metadata, files: metadata.files.map((item) => sanitizedArtifactMetadata(env, software, item)) } };
  }
  return { state: current, metadata: null };
}

function safeObjectKey(value, expectedPrefix = '') {
  if (typeof value !== 'string' || !value.startsWith(expectedPrefix) || value.length <= expectedPrefix.length) return false;
  if (value.startsWith('/') || !safeRelativePath(value)) return false;
  return value.slice(0, expectedPrefix.length) === expectedPrefix;
}
function safeArtifactObjectKey(value, expectedPrefix = '') {
  if (typeof value !== 'string' || !value.startsWith(expectedPrefix) || value.length <= expectedPrefix.length) return false;
  if (value.startsWith('/') || value.includes('\\') || value.includes('//')) return false;
  const parts = value.split('/');
  const filename = parts.pop();
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.includes('..') && KEY_PART.test(part))
    && typeof filename === 'string' && filename.length <= 128
    && filename.trim() === filename && filename !== '.' && filename !== '..'
    && !filename.includes('..') && ARTIFACT_FILENAME_PART.test(filename);
}
function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.includes('//')) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.includes('..') && KEY_PART.test(part));
}
function publicBaseUrl(env, software) {
  const raw = String(env[software.publicBaseUrlEnvVar] || env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed;
  } catch { return null; }
}
function qrPublicBaseUrl(env) {
  const raw = String(env.WECHAT_GROUP_QR_PUBLIC_BASE_URL || env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    return parsed;
  } catch { return null; }
}
function safePublicUrl(candidate, base, key) {
  if (!candidate || !base) return '';
  try {
    const parsed = new URL(String(candidate));
    if (parsed.protocol !== 'https:' || parsed.origin !== base.origin || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    if (parsed.pathname !== new URL(derivedPublicUrl(base, key)).pathname) return '';
    return parsed.href;
  } catch { return ''; }
}
function derivedPublicUrl(base, key) {
  const encodedKey = key.split('/').map(encodeR2PathPart).join('/');
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/${encodedKey}`;
}
function encodeR2PathPart(part) {
  return encodeURIComponent(part).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
function resolveDownloadUrl(env, software, metadata, key) {
  const base = publicBaseUrl(env, software);
  const trusted = safePublicUrl(metadata?.url, base, key);
  if (trusted) return trusted;
  return base ? derivedPublicUrl(base, key) : '';
}
async function download(env, software, channel, wanted) {
  const metadata = await target(env, software, channel, wanted);
  const key = validateArtifactMetadata(env, software, metadata);
  const url = resolveDownloadUrl(env, software, metadata, key);
  if (url) return redirectFound(url);
  let object;
  try { object = await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) throw new HttpError(404, `Artifact not found: ${key}`);
  const headers = new Headers({ 'content-type': metadata.content_type || object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': object.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable', 'content-disposition': `attachment; filename="${safeFilename(metadata.filename || 'download.bin')}"` });
  if (metadata.size) headers.set('content-length', String(metadata.size));
  return new Response(object.body, { headers });
}

function validateQrMetadata(env, metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  const key = metadata?.r2_key;
  const images = `${qrPrefix(env)}/images/`;
  if (!safeObjectKey(key, images)) throw new HttpError(400, 'WeChat group QR code r2_key must be under the configured images prefix.');
  const contentType = String(metadata?.content_type || '').trim().toLowerCase();
  if (contentType && !QR_TYPES.has(contentType)) throw new HttpError(400, 'Invalid WeChat group QR code content_type.');
  return { r2Key: key, contentType };
}

function qrIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.r2_key !== 'string') return null;
  const identity = {};
  for (const field of QR_IDENTITY_FIELDS) {
    if (value[field] === undefined) continue;
    identity[field] = field === 'size' ? Number(value[field]) : String(value[field]);
  }
  identity.r2_key = value.r2_key;
  return identity;
}

function hasQrGenerationIdentity(value) {
  return Boolean(value && typeof value === 'object'
    && (value.generation_id !== undefined || value.operation_id !== undefined));
}

function hasQrGenerationFormat(value) {
  return Boolean(value && typeof value === 'object'
    && Object.prototype.hasOwnProperty.call(value, 'format_version'));
}

function isQrNewGeneration(value) {
  return hasQrGenerationIdentity(value) || hasQrGenerationFormat(value);
}

function completeQrGenerationIdentity(value) {
  const identity = qrIdentity(value);
  if (!identity || !isQrNewGeneration(identity)) return null;
  if (hasQrGenerationFormat(identity) && identity.format_version !== QR_GENERATION_FORMAT) return null;
  for (const field of QR_GENERATION_REQUIRED_FIELDS) {
    if (identity[field] === undefined || identity[field] === null || identity[field] === '') return null;
  }
  if (!Number.isSafeInteger(identity.size) || identity.size < 0) return null;
  if (!/^[a-f0-9]{64}$/i.test(identity.sha256)) return null;
  return identity;
}

function sameQrRecord(actual, expected) {
  const left = qrIdentity(actual);
  const right = qrIdentity(expected);
  if (!left || !right) return false;
  const leftNew = isQrNewGeneration(left);
  const rightNew = isQrNewGeneration(right);
  if (leftNew || rightNew) {
    const completeLeft = completeQrGenerationIdentity(left);
    const completeRight = completeQrGenerationIdentity(right);
    if (!completeLeft || !completeRight) return false;
    return QR_GENERATION_IDENTITY_FIELDS.every((field) =>
      String(completeLeft[field]) === String(completeRight[field]));
  }
  return sameLegacyQrRecord(left, right);
}

function sameQrExpectedRecord(actual, expected) {
  const left = qrIdentity(actual);
  const right = qrIdentity(expected);
  if (!left || !right) return false;
  if (isQrNewGeneration(left) || isQrNewGeneration(right)) return sameQrRecord(left, right);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && String(left[key]) === String(right[key]));
}

function sameLegacyQrRecord(left, right) {
  const a = qrIdentity(left);
  const b = qrIdentity(right);
  if (!a || !b || isQrNewGeneration(a) || isQrNewGeneration(b) || a.r2_key !== b.r2_key) return false;
  for (const field of QR_IDENTITY_FIELDS) {
    // Keep old records readable when an older writer omitted a field, but do
    // not allow two records that both provide a field to disagree.
    if (a[field] !== undefined && b[field] !== undefined && String(a[field]) !== String(b[field])) return false;
  }
  return true;
}

function sameStoredValue(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function verifyQrImage(env, expected) {
  if (!expected?.r2_key) throw new Error('QR image did not reconcile');
  const object = await readQrImageObject(env, expected.r2_key);
  if (!object) throw new Error('QR image did not reconcile');
  return verifyQrImageObject(object, expected);
}

async function readQrImageObject(env, key) {
  try { return await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
}

async function verifyQrImageObject(object, expected) {
  const expectedSize = Number(expected.size);
  const expectedDigest = String(expected.sha256 || '').toLowerCase();
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('QR image integrity metadata is incomplete');
  }
  let observedSize = object.size === undefined ? undefined : Number(object.size);
  if (observedSize !== undefined && observedSize !== expectedSize) throw new Error('QR image size did not reconcile');
  let bytes;
  if (typeof object.arrayBuffer === 'function') {
    bytes = new Uint8Array(await object.arrayBuffer());
  } else if (object.body?.getReader) {
    const reader = object.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > expectedSize) throw new Error('QR image size did not reconcile');
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  }
  let observedDigest = '';
  const checksum = object.checksums?.sha256;
  if (checksum !== undefined) observedDigest = checksumHex(checksum);
  if (bytes) {
    observedSize = bytes.length;
    if (observedSize !== expectedSize) throw new Error('QR image size did not reconcile');
    const computedDigest = await sha256(bytes);
    if (computedDigest !== expectedDigest) throw new Error('QR image digest did not reconcile');
    if (observedDigest && observedDigest !== computedDigest) throw new Error('QR image checksum did not reconcile');
    observedDigest = computedDigest;
  }
  if (observedSize !== expectedSize) throw new Error('QR image size did not reconcile');
  if (!observedDigest || observedDigest !== expectedDigest) throw new Error('QR image digest did not reconcile');
  return { bytes };
}

function checksumHex(value) {
  if (typeof value === 'string') {
    const raw = value.trim();
    const normalized = raw.toLowerCase();
    if (/^[a-f0-9]{64}$/.test(normalized)) return normalized;
    try {
      const binary = atob(raw);
      if (binary.length !== 32) return '';
      return [...binary].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
  }
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  return bytes?.length === 32 ? [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('') : '';
}

function etagOf(object) {
  return object?.etag || object?.httpEtag || null;
}

async function readJsonObject(env, key, { optional = false } = {}) {
  let object;
  try { object = await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) {
    if (optional) return null;
    throw new HttpError(404, `R2 object not found: ${key}`);
  }
  try {
    return { value: JSON.parse(await object.text()), etag: etagOf(object) };
  } catch { throw new HttpError(503, 'Downloads metadata is temporarily unavailable.'); }
}

async function objectExists(env, key) {
  let object;
  try {
    object = typeof env.DOWNLOADS.head === 'function'
      ? await env.DOWNLOADS.head(key)
      : await env.DOWNLOADS.get(key);
  } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (object?.body?.cancel) await object.body.cancel().catch(() => {});
  return Boolean(object);
}

async function readMarker(env, pendingKey, { optional = true } = {}) {
  const result = await readJsonObject(env, pendingKey, { optional });
  if (!result) return null;
  const marker = result.value;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)
    || !QR_MARKER_SCHEMAS.has(marker.schema_version)
    || !QR_MARKER_PHASES.has(marker.phase)
    || typeof marker.operation_id !== 'string'
    || !marker.expected || typeof marker.expected !== 'object'
    || (marker.generation_id !== undefined && marker.expected.generation_id !== marker.generation_id)
    || (isQrNewGeneration(marker.expected) && !completeQrGenerationIdentity(marker.expected))) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  if (typeof result.etag !== 'string' || result.etag === '') {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  return { ...result, marker };
}

function qrFormatKey(env) {
  return qrKey(env, 'state/format.json');
}

async function readQrFormat(env, { optional = true } = {}) {
  const result = await readJsonObject(env, qrFormatKey(env), { optional });
  if (!result) return null;
  const format = result.value;
  if (!format || typeof format !== 'object' || Array.isArray(format)
    || format.schema_version !== 1
    || format.format_version !== QR_GENERATION_FORMAT
    || format.immutable !== true) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  return { ...result, format };
}

async function ensureQrFormat(env) {
  const existing = await readQrFormat(env);
  if (existing) return existing;
  const format = {
    schema_version: 1,
    format_version: QR_GENERATION_FORMAT,
    immutable: true,
    established_at: new Date().toISOString(),
  };
  let result = null;
  try {
    result = await writeJson(env, qrFormatKey(env), format, 'no-store', { etagDoesNotMatch: '*' });
  } catch {
    // R2 may commit before returning an error; reconcile below.
  }
  if (result !== null) return readQrFormat(env, { optional: false });
  const observed = await readQrFormat(env);
  if (!observed) throw new Error('QR generation format did not reconcile');
  return observed;
}

async function markerOwner(env, pendingKey, operationId) {
  const current = await readMarker(env, pendingKey);
  if (!current || current.marker.operation_id !== operationId) throw new Error('QR publication marker ownership changed');
  return current;
}

async function abortQrMarker(env, pendingKey, operationId, reason = 'operation-aborted') {
  const current = await markerOwner(env, pendingKey, operationId);
  if (current.marker.phase === 'aborted') return current;
  return updateQrMarker(env, pendingKey, operationId, {
    ...current.marker,
    phase: 'aborted',
    aborted_at: new Date().toISOString(),
    abort_reason: reason,
  });
}

async function writeJsonVerified(env, key, payload, cacheControl = 'no-store', onlyIf = undefined) {
  try {
    const result = await writeJson(env, key, payload, cacheControl, onlyIf);
    if (result === null) throw new Error('conditional write did not match');
    return result;
  } catch {
    // R2 put() may have committed before the provider response was lost. Read
    // the object back and accept only an exact payload match.
    const observed = await readJsonObject(env, key, { optional: true });
    if (observed && sameStoredValue(observed.value, payload)) return observed;
    throw new Error('QR JSON write did not reconcile');
  }
}

async function acquireQrMarker(env, pendingKey, marker, snapshots) {
  const existing = await readMarker(env, pendingKey);
  if (existing?.marker.phase === 'pending') throw new Error('QR publication is already fenced');
  if (snapshots && !await verifyQrRollback(env, snapshots)) {
    throw new QrSnapshotDriftError();
  }
  try {
    const condition = existing?.etag ? { etagMatches: existing.etag } : { etagDoesNotMatch: '*' };
    const result = await writeJson(env, pendingKey, marker, 'no-store', condition);
    if (result === null) throw new Error('QR publication marker was acquired by another operation');
  } catch {
    const observed = await readMarker(env, pendingKey);
    if (!observed || observed.marker.operation_id !== marker.operation_id
      || !sameStoredValue(observed.marker, marker)) throw new Error('QR publication marker did not reconcile');
    return observed;
  }
  const observed = await readMarker(env, pendingKey);
  if (!observed || observed.marker.operation_id !== marker.operation_id
    || !sameStoredValue(observed.marker, marker)) throw new Error('QR publication marker did not reconcile');
  return observed;
}

async function updateQrMarker(env, pendingKey, operationId, nextMarker) {
  const current = await markerOwner(env, pendingKey, operationId);
  if (!current.etag) throw new Error('QR publication marker has no conditional version');
  try {
    const result = await writeJson(env, pendingKey, nextMarker, 'no-store', { etagMatches: current.etag });
    if (result === null) throw new Error('QR publication marker ownership changed');
  } catch {
    const observed = await readMarker(env, pendingKey);
    if (!observed || observed.marker.operation_id !== operationId
      || !sameStoredValue(observed.marker, nextMarker)) throw new Error('QR publication marker update did not reconcile');
    return observed;
  }
  return markerOwner(env, pendingKey, operationId);
}

async function tombstoneQrMarker(env, pendingKey, operationId) {
  const current = await markerOwner(env, pendingKey, operationId);
  if (current.marker.phase === 'tombstone') return current;
  return updateQrMarker(env, pendingKey, operationId, {
    ...current.marker,
    phase: 'tombstone',
    tombstoned_at: new Date().toISOString(),
  });
}

function sameQrReadVersion(before, after, valueKey) {
  if (!before || !after) return before === after;
  return typeof before.etag === 'string' && before.etag !== ''
    && before.etag === after.etag
    && sameStoredValue(before[valueKey], after[valueKey]);
}

async function assertQrReadVersion(env, pendingKey, markerResult, formatResult) {
  // Format is immutable migration evidence. Sample it before the marker so
  // the marker remains the final R2 read at the snapshot linearization point.
  const finalFormat = await readQrFormat(env);
  const finalMarker = await readMarker(env, pendingKey);
  if (finalMarker?.marker.phase === 'pending'
    || !sameQrReadVersion(formatResult, finalFormat, 'format')
    || !sameQrReadVersion(markerResult, finalMarker, 'marker')) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
}

async function readQrConsistency(env, { loadImage = false } = {}) {
  const pendingKey = qrKey(env, 'state/pending.json');
  const markerResult = await readMarker(env, pendingKey);
  const marker = markerResult?.marker || null;
  if (marker?.phase === 'pending') {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  const [metadata, state, formatResult] = await Promise.all([
    readJson(env, qrKey(env, 'metadata/latest.json'), { optional: true }),
    readJson(env, qrKey(env, 'state/latest.json'), { optional: true }),
    readQrFormat(env),
  ]);
  const format = formatResult?.format || null;
  let integrityExpected = null;
  if (marker?.phase === 'aborted' || marker?.phase === 'committed') {
    const expected = isQrNewGeneration(marker.expected)
      ? completeQrGenerationIdentity(marker.expected)
      : qrIdentity(marker.expected);
    if (!expected || !metadata || !state
      || !sameQrExpectedRecord(metadata, expected)
      || !sameQrExpectedRecord(state, expected)
      || !sameQrRecord(metadata, state)) {
      throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
    }
    integrityExpected = isQrNewGeneration(expected) ? expected : null;
  }
  if (marker?.phase === 'tombstone') {
    try {
      const rollback = marker.rollback;
      if (!rollback || !await verifyQrRollback(env, {
        latestMetadata: rollback.latestMetadata,
        latestState: rollback.latestState,
        previousState: rollback.previousState,
      })) {
        throw new Error('QR tombstone did not reconcile');
      }
      if (isQrNewGeneration(rollback.latestMetadata)) integrityExpected = rollback.latestMetadata;
    } catch {
      throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
    }
  }
  const metadataNew = isQrNewGeneration(metadata);
  const stateNew = isQrNewGeneration(state);
  if (format && (!metadata || !state || !completeQrGenerationIdentity(metadata)
    || !completeQrGenerationIdentity(state) || !sameQrRecord(metadata, state))) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  if (!marker && (metadataNew || stateNew)) {
    if (!metadata || !state || !completeQrGenerationIdentity(metadata)
      || !completeQrGenerationIdentity(state) || !sameQrRecord(metadata, state)) {
      throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
    }
    integrityExpected = metadata;
  }
  if (!marker && metadata && state && (metadata.r2_key || state.r2_key)
    && !metadataNew && !stateNew && !sameLegacyQrRecord(metadata, state)) {
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  if (!marker && !metadata && state) throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  let image = null;
  try {
    if (integrityExpected) validateQrMetadata(env, integrityExpected);
    if (loadImage && metadata) {
      const validated = validateQrMetadata(env, metadata);
      const object = await readQrImageObject(env, validated.r2Key);
      if (!object) {
        if (integrityExpected) throw new Error('QR image did not reconcile');
        throw new HttpError(404, `WeChat group QR code not found: ${validated.r2Key}`);
      }
      const verified = integrityExpected
        ? await verifyQrImageObject(object, integrityExpected)
        : null;
      image = { object, bytes: verified?.bytes };
    } else if (integrityExpected) {
      await verifyQrImage(env, integrityExpected);
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) throw error;
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  await assertQrReadVersion(env, pendingKey, markerResult, formatResult);
  return { metadata, state, marker, image };
}

async function verifyQrPublication(env, expected, pendingKey = undefined, operationId = undefined) {
  if (pendingKey && operationId) await markerOwner(env, pendingKey, operationId);
  const [metadata, state] = await Promise.all([
    readJson(env, qrKey(env, 'metadata/latest.json')),
    readJson(env, qrKey(env, 'state/latest.json')),
  ]);
  if (!sameQrRecord(metadata, qrIdentity(expected)) || !sameQrRecord(state, qrIdentity(expected))) {
    throw new Error('QR publication did not reconcile');
  }
  await verifyQrImage(env, expected);
  if (pendingKey && operationId) await markerOwner(env, pendingKey, operationId);
}

async function verifyQrRollback(env, snapshots) {
  const [metadata, state, previous] = await Promise.all([
    readJson(env, qrKey(env, 'metadata/latest.json'), { optional: true }),
    readJson(env, qrKey(env, 'state/latest.json'), { optional: true }),
    readJson(env, qrKey(env, 'state/previous.json'), { optional: true }),
  ]);
  const projectedMetadata = metadata ? sanitizedQrMetadata(env, metadata) : null;
  return sameStoredValue(projectedMetadata, snapshots.latestMetadata)
    && sameStoredValue(state, snapshots.latestState)
    && sameStoredValue(previous, snapshots.previousState);
}

class QrSnapshotDriftError extends Error {
  constructor() {
    super('QR publication snapshot drifted');
    this.name = 'QrSnapshotDriftError';
  }
}

async function assertQrSnapshotCurrent(env, snapshots, pendingKey, operationId) {
  await markerOwner(env, pendingKey, operationId);
  if (!await verifyQrRollback(env, snapshots)) throw new QrSnapshotDriftError();
}

async function latestQr(env, optional = false) {
  const consistent = await readQrConsistency(env);
  if (!consistent.metadata) {
    if (optional) return null;
    throw new HttpError(404, `R2 object not found: ${qrKey(env, 'metadata/latest.json')}`);
  }
  return sanitizedQrMetadata(env, consistent.metadata);
}
function sanitizedQrMetadata(env, metadata) {
  const validated = validateQrMetadata(env, metadata);
  const base = qrPublicBaseUrl(env);
  const result = { ...metadata };
  if (base) result.url = `${base.origin}${base.pathname.replace(/\/+$/, '')}/${validated.r2Key}`;
  else delete result.url;
  return result;
}
async function serveQr(env) {
  const base = qrPublicBaseUrl(env);
  const consistent = await readQrConsistency(env, { loadImage: !base });
  const metadata = consistent.metadata;
  if (!metadata) throw new HttpError(404, `R2 object not found: ${qrKey(env, 'metadata/latest.json')}`);
  const validated = validateQrMetadata(env, metadata);
  if (base) return new Response(null, { status: 302, headers: { location: `${base.origin}${base.pathname.replace(/\/+$/, '')}/${validated.r2Key}`, 'cache-control': 'no-store' } });
  const { object, bytes } = consistent.image;
  const headers = new Headers({ 'content-type': validated.contentType || object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'no-store' });
  if (metadata.size) headers.set('content-length', String(metadata.size));
  return new Response(bytes || object.body, { headers });
}

async function handleQrUpload(request, env) {
  const session = await requireAdmin(request, env);
  await requireCsrf(request, env, session);
  const upload = (await request.formData()).get('image');
  if (!upload || typeof upload.arrayBuffer !== 'function') throw new HttpError(400, '請選擇一張微信群 QR 圖片。');
  const filename = String(upload.name || 'wechat-group-qrcode').trim() || 'wechat-group-qrcode';
  if (!FILENAME_PART.test(filename) || filename.includes('..') || filename.length > 255) throw new HttpError(400, '圖片檔案名稱無效。');
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const contentType = QR_EXTENSIONS[extension];
  if (!contentType) throw new HttpError(400, '只支持 PNG、JPG、GIF 或 WebP 圖片。');
  if (String(upload.type || '').trim().toLowerCase() !== contentType) throw new HttpError(400, '圖片 MIME 類型與副檔名不一致。');
  let bytes;
  try { bytes = new Uint8Array(await upload.arrayBuffer()); } catch { throw new HttpError(400, '無法讀取圖片檔案。'); }
  if (!bytes.length) throw new HttpError(400, '圖片檔案不能為空。');
  if (bytes.length > QR_MAX_BYTES) throw new HttpError(400, '圖片檔案不能超過 5 MiB。');
  if (!matchesMagic(extension, bytes)) throw new HttpError(400, `圖片內容與 .${extension} 副檔名不一致。`);
  const digest = await sha256(bytes);
  const operationId = randomToken();
  const generationId = randomToken();
  const version = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${generationId}-${digest.slice(0, 12)}`;
  const key = `${qrPrefix(env)}/images/${version}.${extension}`;
  const base = qrPublicBaseUrl(env);
  const uploadedAt = new Date().toISOString();
  const metadata = {
    asset_id: 'wechat-group-qrcode', format_version: QR_GENERATION_FORMAT,
    generation_id: generationId, operation_id: operationId,
    version_id: version, uploaded_at: uploadedAt, source: 'admin-panel', filename, r2_key: key,
    ...(base ? { url: `${base.origin}${base.pathname.replace(/\/+$/, '')}/${key}` } : {}),
    sha256: digest, size: bytes.length, content_type: contentType,
  };
  const snapshots = await snapshotQrState(env);
  const pendingKey = qrKey(env, 'state/pending.json');
  const marker = {
    schema_version: QR_MARKER_SCHEMA,
    phase: 'pending',
    operation_id: operationId,
    generation_id: generationId,
    expected: qrIdentity(metadata),
    rollback: {
      latestMetadata: snapshots.latestMetadata,
      latestState: snapshots.latestState,
      previousState: snapshots.previousState,
    },
  };
  const touched = [];
  let markerAcquired = false;
  let formatEstablished = false;
  try {
    await acquireQrMarker(env, pendingKey, marker, snapshots);
    markerAcquired = true;
    // Snapshotting precedes conditional acquisition so a newer committed
    // generation can win while this operation is preparing. The stale writer
    // aborts before writing or tombstoning that winner.
    await assertQrSnapshotCurrent(env, snapshots, pendingKey, operationId);
    touched.push(key);
    await markerOwner(env, pendingKey, operationId);
    await putBinary(env, key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
    if (snapshots.latestMetadata) {
      touched.push(qrKey(env, 'state/previous.json'));
      await markerOwner(env, pendingKey, operationId);
      await writeJsonVerified(env, qrKey(env, 'state/previous.json'), snapshots.latestMetadata);
    }
    touched.push(qrKey(env, 'metadata/latest.json'));
    await markerOwner(env, pendingKey, operationId);
    await writeJsonVerified(env, qrKey(env, 'metadata/latest.json'), metadata);
    touched.push(qrKey(env, 'state/latest.json'));
    await markerOwner(env, pendingKey, operationId);
    await writeJsonVerified(env, qrKey(env, 'state/latest.json'), metadata);
    await verifyQrPublication(env, metadata, pendingKey, operationId);
    await ensureQrFormat(env);
    formatEstablished = true;
    await updateQrMarker(env, pendingKey, operationId, { ...marker, phase: 'committed', committed_at: new Date().toISOString() });
  } catch (error) {
    if (markerAcquired && snapshots) {
      if (error instanceof QrSnapshotDriftError || formatEstablished) {
        const reason = error instanceof QrSnapshotDriftError ? 'snapshot-drift' : 'commit-after-format-failed';
        try { await abortQrMarker(env, pendingKey, operationId, reason); } catch { /* ownership may have moved */ }
      } else {
        await rollbackQrState(env, snapshots, touched, key, pendingKey, operationId);
      }
    } else if (markerAcquired) {
      try { await abortQrMarker(env, pendingKey, operationId, 'snapshot-unavailable'); } catch { /* ownership may have moved */ }
    }
    throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
  }
  return redirect('/admin?updated=wechat-group-qrcode-uploaded');
}

async function putBinary(env, key, bytes, options) {
  try {
    await env.DOWNLOADS.put(key, bytes, options);
    return;
  } catch {
    try {
      await verifyQrImage(env, { r2_key: key, size: bytes.length, sha256: await sha256(bytes) });
      return;
    } catch {
      throw new HttpError(503, 'Downloads storage is temporarily unavailable.');
    }
  }
}
async function snapshotQrState(env) {
  const consistent = await readQrConsistency(env);
  const previousState = await readJson(env, qrKey(env, 'state/previous.json'), { optional: true });
  return {
    latestMetadata: consistent.metadata ? sanitizedQrMetadata(env, consistent.metadata) : null,
    latestState: consistent.state,
    previousState,
  };
}
async function deleteVerified(env, key) {
  try { await env.DOWNLOADS.delete(key); } catch { /* verify below; delete may have committed */ }
  if (await objectExists(env, key)) throw new Error('QR delete did not reconcile');
}

async function rollbackQrState(env, snapshots, touched, uploadedKey, pendingKey, operationId) {
  const originals = new Map([
    [qrKey(env, 'metadata/latest.json'), snapshots.latestMetadata],
    [qrKey(env, 'state/latest.json'), snapshots.latestState],
    [qrKey(env, 'state/previous.json'), snapshots.previousState],
  ]);
  for (const key of [...touched].reverse()) {
    if (!originals.has(key)) continue;
    const original = originals.get(key);
    try {
      await markerOwner(env, pendingKey, operationId);
      if (original === null) {
        if (typeof env.DOWNLOADS.delete !== 'function') throw new Error('delete unavailable');
        await deleteVerified(env, key);
      } else await writeJsonVerified(env, key, original);
    } catch {
      // Leave the durable pending marker in place when compensation is not
      // verified. Reads and the admin UI then fail closed instead of exposing
      // a metadata/state mix from this attempt.
    }
  }
  if (typeof env.DOWNLOADS.delete === 'function') {
    try { await deleteVerified(env, uploadedKey); } catch { /* retain fence on ambiguity */ }
  }
  try {
    if (await verifyQrRollback(env, snapshots)) await tombstoneQrMarker(env, pendingKey, operationId);
  } catch {
    // A pending marker is intentionally retained unless compensation and the
    // owner-only tombstone both reconcile. Readers remain fail closed.
  }
}

async function handleAdminAction(request, env, softwareId, action) {
  const session = await requireAdmin(request, env);
  await requireCsrf(request, env, session);
  const software = requireSoftware(softwareId);
  if (action === 'lock-previous') {
    const id = releaseId(await state(env, software, 'previous'));
    if (!id) throw new HttpError(400, 'No previous release is available to lock.');
    await publishPublic(env, software, id, true, 'admin-lock-previous');
    return redirect(`/admin?updated=${encodeURIComponent(software.id)}-locked-previous`);
  }
  if (action === 'unlock') {
    const id = releaseId(await state(env, software, 'latest')) || releaseId(await aggregate(env, software, 'latest'));
    if (!id) throw new HttpError(400, 'No latest release is available to publish.');
    await publishPublic(env, software, id, false, 'admin-unlock');
    return redirect(`/admin?updated=${encodeURIComponent(software.id)}-unlocked`);
  }
  if (action === 'set') {
    const id = String((await request.formData()).get('release_id') || '').trim();
    if (!RELEASE_ID.test(id)) throw new HttpError(400, 'Invalid release_id.');
    await publishPublic(env, software, id, true, 'admin-set');
    return redirect(`/admin?updated=${encodeURIComponent(software.id)}-set`);
  }
  throw new HttpError(404, 'Not found');
}
async function publishPublic(env, software, id, locked, source) {
  if (!RELEASE_ID.test(id)) throw new HttpError(400, 'Invalid release_id.');
  const aggregateMetadata = await readJson(env, objectKey(env, software, `releases/${id}/metadata/latest.json`));
  if (!Array.isArray(aggregateMetadata.files) || !aggregateMetadata.files.length) throw new HttpError(400, 'Selected release has no files metadata.');
  validateAggregateMetadata(env, software, aggregateMetadata);
  const projectedAggregate = { ...aggregateMetadata, files: aggregateMetadata.files.map((item) => sanitizedArtifactMetadata(env, software, item)) };
  const planned = [];
  const bySite = new Map();
  for (const item of projectedAggregate.files) {
    const files = bySite.get(item.site) || [];
    files.push(item);
    bySite.set(item.site, files);
    planned.push([objectKey(env, software, `public/${item.site}/${item.platform}/${item.arch}.json`), item]);
  }
  const common = { ...projectedAggregate }; delete common.files;
  for (const [site, files] of bySite) planned.push([objectKey(env, software, `${site}/metadata/public.json`), { ...common, site, files }]);
  await writeJson(env, objectKey(env, software, 'state/public.json'), { release_id: id, locked, updated_at: new Date().toISOString(), source });
  await writeJson(env, objectKey(env, software, 'metadata/public.json'), projectedAggregate, 'public, max-age=60');
  for (const [key, payload] of planned) await writeJson(env, key, payload, 'public, max-age=60');
}

async function handleLogin(request, env) {
  const form = await request.formData();
  await assertMutationOrigin(request);
  // Missing credentials are an intentional fail-closed state.  Never include
  // which secret is missing, or any supplied value, in a response/log.
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) throw new HttpError(503, 'Admin authentication is not configured.');
  const csrf = String(form.get('csrf_token') || request.headers.get('x-csrf-token') || '');
  if (!constantTimeEqual(csrf, await loginCsrfToken(request, env))) throw new HttpError(403, 'CSRF validation failed.');
  const password = String(form.get('password') || '');
  if (!constantTimeEqual(password, env.ADMIN_PASSWORD)) return await renderLoginPage(env, request, '密码错误。', 401);
  return redirect('/admin', await createSessionCookie(env));
}
async function requireAdmin(request, env) {
  const session = await verifySession(request, env);
  if (!session) throw new HttpError(401, 'Admin login required.');
  return session;
}
async function requireCsrf(request, env, session) {
  await assertMutationOrigin(request);
  const form = await request.clone().formData().catch(() => null);
  const token = String(form?.get('csrf_token') || request.headers.get('x-csrf-token') || '');
  if (!session?.csrf || !constantTimeEqual(token, session.csrf)) throw new HttpError(403, 'CSRF validation failed.');
}
async function assertMutationOrigin(request) {
  const expected = new URL(request.url).origin;
  for (const name of ['origin', 'referer']) {
    const value = request.headers.get(name);
    if (!value) continue;
    try {
      if (new URL(value).origin !== expected) throw new Error('origin mismatch');
    } catch {
      throw new HttpError(403, 'CSRF validation failed.');
    }
  }
}
async function loginCsrfToken(request, env) { return sign(`login:${new URL(request.url).origin}`, env.ADMIN_SESSION_SECRET); }
async function verifySession(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return null;
  const cookie = parseCookies(request.headers.get('cookie') || '')[COOKIE_NAME];
  if (!cookie) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !constantTimeEqual(signature, await sign(payload, env.ADMIN_SESSION_SECRET))) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Decode(payload)));
    return parsed.exp && Date.now() / 1000 <= parsed.exp && typeof parsed.csrf === 'string' ? parsed : null;
  } catch { return null; }
}
async function createSessionCookie(env) {
  const now = Math.floor(Date.now() / 1000);
  const csrfBytes = new Uint8Array(32);
  crypto.getRandomValues(csrfBytes);
  const payload = base64Encode(new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + SESSION_TTL_SECONDS, csrf: base64Encode(csrfBytes) })));
  return `${COOKIE_NAME}=${payload}.${await sign(payload, env.ADMIN_SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}
function clearSessionCookie() { return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
async function sign(value, secret) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return base64Encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))); }
function parseCookies(header) { return Object.fromEntries(header.split(';').map((part) => { const [name, ...rest] = part.trim().split('='); return [name, rest.join('=')]; }).filter(([name]) => name)); }
function constantTimeEqual(a, b) { const left = new TextEncoder().encode(String(a)); const right = new TextEncoder().encode(String(b)); let difference = left.length ^ right.length; for (let i = 0; i < Math.max(left.length, right.length); i += 1) difference |= (left[i] || 0) ^ (right[i] || 0); return difference === 0; }
function randomToken() { const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function base64Encode(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function base64Decode(value) { const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
async function sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function matchesMagic(extension, bytes) { if (extension === 'png') return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]); if (extension === 'jpg' || extension === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; if (extension === 'gif') return new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF87a' || new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF89a'; return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'; }
function safeFilename(value) { return String(value).replace(/["\\\r\n]/g, '_'); }

async function readDisplayMetadata(env, software) {
  try {
    return { metadata: await aggregate(env, software, 'public'), error: '', missing: false };
  } catch (publicError) {
    if (!(publicError instanceof HttpError) || publicError.status !== 404) throw publicError;
    try {
      return { metadata: await aggregate(env, software, 'latest'), error: '公开版本元数据暂不可用，当前显示最新版本元数据。', missing: false };
    } catch (latestError) {
      if (!(latestError instanceof HttpError) || latestError.status !== 404) throw latestError;
      return { metadata: null, error: '暂无可展示的版本元数据。', missing: true };
    }
  }
}

async function renderAdminV2(env, request) {
  const session = await verifySession(request, env);
  if (!session) {
    return renderLoginPage(env, request);
  }
  const csrf = escapeHtml(session.csrf);
  const cards = await Promise.all(profiles().map(async (software) => renderAdminSoftwareCard(
    software,
    await readAdminSoftware(env, software),
    csrf,
  )));
  const updated = new URL(request.url).searchParams.get('updated');
  const notice = updated === 'wechat-group-qrcode-uploaded'
    ? '<p class="notice" role="status">微信群 QR 圖片已上傳並發布。</p>'
    : updated ? `<p class="notice" role="status">操作已完成：${escapeHtml(updated)}</p>` : '';
  let qrCurrent = '<p class="muted">尚未发布微信群二维码。</p>';
  let qrStorageAvailable = true;
  try {
    const qr = await latestQr(env, true);
    if (qr) qrCurrent = `<img src="/wechat-group-qrcode" alt="当前微信群二维码" loading="lazy"><dl><dt>当前文件</dt><dd>${escapeHtml(qr.filename || '未命名')}</dd><dt>更新时间</dt><dd>${escapeHtml(qr.uploaded_at || '未知')}</dd><dt>大小</dt><dd>${escapeHtml(formatBytes(qr.size))}</dd><dt>稳定 URL</dt><dd><a href="/wechat-group-qrcode">/wechat-group-qrcode</a></dd></dl>`;
  } catch (error) {
    qrStorageAvailable = false;
    qrCurrent = '<p class="error">R2 存储暂时不可用，当前二维码信息无法读取。</p><p class="muted">为避免发布出不一致状态，上传操作已暂时停用。</p>';
  }
  return htmlPage('R2 管理后台', `${notice}<section class="card"><h1>R2 管理后台</h1><form method="post" action="/admin/logout"><input type="hidden" name="csrf_token" value="${csrf}"><button type="submit">退出登录</button></form></section><section class="download-section"><h2>微信群二维码</h2><article class="card">${qrCurrent}<form method="post" action="/admin/wechat-group-qrcode/upload" enctype="multipart/form-data"><input type="hidden" name="csrf_token" value="${csrf}"><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><p class="muted">支持 PNG、JPG、GIF、WebP，文件大小不超过 5 MiB。</p><button type="submit" ${qrStorageAvailable ? '' : 'disabled'}>上传并发布</button></form></article></section><section class="download-section"><h2>软件发布控制</h2><div class="admin-grid">${cards.join('')}</div></section>`, { status: qrStorageAvailable ? 200 : 503 });
}

async function readAdminSoftware(env, software) {
  try {
    const [latest, publicState, previousState, latestMeta, publicMeta, releases] = await Promise.all([
      state(env, software, 'latest'), state(env, software, 'public'), state(env, software, 'previous'),
      optionalAggregate(env, software, 'latest'), optionalAggregate(env, software, 'public'),
      listReleases(env, software),
    ]);
    return { kind: 'ok', latest, publicState, previousState, latestMeta, publicMeta, releases };
  } catch {
    return { kind: 'outage' };
  }
}

function renderAdminSoftwareCard(software, result, csrf) {
  const actionBase = software.id === DEFAULT_SOFTWARE_ID ? '/admin/public' : `/admin/${encodeURIComponent(software.id)}/public`;
  if (result.kind === 'outage') {
    return `<article class="card"><h3>${escapeHtml(software.displayName)}</h3><p class="error">R2 存储暂时不可用，无法读取发布状态。</p><p class="muted">发布操作已停用，存储恢复后可重新载入本页。</p><form method="post" action="${actionBase}/lock-previous"><button type="submit" disabled>锁定到上一公开版本</button></form><form method="post" action="${actionBase}/unlock"><button type="submit" disabled>解除锁定并发布最新版本</button></form><form method="post" action="${actionBase}/set"><button type="submit" disabled>锁定所选版本</button></form></article>`;
  }
  const previousId = releaseId(result.previousState);
  const options = result.releases.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  return `<article class="card"><h3>${escapeHtml(software.displayName)}</h3><dl><dt>最新版本</dt><dd>${escapeHtml(releaseId(result.latest) || result.latestMeta?.release_id || '缺失')}</dd><dt>公开版本</dt><dd>${escapeHtml(releaseId(result.publicState) || result.publicMeta?.release_id || '缺失')}</dd><dt>公开版本锁定</dt><dd>${result.publicState?.locked ? '是' : '否'}</dd><dt>上一版本</dt><dd>${escapeHtml(previousId || '缺失')}</dd></dl><form method="post" action="${actionBase}/lock-previous"><input type="hidden" name="csrf_token" value="${csrf}"><button type="submit" ${previousId ? '' : 'disabled'}>锁定到上一公开版本</button></form><form method="post" action="${actionBase}/unlock"><input type="hidden" name="csrf_token" value="${csrf}"><button type="submit">解除锁定并发布最新版本</button></form><form method="post" action="${actionBase}/set"><input type="hidden" name="csrf_token" value="${csrf}"><select name="release_id" required>${options}</select><button type="submit" ${result.releases.length ? '' : 'disabled'}>锁定所选版本</button></form></article>`;
}
async function optionalAggregate(env, software, channel) {
  try { return await aggregate(env, software, channel); }
  catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

async function renderLoginPage(env, request, message = '', status = 200) {
  const token = env.ADMIN_SESSION_SECRET ? await loginCsrfToken(request, env) : '';
  return htmlPage('管理员登录', `<section class="card narrow"><h1>管理员登录</h1>${message ? `<p class="error">${escapeHtml(message)}</p>` : ''}<form method="post" action="/admin/login"><input type="hidden" name="csrf_token" value="${escapeHtml(token)}"><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section>`, { status });
}

async function renderLandingPage(env) {
  const home = String(env.JUAPI_HOME_URL || SITE_PROFILES.tokenrouter.origin).trim();
  const groups = await Promise.all(profiles().map(async (software) => { const result = await readDisplayMetadata(env, software); const files = Array.isArray(result.metadata?.files) ? result.metadata.files : []; const links = files.filter((file) => file?.site && file.platform && file.arch).map((file) => `<div class="platform-download"><span>${escapeHtml(`${friendlyPlatform(file.platform)} ${friendlyArch(file.arch)}`)}</span><a href="/download/${encodeURIComponent(software.id)}/${encodeURIComponent(file.site)}/${encodeURIComponent(file.platform)}/${encodeURIComponent(file.arch)}">下载</a></div>`).join(''); return `<article class="download-group"><div><p class="eyebrow">Software</p><h3>${escapeHtml(software.displayName)}</h3><p class="muted">发布日期 ${escapeHtml(formatDate(result.metadata?.generated_at))}</p></div><a href="/software/${encodeURIComponent(software.id)}">详情</a><div class="platform-list">${links || '<p class="muted">暂无可展示的下载平台。</p>'}</div>${result.error ? `<p class="notice">${escapeHtml(result.error)}</p>` : ''}</article>`; }));
  if (groups.every((group) => group.includes('暂无可展示的下载平台。'))) throw new HttpError(404, 'Downloads metadata not found.');
  return htmlPage('JuAPI 软件下载中心', `<section class="hero"><p class="eyebrow">JuAPI 分发服务</p><h1><span>JuAPI</span> 下载中心</h1><a class="button" href="${escapeHtml(home)}">前往 JuAPI</a></section><section class="download-section"><p class="eyebrow">Downloads</p><h2>可用下载</h2><div class="download-group-grid">${groups.join('')}</div></section>`);
}
async function renderSoftwarePage(env, software) { const result = await readDisplayMetadata(env, software); if (result.missing) throw new HttpError(404, 'Downloads metadata not found.'); const files = Array.isArray(result.metadata?.files) ? result.metadata.files : []; const cards = files.map((file) => `<article class="file-card"><h3>${escapeHtml(`${siteLabel(file.site)} · ${friendlyPlatform(file.platform)} ${friendlyArch(file.arch)}`)}</h3><p>${escapeHtml(file.filename || '安装包')}</p><p class="muted">${escapeHtml(formatBytes(file.size))} · SHA-256 ${escapeHtml(String(file.sha256 || '').slice(0, 16))}</p><a href="/download/${encodeURIComponent(software.id)}/${encodeURIComponent(file.site)}/${encodeURIComponent(file.platform)}/${encodeURIComponent(file.arch)}">下载安装器</a></article>`).join(''); return htmlPage(software.title, `<section class="hero"><p class="eyebrow">${escapeHtml(software.displayName)} 官方下载</p><h1>${escapeHtml(software.displayName)} 下载</h1><p>${escapeHtml(software.subtitle)}</p><span class="release-pill">公开版本 <strong>${escapeHtml(result.metadata?.release_id || '未知')}</strong></span></section><section class="download-section"><h2>可用下载</h2><div class="grid">${cards || `<article class="empty-state"><h3>暂无安装包</h3><p>${escapeHtml(result.error || '这个公开版本暂时没有可下载文件。')}</p></article>`}</div></section><p class="footer-link"><a href="/downloads">软件下载中心</a> · <a href="/api/${encodeURIComponent(software.id)}/public">公开元数据</a> · <a href="/admin">管理后台</a></p>`); }
async function renderAdmin(env, request) { if (!await verifySession(request, env)) return htmlPage('管理员登录', `<section class="card narrow"><h1>管理员登录</h1><form method="post" action="/admin/login"><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section>`); const cards = await Promise.all(profiles().map(async (software) => { const [latest, pub, prev, releases] = await Promise.all([state(env, software, 'latest'), state(env, software, 'public'), state(env, software, 'previous'), listReleases(env, software)]); const base = software.id === DEFAULT_SOFTWARE_ID ? '/admin/public' : `/admin/${encodeURIComponent(software.id)}/public`; return `<article class="card"><h3>${escapeHtml(software.displayName)}</h3><dl><dt>最新版本</dt><dd>${escapeHtml(releaseId(latest) || '缺失')}</dd><dt>公开版本</dt><dd>${escapeHtml(releaseId(pub) || '缺失')}</dd><dt>上一版本</dt><dd>${escapeHtml(releaseId(prev) || '缺失')}</dd></dl><form method="post" action="${base}/lock-previous"><button ${releaseId(prev) ? '' : 'disabled'}>锁定到上一公开版本</button></form><form method="post" action="${base}/unlock"><button>解除锁定并发布最新版本</button></form><form method="post" action="${base}/set"><select name="release_id" required>${releases.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')}</select><button ${releases.length ? '' : 'disabled'}>锁定所选版本</button></form></article>`; })); return htmlPage('R2 管理后台', `<section class="card"><h1>R2 管理后台</h1><form method="post" action="/admin/logout"><button>退出登录</button></form></section><section class="download-section"><h2>微信群二维码</h2><form method="post" action="/admin/wechat-group-qrcode/upload" enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><button>上传并发布</button></form></section><section class="download-section"><h2>软件发布控制</h2><div class="admin-grid">${cards.join('')}</div></section>`); }
async function listReleases(env, software) { if (typeof env.DOWNLOADS.list !== 'function') return []; let result; try { result = await env.DOWNLOADS.list({ prefix: objectKey(env, software, 'releases/'), delimiter: '/', limit: 1000 }); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); } const start = objectKey(env, software, 'releases/'); return (result.delimitedPrefixes || []).map((value) => String(value).slice(start.length).replace(/\/$/, '')).filter(Boolean).sort().reverse(); }
function adminPage(message) { return htmlPage('管理员登录', `<section class="card narrow"><h1>管理员登录</h1><p class="error">${escapeHtml(message)}</p><form method="post" action="/admin/login"><label>密码 <input type="password" name="password" required></label><button>登录</button></form></section>`); }

function json(payload, status = 200) { return new Response(JSON.stringify(payload, null, 2) + '\n', { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function redirect(location, cookie = '') { const headers = new Headers({ location, 'cache-control': 'no-store' }); if (cookie) headers.set('set-cookie', cookie); return new Response(null, { status: 303, headers }); }
function redirectFound(location) { return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } }); }
function htmlPage(title, body, { status = 200, headers: extraHeaders = undefined } = {}) { return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" type="image/png" href="${BRAND_ASSETS.favicon}"><style>body{font-family:system-ui,sans-serif;margin:0;background:#f7f9ff;color:#101828}main{max-width:1120px;margin:auto;padding:2rem}.hero,.card,.file-card,.download-group{padding:1.25rem;border:1px solid #d9ddf5;border-radius:20px;background:#fff;box-shadow:0 10px 30px #66708522}.download-group-grid,.grid,.admin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem}.platform-list{display:grid;gap:.5rem}.platform-download{display:flex;justify-content:space-between;gap:1rem;padding:.75rem;border:1px solid #e5e7eb;border-radius:12px}.button,button,a{color:#4f46e5;font-weight:700}.button,button{padding:.65rem 1rem;border-radius:999px;border:0;background:#4f46e5;color:white;cursor:pointer}.muted{color:#667085}.narrow{max-width:440px;margin:10vh auto}label,select,input{display:block;margin:.5rem 0;padding:.65rem;width:100%;box-sizing:border-box}.eyebrow{color:#4f46e5;font-weight:800}.error{color:#b42318}.notice{color:#067647}</style></head><body><main>${body}</main></body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(extraHeaders || {}) } }); }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function formatDate(value) { const date = new Date(String(value || '')); return Number.isNaN(date.getTime()) ? '未提供' : date.toISOString().slice(0, 10); }
function formatBytes(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0) return '大小未知'; const units = ['B', 'KB', 'MB', 'GB']; let current = number; let unit = 0; while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; } return `${current.toFixed(unit ? 1 : 0)} ${units[unit]}`; }
function friendlyPlatform(value) { return ({ darwin: 'macOS', mac: 'macOS', macos: 'macOS', win32: 'Windows', windows: 'Windows', linux: 'Linux' })[String(value || '').toLowerCase()] || titleCase(value || '平台'); }
function friendlyArch(value) { return ({ amd64: 'x64', x64: 'x64', x86_64: 'x64', aarch64: 'arm64', arm64: 'arm64' })[String(value || '').toLowerCase()] || String(value || '架构'); }
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || '下载'; }
function siteLabel(value) { return SITE_PROFILES[String(value || '').toLowerCase()]?.displayName || titleCase(value || '下载'); }
