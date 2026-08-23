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
    CONTENT_ADAPTER: 'unconfigured',
  });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error.details.configured_adapter, 'unconfigured');
  assert.equal(body.error.details.live_integration, false);
});

test('live content mode fails closed when token or VPC binding is absent', async () => {
  for (const env of [
    { ...fixtureEnv, CONTENT_ADAPTER: 'newapi' },
    { ...fixtureEnv, CONTENT_ADAPTER: 'newapi', LIVE_CONTENT_ADAPTER_TOKEN: 'too-short' },
  ]) {
    const response = await fetchWorker('/api/content/docs', env);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'integration_unavailable');
    assert.equal(body.error.details.live_integration, true);
    assert.equal(body.error.details.configured_adapter, 'newapi');
  }
});

test('live health separates selected mode from verified private health', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const base = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
  };

  for (const env of [
    { ...base, LIVE_CONTENT_ADAPTER_TOKEN: undefined, NEWAPI_VPC_SERVICE: { fetch: async () => { throw new Error('must not run'); } } },
    base,
    { ...base, NEWAPI_VPC_SERVICE: {} },
  ]) {
    const response = await fetchWorker('/api/health', env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, 'degraded');
    assert.equal(body.content_adapter_selected, 'newapi');
    assert.equal(body.live_newapi, false);
    assert.equal(body.live_newapi_healthy, false);
    assert.equal(body.content_adapter_configured, false);
  }

  const failed = await fetchWorker('/api/health', {
    ...base,
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response(JSON.stringify({ success: false, secret: 'redacted' }), {
        status: 503,
        headers: {
          'content-type': 'application/json',
          'x-newapi-content-contract': 'v1',
        },
      }),
    },
  });
  const failedBody = await failed.json();
  assert.equal(failedBody.content_adapter_configured, true);
  assert.equal(failedBody.live_newapi, false);
  assert.equal(failedBody.live_newapi_healthy, false);
  assert.doesNotMatch(JSON.stringify(failedBody), /redacted|worker-live-content-token/);

  const invalid = await fetchWorker('/api/health', {
    ...base,
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response('{bad', {
        headers: {
          'content-type': 'application/json',
          'x-newapi-content-contract': 'v1',
        },
      }),
    },
  });
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.content_adapter_configured, true);
  assert.equal(invalidBody.live_newapi, false);
  assert.equal(invalidBody.live_newapi_healthy, false);

  for (const [name, upstream] of [
    ['incomplete 200', new Response(JSON.stringify({ success: true }), {
      headers: {
        'content-type': 'application/json',
        'x-newapi-content-contract': 'v1',
      },
    })],
    ['304 health', new Response(null, {
      status: 304,
      headers: {
        etag: '"health-v1"',
        'x-newapi-content-contract': 'v1',
      },
    })],
    ['valid 200', new Response(JSON.stringify({
      success: true,
      service: 'newapi-live-content',
      contract_version: 'v1',
      read_only: true,
    }), {
      headers: {
        'content-type': 'application/json',
        'x-newapi-content-contract': 'v1',
      },
    })],
  ]) {
    const response = await fetchWorker('/api/health', {
      ...base,
      NEWAPI_VPC_SERVICE: {
        fetch: async (request) => {
          assert.equal(new URL(request.url).pathname, '/api/internal/live-content/v1/health');
          assert.equal(request.method, 'GET');
          assert.equal(request.headers.get('cookie'), null);
          return upstream;
        },
      },
    });
    const body = await response.json();
    assert.equal(body.content_adapter_configured, true, name);
    assert.equal(body.live_newapi, name === 'valid 200', name);
    assert.equal(body.live_newapi_healthy, name === 'valid 200', name);
    assert.doesNotMatch(JSON.stringify(body), /worker-live-content-token/);
  }
});

