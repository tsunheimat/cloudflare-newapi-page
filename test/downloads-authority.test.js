import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

class MockR2 {
  constructor(objects = {}) {
    this.objects = new Map(Object.entries(objects));
    this.puts = [];
    this.deletes = [];
    this.beforePut = null;
    this.etags = new Map([...this.objects.keys()].map((key, index) => [key, `etag-${index + 1}`]));
    this.nextEtag = this.etags.size + 1;
  }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    if (value?.bytes) {
      return {
        body: new ReadableStream({ start(controller) { controller.enqueue(value.bytes); controller.close(); } }),
        etag: this.etags.get(key),
        httpEtag: `"${this.etags.get(key)}"`,
        httpMetadata: value.httpMetadata || {},
        arrayBuffer: async () => value.bytes.slice().buffer,
        text: async () => new TextDecoder().decode(value.bytes),
      };
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
      etag: this.etags.get(key),
      httpEtag: `"${this.etags.get(key)}"`,
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      text: async () => text,
    };
  }
  async put(key, value, options) {
    if (this.beforePut) await this.beforePut(key, value, options);
    const condition = options?.onlyIf;
    if (condition?.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    if (condition?.etagMatches !== undefined && this.etags.get(key) !== condition.etagMatches) return null;
    this.puts.push({ key, value, options });
    this.objects.set(key, typeof value === 'string' ? value : { bytes: value, httpMetadata: options?.httpMetadata });
    const etag = `etag-${this.nextEtag++}`;
    this.etags.set(key, etag);
    return { key, etag, httpEtag: `"${etag}"` };
  }
  async delete(key) {
    this.deletes.push(key);
    this.objects.delete(key);
    this.etags.delete(key);
  }
  async list({ prefix, delimiter }) {
    const result = new Set();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      const at = delimiter ? remainder.indexOf(delimiter) : -1;
      if (at >= 0) result.add(`${prefix}${remainder.slice(0, at + 1)}`);
    }
    return { delimitedPrefixes: [...result] };
  }
}

const publicFile = {
  site: 'tokenrouter', platform: 'windows', arch: 'x64', filename: 'setup.exe', size: 12,
  sha256: 'a'.repeat(64), r2_key: 'codex-install/releases/v1/setup.exe', content_type: 'application/octet-stream',
};
const latestFile = { ...publicFile, r2_key: 'codex-install/releases/v2/setup.exe', filename: 'setup-latest.exe' };
const legacyMigratorFilename = 'Codex聊天记录迁移工具-linux-gui.tar.gz';
const legacyMigratorFile = {
  site: 'tokenrouter', platform: 'linux', arch: 'x64', filename: legacyMigratorFilename, size: 24,
  sha256: 'b'.repeat(64),
  r2_key: `codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/${legacyMigratorFilename}`,
  content_type: 'application/gzip',
  url: 'https://attacker.invalid/untrusted-metadata-url',
};

function env(overrides = {}) {
  const r2 = new MockR2({
    'codex-install/metadata/public.json': { release_id: 'v1', generated_at: '2026-01-01T00:00:00Z', files: [publicFile] },
    'codex-install/metadata/latest.json': { release_id: 'v2', files: [latestFile] },
    'codex-install/public/tokenrouter/windows/x64.json': publicFile,
    'codex-install/latest/tokenrouter/windows/x64.json': latestFile,
    'codex-install/state/latest.json': { release_id: 'v2' },
    'codex-install/state/previous.json': { release_id: 'v1' },
    'codex-install/releases/v1/metadata/latest.json': { release_id: 'v1', files: [publicFile] },
    'codex-install/releases/v2/metadata/latest.json': { release_id: 'v2', files: [latestFile] },
    'wechat-group-qrcode/metadata/latest.json': {
      asset_id: 'wechat-group-qrcode', r2_key: 'wechat-group-qrcode/images/current.png', size: png.length, content_type: 'image/png',
    },
    'wechat-group-qrcode/images/current.png': { bytes: png, httpMetadata: { contentType: 'image/png' } },
  });
  return {
    R2_PREFIX: 'codex-install', R2_PUBLIC_BASE_URL: 'https://tokenrouter-r2.wdtokenacc.top',
    JUAPI_HOME_URL: 'https://www.juaiapi.com', WECHAT_GROUP_QR_PREFIX: 'wechat-group-qrcode',
    WECHAT_GROUP_QR_PUBLIC_BASE_URL: 'https://tokenrouter-r2.wdtokenacc.top',
    CODEX_CHAT_RECORD_MIGRATOR_R2_PUBLIC_BASE_URL: 'https://tokenrouter-r2.wdtokenacc.top',
    DOWNLOADS: r2, ...overrides,
  };
}

function installMigratorMetadata(runtime, file = legacyMigratorFile) {
  const aggregate = { release_id: 'v0.1.1', generated_at: '2026-08-26T00:00:00Z', files: [file] };
  runtime.DOWNLOADS.objects.set('codex-chat-record-migrator/metadata/public.json', aggregate);
  runtime.DOWNLOADS.objects.set('codex-chat-record-migrator/metadata/latest.json', aggregate);
  runtime.DOWNLOADS.objects.set('codex-chat-record-migrator/public/tokenrouter/linux/x64.json', file);
  runtime.DOWNLOADS.objects.set('codex-chat-record-migrator/latest/tokenrouter/linux/x64.json', file);
  return runtime;
}

async function get(path, runtime = env(), init) {
  return worker.fetch(new Request(`https://public.example${path}`, init), runtime);
}

async function adminSession(runtime) {
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie');
  return { cookie, csrf: sessionCsrfToken(cookie) };
}

function qrUploadInit(session, filename) {
  const form = new FormData();
  form.append('csrf_token', session.csrf);
  form.append('image', new File([png], filename, { type: 'image/png' }));
  return { method: 'POST', headers: { cookie: session.cookie }, body: form };
}

