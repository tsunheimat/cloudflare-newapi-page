import assert from 'node:assert/strict';
import test from 'node:test';

import worker, * as workerModule from '../src/worker.js';
import { createStatusAdapter } from '../src/adapters/status.js';

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

test('canonical DocsHub routes mount the original read contract and omit browser credentials', async () => {
  const config = await fetchWorker('/api/docs/v2/config', fixtureEnv);
  assert.equal(config.status, 200);
  assert.equal((await config.json()).data.default_locale, 'zh');
  const spaces = await fetchWorker('/api/docs/v2/spaces?locale=zh', fixtureEnv);
  assert.equal(spaces.status, 200);
  assert.equal((await spaces.json()).data[0].slug, 'quickstart');
  const page = await fetchWorker('/api/docs/v2/pages/quickstart?space=quickstart&locale=zh&path=quickstart', fixtureEnv);
  assert.equal(page.status, 200);
  assert.equal((await page.json()).data.title, '快速开始');
  const search = await fetchWorker('/api/docs/v2/search?q=temperature&locale=zh&space=quickstart', fixtureEnv);
  assert.equal(search.status, 200);
  assert.equal(Array.isArray((await search.json()).data), true);

  const seen = [];
  const livePayload = {
    success: true,
    data: {
      enabled: true,
      require_auth: false,
      schema_version: 1,
      renderer_version: 1,
      default_locale: 'zh',
    },
  };
  const response = await fetchWorker('/api/docs/v2/config?locale=zh', {
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: `docs-route-${'x'.repeat(32)}`,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        seen.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) });
        return new Response(JSON.stringify(livePayload), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-newapi-content-contract': 'v1',
            etag: '"docs-config"',
          },
        });
      },
    },
  }, {
    headers: {
      cookie: 'session=browser',
      authorization: 'Bearer browser',
      'new-api-user': 'browser-user',
      'x-api-key': 'browser-key',
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.default_locale, 'zh');
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, '/api/internal/live-content/v1/docs/v2/config');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].headers.accept, 'application/json');
  assert.match(seen[0].headers.authorization, /^Bearer docs-route-/);
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers['new-api-user'], undefined);
  assert.equal(seen[0].headers['x-api-key'], undefined);
});

test('/console/pricing is an asset route and never falls back to fixture pricing', async () => {
  const response = await fetchWorker('/console/pricing', fixtureEnv);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/console/pricing');
});

test('public Docs navigation uses the token endpoint and preserves recursive public fields', async () => {
  const token = `worker-public-docs-${'x'.repeat(32)}`;
  const payload = {
    success: true,
    data: [{
      type: 'group', id: 1, slug: 'guides', title: 'Guides', description: 'Public folder',
      icon_key: 'book', space_id: 2, parent_id: 0, sort_key: 1, locale: 'zh', enabled: true,
      private_secret: 'drop',
      children: [{
        type: 'page', id: 2, slug: 'quickstart', path: 'guides/quickstart', title: 'Quickstart',
        description: 'Public page', space_id: 2, parent_id: 1, sort_key: 2, locale: 'zh', enabled: true,
        children: [{ type: 'page', id: 3, slug: 'nested', path: 'guides/quickstart/nested', title: 'Nested', space_id: 2, locale: 'zh', private_secret: 'drop' }],
        private_secret: 'drop',
      }],
    }],
    private_secret: 'drop',
  };
  const seen = [];
  const response = await fetchWorker('/api/front-door/v1/docs/v2/navigation?locale=zh', {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: { fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers),
      });
      return new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'x-newapi-content-contract': 'v1',
          etag: '"docs-navigation-v1"',
        },
      });
    } },
  }, {
    headers: {
      cookie: 'session=browser-secret',
      'New-Api-User': 'browser-user',
      authorization: 'Bearer browser-key',
      'x-api-key': 'browser-api-key',
      'x-provider-credential': 'provider-secret',
      'x-random': 'must-not-forward',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('etag'), '"docs-navigation-v1"');
  const body = await response.json();
  assert.equal(body.data[0].children[0].children[0].path, 'guides/quickstart/nested');
  assert.equal(body.data[0].description, 'Public folder');
  assert.doesNotMatch(JSON.stringify(body), /private_secret/);
  assert.deepEqual(seen, [{
    path: '/api/internal/live-content/v1/docs/v2/navigation',
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  }]);
});

test('public Docs navigation is identity-independent and never forwards browser credentials', async () => {
  const token = `worker-public-docs-${'x'.repeat(32)}`;
  const seen = [];
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        seen.push({ headers: Object.fromEntries(request.headers) });
        return new Response(JSON.stringify({
          success: true, data: [{
            type: 'group', id: 1, slug: 'guides', title: 'Public',
            space_id: 1, locale: 'zh', children: [],
          }],
        }), {
          headers: {
            'content-type': 'application/json',
            'x-newapi-content-contract': 'v1',
            etag: '"docs-upstream"',
          },
        });
      },
    },
  };
  const hostile = {
    cookie: 'session=browser-secret',
    'New-Api-User': 'browser-user',
    authorization: 'Bearer browser-key',
    'x-api-key': 'browser-api-key',
    'x-provider-credential': 'provider-secret',
  };
  const responseA = await fetchWorker('/api/front-door/v1/docs/v2/navigation?locale=zh', env, { headers: hostile });
  const responseB = await fetchWorker('/api/front-door/v1/docs/v2/navigation?locale=zh', env, { headers: hostile });
  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.equal(responseA.headers.get('cache-control'), 'no-cache');
  assert.equal(responseB.headers.get('cache-control'), 'no-cache');
  assert.deepEqual(await responseA.json(), await responseB.json());
  assert.deepEqual(seen, [
    { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
    { headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
  ]);
});

