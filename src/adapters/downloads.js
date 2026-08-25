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
const TARGET_PART = /^[A-Za-z0-9._-]+$/;
const RESERVED = new Set(['admin', 'api', 'download', 'latest', 'previous', 'public', 'software', 'wechat-group-qrcode']);
const QR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const QR_EXTENSIONS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const QR_MAX_BYTES = 5 * 1024 * 1024;
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
  if (pathname === '/software' || pathname.startsWith('/software/')) return true;
  if (pathname === '/download' || pathname.startsWith('/download/')) return true;
  if (pathname === '/wechat-group-qrcode' || pathname.startsWith('/wechat-group-qrcode/')) return true;
  if (pathname === '/api/latest' || pathname === '/api/public' || pathname === '/api/previous') return true;
  if (pathname.startsWith('/api/latest/') || pathname.startsWith('/api/public/')) return true;
  if (pathname === '/api/wechat-group-qrcode/latest') return true;
  return /^\/api\/[a-z0-9][a-z0-9-]{0,62}\/(latest|public|previous)(?:\/|$)/.test(pathname);
}

export async function routeDownloads(request, env, pathname) {
  const mounted = pathname === '/downloads' || pathname.startsWith('/downloads/');
  const localPath = mounted ? (pathname === '/downloads' ? '/' : pathname.slice('/downloads'.length)) : pathname;
  const normalized = normalizePath(localPath);
  const parts = normalized.split('/').filter(Boolean);

  // The source Worker has no explicit HEAD handlers; retain its empty HTML
  // 404 contract instead of turning a probe into a successful GET.
  if (request.method === 'HEAD') return new Response(null, { status: 404, headers: { 'content-type': normalized.startsWith('/api/') ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

  if (request.method === 'GET' && normalized === '/') return renderLandingPage(env);
  if (request.method === 'GET' && (normalized === '/assets' || normalized.startsWith('/assets/'))) {
    if (!env.ASSETS?.fetch) throw new HttpError(404, 'Asset not found.');
    const assetUrl = new URL(request.url);
    assetUrl.pathname = normalized;
    return env.ASSETS.fetch(new Request(assetUrl, request));
  }
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
    await requireAdmin(request, env);
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
  if (parts.length === 3 && parts[1] === 'wechat-group-qrcode' && parts[2] === 'latest') return json(await readJson(env, qrKey(env, 'metadata/latest.json')));
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
  if (parts.length !== 3 || !parts.every((part) => TARGET_PART.test(part))) throw new HttpError(400, 'Invalid target.');
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
function prefix(env, software) { return String(env[software.prefixEnvVar] || software.prefix || DEFAULT_PREFIX).replace(/^\/+|\/+$/g, '') || DEFAULT_PREFIX; }
function objectKey(env, software, relative) { return `${prefix(env, software)}/${relative.replace(/^\/+/, '')}`; }
function qrPrefix(env) { return String(env.WECHAT_GROUP_QR_PREFIX || DEFAULT_QR_PREFIX).replace(/^\/+|\/+$/g, '') || DEFAULT_QR_PREFIX; }
function qrKey(env, relative) { return `${qrPrefix(env)}/${relative.replace(/^\/+/, '')}`; }

async function readJson(env, key, { optional = false } = {}) {
  let object;
  try { object = await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) {
    if (optional) return null;
    throw new HttpError(404, `R2 object not found: ${key}`);
  }
  try { return JSON.parse(await object.text()); } catch { throw new HttpError(503, 'Downloads metadata is temporarily unavailable.'); }
}
async function writeJson(env, key, payload, cacheControl = 'no-store') {
  try {
    await env.DOWNLOADS.put(key, `${JSON.stringify(payload, null, 2)}\n`, { httpMetadata: { contentType: 'application/json; charset=utf-8', cacheControl } });
  } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
}
async function aggregate(env, software, channel) { return readJson(env, objectKey(env, software, `metadata/${channel}.json`)); }
async function target(env, software, channel, wanted) { return readJson(env, objectKey(env, software, `${channel}/${wanted.site}/${wanted.platform}/${wanted.arch}.json`)); }
async function state(env, software, name) { return readJson(env, objectKey(env, software, `state/${name}.json`), { optional: true }); }

function releaseId(payload) {
  if (typeof payload === 'string') return payload.trim();
  return payload && typeof payload === 'object' ? String(payload.release_id || payload.latest_release_id || '').trim() : '';
}
async function previous(env, software) {
  const current = await state(env, software, 'previous');
  const id = releaseId(current);
  if (id && !RELEASE_ID.test(id)) throw new HttpError(503, 'Downloads metadata is temporarily unavailable.');
  return id ? { state: current, metadata: await readJson(env, objectKey(env, software, `releases/${id}/metadata/latest.json`), { optional: true }) } : { state: null, metadata: null };
}

function safeObjectKey(value, expectedPrefix = '') {
  return typeof value === 'string' && value.startsWith(expectedPrefix) && value.length > expectedPrefix.length
    && !value.startsWith('/') && !value.includes('\\') && !value.includes('..') && !value.includes('//') && /^[A-Za-z0-9._/-]+$/.test(value);
}
function resolveDownloadUrl(env, software, metadata) {
  if (metadata?.url) return String(metadata.url);
  if (metadata?.r2_key) {
    const base = String(env[software.publicBaseUrlEnvVar] || env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    if (base) return `${base}/${metadata.r2_key}`;
  }
  return '';
}
async function download(env, software, channel, wanted) {
  const metadata = await target(env, software, channel, wanted);
  const url = resolveDownloadUrl(env, software, metadata);
  if (url) return redirectFound(url);
  const key = metadata?.r2_key;
  if (!safeObjectKey(key, `${prefix(env, software)}/`)) throw new HttpError(404, 'Selected artifact has no valid r2_key.');
  let object;
  try { object = await env.DOWNLOADS.get(key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) throw new HttpError(404, `Artifact not found: ${key}`);
  const headers = new Headers({ 'content-type': metadata.content_type || object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': object.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable', 'content-disposition': `attachment; filename="${safeFilename(metadata.filename || 'download.bin')}"` });
  if (metadata.size) headers.set('content-length', String(metadata.size));
  return new Response(object.body, { headers });
}

function validateQrMetadata(env, metadata) {
  const key = metadata?.r2_key;
  const images = `${qrPrefix(env)}/images/`;
  if (!safeObjectKey(key, images)) throw new HttpError(400, 'WeChat group QR code r2_key must be under the configured images prefix.');
  const contentType = String(metadata?.content_type || '').trim().toLowerCase();
  if (contentType && !QR_TYPES.has(contentType)) throw new HttpError(400, 'Invalid WeChat group QR code content_type.');
  return { r2Key: key, contentType };
}
async function latestQr(env, optional = false) { return readJson(env, qrKey(env, 'metadata/latest.json'), { optional }); }
async function serveQr(env) {
  const metadata = await latestQr(env);
  const validated = validateQrMetadata(env, metadata);
  const base = String(env.WECHAT_GROUP_QR_PUBLIC_BASE_URL || env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (base) return new Response(null, { status: 302, headers: { location: `${base}/${validated.r2Key}`, 'cache-control': 'no-store' } });
  let object;
  try { object = await env.DOWNLOADS.get(validated.r2Key); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); }
  if (!object) throw new HttpError(404, `WeChat group QR code not found: ${validated.r2Key}`);
  const headers = new Headers({ 'content-type': validated.contentType || object.httpMetadata?.contentType || 'application/octet-stream', 'cache-control': 'no-store' });
  if (metadata.size) headers.set('content-length', String(metadata.size));
  return new Response(object.body, { headers });
}

async function handleQrUpload(request, env) {
  await requireAdmin(request, env);
  const upload = (await request.formData()).get('image');
  if (!upload || typeof upload.arrayBuffer !== 'function') throw new HttpError(400, '請選擇一張微信群 QR 圖片。');
  const filename = String(upload.name || 'wechat-group-qrcode').trim() || 'wechat-group-qrcode';
  const extension = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const contentType = QR_EXTENSIONS[extension];
  if (!contentType) throw new HttpError(400, '只支持 PNG、JPG、GIF 或 WebP 圖片。');
  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, '圖片檔案不能為空。');
  if (bytes.length > QR_MAX_BYTES) throw new HttpError(400, '圖片檔案不能超過 5 MiB。');
  if (!matchesMagic(extension, bytes)) throw new HttpError(400, `圖片內容與 .${extension} 副檔名不一致。`);
  const digest = await sha256(bytes);
  const version = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${digest.slice(0, 12)}`;
  const key = `${qrPrefix(env)}/images/${version}.${extension}`;
  const base = String(env.WECHAT_GROUP_QR_PUBLIC_BASE_URL || env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const metadata = { asset_id: 'wechat-group-qrcode', version_id: version, uploaded_at: new Date().toISOString(), source: 'admin-panel', filename, r2_key: key, ...(base ? { url: `${base}/${key}` } : {}), sha256: digest, size: bytes.length, content_type: contentType };
  const latest = await latestQr(env, true);
  await env.DOWNLOADS.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
  if (latest) await writeJson(env, qrKey(env, 'state/previous.json'), latest);
  await writeJson(env, qrKey(env, 'metadata/latest.json'), metadata);
  await writeJson(env, qrKey(env, 'state/latest.json'), metadata);
  return redirect('/admin?updated=wechat-group-qrcode-uploaded');
}

async function handleAdminAction(request, env, softwareId, action) {
  await requireAdmin(request, env);
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
  await writeJson(env, objectKey(env, software, 'state/public.json'), { release_id: id, locked, updated_at: new Date().toISOString(), source });
  await writeJson(env, objectKey(env, software, 'metadata/public.json'), aggregateMetadata, 'public, max-age=60');
  const bySite = new Map();
  for (const item of aggregateMetadata.files) {
    if (!item?.site || !item.platform || !item.arch) continue;
    const files = bySite.get(item.site) || []; files.push(item); bySite.set(item.site, files);
    await writeJson(env, objectKey(env, software, `public/${item.site}/${item.platform}/${item.arch}.json`), item, 'public, max-age=60');
  }
  const common = { ...aggregateMetadata }; delete common.files;
  for (const [site, files] of bySite) await writeJson(env, objectKey(env, software, `${site}/metadata/public.json`), { ...common, site, files }, 'public, max-age=60');
}

async function handleLogin(request, env) {
  const password = String((await request.formData()).get('password') || '');
  // Missing credentials are an intentional fail-closed state.  Never include
  // which secret is missing, or any supplied value, in a response/log.
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) throw new HttpError(503, 'Admin authentication is not configured.');
  if (!constantTimeEqual(password, env.ADMIN_PASSWORD)) return new Response(adminPage('密码错误。'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  return redirect('/admin', await createSessionCookie(env));
}
async function requireAdmin(request, env) { if (!await verifySession(request, env)) throw new HttpError(401, 'Admin login required.'); }
async function verifySession(request, env) {
  if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return null;
  const cookie = parseCookies(request.headers.get('cookie') || '')[COOKIE_NAME];
  if (!cookie) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature || !constantTimeEqual(signature, await sign(payload, env.ADMIN_SESSION_SECRET))) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64Decode(payload)));
    return parsed.exp && Date.now() / 1000 <= parsed.exp ? parsed : null;
  } catch { return null; }
}
async function createSessionCookie(env) { const now = Math.floor(Date.now() / 1000); const payload = base64Encode(new TextEncoder().encode(JSON.stringify({ iat: now, exp: now + SESSION_TTL_SECONDS }))); return `${COOKIE_NAME}=${payload}.${await sign(payload, env.ADMIN_SESSION_SECRET)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`; }
function clearSessionCookie() { return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
async function sign(value, secret) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return base64Encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))); }
function parseCookies(header) { return Object.fromEntries(header.split(';').map((part) => { const [name, ...rest] = part.trim().split('='); return [name, rest.join('=')]; }).filter(([name]) => name)); }
function constantTimeEqual(a, b) { const left = new TextEncoder().encode(String(a)); const right = new TextEncoder().encode(String(b)); let difference = left.length ^ right.length; for (let i = 0; i < Math.max(left.length, right.length); i += 1) difference |= (left[i] || 0) ^ (right[i] || 0); return difference === 0; }
function base64Encode(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function base64Decode(value) { const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
async function sha256(bytes) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function matchesMagic(extension, bytes) { if (extension === 'png') return bytes.length >= 8 && bytes.slice(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index]); if (extension === 'jpg' || extension === 'jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff; if (extension === 'gif') return new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF87a' || new TextDecoder().decode(bytes.slice(0, 6)) === 'GIF89a'; return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'; }
function safeFilename(value) { return String(value).replace(/["\\\r\n]/g, '_'); }

async function readDisplayMetadata(env, software) { try { return { metadata: await aggregate(env, software, 'public'), error: '' }; } catch (publicError) { try { return { metadata: await aggregate(env, software, 'latest'), error: '公开版本元数据暂不可用，当前显示最新版本元数据。' }; } catch { return { metadata: null, error: '暂无可展示的版本元数据。' }; } } }

async function renderAdminV2(env, request) {
  if (!await verifySession(request, env)) {
    return htmlPage('管理员登录', '<section class="card narrow"><h1>管理员登录</h1><form method="post" action="/admin/login"><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section>');
  }
  const cards = await Promise.all(profiles().map(async (software) => {
    const [latest, publicState, previousState, latestMeta, publicMeta, releases] = await Promise.all([
      state(env, software, 'latest'), state(env, software, 'public'), state(env, software, 'previous'),
      aggregate(env, software, 'latest').catch(() => null), aggregate(env, software, 'public').catch(() => null),
      listReleases(env, software),
    ]);
    const previousId = releaseId(previousState);
    const actionBase = software.id === DEFAULT_SOFTWARE_ID ? '/admin/public' : `/admin/${encodeURIComponent(software.id)}/public`;
    const options = releases.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
    return `<article class="card"><h3>${escapeHtml(software.displayName)}</h3><dl><dt>最新版本</dt><dd>${escapeHtml(releaseId(latest) || latestMeta?.release_id || '缺失')}</dd><dt>公开版本</dt><dd>${escapeHtml(releaseId(publicState) || publicMeta?.release_id || '缺失')}</dd><dt>公开版本锁定</dt><dd>${publicState?.locked ? '是' : '否'}</dd><dt>上一版本</dt><dd>${escapeHtml(previousId || '缺失')}</dd></dl><form method="post" action="${actionBase}/lock-previous"><button type="submit" ${previousId ? '' : 'disabled'}>锁定到上一公开版本</button></form><form method="post" action="${actionBase}/unlock"><button type="submit">解除锁定并发布最新版本</button></form><form method="post" action="${actionBase}/set"><select name="release_id" required>${options}</select><button type="submit" ${releases.length ? '' : 'disabled'}>锁定所选版本</button></form></article>`;
  }));
  return htmlPage('R2 管理后台', `<section class="card"><h1>R2 管理后台</h1><form method="post" action="/admin/logout"><button type="submit">退出登录</button></form></section><section class="download-section"><h2>微信群二维码</h2><form method="post" action="/admin/wechat-group-qrcode/upload" enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><button type="submit">上传并发布</button></form></section><section class="download-section"><h2>软件发布控制</h2><div class="admin-grid">${cards.join('')}</div></section>`);
}

async function renderLandingPage(env) {
  const home = String(env.JUAPI_HOME_URL || SITE_PROFILES.tokenrouter.origin).trim();
  const groups = await Promise.all(profiles().map(async (software) => { const result = await readDisplayMetadata(env, software); const files = Array.isArray(result.metadata?.files) ? result.metadata.files : []; const links = files.filter((file) => file?.site && file.platform && file.arch).map((file) => `<div class="platform-download"><span>${escapeHtml(`${friendlyPlatform(file.platform)} ${friendlyArch(file.arch)}`)}</span><a href="/download/${encodeURIComponent(software.id)}/${encodeURIComponent(file.site)}/${encodeURIComponent(file.platform)}/${encodeURIComponent(file.arch)}">下载</a></div>`).join(''); return `<article class="download-group"><div><p class="eyebrow">Software</p><h3>${escapeHtml(software.displayName)}</h3><p class="muted">发布日期 ${escapeHtml(formatDate(result.metadata?.generated_at))}</p></div><a href="/software/${encodeURIComponent(software.id)}">详情</a><div class="platform-list">${links || '<p class="muted">暂无可展示的下载平台。</p>'}</div>${result.error ? `<p class="notice">${escapeHtml(result.error)}</p>` : ''}</article>`; }));
  return htmlPage('JuAPI 软件下载中心', `<section class="hero"><p class="eyebrow">JuAPI 分发服务</p><h1><span>JuAPI</span> 下载中心</h1><a class="button" href="${escapeHtml(home)}">前往 JuAPI</a></section><section class="download-section"><p class="eyebrow">Downloads</p><h2>可用下载</h2><div class="download-group-grid">${groups.join('')}</div></section>`);
}
async function renderSoftwarePage(env, software) { const result = await readDisplayMetadata(env, software); const files = Array.isArray(result.metadata?.files) ? result.metadata.files : []; const cards = files.map((file) => `<article class="file-card"><h3>${escapeHtml(`${siteLabel(file.site)} · ${friendlyPlatform(file.platform)} ${friendlyArch(file.arch)}`)}</h3><p>${escapeHtml(file.filename || '安装包')}</p><p class="muted">${escapeHtml(formatBytes(file.size))} · SHA-256 ${escapeHtml(String(file.sha256 || '').slice(0, 16))}</p><a href="/download/${encodeURIComponent(software.id)}/${encodeURIComponent(file.site)}/${encodeURIComponent(file.platform)}/${encodeURIComponent(file.arch)}">下载安装器</a></article>`).join(''); return htmlPage(software.title, `<section class="hero"><p class="eyebrow">${escapeHtml(software.displayName)} 官方下载</p><h1>${escapeHtml(software.displayName)} 下载</h1><p>${escapeHtml(software.subtitle)}</p><span class="release-pill">公开版本 <strong>${escapeHtml(result.metadata?.release_id || '未知')}</strong></span></section><section class="download-section"><h2>可用下载</h2><div class="grid">${cards || `<article class="empty-state"><h3>暂无安装包</h3><p>${escapeHtml(result.error || '这个公开版本暂时没有可下载文件。')}</p></article>`}</div></section><p class="footer-link"><a href="/downloads">软件下载中心</a> · <a href="/api/${encodeURIComponent(software.id)}/public">公开元数据</a> · <a href="/admin">管理后台</a></p>`); }
async function renderAdmin(env, request) { if (!await verifySession(request, env)) return htmlPage('管理员登录', `<section class="card narrow"><h1>管理员登录</h1><form method="post" action="/admin/login"><label>密码 <input type="password" name="password" autocomplete="current-password" required></label><button type="submit">登录</button></form></section>`); const cards = await Promise.all(profiles().map(async (software) => { const [latest, pub, prev, releases] = await Promise.all([state(env, software, 'latest'), state(env, software, 'public'), state(env, software, 'previous'), listReleases(env, software)]); const base = software.id === DEFAULT_SOFTWARE_ID ? '/admin/public' : `/admin/${encodeURIComponent(software.id)}/public`; return `<article class="card"><h3>${escapeHtml(software.displayName)}</h3><dl><dt>最新版本</dt><dd>${escapeHtml(releaseId(latest) || '缺失')}</dd><dt>公开版本</dt><dd>${escapeHtml(releaseId(pub) || '缺失')}</dd><dt>上一版本</dt><dd>${escapeHtml(releaseId(prev) || '缺失')}</dd></dl><form method="post" action="${base}/lock-previous"><button ${releaseId(prev) ? '' : 'disabled'}>锁定到上一公开版本</button></form><form method="post" action="${base}/unlock"><button>解除锁定并发布最新版本</button></form><form method="post" action="${base}/set"><select name="release_id" required>${releases.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')}</select><button ${releases.length ? '' : 'disabled'}>锁定所选版本</button></form></article>`; })); return htmlPage('R2 管理后台', `<section class="card"><h1>R2 管理后台</h1><form method="post" action="/admin/logout"><button>退出登录</button></form></section><section class="download-section"><h2>微信群二维码</h2><form method="post" action="/admin/wechat-group-qrcode/upload" enctype="multipart/form-data"><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" required><button>上传并发布</button></form></section><section class="download-section"><h2>软件发布控制</h2><div class="admin-grid">${cards.join('')}</div></section>`); }
async function listReleases(env, software) { if (typeof env.DOWNLOADS.list !== 'function') return []; let result; try { result = await env.DOWNLOADS.list({ prefix: objectKey(env, software, 'releases/'), delimiter: '/', limit: 1000 }); } catch { throw new HttpError(503, 'Downloads storage is temporarily unavailable.'); } const start = objectKey(env, software, 'releases/'); return (result.delimitedPrefixes || []).map((value) => String(value).slice(start.length).replace(/\/$/, '')).filter(Boolean).sort().reverse(); }
function adminPage(message) { return htmlPage('管理员登录', `<section class="card narrow"><h1>管理员登录</h1><p class="error">${escapeHtml(message)}</p><form method="post" action="/admin/login"><label>密码 <input type="password" name="password" required></label><button>登录</button></form></section>`); }

function json(payload, status = 200) { return new Response(JSON.stringify(payload, null, 2) + '\n', { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function redirect(location, cookie = '') { const headers = new Headers({ location, 'cache-control': 'no-store' }); if (cookie) headers.set('set-cookie', cookie); return new Response(null, { status: 303, headers }); }
function redirectFound(location) { return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } }); }
function htmlPage(title, body) { return new Response(`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="icon" type="image/png" href="${BRAND_ASSETS.favicon}"><style>body{font-family:system-ui,sans-serif;margin:0;background:#f7f9ff;color:#101828}main{max-width:1120px;margin:auto;padding:2rem}.hero,.card,.file-card,.download-group{padding:1.25rem;border:1px solid #d9ddf5;border-radius:20px;background:#fff;box-shadow:0 10px 30px #66708522}.download-group-grid,.grid,.admin-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem}.platform-list{display:grid;gap:.5rem}.platform-download{display:flex;justify-content:space-between;gap:1rem;padding:.75rem;border:1px solid #e5e7eb;border-radius:12px}.button,button,a{color:#4f46e5;font-weight:700}.button,button{padding:.65rem 1rem;border-radius:999px;border:0;background:#4f46e5;color:white;cursor:pointer}.muted{color:#667085}.narrow{max-width:440px;margin:10vh auto}label,select,input{display:block;margin:.5rem 0;padding:.65rem;width:100%;box-sizing:border-box}.eyebrow{color:#4f46e5;font-weight:800}.error{color:#b42318}</style></head><body><main>${body}</main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }); }
function escapeHtml(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
function formatDate(value) { const date = new Date(String(value || '')); return Number.isNaN(date.getTime()) ? '未提供' : date.toISOString().slice(0, 10); }
function formatBytes(value) { const number = Number(value); if (!Number.isFinite(number) || number < 0) return '大小未知'; const units = ['B', 'KB', 'MB', 'GB']; let current = number; let unit = 0; while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; } return `${current.toFixed(unit ? 1 : 0)} ${units[unit]}`; }
function friendlyPlatform(value) { return ({ darwin: 'macOS', mac: 'macOS', macos: 'macOS', win32: 'Windows', windows: 'Windows', linux: 'Linux' })[String(value || '').toLowerCase()] || titleCase(value || '平台'); }
function friendlyArch(value) { return ({ amd64: 'x64', x64: 'x64', x86_64: 'x64', aarch64: 'arm64', arm64: 'arm64' })[String(value || '').toLowerCase()] || String(value || '架构'); }
function titleCase(value) { return String(value).split(/[-_\s]+/).filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || '下载'; }
function siteLabel(value) { return SITE_PROFILES[String(value || '').toLowerCase()]?.displayName || titleCase(value || '下载'); }
