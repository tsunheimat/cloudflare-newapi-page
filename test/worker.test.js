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

test('front-door session routes forward only the signed session and New-Api-User identity', async () => {
  const seen = [];
  const pricing = {
    success: true,
    data: [{ model_name: 'gpt-session', quota_type: 0, model_ratio: 1, model_price: 0, owner_by: '', completion_ratio: 1, enable_groups: ['default'], supported_endpoint_types: [] }],
    vendors: [{ id: 7, name: 'Canonical vendor' }],
    group_ratio: { default: 1.2 },
    usable_group: { default: 'default' },
    supported_endpoint: {},
    auto_groups: [],
    video_resolution_dimensions: {},
    pricing_version: 'canonical',
  };
  const navigation = {
    success: true,
    data: [{
      type: 'group',
      id: 10,
      slug: 'getting-started',
      title: '开始使用',
      space_id: 1,
      locale: 'zh',
      children: [{
        type: 'page',
        id: 11,
        slug: 'setup',
        path: 'setup',
        title: '安装',
        space_id: 1,
        locale: 'zh',
        children: [{
          type: 'page',
          id: 12,
          slug: 'windows',
          path: 'setup/windows',
          title: 'Windows',
          space_id: 1,
          locale: 'zh',
        }],
      }],
    }],
  };
  const env = {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        seen.push({
          path: new URL(request.url).pathname,
          query: new URL(request.url).search,
          method: request.method,
          cookie: request.headers.get('cookie'),
          identity: request.headers.get('new-api-user'),
          ifNoneMatch: request.headers.get('if-none-match'),
          acceptLanguage: request.headers.get('accept-language'),
          authorization: request.headers.get('authorization'),
          random: request.headers.get('x-random'),
        });
        const body = new URL(request.url).pathname.endsWith('/pricing')
          ? pricing
          : navigation;
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      },
    },
  };
  const init = {
    headers: {
      cookie: 'session=signed-cookie; preference=compact',
      'New-Api-User': 'public-user-1',
      'X-Random': 'must-not-forward',
      'If-None-Match': '"browser-validator"',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  };
  const pricingResponse = await fetchWorker('/api/front-door/v1/pricing', env, init);
  assert.equal(pricingResponse.status, 200);
  assert.deepEqual(await pricingResponse.json(), pricing);
  const docsResponse = await fetchWorker('/api/front-door/v1/docs/v2/navigation?locale=zh', env, init);
  assert.equal(docsResponse.status, 200);
  assert.deepEqual(await docsResponse.json(), navigation);
  assert.deepEqual(seen.map(({ path, query, method, cookie, identity, authorization, random, ifNoneMatch, acceptLanguage }) => ({ path, query, method, cookie, identity, authorization, random, ifNoneMatch, acceptLanguage })), [
    {
      path: '/api/front-door/v1/pricing',
      query: '',
      method: 'GET',
      cookie: 'session=signed-cookie',
      identity: 'public-user-1',
      authorization: null,
      random: null,
      ifNoneMatch: '"browser-validator"',
      acceptLanguage: 'zh-CN,zh;q=0.9',
    },
    {
      path: '/api/front-door/v1/docs/v2/navigation',
      query: '?locale=zh',
      method: 'GET',
      cookie: 'session=signed-cookie',
      identity: 'public-user-1',
      authorization: null,
      random: null,
      ifNoneMatch: '"browser-validator"',
      acceptLanguage: 'zh-CN,zh;q=0.9',
    },
  ]);
});

