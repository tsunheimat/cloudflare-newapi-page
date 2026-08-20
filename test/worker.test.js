import assert from 'node:assert/strict';
import test from 'node:test';

import worker, * as workerModule from '../src/worker.js';

const fetchWorker = (path, env = {}, init = undefined) =>
  worker.fetch(new Request(`https://public.example${path}`, init), env);

const fixtureEnv = {
  CONTENT_ADAPTER: 'fixture',
  DOWNLOADS_INTEGRATION: 'disabled',
  ASSETS: {
    fetch: async (request) =>
      new Response(`asset:${new URL(request.url).pathname}`, {
        headers: { 'content-type': 'text/plain' },
      }),
  },
};

test('Worker module exports only workerd-compatible entrypoints', () => {
  assert.deepEqual(Object.keys(workerModule).sort(), ['default', 'route']);
  assert.equal(typeof workerModule.default.fetch, 'function');
  assert.equal(typeof workerModule.route, 'function');
});

test('health reports phase and explicit non-live boundaries', async () => {
  const response = await fetchWorker('/api/health', fixtureEnv);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.phase, '2');
  assert.equal(body.live_newapi, false);
  assert.deepEqual(body.pricing_context, {
    user_group: 'default',
    selected_group: 'default',
  });
  assert.equal(body.downloads.configured, false);
  assert.equal(body.downloads.enabled, false);
  assert.equal(body.downloads.binding_present, false);
  assert.equal(body.downloads.bound, false);
  assert.equal(body.downloads.active, false);
  assert.equal(body.downloads.healthy, null);
  assert.equal(body.downloads.live, false);
  assert.equal(body.downloads.phase, 'disabled');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});

test('content routes serve fixture docs and pricing', async () => {
  const catalogResponse = await fetchWorker('/api/content/docs', fixtureEnv);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.success, true);
  assert.equal(catalog.data.meta.fixture, true);

  const pageResponse = await fetchWorker('/api/content/docs/quickstart', fixtureEnv);
  const page = await pageResponse.json();
  assert.equal(page.data.page.slug, 'quickstart');

  const pricingResponse = await fetchWorker('/api/content/pricing', fixtureEnv);
  const pricing = await pricingResponse.json();
  assert.equal(pricing.context.user_group, 'default');
  assert.equal(pricing.context.selected_group, 'default');
  assert.equal(pricing.meta.live, false);
});

test('invalid or missing content paths return bounded JSON errors', async () => {
  const badSlug = await fetchWorker('/api/content/docs/%2Fescape', fixtureEnv);
  assert.equal(badSlug.status, 400);
  assert.equal((await badSlug.json()).error.code, 'bad_request');

  const missing = await fetchWorker('/api/content/docs/not-there', fixtureEnv);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'not_found');

  const unknown = await fetchWorker('/api/content/unknown', fixtureEnv);
  assert.equal(unknown.status, 404);
});

test('non-fixture content mode fails closed and never claims live integration', async () => {
  const response = await fetchWorker('/api/content/pricing', {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.details.configured_adapter, 'newapi');
  assert.equal(body.error.details.live_integration, false);
});

test('SPA routes pass through the asset binding with security headers', async () => {
  const response = await fetchWorker('/docs/quickstart', fixtureEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/docs/quickstart');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(
    response.headers.get('content-security-policy'),
    /style-src 'self'(?:;|$)/,
  );
  assert.doesNotMatch(
    response.headers.get('content-security-policy'),
    /'unsafe-inline'/,
  );
});

test('download routes fail closed while service binding is absent', async () => {
  const response = await fetchWorker('/downloads', fixtureEnv);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.details.transport, 'cloudflare-service-binding');
  assert.equal(body.error.details.phase, 'disabled');
  assert.deepEqual(body.error.details.capabilities, [
    'downloads',
    'admin',
    'r2',
    'rollback',
    'wechat_qr',
  ]);

  const stagingUnbound = await fetchWorker('/downloads', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
  });
  const stagingBody = await stagingUnbound.json();
  assert.equal(stagingUnbound.status, 503);
  assert.equal(stagingBody.error.details.configured, false);
  assert.equal(stagingBody.error.details.binding_present, false);
  assert.equal(stagingBody.error.details.bound, false);
  assert.equal(stagingBody.error.details.active, false);
  assert.equal(stagingBody.error.details.phase, 'unbound');
});

test('software-specific download APIs stay behind the service binding boundary', async () => {
  const response = await fetchWorker(
    '/api/codex-installer/public/tokenrouter/windows/x64',
    fixtureEnv,
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.details.phase, 'disabled');
});

test('download prefixes require a path segment boundary', async () => {
  const administrator = await fetchWorker('/administrator', fixtureEnv);
  assert.equal(administrator.status, 200);
  assert.equal(await administrator.text(), 'asset:/administrator');

  const latestNews = await fetchWorker('/api/latest-news', fixtureEnv);
  assert.equal(latestNews.status, 404);
  assert.equal((await latestNews.json()).error.code, 'not_found');
});