test('content pricing remains on its configured adapter even with New-Api-User', async () => {
  const response = await fetchWorker('/api/content/pricing', fixtureEnv, {
    headers: { 'New-Api-User': 'session-user' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.meta.live, false);
  assert.equal(body.context.user_group, 'default');
});

test('public Pricing ignores browser identity and uses only the Worker adapter token', async () => {
  const token = `worker-public-pricing-${'x'.repeat(32)}`;
  const seen = [];
  const payload = {
    success: true,
    meta: {
      source: 'newapi', fixture: false, live: true,
      label: 'NewAPI live content', updated_at: null, contract_version: 'v1',
    },
    context: { user_group: 'default', selected_group: 'default', locked: true },
    display: {
      quota_display_type: 'USD', default_currency: 'CNY', price: 7.2,
      usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1,
      custom_currency_symbol: '¤', show_with_recharge: true,
    },
    data: [{
      model_name: 'public-model', quota_type: 0, model_ratio: 1,
      model_price: 0, owner_by: '', completion_ratio: 1,
      enable_groups: ['default'], supported_endpoint_types: [],
    }],
    vendors: [{ id: 1, name: 'Public vendor' }],
    group_ratio: { default: 3.25 },
    usable_group: { default: 'Default' },
    supported_endpoint: {}, auto_groups: [],
    video_resolution_dimensions: {}, pricing_version: 'public-v1',
  };
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          method: request.method,
          headers: Object.fromEntries(request.headers),
        });
        return new Response(JSON.stringify(payload), {
          headers: {
            'content-type': 'application/json',
            'x-newapi-content-contract': 'v1',
          },
        });
      },
    },
  };
  const hostileHeaders = {
    cookie: 'session=user-a',
    'New-Api-User': 'browser-user-a',
    authorization: 'Bearer browser-key-a',
    'x-api-key': 'browser-api-key-a',
    'x-provider-credential': 'provider-secret-a',
    'x-random': 'must-not-forward',
  };
  const responseA = await fetchWorker('/api/content/pricing', env, { headers: hostileHeaders });
  const responseB = await fetchWorker('/api/content/pricing', env, {
    headers: { ...hostileHeaders, cookie: 'session=user-b', 'New-Api-User': 'browser-user-b' },
  });
  assert.equal(responseA.status, 200);
  assert.equal(responseB.status, 200);
  assert.doesNotMatch(responseA.headers.get('etag') || '', /worker-public-pricing/);
  assert.doesNotMatch(JSON.stringify(Object.fromEntries(responseA.headers)), /worker-public-pricing/);
  const bodyA = await responseA.json();
  const bodyB = await responseB.json();
  assert.deepEqual(bodyA, bodyB);
  assert.deepEqual(seen, [
    {
      path: '/api/internal/live-content/v1/pricing',
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    },
    {
      path: '/api/internal/live-content/v1/pricing',
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(bodyA), /worker-public-pricing|browser-key-a|provider-secret-a|session=user-a/);

  const removedFrontDoor = await fetchWorker('/api/front-door/v1/pricing', env, {
    headers: hostileHeaders,
  });
  assert.equal(removedFrontDoor.status, 404);
  assert.equal(seen.length, 2);
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

test('Worker fails closed when Docs upstream 304 lacks or mismatches the browser validator', async () => {
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: 'worker-live-content-token-' + 'x'.repeat(32),
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response(null, {
        status: 304,
        headers: {
          'x-newapi-content-contract': 'v1',
          etag: '"docs-v1"',
        },
      }),
    },
  };

  for (const init of [undefined, { headers: { 'if-none-match': '"docs-other"' } }]) {
    const response = await fetchWorker('/api/content/docs', env, init);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'integration_unavailable');
    assert.equal(body.error.details.reason, 'invalid_upstream_etag');
  }
});

test('live Docs upstream 200 is not converted to a local 304 by matching ETag', async () => {
  const docsEtag = '"pricing-deadbeef"';
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, '/api/internal/live-content/v1/docs');
        assert.equal(request.headers.get('if-none-match'), docsEtag);
        return new Response(JSON.stringify({
          success: true,
          data: {
            meta: {
              source: 'newapi',
              fixture: false,
              live: true,
              label: 'NewAPI live content',
              updated_at: null,
              contract_version: 'v1',
              schema_version: 1,
              renderer_version: 1,
            },
            sections: [{ title: 'Guides', items: [] }],
            search_index: [],
          },
        }), {
          headers: {
            'content-type': 'application/json',
            'x-newapi-content-contract': 'v1',
            etag: docsEtag,
          },
        });
      },
    },
  };

  const response = await fetchWorker('/api/content/docs', env, {
    headers: { 'if-none-match': docsEtag },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('etag'), docsEtag);
  assert.deepEqual((await response.json()).data.sections, [{ title: 'Guides', items: [] }]);
});

test('SPA routes pass through the asset binding with security headers', async () => {
  for (const path of ['/docs/quickstart', '/console/pricing', '/pricing']) {
    const response = await fetchWorker(path, fixtureEnv);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), `asset:${path}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(
      response.headers.get('content-security-policy'),
      /style-src 'self'(?:;|$)/,
    );
    assert.doesNotMatch(
      response.headers.get('content-security-policy'),
      /'unsafe-inline'/,
    );
  }
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