test('front-door Pricing preserves a non-default usable user group from canonical NewAPI', async () => {
  const payload = {
    success: true,
    data: [],
    vendors: [],
    group_ratio: { vip: 0.8 },
    usable_group: { vip: 'VIP' },
    supported_endpoint: {},
    auto_groups: [],
    video_resolution_dimensions: {},
    pricing_version: 'canonical',
  };
  const response = await fetchWorker('/api/front-door/v1/pricing', {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: {
      fetch: async () => new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      }),
    },
  }, {
    headers: { cookie: 'session=signed', 'New-Api-User': 'vip-user' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
});

test('front-door session routes reject credentials and incomplete browser sessions before VPC forwarding', async () => {
  let calls = 0;
  const env = {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: { fetch: async () => { calls += 1; throw new Error('must not forward'); } },
  };
  const rejected = [
    { headers: { cookie: 'session=signed', 'New-Api-User': 'u', authorization: 'Bearer key' } },
    { headers: { cookie: 'session=signed', 'New-Api-User': 'u', 'X-Api-Key': 'key' } },
    { headers: { cookie: 'session=signed', 'New-Api-User': 'u', 'Proxy-Authorization': 'Basic key' } },
    { headers: { cookie: 'session=signed', 'New-Api-User': 'u', 'Sec-WebSocket-Protocol': 'bearer key' } },
    { headers: { cookie: 'session=signed', 'New-Api-User': 'u' }, url: '/api/front-door/v1/pricing?api_key=key' },
    { headers: { 'New-Api-User': 'u' } },
    { headers: { cookie: 'session=signed' } },
  ];
  for (const candidate of rejected) {
    const response = await fetchWorker(candidate.url || '/api/front-door/v1/pricing', env, { headers: candidate.headers });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  }
  assert.equal(calls, 0);
});

test('front-door rejects credential-shaped headers, cookie variants, and query credentials', async () => {
  let calls = 0;
  const env = {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: { fetch: async () => { calls += 1; throw new Error('must not forward'); } },
  };
  const headers = [
    { 'X-Provider-Key': 'provider-secret' },
    { 'X-Service-Key': 'service-secret' },
    { 'X-Provider-Auth': 'provider-auth' },
    { 'X-Client-Secret': 'client-secret' },
    { 'X-Access-Token': 'access-token' },
    { 'X-Credential': 'credential' },
  ];
  for (const extra of headers) {
    const response = await fetchWorker('/api/front-door/v1/pricing', env, {
      headers: { cookie: 'session=signed', 'New-Api-User': 'user', ...extra },
    });
    assert.equal(response.status, 401, Object.keys(extra)[0]);
  }
  for (const cookie of [
    'session=one; session=two',
    'session=one; session =two',
    'session =one',
    'session=one, session=two',
    'session= one',
    'session=one; key=provider-secret',
  ]) {
    const response = await fetchWorker('/api/front-door/v1/pricing', env, {
      headers: { cookie, 'New-Api-User': 'user' },
    });
    assert.equal(response.status, 401, cookie);
  }
  for (const name of ['client_secret', 'client_id', 'secret', 'token', 'key', 'api-key', 'api_key', 'access_token', 'provider_credential']) {
    const response = await fetchWorker(`/api/front-door/v1/pricing?${name}=redacted`, env, {
      headers: { cookie: 'session=signed', 'New-Api-User': 'user' },
    });
    assert.equal(response.status, 401, name);
  }
  assert.equal(calls, 0);
});

test('front-door projection preserves canonical fields and drops private or unknown fields', async () => {
  const payload = {
    success: true,
    user_group: 'premium',
    selected_group: 'premium',
    locked: false,
    context: { user_group: 'premium', selected_group: 'premium', locked: false, private_secret: 'drop' },
    data: [{
      model_name: 'canonical-model', description: 'Public', vendor_id: 4,
      model_ratio: 1, model_price: 0, completion_ratio: 2, quota_type: 0, owner_by: '',
      enable_groups: ['premium'], supported_endpoint_types: ['openai'],
      endpoint_map: { openai: { method: 'POST', path: '/v1/chat/completions', private_secret: 'drop' }, private_key: { method: 'GET', path: '/private' } },
      private_secret: 'drop', unknown_admin_field: 'drop',
    }],
    vendors: [{ id: 4, name: 'Vendor', description: 'Public', private_secret: 'drop' }],
    group_ratio: { premium: 0.8, private_secret: 'drop' },
    usable_group: { premium: 'Premium', private_secret: 'drop' },
    supported_endpoint: { openai: { method: 'POST', path: '/v1/chat/completions', private_secret: 'drop' }, private_secret: { method: 'GET', path: '/private' } },
    auto_groups: ['premium'],
    video_resolution_dimensions: {},
    pricing_version: 'canonical-v1',
    private_secret: 'drop',
  };
  const response = await fetchWorker('/api/front-door/v1/pricing', {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: { fetch: async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) },
  }, { headers: { cookie: 'session=signed', 'New-Api-User': 'user' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.context, { user_group: 'premium', selected_group: 'premium', locked: false });
  assert.deepEqual(body.group_ratio, { premium: 0.8 });
  assert.deepEqual(body.usable_group, { premium: 'Premium' });
  assert.deepEqual(body.data[0].endpoint_map, { openai: { method: 'POST', path: '/v1/chat/completions' } });
  assert.deepEqual(body.supported_endpoint, { openai: { method: 'POST', path: '/v1/chat/completions' } });
  assert.doesNotMatch(JSON.stringify(body), /private_secret|unknown_admin_field/);
});

test('front-door Docs projection preserves recursive folder/layer fields and drops private fields', async () => {
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
  const response = await fetchWorker('/api/front-door/v1/docs/v2/navigation?locale=zh', {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: { fetch: async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) },
  }, { headers: { cookie: 'session=signed', 'New-Api-User': 'user' } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data[0].children[0].children[0].path, 'guides/quickstart/nested');
  assert.equal(body.data[0].description, 'Public folder');
  assert.doesNotMatch(JSON.stringify(body), /private_secret/);
});

test('front-door fails closed on malformed canonical public fields', async () => {
  const base = {
    success: true, data: [], vendors: [], group_ratio: { default: 1 }, usable_group: { default: 'Default' },
    supported_endpoint: {}, auto_groups: [], video_resolution_dimensions: {}, pricing_version: 'v1',
  };
  for (const payload of [
    { ...base, group_ratio: { default: '1' } },
    { ...base, usable_group: { default: '' } },
    { ...base, supported_endpoint: { openai: { method: 'POST', path: 'not-absolute' } } },
    { ...base, context: { user_group: 'default', selected_group: 'missing', locked: true } },
  ]) {
    const response = await fetchWorker('/api/front-door/v1/pricing', {
      ...fixtureEnv,
      NEWAPI_VPC_SERVICE: { fetch: async () => new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }) },
    }, { headers: { cookie: 'session=signed', 'New-Api-User': 'user' } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.details.reason, 'invalid_upstream_schema');
  }
});

test('front-door conditional requests forward and verify an exact browser validator', async () => {
  const seen = [];
  const env = {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        seen.push(request.headers.get('if-none-match'));
        return new Response(null, { status: 304, headers: { etag: '"front-v1"', 'content-type': 'application/json' } });
      },
    },
  };
  const matched = await fetchWorker('/api/front-door/v1/pricing', env, { headers: { cookie: 'session=signed', 'New-Api-User': 'user', 'If-None-Match': '"front-v1"' } });
  assert.equal(matched.status, 304);
  assert.equal(matched.headers.get('etag'), '"front-v1"');
  assert.equal(await matched.text(), '');

  const mismatched = await fetchWorker('/api/front-door/v1/pricing', {
    ...env,
    NEWAPI_VPC_SERVICE: { fetch: async () => new Response(null, { status: 304, headers: { etag: '"other"' } }) },
  }, { headers: { cookie: 'session=signed', 'New-Api-User': 'user', 'If-None-Match': '"front-v1"' } });
  assert.equal(mismatched.status, 503);
  assert.equal(seen[0], '"front-v1"');
});