function storedJson(runtime, key) {
  const value = runtime.DOWNLOADS.objects.get(key);
  if (value === undefined) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function sha256Hex(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function qrGeneration(label) {
  return {
    asset_id: 'wechat-group-qrcode', format_version: 'qr-generation-v1',
    generation_id: `generation-${label}`, operation_id: `operation-${label}`,
    version_id: `version-${label}`, uploaded_at: '2026-08-26T00:00:00.000Z',
    source: 'admin-panel', filename: `${label}.png`,
    r2_key: `wechat-group-qrcode/images/${label}.png`,
    sha256: await sha256Hex(png), size: png.length, content_type: 'image/png',
  };
}

function setR2Object(runtime, key, value, etag) {
  runtime.DOWNLOADS.objects.set(key, value);
  runtime.DOWNLOADS.etags.set(key, etag);
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('migrated public APIs read dynamic R2 metadata and direct/mounted targets agree', async () => {
  const runtime = env();
  const publicResponse = await get('/api/codex-installer/public', runtime);
  assert.equal(publicResponse.status, 200);
  assert.equal((await publicResponse.json()).release_id, 'v1');
  const mounted = await get('/downloads/api/codex-installer/public/tokenrouter/windows/x64', runtime);
  assert.equal(mounted.status, 200);
  assert.equal((await mounted.json()).filename, 'setup.exe');
  const redirect = await get('/download/latest/tokenrouter/windows/x64', runtime);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://tokenrouter-r2.wdtokenacc.top/codex-install/releases/v2/setup.exe');
});

test('legacy migrator Unicode artifact filenames remain valid across public routes', async () => {
  const runtime = installMigratorMetadata(env());
  const expectedUrl = 'https://tokenrouter-r2.wdtokenacc.top/codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/Codex%E8%81%8A%E5%A4%A9%E8%AE%B0%E5%BD%95%E8%BF%81%E7%A7%BB%E5%B7%A5%E5%85%B7-linux-gui.tar.gz';

  const publicResponse = await get('/api/codex-chat-record-migrator/public', runtime);
  assert.equal(publicResponse.status, 200);
  const metadata = await publicResponse.json();
  assert.equal(metadata.files[0].filename, legacyMigratorFilename);
  assert.equal(metadata.files[0].r2_key, legacyMigratorFile.r2_key);
  assert.equal(metadata.files[0].url, expectedUrl);
  assert.equal((await get('/downloads/api/codex-chat-record-migrator/public', runtime)).status, 200);

  const softwarePage = await get('/software/codex-chat-record-migrator', runtime);
  assert.equal(softwarePage.status, 200);
  assert.match(await softwarePage.text(), new RegExp(legacyMigratorFilename));
  assert.equal((await get('/downloads', runtime)).status, 200);

  const redirect = await get('/download/codex-chat-record-migrator/tokenrouter/linux/x64', runtime);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), expectedUrl);
});

test('artifact key validation rejects unsafe Unicode and path components', async () => {
  const unsafeKeys = [
    `/codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/${legacyMigratorFilename}`,
    `codex-chat-record-migrator//releases/v0.1.1/tokenrouter/linux/x64/${legacyMigratorFilename}`,
    `codex-chat-record-migrator/releases/../tokenrouter/linux/x64/${legacyMigratorFilename}`,
    `codex-chat-record-migrator/releases/v0..1/tokenrouter/linux/x64/${legacyMigratorFilename}`,
    `codex-chat-record-migrator/releases/v0.1.1/tokenrouter/版本/x64/${legacyMigratorFilename}`,
    `codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64\\${legacyMigratorFilename}`,
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/Codex聊天..tar.gz',
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/.',
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/..',
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/Codex聊\u0000天.tar.gz',
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/Codex聊\u0085天.tar.gz',
    'codex-chat-record-migrator/releases/v0.1.1/tokenrouter/linux/x64/Codex聊\u2028天.tar.gz',
  ];

  for (const r2Key of unsafeKeys) {
    const runtime = installMigratorMetadata(env(), { ...legacyMigratorFile, r2_key: r2Key });
    const response = await get('/api/codex-chat-record-migrator/public', runtime);
    assert.equal(response.status, 503, JSON.stringify(r2Key));
    assert.doesNotMatch(await response.text(), /attacker\.invalid|escape/);
  }
});

test('migrated routes prefer R2 and never call the rollback service binding', async () => {
  let called = false;
  const runtime = env({ DOWNLOADS_SERVICE: { fetch: async () => { called = true; return new Response('legacy'); } } });
  const response = await get('/downloads', runtime);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Codex 安装器/);
  assert.equal(called, false);
});

test('migrated route HTML carries a nonce CSP while the rollback service remains untouched', async () => {
  const response = await get('/downloads', env());
  assert.equal(response.status, 200);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /style-src 'nonce-[A-Za-z0-9]+'/);
  const nonce = csp.match(/style-src 'nonce-([^']+)'/)[1];
  assert.match(await response.text(), new RegExp(`<style nonce="${nonce}">`));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('production R2 mode fails closed without get/put and never calls the rollback service', async () => {
  let serviceCalled = false;
  const runtime = env({
    DOWNLOADS_INTEGRATION: 'production-r2-binding',
    DOWNLOADS: undefined,
    DOWNLOADS_SERVICE: { fetch: async () => { serviceCalled = true; return new Response('legacy'); } },
  });
  for (const path of [
    '/api/downloads/catalog',
    '/api/codex-installer/public',
    '/downloads',
    '/wechat-group-qrcode/latest',
    '/admin',
  ]) {
    const response = await get(path, runtime);
    assert.equal(response.status, 503, path);
    assert.doesNotMatch(await response.text(), /legacy|DOWNLOADS_SERVICE/);
  }
  assert.equal(serviceCalled, false);

  const getOnly = env({
    DOWNLOADS_INTEGRATION: 'production-r2-binding',
    DOWNLOADS: { get: async () => null },
    DOWNLOADS_SERVICE: { fetch: async () => { serviceCalled = true; return new Response('legacy'); } },
  });
  assert.equal((await get('/api/codex-installer/public', getOnly)).status, 503);
  assert.equal(serviceCalled, false);
});

