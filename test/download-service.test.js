import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';
import {
  DOWNLOAD_ROUTE_MODES,
  downloadServiceRouteMetadata,
  downloadServiceStatus,
  isDownloadServiceRoute,
} from '../src/adapters/download-service.js';

const ACTIVE_MODE = 'staging-service-binding';

const DIRECT_ROUTE_CASES = [
  '/software/codex-installer',
  '/assets/juapi-logo.png',
  '/wechat-group-qrcode',
  '/wechat-group-qrcode/latest',
  '/api/wechat-group-qrcode/latest',
  '/api/latest',
  '/api/public',
  '/api/previous',
  '/api/latest/tokenrouter/windows/x64',
  '/api/public/tokenrouter/windows/x64',
  '/api/codex-installer/latest',
  '/api/codex-installer/public',
  '/api/codex-installer/previous',
  '/api/codex-installer/latest/tokenrouter/windows/x64',
  '/api/codex-installer/public/tokenrouter/windows/x64',
  '/download/latest/tokenrouter/windows/x64',
  '/download/tokenrouter/windows/x64',
  '/download/codex-installer/latest/tokenrouter/windows/x64',
  '/download/codex-installer/tokenrouter/windows/x64',
  '/admin',
  '/admin/login',
  '/admin/logout',
  '/admin/wechat-group-qrcode/upload',
  '/admin/public/lock-previous',
  '/admin/public/unlock',
  '/admin/public/set',
  '/admin/codex-installer/public/lock-previous',
  '/admin/codex-installer/public/unlock',
  '/admin/codex-installer/public/set',
];

const NEGATIVE_ROUTE_CASES = [
  '/administrator',
  '/assets-old/logo.png',
  '/downloads-old',
  '/software-center',
  '/wechat-group-qrcode-old',
  '/api/latest-news',
  '/api/publicity',
  '/api/codex-installer/publicity',
  '/api/codex_installer/public',
  '/api/content/pricing',
];

const fetchWorker = (path, bindingFetch, init = undefined) =>
  worker.fetch(
    new Request(`https://public.example${path}`, init),
    {
      CONTENT_ADAPTER: 'fixture',
      DOWNLOADS_INTEGRATION: ACTIVE_MODE,
      DOWNLOADS_SERVICE: { fetch: bindingFetch },
    },
  );

test('route contract covers every reviewed downstream family in direct and mounted modes', () => {
  const root = downloadServiceRouteMetadata('/downloads');
  assert.deepEqual(root, {
    mode: 'mounted',
    downstream_path: '/',
    forwarded_prefix: '/downloads',
  });

  for (const directPath of DIRECT_ROUTE_CASES) {
    assert.equal(isDownloadServiceRoute(directPath), true, directPath);
    assert.deepEqual(
      downloadServiceRouteMetadata(directPath),
      {
        mode: 'direct',
        downstream_path: directPath,
        forwarded_prefix: null,
      },
      directPath,
    );

    const mountedPath = `/downloads${directPath}`;
    assert.equal(isDownloadServiceRoute(mountedPath), true, mountedPath);
    assert.deepEqual(
      downloadServiceRouteMetadata(mountedPath),
      {
        mode: 'mounted',
        downstream_path: directPath,
        forwarded_prefix: '/downloads',
      },
      mountedPath,
    );
  }

  for (const path of NEGATIVE_ROUTE_CASES) {
    assert.equal(isDownloadServiceRoute(path), false, path);
    assert.equal(downloadServiceRouteMetadata(path), null, path);
  }
});

test('status publishes stable mounted/direct metadata without claiming health or liveness', () => {
  const status = downloadServiceStatus({
    DOWNLOADS_INTEGRATION: ACTIVE_MODE,
    DOWNLOADS_SERVICE: { fetch: async () => new Response('ok') },
  });

  assert.equal(status.configured, true);
  assert.equal(status.bound, true);
  assert.equal(status.active, true);
  assert.equal(status.healthy, null);
  assert.equal(status.live, false);
  assert.equal(status.phase, 'bound-unverified');
  assert.deepEqual(status.routes, DOWNLOAD_ROUTE_MODES);
  assert.deepEqual(status.routes.mounted, {
    public_prefix: '/downloads',
    downstream_prefix: '/',
    forwarded_prefix: '/downloads',
  });
  assert.equal(status.routes.direct.forwarded_prefix, null);
});

