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
  }
  async get(key) {
    if (!this.objects.has(key)) return null;
    const value = this.objects.get(key);
    if (value?.bytes) {
      return {
        body: new ReadableStream({ start(controller) { controller.enqueue(value.bytes); controller.close(); } }),
        httpMetadata: value.httpMetadata || {},
        text: async () => new TextDecoder().decode(value.bytes),
      };
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } }),
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      text: async () => text,
    };
  }
  async put(key, value, options) {
    this.puts.push({ key, value, options });
    this.objects.set(key, typeof value === 'string' ? value : { bytes: value, httpMetadata: options?.httpMetadata });
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

async function get(path, runtime = env(), init) {
  return worker.fetch(new Request(`https://public.example${path}`, init), runtime);
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
}
);

test('migrated routes prefer R2 and never call the rollback service binding', async () => {
  let called = false;
  const runtime = env({ DOWNLOADS_SERVICE: { fetch: async () => { called = true; return new Response('legacy'); } } });
  const response = await get('/downloads', runtime);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Codex 安装器/);
  assert.equal(called, false);
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
});

test('authenticated QR upload validates bytes and writes object plus latest/previous metadata', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const login = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct' }) });
  assert.equal(login.status, 303);
  const form = new FormData();
  form.append('image', new File([png], 'new-qr.png', { type: 'image/png' }));
  const upload = await get('/admin/wechat-group-qrcode/upload', runtime, { method: 'POST', headers: { cookie: login.headers.get('set-cookie') }, body: form });
  assert.equal(upload.status, 303);
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key.startsWith('wechat-group-qrcode/images/')));
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'wechat-group-qrcode/metadata/latest.json'));
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'wechat-group-qrcode/state/previous.json'));
});

test('release lock action selects R2 state and writes public projections', async () => {
  const runtime = env({ ADMIN_PASSWORD: 'correct', ADMIN_SESSION_SECRET: 'session-secret' });
  const login = await get('/admin/login', runtime, { method: 'POST', body: new URLSearchParams({ password: 'correct' }) });
  const response = await get('/admin/public/lock-previous', runtime, { method: 'POST', headers: { cookie: login.headers.get('set-cookie') } });
  assert.equal(response.status, 303);
  const statePut = runtime.DOWNLOADS.puts.find(({ key }) => key === 'codex-install/state/public.json');
  assert.ok(statePut);
  assert.match(String(statePut.value), /"release_id": "v1"/);
  assert.ok(runtime.DOWNLOADS.puts.some(({ key }) => key === 'codex-install/public/tokenrouter/windows/x64.json'));
});