test('production R2 route matrix fails closed before any rollback service fallback', async () => {
  let serviceCalls = 0;
  const runtime = env({
    DOWNLOADS_INTEGRATION: 'production-r2-binding',
    DOWNLOADS: undefined,
    DOWNLOADS_SERVICE: { fetch: async () => {
      serviceCalls += 1;
      return new Response('legacy-service-must-not-run', { status: 200 });
    } },
  });
  const routes = [
    '/downloads', '/downloads/software/codex-installer', '/downloads/api/previous/foo',
    '/assets/juapi-logo.png', '/software/codex-installer', '/download/tokenrouter/windows/x64',
    '/admin', '/admin/public/lock-previous', '/wechat-group-qrcode',
    '/wechat-group-qrcode/latest', '/api/latest', '/api/latest/tokenrouter/windows/x64',
    '/api/public', '/api/public/tokenrouter/windows/x64', '/api/previous',
    '/api/previous/tokenrouter/windows/x64', '/api/wechat-group-qrcode',
    '/api/wechat-group-qrcode/latest', '/api/wechat-group-qrcode/history/current',
    '/api/codex-installer/latest', '/api/codex-installer/latest/tokenrouter/windows/x64',
    '/api/codex-installer/public', '/api/codex-installer/public/tokenrouter/windows/x64',
    '/api/codex-installer/previous', '/api/codex-installer/previous/tokenrouter/windows/x64',
  ];
  for (const path of routes) {
    const response = await get(path, runtime);
    assert.equal(response.status, 503, path);
    assert.doesNotMatch(await response.text(), /legacy-service-must-not-run/);
  }
  assert.equal(serviceCalls, 0);
});