test('binding presence is not reported as healthy or live', async () => {
  const response = await fetchWorker('/api/integrations/downloads', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: { fetch: async () => new Response('ok') },
  });
  const status = (await response.json()).data;
  assert.equal(status.configured, true);
  assert.equal(status.enabled, true);
  assert.equal(status.binding_present, true);
  assert.equal(status.bound, true);
  assert.equal(status.active, true);
  assert.equal(status.healthy, null);
  assert.equal(status.live, false);
  assert.equal(status.phase, 'bound-unverified');

  const invalid = await fetchWorker('/api/integrations/downloads', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: {},
  });
  const invalidStatus = (await invalid.json()).data;
  assert.equal(invalidStatus.configured, true);
  assert.equal(invalidStatus.bound, false);
  assert.equal(invalidStatus.active, false);
  assert.equal(invalidStatus.phase, 'invalid-binding');

  const disabled = await fetchWorker('/api/integrations/downloads', {
    ...fixtureEnv,
    DOWNLOADS_SERVICE: { fetch: async () => new Response('must not run') },
  });
  const disabledStatus = (await disabled.json()).data;
  assert.equal(disabledStatus.configured, true);
  assert.equal(disabledStatus.binding_present, true);
  assert.equal(disabledStatus.bound, true);
  assert.equal(disabledStatus.active, false);
  assert.equal(disabledStatus.phase, 'disabled');

  const blocked = await fetchWorker('/downloads', {
    ...fixtureEnv,
    DOWNLOADS_SERVICE: { fetch: async () => new Response('must not run') },
  });
  assert.equal(blocked.status, 503);

  const production = await fetchWorker('/api/integrations/downloads', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'production-service-binding',
    DOWNLOADS_SERVICE: { fetch: async () => new Response('ok') },
  });
  const productionStatus = (await production.json()).data;
  assert.equal(productionStatus.mode, 'production-service-binding');
  assert.equal(productionStatus.active, true);
  assert.equal(productionStatus.live, false);
  assert.equal(productionStatus.phase, 'bound-unverified');
});

test('download service binding preserves request semantics and maps reserved prefix', async () => {
  let observed;
  const env = {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: {
      async fetch(request) {
        observed = {
          url: request.url,
          method: request.method,
          body: await request.text(),
          cookie: request.headers.get('cookie'),
          prefix: request.headers.get('x-forwarded-prefix'),
        };
        return new Response(null, {
          status: 303,
          headers: { location: '/admin?updated=1' },
        });
      },
    },
  };
  const response = await fetchWorker('/downloads/admin/login', env, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'tr_admin=session',
      'x-forwarded-prefix': '/untrusted',
    },
    body: 'password=example',
    redirect: 'manual',
  });

  assert.equal(new URL(observed.url).pathname, '/admin/login');
  assert.equal(observed.method, 'POST');
  assert.equal(observed.body, 'password=example');
  assert.equal(observed.cookie, 'tr_admin=session');
  assert.equal(observed.prefix, '/downloads');
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/admin?updated=1');
});

test('direct legacy download routes do not claim the mounted downloads prefix', async () => {
  const observed = [];
  const env = {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: {
      async fetch(request) {
        observed.push({
          pathname: new URL(request.url).pathname,
          prefix: request.headers.get('x-forwarded-prefix'),
        });
        return new Response('ok');
      },
    },
  };

  await fetchWorker('/admin', env, {
    headers: { 'x-forwarded-prefix': '/untrusted' },
  });
  await fetchWorker('/software/client', env);

  assert.deepEqual(observed, [
    { pathname: '/admin', prefix: null },
    { pathname: '/software/client', prefix: null },
  ]);
});

test('download binding preserves relative, root-relative, and external redirects', async () => {
  const locations = [
    'next?ok=1',
    '/admin?updated=1',
    'https://downloads.example/releases/latest',
  ];

  for (const path of ['/downloads/admin', '/admin']) {
    for (const location of locations) {
      const response = await fetchWorker(
        path,
        {
          ...fixtureEnv,
          DOWNLOADS_INTEGRATION: 'staging-service-binding',
          DOWNLOADS_SERVICE: {
            fetch: async () =>
              new Response(null, {
                status: 302,
                headers: { location },
              }),
          },
        },
        { redirect: 'manual' },
      );
      assert.equal(response.headers.get('location'), location, path);
    }
  }
});

test('downstream inline-style HTML does not receive the SPA CSP', async () => {
  const inlineHtml = '<!doctype html><style>body{color:red}</style><h1>Admin</h1>';
  const response = await fetchWorker('/admin', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: {
      fetch: async () =>
        new Response(inlineHtml, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), inlineHtml);
  assert.equal(response.headers.get('content-security-policy'), null);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('downstream CSP is preserved instead of overwritten by the SPA policy', async () => {
  const downstreamCsp = "default-src 'none'; style-src 'unsafe-inline'";
  const response = await fetchWorker('/downloads/admin', {
    ...fixtureEnv,
    DOWNLOADS_INTEGRATION: 'staging-service-binding',
    DOWNLOADS_SERVICE: {
      fetch: async () =>
        new Response('<style>body{color:red}</style>', {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': downstreamCsp,
            'referrer-policy': 'no-referrer',
          },
        }),
    },
  });
  assert.equal(response.headers.get('content-security-policy'), downstreamCsp);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
});

test('unhandled API routes do not fall into the SPA', async () => {
  const apiRoot = await fetchWorker('/api', fixtureEnv);
  assert.equal(apiRoot.status, 404);
  assert.equal((await apiRoot.json()).error.code, 'not_found');

  const apiRootSlash = await fetchWorker('/api/', fixtureEnv);
  assert.equal(apiRootSlash.status, 404);
  assert.equal((await apiRootSlash.json()).error.code, 'not_found');

  const response = await fetchWorker('/api/not-real', fixtureEnv);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'not_found');
});