test('live content mode preserves public route envelopes and pricing lock', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/pricing')) {
          return new Response(JSON.stringify({
            success: true,
            meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1' },
            context: { user_group: 'default', selected_group: 'default', locked: true },
            display: { quota_display_type: 'USD', default_currency: 'CNY', price: 7.2, usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1, custom_currency_symbol: '¤', show_with_recharge: true },
            data: [], vendors: [], group_ratio: { default: 1.25 }, usable_group: { default: '普通用户' }, supported_endpoint: {}, auto_groups: [], video_resolution_dimensions: {}, pricing_version: 'live-v1',
          }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } });
        }
        return new Response(JSON.stringify({ success: true, data: { meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1', schema_version: 1, renderer_version: 1 }, sections: [], search_index: [] } }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } });
      },
    },
  };
  const docs = await fetchWorker('/api/content/docs', env);
  assert.equal(docs.status, 200);
  assert.equal((await docs.json()).data.meta.live, true);
  const pricing = await fetchWorker('/api/content/pricing', env);
  const payload = await pricing.json();
  assert.equal(pricing.status, 200);
  assert.deepEqual(payload.context, { user_group: 'default', selected_group: 'default', locked: true });
  assert.equal(payload.group_ratio.default, 1.25);
});

test('live Docs page 404s are public only after the upstream not-found contract is verified', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const base = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
  };
  const contractless = await fetchWorker('/api/content/docs/missing', {
    ...base,
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response('private backend details', {
        status: 404,
        headers: { 'content-type': 'text/plain' },
      }),
    },
  });
  assert.equal(contractless.status, 503);
  const contractlessBody = await contractless.json();
  assert.equal(contractlessBody.error.code, 'integration_unavailable');
  assert.doesNotMatch(JSON.stringify(contractlessBody), /private backend details/);

  const verified = await fetchWorker('/api/content/docs/missing', {
    ...base,
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response(JSON.stringify({
        success: false,
        message: 'document page not found',
      }), {
        status: 404,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-newapi-content-contract': 'v1',
        },
      }),
    },
  });
  assert.equal(verified.status, 404);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.error.code, 'not_found');
  assert.equal(verifiedBody.error.message, 'Document page not found.');
  assert.doesNotMatch(JSON.stringify(verifiedBody), /private backend details/);
});

test('live Docs catalog/page and Pricing responses project only reviewed public fields', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const liveDocsSlug = 'page-1785606868894-3673ea8d4916890d';
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/pricing')) {
          return new Response(JSON.stringify({
            success: true,
            private_secret: 'top-level-secret',
            meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1', private_secret: 'meta-secret' },
            context: { user_group: 'default', selected_group: 'default', locked: true, private_secret: 'context-secret' },
            display: { quota_display_type: 'USD', default_currency: 'CNY', price: 7.2, usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1, custom_currency_symbol: '¤', show_with_recharge: true, private_secret: 'display-secret' },
            data: [{ model_name: 'live-model', description: 'Valid model', enable_groups: ['default'], private_secret: 'model-secret', video_pricing: { version: 1, currency: 'CNY', unit: 'per_1m_completion_tokens', rate_multiplier: 1, resolution_rates: { '720p': { without_video: 2, with_video: 3, private_secret: 'video-rate-secret' } }, private_secret: 'video-secret' } }],
            vendors: [{ id: 1, name: 'Live vendor', private_secret: 'vendor-secret' }],
            group_ratio: { default: 10, premium: 2, private_secret: 'ratio-secret' },
            usable_group: { default: '普通用户', private_secret: 'usable-secret' },
            supported_endpoint: { openai: { method: 'POST', path: '/v1/chat/completions', private_secret: 'endpoint-secret' }, private_secret: { method: 'GET', path: '/secret' } },
            auto_groups: [],
            video_resolution_dimensions: { '720p': { landscape: { default: [1280, 720], private_secret: [1, 1] } }, private_secret: { hidden: { default: [1, 1] } } },
            pricing_version: 'live-v1',
          }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } });
        }
        if (path.endsWith(`/docs/${liveDocsSlug}`)) {
          return new Response(JSON.stringify({
            success: true,
            private_secret: 'page-envelope-secret',
            data: {
              meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1', schema_version: 1, renderer_version: 1, private_secret: 'page-meta-secret' },
              page: {
                slug: liveDocsSlug, title: 'Live quickstart', summary: 'Start here', section: 'Guides', keywords: [], updated_at: 1, private_secret: 'page-secret',
                blocks: [{ type: 'paragraph', text: 'Valid page text', private_secret: 'block-secret' }],
              },
            },
          }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } });
        }
        return new Response(JSON.stringify({
          success: true,
          private_secret: 'catalog-envelope-secret',
          data: {
            meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1', schema_version: 1, renderer_version: 1, private_secret: 'catalog-meta-secret' },
            sections: [{ title: 'Guides', private_secret: 'section-secret', items: [{ slug: liveDocsSlug, title: 'Live quickstart', summary: 'Start here', keywords: [], private_secret: 'item-secret' }] }],
            search_index: [{ slug: liveDocsSlug, anchor: null, title: 'Live quickstart', target_title: 'Live quickstart', text: 'Valid search text', private_secret: 'search-secret' }],
          },
        }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } });
      },
    },
  };

  const catalog = await fetchWorker('/api/content/docs', env);
  assert.equal(catalog.status, 200);
  const catalogBody = await catalog.json();
  assert.equal(catalogBody.data.sections[0].items[0].slug, liveDocsSlug);
  assert.equal(catalogBody.data.search_index[0].text, 'Valid search text');
  assert.doesNotMatch(JSON.stringify(catalogBody), /private_secret/);

  const page = await fetchWorker(`/api/content/docs/${liveDocsSlug}`, env);
  assert.equal(page.status, 200);
  const pageBody = await page.json();
  assert.equal(pageBody.data.page.blocks[0].text, 'Valid page text');
  assert.doesNotMatch(JSON.stringify(pageBody), /private_secret/);

  const pricing = await fetchWorker('/api/content/pricing', env);
  assert.equal(pricing.status, 200);
  const pricingBody = await pricing.json();
  assert.equal(pricingBody.data[0].model_name, 'live-model');
  assert.equal(pricingBody.vendors[0].name, 'Live vendor');
  assert.equal(pricingBody.group_ratio.default, 10);
  assert.equal(pricingBody.group_ratio.premium, 2);
  assert.doesNotMatch(JSON.stringify(pricingBody), /private_secret/);
});