test('staging and production gates activate only a callable binding', () => {
  for (const mode of [
    'staging-service-binding',
    'production-service-binding',
  ]) {
    const active = downloadServiceStatus({
      DOWNLOADS_INTEGRATION: mode,
      DOWNLOADS_SERVICE: { fetch: async () => new Response('ok') },
    });
    assert.equal(active.mode, mode);
    assert.equal(active.enabled, true);
    assert.equal(active.active, true);
    assert.equal(active.phase, 'bound-unverified');

    const unbound = downloadServiceStatus({ DOWNLOADS_INTEGRATION: mode });
    assert.equal(unbound.enabled, true);
    assert.equal(unbound.active, false);
    assert.equal(unbound.phase, 'unbound');
  }
});

test('mounted forwarding preserves method, bytes, query, cookies, and content type', async () => {
  const payload = Uint8Array.from([0, 1, 2, 13, 10, 255]);
  let observed;
  const response = await fetchWorker(
    '/downloads/admin/wechat-group-qrcode/upload?return=%2Fadmin&channel=public&channel=latest',
    async (request) => {
      observed = {
        method: request.method,
        pathname: new URL(request.url).pathname,
        search: new URL(request.url).search,
        body: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get('content-type'),
        cookie: request.headers.get('cookie'),
        prefix: request.headers.get('x-forwarded-prefix'),
      };
      return new Response(null, { status: 204 });
    },
    {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=phase-2a',
        cookie: 'tr_admin=signed-session; preference=compact',
        'x-forwarded-prefix': '/untrusted',
      },
      body: payload,
    },
  );

  assert.equal(response.status, 204);
  assert.equal(observed.method, 'POST');
  assert.equal(observed.pathname, '/admin/wechat-group-qrcode/upload');
  assert.equal(
    observed.search,
    '?return=%2Fadmin&channel=public&channel=latest',
  );
  assert.deepEqual(observed.body, payload);
  assert.equal(
    observed.contentType,
    'multipart/form-data; boundary=phase-2a',
  );
  assert.equal(
    observed.cookie,
    'tr_admin=signed-session; preference=compact',
  );
  assert.equal(observed.prefix, '/downloads');
});

test('direct forwarding preserves query and HEAD while stripping spoofed mount metadata', async () => {
  const observed = [];
  const bindingFetch = async (request) => {
    const url = new URL(request.url);
    observed.push({
      method: request.method,
      pathname: url.pathname,
      search: url.search,
      prefix: request.headers.get('x-forwarded-prefix'),
    });
    return new Response(null, {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };

  await fetchWorker('/api/public?site=tokenrouter&arch=x64', bindingFetch, {
    method: 'GET',
    headers: { 'x-forwarded-prefix': '/spoofed' },
  });
  await fetchWorker('/assets/favicon.png?cache=probe', bindingFetch, {
    method: 'HEAD',
    headers: { 'x-forwarded-prefix': '/spoofed' },
  });

  assert.deepEqual(observed, [
    {
      method: 'GET',
      pathname: '/api/public',
      search: '?site=tokenrouter&arch=x64',
      prefix: null,
    },
    {
      method: 'HEAD',
      pathname: '/assets/favicon.png',
      search: '?cache=probe',
      prefix: null,
    },
  ]);
});

test('binary stream status and downstream headers survive the binding boundary', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0, 1, 2]));
      controller.enqueue(Uint8Array.from([253, 254, 255]));
      controller.close();
    },
  });
  const downstreamCsp = "default-src 'none'; sandbox";
  const response = await fetchWorker(
    '/downloads/download/tokenrouter/windows/x64',
    async () =>
      new Response(stream, {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '6',
          'content-disposition': 'attachment; filename="installer.bin"',
          'content-security-policy': downstreamCsp,
          etag: '"phase-2a-binary"',
          'set-cookie': 'download_probe=1; Secure; HttpOnly',
          'x-frame-options': 'SAMEORIGIN',
        },
      }),
  );

  assert.equal(response.status, 206);
  assert.deepEqual(
    new Uint8Array(await response.arrayBuffer()),
    Uint8Array.from([0, 1, 2, 253, 254, 255]),
  );
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('content-length'), '6');
  assert.equal(
    response.headers.get('content-disposition'),
    'attachment; filename="installer.bin"',
  );
  assert.equal(response.headers.get('content-security-policy'), downstreamCsp);
  assert.equal(response.headers.get('etag'), '"phase-2a-binary"');
  assert.equal(
    response.headers.get('set-cookie'),
    'download_probe=1; Secure; HttpOnly',
  );
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