test('front-door ETags are stable and participate in the complete upstream 304 round trip', async () => {
  const payload = {
    success: true, data: [], vendors: [], group_ratio: { default: 1 }, usable_group: { default: 'Default' },
    supported_endpoint: {}, auto_groups: [], video_resolution_dimensions: {}, pricing_version: 'v1', private_secret: 'drop',
  };
  const seen = [];
  const env = {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        const validator = request.headers.get('if-none-match');
        seen.push(validator);
        if (validator === '"canonical-v1"') return new Response(null, { status: 304, headers: { etag: validator } });
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json', etag: '"canonical-v1"' } });
      },
    },
  };
  const headers = { cookie: 'session=signed', 'New-Api-User': 'user' };
  const fresh = await fetchWorker('/api/front-door/v1/pricing', env, { headers });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers.get('etag'), '"canonical-v1"');
  assert.doesNotMatch(JSON.stringify(await fresh.json()), /private_secret/);

  const conditional = await fetchWorker('/api/front-door/v1/pricing', env, {
    headers: { ...headers, 'If-None-Match': fresh.headers.get('etag') },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('etag'), '"canonical-v1"');
  assert.deepEqual(seen, [null, '"canonical-v1"']);

  const withoutUpstreamEtag = async (privateSecret) => fetchWorker('/api/front-door/v1/pricing', {
    ...fixtureEnv,
    NEWAPI_VPC_SERVICE: { fetch: async () => new Response(JSON.stringify({ ...payload, private_secret: privateSecret }), { headers: { 'content-type': 'application/json' } }) },
  }, { headers });
  const projectedA = await withoutUpstreamEtag('first');
  const projectedB = await withoutUpstreamEtag('second');
  assert.match(projectedA.headers.get('etag'), /^"front-door-pricing-/);
  assert.equal(projectedB.headers.get('etag'), projectedA.headers.get('etag'));
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
        if (request.headers.get('if-none-match') === '"docs-v1"' || (path.endsWith('/pricing') && request.headers.get('if-none-match'))) {
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

  let pricingPublicEtag;
  for (const [path, etag] of [['/api/content/docs', '"docs-v1"'], ['/api/content/pricing', '"pricing-v1"']]) {
    const fresh = await fetchWorker(path, env);
    assert.equal(fresh.status, 200);
    const publicEtag = path.endsWith('/pricing') ? fresh.headers.get('etag') : etag;
    if (path.endsWith('/pricing')) pricingPublicEtag = publicEtag;
    assert.ok(publicEtag);
    assert.equal(fresh.headers.get('etag'), publicEtag);
    assert.equal(fresh.headers.get('cache-control'), 'no-cache');
    assert.equal((await fresh.json()).success, true);

    const conditional = await fetchWorker(path, env, {
      headers: {
        'if-none-match': publicEtag,
        cookie: 'session=must-not-forward',
        authorization: 'Bearer user-key-must-not-forward',
      },
    });
    assert.equal(conditional.status, 304);
    assert.equal(conditional.headers.get('etag'), publicEtag);
    assert.equal(await conditional.text(), '');
  }
  assert.deepEqual(calls.map(({ path, ifNoneMatch, cookie }) => ({ path, ifNoneMatch, cookie })), [
    { path: '/api/internal/live-content/v1/docs', ifNoneMatch: null, cookie: null },
    { path: '/api/internal/live-content/v1/docs', ifNoneMatch: '"docs-v1"', cookie: null },
    { path: '/api/internal/live-content/v1/pricing', ifNoneMatch: null, cookie: null },
    { path: '/api/internal/live-content/v1/pricing', ifNoneMatch: pricingPublicEtag, cookie: null },
  ]);
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

test('live pricing returns 304 after an order-only upstream ETag change', async () => {
  const token = 'worker-live-content-token-' + 'x'.repeat(32);
  const models = [
    { model_name: 'zeta-model', description: 'Zeta', model_ratio: 2, enable_groups: ['default'] },
    { model_name: 'alpha-model', description: 'Alpha', model_ratio: 1, enable_groups: ['default'] },
  ];
  let requestCount = 0;
  const env = {
    ...fixtureEnv,
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, '/api/internal/live-content/v1/pricing');
        const data = requestCount++ === 0 ? models : [...models].reverse();
        const rawEtag = requestCount === 1 ? '"raw-order-a"' : '"raw-order-b"';
        return new Response(JSON.stringify({
          success: true,
          meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI live content', updated_at: null, contract_version: 'v1' },
          context: { user_group: 'default', selected_group: 'default', locked: true },
          display: { quota_display_type: 'USD', default_currency: 'CNY', price: 7.2, usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1, custom_currency_symbol: '¤', show_with_recharge: true },
          data,
          vendors: [],
          group_ratio: { default: 10 },
          usable_group: { default: '普通用户' },
          supported_endpoint: {},
          auto_groups: [],
          video_resolution_dimensions: {},
          pricing_version: 'live-v1',
        }), {
          headers: {
            'content-type': 'application/json',
            'x-newapi-content-contract': 'v1',
            etag: rawEtag,
          },
        });
      },
    },
  };

  const first = await fetchWorker('/api/content/pricing', env);
  const firstBody = await first.json();
  const second = await fetchWorker('/api/content/pricing', env);
  const secondBody = await second.json();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody, firstBody);
  assert.equal(second.headers.get('etag'), first.headers.get('etag'));
  assert.deepEqual(firstBody.context, { user_group: 'default', selected_group: 'default', locked: true });
  assert.equal(firstBody.group_ratio.default, 10);
  assert.deepEqual(firstBody.data.map((model) => model.model_name), ['alpha-model', 'zeta-model']);

  const conditional = await fetchWorker('/api/content/pricing', env, {
    headers: { 'if-none-match': first.headers.get('etag') },
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.headers.get('etag'), first.headers.get('etag'));
  assert.equal(await conditional.text(), '');
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