test('live Docs and Pricing preserve ETags and upstream conditional 304 responses', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const calls = [];
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        calls.push({ path, ifNoneMatch: request.headers.get('if-none-match'), cookie: request.headers.get('cookie') });
        if (request.headers.get('if-none-match') === '"pricing-v1"' || request.headers.get('if-none-match') === '"docs-v1"') {
          return new Response(null, {
            status: 304,
            headers: { 'x-newapi-content-contract': 'v1', etag: request.headers.get('if-none-match') },
          });
        }
        if (path.endsWith('/pricing')) {
          return new Response(JSON.stringify({
            success: true,
            meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1' },
            context: { user_group: 'default', selected_group: 'default', locked: true },
            display: { quota_display_type: 'USD', default_currency: 'CNY', price: 7.2, usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1, custom_currency_symbol: '¤', show_with_recharge: true },
            data: [], vendors: [], group_ratio: { default: 1.25 }, usable_group: { default: '普通用户' }, supported_endpoint: {}, auto_groups: [], video_resolution_dimensions: {}, pricing_version: 'live-v1',
          }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1', etag: '"pricing-v1"' } });
        }
        return new Response(JSON.stringify({ success: true, data: { meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1', schema_version: 1, renderer_version: 1 }, sections: [], search_index: [] } }), { headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1', etag: '"docs-v1"' } });
      },
    },
  };

  for (const [path, etag] of [['/api/content/docs', '"docs-v1"'], ['/api/content/pricing', '"pricing-v1"']]) {
    const fresh = await fetchWorker(path, env);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get('etag'), etag);
    assert.equal(fresh.headers.get('cache-control'), 'no-cache');
    assert.equal((await fresh.json()).success, true);

    const conditional = await fetchWorker(path, env, {
      headers: {
        'if-none-match': etag,
        cookie: 'session=must-not-forward',
        authorization: 'Bearer user-key-must-not-forward',
      },
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get('etag'), etag);
    assert.equal(await conditional.text(), '');
  }
  assert.deepEqual(calls.map(({ path, ifNoneMatch, cookie }) => ({ path, ifNoneMatch, cookie })), [
    { path: '/api/internal/live-content/v1/docs', ifNoneMatch: null, cookie: null },
    { path: '/api/internal/live-content/v1/docs', ifNoneMatch: '"docs-v1"', cookie: null },
    { path: '/api/internal/live-content/v1/pricing', ifNoneMatch: null, cookie: null },
    { path: '/api/internal/live-content/v1/pricing', ifNoneMatch: '"pricing-v1"', cookie: null },
  ]);
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