test('direct assets use NewAPI ASSETS with R2 authority and retain service fallback without R2', async () => {
  let assetCalled = false;
  let serviceCalled = false;
  const runtime = env({
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    ASSETS: { fetch: async (request) => {
      assetCalled = true;
      return new Response(`local:${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/plain' } });
    } },
    DOWNLOADS_SERVICE: { fetch: async () => {
      serviceCalled = true;
      return new Response('legacy');
    } },
  });
  const local = await get('/assets/juapi-logo.png', runtime);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), 'local:/assets/juapi-logo.png');
  assert.equal(assetCalled, true);
  assert.equal(serviceCalled, false);

  delete runtime.DOWNLOADS;
  const fallback = await get('/assets/juapi-logo.png', runtime);
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), 'legacy');
  assert.equal(serviceCalled, true);
});

test('QR metadata is validated, redirects to the reviewed public base, and streams without a base', async () => {
  const redirect = await get('/wechat-group-qrcode/latest', env());
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), 'https://tokenrouter-r2.wdtokenacc.top/wechat-group-qrcode/images/current.png');
  const runtime = env();
  delete runtime.R2_PUBLIC_BASE_URL;
  delete runtime.WECHAT_GROUP_QR_PUBLIC_BASE_URL;
  const streamed = await get('/wechat-group-qrcode', runtime);
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await streamed.arrayBuffer()), png);
});

test('admin authentication fails closed without ADMIN_PASSWORD and does not expose secrets', async () => {
  const response = await get('/admin/login', env({ ADMIN_SESSION_SECRET: 'known-secret' }), {
    method: 'POST', body: new URLSearchParams({ password: 'guess' }),
  });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.doesNotMatch(body, /known-secret|guess|ADMIN_PASSWORD/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
});

test('admin login rejects a missing or mismatched CSRF token', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const missing = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct' }) });
  assert.equal(missing.status, 403);
  const page = await get('/admin', runtime);
  const token = loginPageTextToken(await page.text());
  const mismatched = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct', csrf_token: `${token}x` }) });
  assert.equal(mismatched.status, 403);
});

test('authenticated QR upload validates bytes and writes object plus latest/previous metadata', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const csrf = loginPageTextToken(await loginPage.text());
  const login = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct', csrf_token: csrf }) });
  assert.equal(login.status, 303);
  const form = new FormData();
  form.append('csrf_token', sessionCsrfToken(login.headers.get('set-cookie')));
  form.append('image', new File([png], 'new-qr.png', { type: 'image/png' }));
  const upload = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie: login.headers.get('set-cookie') }, body: form });
  assert.equal(upload.status, 303);
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key.startsWith('wechat-group-qrcode/images/')));
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'wechat-group-qrcode/metadata/latest.json'));
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'wechat-group-qrcode/state/previous.json'));
  const marker = storedJson(runtime, 'wechat-group-qrcode/state/pending.json');
  assert.equal(marker.phase, 'committed');
});

test('concurrent identical uploads have one conditional fence owner and never publish a mixed pair', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const markerPaused = deferred();
  const releaseMarker = deferred();
  const secondPaused = deferred();
  const releaseSecond = deferred();
  let markerHeld = false;
  let secondHeld = false;
  runtime.DOWNLOADS.beforePut = async (key) => {
    if (!markerHeld && key === 'wechat-group-qrcode/state/pending.json') {
      markerHeld = true;
      markerPaused.resolve();
      await releaseMarker.promise;
    } else if (markerHeld && !secondHeld && key.startsWith('wechat-group-qrcode/images/')) {
      secondHeld = true;
      secondPaused.resolve();
      await releaseSecond.promise;
    }
  };
  const firstPromise = get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'a.png'));
  await markerPaused.promise;
  const secondPromise = get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'b.png'));
  await secondPaused.promise;
  releaseMarker.resolve();
  const first = await firstPromise;
  releaseSecond.resolve();
  const second = await secondPromise;
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [303, 503]);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').phase, 'committed');
  const metadata = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
  const state = storedJson(runtime, 'wechat-group-qrcode/state/latest.json');
  assert.ok(metadata?.generation_id && state?.generation_id);
  assert.equal(metadata.generation_id, state.generation_id);
  assert.equal(metadata.operation_id, state.operation_id);
  assert.equal(metadata.r2_key, state.r2_key);
  assert.match(metadata.filename, /^[ab]\.png$/);
  const apiRead = await get('/api/wechat-group-qrcode/latest', runtime);
  assert.equal(apiRead.status, 200);
  assert.equal((await apiRead.json()).generation_id, metadata.generation_id);
  assert.equal((await get('/wechat-group-qrcode/latest', runtime)).status, 302);
});

for (const initialMarker of ['aborted', 'absent']) {
  test(`interleaved QR readers never expose a pending generation before ${initialMarker} rollback`, async () => {
    const runtime = env({
      ADMIN_PASSWORD: 'correct',
      ADMIN_SESSION_SECRET: 'session-secret',
      R2_PUBLIC_BASE_URL: '',
      WECHAT_GROUP_QR_PUBLIC_BASE_URL: '',
    });
    const session = await adminSession(runtime);
    const pendingKey = 'wechat-group-qrcode/state/pending.json';
    const formatKey = 'wechat-group-qrcode/state/format.json';
    let stableGeneration = null;
    if (initialMarker === 'aborted') {
      stableGeneration = await qrGeneration('stable');
      setR2Object(runtime, stableGeneration.r2_key, {
        bytes: png, httpMetadata: { contentType: 'image/png' },
      }, 'etag-stable-image');
      setR2Object(runtime, 'wechat-group-qrcode/metadata/latest.json', stableGeneration, 'etag-stable-metadata');
      setR2Object(runtime, 'wechat-group-qrcode/state/latest.json', stableGeneration, 'etag-stable-state');
      setR2Object(runtime, pendingKey, {
        schema_version: 2, phase: 'aborted',
        operation_id: stableGeneration.operation_id,
        generation_id: stableGeneration.generation_id,
        expected: stableGeneration,
        aborted_at: '2026-08-26T00:01:00.000Z',
        abort_reason: 'prior-response-lost',
      }, 'etag-stable-marker');
    } else {
      runtime.DOWNLOADS.objects.delete(pendingKey);
      runtime.DOWNLOADS.etags.delete(pendingKey);
    }
    runtime.DOWNLOADS.objects.delete(formatKey);
    runtime.DOWNLOADS.etags.delete(formatKey);

    const routes = [
      { path: '/api/wechat-group-qrcode/latest' },
      { path: '/downloads/api/wechat-group-qrcode/latest' },
      { path: '/wechat-group-qrcode' },
      { path: '/wechat-group-qrcode/latest' },
      { path: '/downloads/wechat-group-qrcode' },
      { path: '/downloads/wechat-group-qrcode/latest' },
      { path: '/admin', init: { headers: { cookie: session.cookie } } },
      { path: '/downloads/admin', init: { headers: { cookie: session.cookie } } },
    ];
    const readersCaptured = deferred();
    const releaseReaders = deferred();
    const originalGet = runtime.DOWNLOADS.get.bind(runtime.DOWNLOADS);
    let captured = 0;
    runtime.DOWNLOADS.get = async (key) => {
      if (key === pendingKey && captured < routes.length) {
        const snapshot = await originalGet(key);
        captured += 1;
        if (captured === routes.length) readersCaptured.resolve();
        await releaseReaders.promise;
        return snapshot;
      }
      return originalGet(key);
    };

    const readerPromises = routes.map(({ path, init }) => get(path, runtime, init));
    await bounded(readersCaptured.promise, 'QR readers to capture the initial marker');

    const projectionsWritten = deferred();
    const releaseRollback = deferred();
    runtime.DOWNLOADS.beforePut = async (key) => {
      if (key !== formatKey) return;
      projectionsWritten.resolve();
      await releaseRollback.promise;
      throw new Error('forced-format-write-failure');
    };
    const uploadPromise = get(
      '/admin/wechat-group-qrcode/upload',
      runtime,
      qrUploadInit(session, 'transient.png'),
    );
    await bounded(Promise.race([
      projectionsWritten.promise,
      uploadPromise.then(() => { throw new Error('upload ended before projections were held'); }),
    ]), 'the transient projections');

    const transient = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
    const transientState = storedJson(runtime, 'wechat-group-qrcode/state/latest.json');
    const pendingMarker = storedJson(runtime, pendingKey);
    releaseReaders.resolve();
    const responses = await Promise.all(readerPromises);
    releaseRollback.resolve();
    const upload = await uploadPromise;

    assert.equal(transient.filename, 'transient.png');
    assert.equal(transientState.generation_id, transient.generation_id);
    assert.equal(pendingMarker.phase, 'pending');
    assert.equal(upload.status, 503);
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 503, routes[index].path);
      const body = await response.text();
      assert.doesNotMatch(body, new RegExp(`${transient.generation_id}|transient\\.png|forced-format-write-failure`), routes[index].path);
    }
    assert.equal(storedJson(runtime, pendingKey).phase, 'tombstone');
    assert.equal(runtime.DOWNLOADS.objects.has(transient.r2_key), false);
    const restored = await get('/api/wechat-group-qrcode/latest', runtime);
    assert.equal(restored.status, 200);
    const restoredMetadata = await restored.json();
    assert.notEqual(restoredMetadata.generation_id, transient.generation_id);
    if (stableGeneration) assert.equal(restoredMetadata.generation_id, stableGeneration.generation_id);
  });
}

test('aborted and committed QR markers bind projections to their exact expected generation', async () => {
  for (const phase of ['aborted', 'committed']) {
    const runtime = env({ R2_PUBLIC_BASE_URL: '', WECHAT_GROUP_QR_PUBLIC_BASE_URL: '' });
    const expected = await qrGeneration(`expected-${phase}`);
    const foreign = await qrGeneration(`foreign-${phase}`);
    setR2Object(runtime, foreign.r2_key, {
      bytes: png, httpMetadata: { contentType: 'image/png' },
    }, `etag-${phase}-foreign-image`);
    setR2Object(runtime, 'wechat-group-qrcode/metadata/latest.json', foreign, `etag-${phase}-foreign-metadata`);
    setR2Object(runtime, 'wechat-group-qrcode/state/latest.json', foreign, `etag-${phase}-foreign-state`);
    setR2Object(runtime, 'wechat-group-qrcode/state/pending.json', {
      schema_version: 2, phase, operation_id: expected.operation_id,
      generation_id: expected.generation_id, expected,
    }, `etag-${phase}-marker`);

    const response = await get('/api/wechat-group-qrcode/latest', runtime);
    assert.equal(response.status, 503, phase);
    assert.doesNotMatch(await response.text(), new RegExp(`${foreign.generation_id}|${foreign.filename}`));
  }
});

test('QR reads reject a rewritten or disappeared terminal marker after image verification', async () => {
  for (const mutation of ['rewrite', 'delete']) {
    const runtime = env({ R2_PUBLIC_BASE_URL: '', WECHAT_GROUP_QR_PUBLIC_BASE_URL: '' });
    const record = await qrGeneration(`version-${mutation}`);
    const pendingKey = 'wechat-group-qrcode/state/pending.json';
    const marker = {
      schema_version: 2, phase: 'committed', operation_id: record.operation_id,
      generation_id: record.generation_id, expected: record,
      committed_at: '2026-08-26T00:02:00.000Z',
    };
    setR2Object(runtime, record.r2_key, {
      bytes: png, httpMetadata: { contentType: 'image/png' },
    }, `etag-${mutation}-image`);
    setR2Object(runtime, 'wechat-group-qrcode/metadata/latest.json', record, `etag-${mutation}-metadata`);
    setR2Object(runtime, 'wechat-group-qrcode/state/latest.json', record, `etag-${mutation}-state`);
    setR2Object(runtime, 'wechat-group-qrcode/state/format.json', {
      schema_version: 1, format_version: 'qr-generation-v1', immutable: true,
      established_at: '2026-08-26T00:00:00.000Z',
    }, `etag-${mutation}-format`);
    setR2Object(runtime, pendingKey, marker, `etag-${mutation}-marker`);

    const originalGet = runtime.DOWNLOADS.get.bind(runtime.DOWNLOADS);
    let mutated = false;
    runtime.DOWNLOADS.get = async (key) => {
      const object = await originalGet(key);
      if (key === record.r2_key && !mutated) {
        mutated = true;
        if (mutation === 'rewrite') {
          await runtime.DOWNLOADS.put(pendingKey, `${JSON.stringify(marker)}\n`, {
            httpMetadata: { contentType: 'application/json; charset=utf-8' },
          });
        } else {
          await runtime.DOWNLOADS.delete(pendingKey);
        }
      }
      return object;
    };
    const response = await get('/api/wechat-group-qrcode/latest', runtime);
    assert.equal(response.status, 503, mutation);
    assert.doesNotMatch(await response.text(), new RegExp(`${record.generation_id}|${record.filename}`));
  }
});

test('stale snapshot cannot replace or tombstone a newer committed QR generation', async () => {
  const runtime = env({
    ADMIN_PASSWORD: 'correct',
    ADMIN_SESSION_SECRET: 'session-secret',
    R2_PUBLIC_BASE_URL: '',
    WECHAT_GROUP_QR_PUBLIC_BASE_URL: '',
  });
  const session = await adminSession(runtime);
  const snapshotPaused = deferred();
  const releaseSnapshot = deferred();
  const originalGet = runtime.DOWNLOADS.get.bind(runtime.DOWNLOADS);
  let paused = false;
  runtime.DOWNLOADS.get = async (key) => {
    const result = await originalGet(key);
    if (!paused && key === 'wechat-group-qrcode/state/previous.json') {
      paused = true;
      snapshotPaused.resolve();
      await releaseSnapshot.promise;
    }
    return result;
  };

  const staleUpload = get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'stale.png'));
  await snapshotPaused.promise;

  const digest = await sha256Hex(png);
  const newer = {
    asset_id: 'wechat-group-qrcode', format_version: 'qr-generation-v1',
    generation_id: 'generation-a', operation_id: 'operation-a', version_id: 'version-a',
    uploaded_at: '2026-08-25T12:00:00.000Z', source: 'admin-panel', filename: 'a.png',
    r2_key: 'wechat-group-qrcode/images/version-a.png', sha256: digest, size: png.length,
    content_type: 'image/png',
  };
  runtime.DOWNLOADS.objects.set(newer.r2_key, { bytes: png, httpMetadata: { contentType: 'image/png' } });
  runtime.DOWNLOADS.objects.set('wechat-group-qrcode/metadata/latest.json', newer);
  runtime.DOWNLOADS.objects.set('wechat-group-qrcode/state/latest.json', newer);
  runtime.DOWNLOADS.objects.set('wechat-group-qrcode/state/pending.json', {
    schema_version: 2, phase: 'committed', operation_id: newer.operation_id,
    generation_id: newer.generation_id, expected: newer,
  });
  runtime.DOWNLOADS.etags.set('wechat-group-qrcode/metadata/latest.json', 'etag-a-metadata');
  runtime.DOWNLOADS.etags.set('wechat-group-qrcode/state/latest.json', 'etag-a-state');
  runtime.DOWNLOADS.etags.set('wechat-group-qrcode/state/pending.json', 'etag-a-marker');
  releaseSnapshot.resolve();

  const stale = await staleUpload;
  assert.equal(stale.status, 503);
  assert.deepEqual(runtime.DOWNLOADS.deletes, []);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').phase, 'committed');
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').operation_id, 'operation-a');
  assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 200);
  assert.equal((await get('/wechat-group-qrcode', runtime)).status, 200);
  assert.deepEqual(new Uint8Array(await (await get('/wechat-group-qrcode', runtime)).arrayBuffer()), png);
  assert.equal((await get('/admin', runtime, { headers: { cookie: session.cookie } })).status, 200);
});

test('stale writer cannot delete or overwrite a foreign pending marker', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const originalPut = runtime.DOWNLOADS.put.bind(runtime.DOWNLOADS);
  const originalDelete = runtime.DOWNLOADS.delete.bind(runtime.DOWNLOADS);
  let foreignMarker;
  const deleted = [];
  runtime.DOWNLOADS.delete = async (key) => { deleted.push(key); return originalDelete(key); };
  runtime.DOWNLOADS.put = async (key, value, options) => {
    const result = await originalPut(key, value, options);
    if (key === 'wechat-group-qrcode/state/pending.json' && !foreignMarker) {
      const marker = JSON.parse(String(value));
      foreignMarker = {
        ...marker,
        operation_id: 'foreign-operation',
        generation_id: 'foreign-generation',
        expected: { ...marker.expected, operation_id: 'foreign-operation', generation_id: 'foreign-generation' },
      };
      runtime.DOWNLOADS.objects.set(key, JSON.stringify(foreignMarker));
    }
    return result;
  };
  const response = await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'stale.png'));
  assert.equal(response.status, 503);
  assert.deepEqual(deleted, []);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').operation_id, 'foreign-operation');
  assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 503);
  assert.equal((await get('/admin', runtime, { headers: { cookie: session.cookie } })).status, 503);
});

test('QR publication reconciles commit-then-throw for acquisition, image, projections, and marker commit', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const originalPut = runtime.DOWNLOADS.put.bind(runtime.DOWNLOADS);
  const thrown = new Set();
  runtime.DOWNLOADS.put = async (key, value, options) => {
    const result = await originalPut(key, value, options);
    const payload = typeof value === 'string' ? JSON.parse(value) : null;
    let fault = '';
    if (key.startsWith('wechat-group-qrcode/images/')) fault = 'image';
    else if (key === 'wechat-group-qrcode/metadata/latest.json') fault = 'metadata';
    else if (key === 'wechat-group-qrcode/state/latest.json') fault = 'state';
    else if (key === 'wechat-group-qrcode/state/pending.json' && payload?.phase === 'pending') fault = 'marker-acquire';
    else if (key === 'wechat-group-qrcode/state/pending.json' && payload?.phase === 'committed') fault = 'marker-commit';
    if (fault && !thrown.has(fault)) {
      thrown.add(fault);
      throw new Error(`${fault}-response-lost`);
    }
    return result;
  };
  const response = await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'commit-then-throw.png'));
  assert.equal(response.status, 303);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').phase, 'committed');
  const metadata = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
  const state = storedJson(runtime, 'wechat-group-qrcode/state/latest.json');
  assert.deepEqual([...thrown].sort(), ['image', 'marker-acquire', 'marker-commit', 'metadata', 'state']);
  assert.equal(metadata.generation_id, state.generation_id);
  assert.equal(metadata.filename, 'commit-then-throw.png');
});

test('QR committed marker is retained and no unconditional cleanup delete is attempted', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const originalDelete = runtime.DOWNLOADS.delete.bind(runtime.DOWNLOADS);
  let deleteCalled = false;
  runtime.DOWNLOADS.delete = async (key) => {
    deleteCalled = true;
    await originalDelete(key);
  };
  const response = await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'delete-then-throw.png'));
  assert.equal(response.status, 303);
  assert.equal(deleteCalled, false);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').phase, 'committed');
});

test('a later upload replaces a retained committed marker only with its current ETag', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  assert.equal((await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'first.png'))).status, 303);
  const first = storedJson(runtime, 'wechat-group-qrcode/state/pending.json');
  assert.equal(first.phase, 'committed');
  assert.equal((await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'second.png'))).status, 303);
  const second = storedJson(runtime, 'wechat-group-qrcode/state/pending.json');
  assert.equal(second.phase, 'committed');
  assert.notEqual(second.operation_id, first.operation_id);
  const metadata = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
  assert.equal(metadata.operation_id, second.operation_id);
  assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 200);
});

test('QR readers reject filename/source mixes even when a legacy r2_key and digest agree', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const metadata = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
  const current = {
    ...metadata, version_id: 'legacy-version', filename: 'a.png', sha256: 'a'.repeat(64),
    uploaded_at: '2026-08-25T00:00:00.000Z', source: 'admin-panel',
  };
  runtime.DOWNLOADS.objects.set('wechat-group-qrcode/metadata/latest.json', current);
  runtime.DOWNLOADS.objects.set('wechat-group-qrcode/state/latest.json', { ...current, filename: 'b.png', source: 'other' });
  assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 503);
  assert.equal((await get('/wechat-group-qrcode/latest', runtime)).status, 503);
  assert.equal((await get('/admin', runtime, { headers: { cookie: session.cookie } })).status, 503);
});

test('QR readers reject incomplete or one-sided new-generation state identity', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const upload = await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'identity.png'));
  assert.equal(upload.status, 303);
  const stateKey = 'wechat-group-qrcode/state/latest.json';
  const state = storedJson(runtime, stateKey);
  delete state.operation_id;
  runtime.DOWNLOADS.objects.set(stateKey, state);
  for (const path of ['/api/wechat-group-qrcode/latest', '/wechat-group-qrcode/latest']) {
    assert.equal((await get(path, runtime)).status, 503, path);
  }
  assert.equal((await get('/admin', runtime, { headers: { cookie: session.cookie } })).status, 503);
});

test('new-generation QR reads fail closed for deletion, replacement, size, and digest drift', async () => {
  for (const mutate of [
    (runtime, key) => runtime.DOWNLOADS.objects.delete(key),
    (runtime, key) => runtime.DOWNLOADS.objects.set(key, { bytes: Uint8Array.from([...png.slice(0, -1), png[png.length - 1] ^ 1]), httpMetadata: { contentType: 'image/png' } }),
    (runtime, key) => runtime.DOWNLOADS.objects.set(key, { bytes: Uint8Array.from([...png, 0]), httpMetadata: { contentType: 'image/png' } }),
  ]) {
    const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
    const session = await adminSession(runtime);
    assert.equal((await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'integrity.png'))).status, 303);
    const metadata = storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json');
    mutate(runtime, metadata.r2_key);
    assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 503);
    assert.equal((await get('/wechat-group-qrcode/latest', runtime)).status, 503);
    assert.equal((await get('/admin', runtime, { headers: { cookie: session.cookie } })).status, 503);
  }
});

test('new-generation format proof survives marker and generation-field loss', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  assert.equal((await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'proof.png'))).status, 303);
  const metadataKey = 'wechat-group-qrcode/metadata/latest.json';
  const stateKey = 'wechat-group-qrcode/state/latest.json';
  const pendingKey = 'wechat-group-qrcode/state/pending.json';
  const metadata = storedJson(runtime, metadataKey);
  const state = storedJson(runtime, stateKey);
  delete metadata.generation_id;
  delete metadata.operation_id;
  delete state.generation_id;
  delete state.operation_id;
  runtime.DOWNLOADS.objects.set(metadataKey, metadata);
  runtime.DOWNLOADS.objects.set(stateKey, state);
  await runtime.DOWNLOADS.delete(pendingKey);
  runtime.DOWNLOADS.objects.set(metadata.r2_key, {
    bytes: Uint8Array.from([...png, 0]),
    httpMetadata: { contentType: 'image/png' },
  });
  for (const path of ['/api/wechat-group-qrcode/latest', '/wechat-group-qrcode', '/admin']) {
    const response = await get(path, runtime, path === '/admin' ? { headers: { cookie: session.cookie } } : undefined);
    assert.equal(response.status, 503, path);
    assert.doesNotMatch(await response.text(), /proof\.png/);
  }
});

test('release lock action selects R2 state and writes public projections', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const csrf = loginPageTextToken(await loginPage.text());
  const login = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct', csrf_token: csrf }) });
  const response = await get('/admin/public/lock-previous', runtime, { method: 'POST', headers: { cookie: login.headers.get('set-cookie'), 'x-csrf-token': sessionCsrfToken(login.headers.get('set-cookie')) } });
  assert.equal(response.status, 303);
  const statePut = runtime.DOWNLOADS.puts.find(({ key }) => key === 'codex-install/state/public.json');
  assert.ok(statePut);
  assert.match(String(statePut.value), /"release_id": "v1"/);
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'codex-install/public/tokenrouter/windows/x64.json'));
});

test('download validation rejects unsafe keys before URL resolution and ignores unsafe metadata URLs', async () => {
  const runtime = env();
  runtime.DOWNLOADS.objects.set('codex-install/public/tokenrouter/windows/x64.json', {
    ...publicFile,
    url: 'https://attacker.invalid/steal',
  });
  const safe = await get('/download/tokenrouter/windows/x64', runtime);
  assert.equal(safe.status, 302);
  assert.equal(safe.headers.get('location'), 'https://tokenrouter-r2.wdtokenacc.top/codex-install/releases/v1/setup.exe');

  runtime.DOWNLOADS.objects.set('codex-install/public/tokenrouter/windows/x64.json', {
    ...publicFile,
    r2_key: 'codex-install/releases/../secrets.txt',
    url: 'https://attacker.invalid/steal',
  });
  const unsafe = await get('/download/tokenrouter/windows/x64', runtime);
  assert.equal(unsafe.status, 503);
  assert.doesNotMatch(await unsafe.text(), /attacker\.invalid|secrets/);
});

test('admin publication validates every path component before any projection write', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  const csrf = sessionCsrfToken(login.headers.get('set-cookie'));
  runtime.DOWNLOADS.objects.set('codex-install/releases/v1/metadata/latest.json', {
    release_id: 'v1',
    files: [{ ...publicFile, site: '../escape' }],
  });
  const before = runtime.DOWNLOADS.puts.length;
  const response = await get('/admin/public/lock-previous', runtime, {
    method: 'POST',
    headers: { cookie: login.headers.get('set-cookie'), 'x-csrf-token': csrf },
  });
  assert.equal(response.status, 503);
  assert.equal(runtime.DOWNLOADS.puts.length, before);
});

test('QR upload requires declared MIME agreement and rolls back a failed publication generically', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  const cookie = login.headers.get('set-cookie');
  const csrf = sessionCsrfToken(cookie);
  const badForm = new FormData();
  badForm.append('csrf_token', csrf);
  badForm.append('image', new File([png], 'bad.png', { type: 'text/plain' }));
  const bad = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie }, body: badForm });
  assert.equal(bad.status, 400);
  assert.equal(runtime.DOWNLOADS.puts.length, 0);

  const originalLatest = { ...runtime.DOWNLOADS.objects.get('wechat-group-qrcode/metadata/latest.json'), url: 'https://tokenrouter-r2.wdtokenacc.top/wechat-group-qrcode/images/current.png' };
  const originalState = runtime.DOWNLOADS.objects.get('wechat-group-qrcode/state/latest.json') ?? null;
  const originalPut = runtime.DOWNLOADS.put.bind(runtime.DOWNLOADS);
  let failed = false;
  runtime.DOWNLOADS.put = async (key, value, options) => {
    if (!failed && key === 'wechat-group-qrcode/metadata/latest.json') {
      failed = true;
      throw new Error('provider-secret-detail');
    }
    return originalPut(key, value, options);
  };
  const goodForm = new FormData();
  goodForm.append('csrf_token', csrf);
  goodForm.append('image', new File([png], 'good.png', { type: 'image/png' }));
  const failedUpload = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie }, body: goodForm });
  assert.equal(failedUpload.status, 503);
  assert.doesNotMatch(await failedUpload.text(), /provider-secret-detail/);
  assert.deepEqual(JSON.parse(runtime.DOWNLOADS.objects.get('wechat-group-qrcode/metadata/latest.json')), originalLatest);
  assert.equal(runtime.DOWNLOADS.objects.get('wechat-group-qrcode/state/latest.json') ?? null, originalState);
});

test('QR rollback verifies commit-then-throw restores and delete-then-throw cleanup', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const session = await adminSession(runtime);
  const originalPut = runtime.DOWNLOADS.put.bind(runtime.DOWNLOADS);
  let publicationFailed = false;
  let restoreResponseLost = false;
  runtime.DOWNLOADS.put = async (key, value, options) => {
    const payload = typeof value === 'string' ? JSON.parse(value) : null;
    if (key === 'wechat-group-qrcode/state/latest.json' && payload?.generation_id && !publicationFailed) {
      publicationFailed = true;
      throw new Error('state-write-not-committed');
    }
    const result = await originalPut(key, value, options);
    if (key === 'wechat-group-qrcode/metadata/latest.json'
      && payload?.r2_key === 'wechat-group-qrcode/images/current.png' && !restoreResponseLost) {
      restoreResponseLost = true;
      throw new Error('rollback-put-response-lost');
    }
    return result;
  };
  const originalDelete = runtime.DOWNLOADS.delete.bind(runtime.DOWNLOADS);
  const lostDeleteResponses = new Set();
  runtime.DOWNLOADS.delete = async (key) => {
    await originalDelete(key);
    if ((key === 'wechat-group-qrcode/state/latest.json'
      || key === 'wechat-group-qrcode/state/previous.json'
      || key === 'wechat-group-qrcode/state/pending.json'
      || key.startsWith('wechat-group-qrcode/images/')) && !lostDeleteResponses.has(key)) {
      lostDeleteResponses.add(key);
      throw new Error('rollback-delete-response-lost');
    }
  };
  const response = await get('/admin/wechat-group-qrcode/upload', runtime, qrUploadInit(session, 'rollback-ambiguity.png'));
  assert.equal(response.status, 503);
  assert.equal(publicationFailed, true);
  assert.equal(restoreResponseLost, true);
  assert.ok(lostDeleteResponses.has('wechat-group-qrcode/state/latest.json'));
  assert.ok(lostDeleteResponses.has('wechat-group-qrcode/state/previous.json'));
  assert.equal(lostDeleteResponses.has('wechat-group-qrcode/state/pending.json'), false);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/state/pending.json').phase, 'tombstone');
  assert.equal(runtime.DOWNLOADS.objects.has('wechat-group-qrcode/state/latest.json'), false);
  assert.equal(runtime.DOWNLOADS.objects.has('wechat-group-qrcode/state/previous.json'), false);
  assert.equal(storedJson(runtime, 'wechat-group-qrcode/metadata/latest.json').r2_key, 'wechat-group-qrcode/images/current.png');
  assert.equal([...runtime.DOWNLOADS.objects.keys()].filter((key) => key.startsWith('wechat-group-qrcode/images/')).length, 1);
  assert.equal((await get('/api/wechat-group-qrcode/latest', runtime)).status, 200);
});

test('QR partial commit plus rollback failure leaves a durable fence and no mixed read success', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  const cookie = login.headers.get('set-cookie');
  const csrf = sessionCsrfToken(cookie);
  const originalPut = runtime.DOWNLOADS.put.bind(runtime.DOWNLOADS);
  let stateWriteFailed = false;
  runtime.DOWNLOADS.put = async (key, value, options) => {
    if (key === 'wechat-group-qrcode/state/latest.json' && !stateWriteFailed) {
      stateWriteFailed = true;
      throw new Error('state-write-failure');
    }
    if (key === 'wechat-group-qrcode/metadata/latest.json' && stateWriteFailed) {
      throw new Error('rollback-write-failure');
    }
    return originalPut(key, value, options);
  };
  const form = new FormData();
  form.append('csrf_token', csrf);
  form.append('image', new File([png], 'partial.png', { type: 'image/png' }));
  const failed = await get('/admin/wechat-group-qrcode/upload', runtime, {
    method: 'POST', headers: { cookie }, body: form,
  });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /state-write-failure|rollback-write-failure/);
  const pending = runtime.DOWNLOADS.objects.get('wechat-group-qrcode/state/pending.json');
  assert.ok(pending);
  assert.equal(JSON.parse(pending).phase, 'pending');

  const publicRead = await get('/wechat-group-qrcode/latest', runtime);
  assert.equal(publicRead.status, 503);
  assert.doesNotMatch(await publicRead.text(), /partial\.png|state-write-failure|rollback-write-failure/);
  const apiRead = await get('/api/wechat-group-qrcode/latest', runtime);
  assert.equal(apiRead.status, 503);
  assert.doesNotMatch(await apiRead.text(), /partial\.png|state-write-failure|rollback-write-failure/);

  const admin = await get('/admin', runtime, { headers: { cookie } });
  assert.equal(admin.status, 503);
  assert.match(admin.headers.get('content-type'), /^text\/html/);
  const adminBody = await admin.text();
  assert.match(adminBody, /R2 存储暂时不可用/);
  assert.match(adminBody, /支持 PNG、JPG、GIF、WebP/);
  assert.doesNotMatch(adminBody, /state-write-failure|rollback-write-failure|partial\.png/);
});

test('authenticated admin GET fails closed with an HTML outage card when R2 reads fail', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  const cookie = login.headers.get('set-cookie');
  runtime.DOWNLOADS.get = async () => { throw new Error('provider-secret-detail'); };
  const response = await get('/admin', runtime, { headers: { cookie } });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  const body = await response.text();
  assert.match(body, /R2 管理后台/);
  assert.match(body, /R2 存储暂时不可用/);
  assert.match(body, /支持 PNG、JPG、GIF、WebP，文件大小不超过 5 MiB/);
  assert.doesNotMatch(body, /provider-secret-detail|"success"\s*:|"error"\s*:/);
});

test('admin mutations reject missing CSRF and hostile origins before R2 writes', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const loginPage = await get('/admin', runtime);
  const login = await get('/admin/login', runtime, {
    method: 'POST',
    body: new URLSearchParams({ password: 'correct', csrf_token: loginPageTextToken(await loginPage.text()) }),
  });
  const cookie = login.headers.get('set-cookie');
  const form = new FormData();
  form.append('image', new File([png], 'missing.png', { type: 'image/png' }));
  const missing = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie }, body: form });
  assert.equal(missing.status, 403);
  const csrf = sessionCsrfToken(cookie);
  const hostile = new FormData();
  hostile.append('csrf_token', csrf);
  hostile.append('image', new File([png], 'hostile.png', { type: 'image/png' }));
  const rejected = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie, origin: 'https://evil.invalid' }, body: hostile });
  assert.equal(rejected.status, 403);
  assert.equal(runtime.DOWNLOADS.puts.length, 0);
});

test('public landing distinguishes missing metadata from R2 outage', async () => {
  const missingRuntime = env();
  missingRuntime.DOWNLOADS.objects.clear();
  const missing = await get('/downloads', missingRuntime);
  assert.equal(missing.status, 404);
  const outageRuntime = env();
  outageRuntime.DOWNLOADS.get = async () => { throw new Error('r2 transport detail'); };
  const outage = await get('/downloads', outageRuntime);
  assert.equal(outage.status, 503);
  assert.doesNotMatch(await outage.text(), /r2 transport detail/);
});

function loginPageTextToken(body) {
  const match = body.match(/name="csrf_token" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}
function sessionCsrfToken(cookie) {
  const value = cookie.split(';', 1)[0].split('=', 2)[1];
  const payload = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
  return payload.csrf;
}
