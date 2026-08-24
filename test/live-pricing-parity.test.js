import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/worker.js';

const token = `parity-token-${'x'.repeat(40)}`;

function liveEnv(fetch) {
  return {
    CONTENT_ADAPTER: 'newapi',
    LIVE_CONTENT_ADAPTER_TOKEN: token,
    NEWAPI_VPC_SERVICE: { fetch },
    ASSETS: { fetch: async () => new Response('canonical-assets') },
  };
}

test('canonical pricing is byte-for-byte and preserves arbitrary groups, order, and future fields', async () => {
  const raw = '{"success":true,"data":[{"model_name":"zeta model","future_model_field":{"keep":[3,2,1]},"enable_groups":["team premium","default"]},{"model_name":"alpha model"}],"vendors":[{"id":2,"name":"Vendor B"},{"id":1,"name":"Vendor A"}],"group_ratio":{"team premium":2.75,"default":1,"enterprise tier":4.25},"usable_group":{"team premium":"Team Premium","default":"Default","enterprise tier":"Enterprise"},"supported_endpoint":{"future endpoint":{"method":"PATCH","path":"/v1/future"},"openai":{"method":"POST","path":"/v1/chat/completions"}},"auto_groups":["team premium","enterprise tier"],"video_resolution_dimensions":{"wide screen":{"landscape":{"default":[1920,1080]}}},"pricing_version":"backend-exact-v7","future_top_level":{"preserve":true}}';
  const seen = [];
  const env = liveEnv(async (request) => {
    seen.push(request);
    return new Response(raw, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-newapi-content-contract': 'v1',
        etag: '"backend-exact-v7"',
      },
    });
  });
  const hostile = {
    cookie: 'session=browser',
    authorization: 'Bearer browser',
    'x-api-key': 'browser-key',
    'x-admin-token': 'admin-secret',
    'x-provider-credential': 'provider-secret',
  };

  for (const path of ['/api/pricing', '/api/content/pricing']) {
    const response = await worker.fetch(new Request(`https://public.example${path}`, { headers: hostile }), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), raw);
  }
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(request.method, 'GET');
    assert.deepEqual(Object.fromEntries(request.headers), {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    });
    assert.equal(new URL(request.url).pathname, '/api/internal/live-content/v1/pricing');
  }
});

test('token-only status bootstrap preserves canonical display and conversion fields', async () => {
  const seen = [];
  const env = liveEnv(async (request) => {
    seen.push(request);
    return new Response(JSON.stringify({
      success: true,
      message: '',
      data: {
        display_in_currency: true,
        quota_display_type: 'CNY',
        custom_currency_symbol: '¤',
        custom_currency_exchange_rate: 1.7,
        usd_exchange_rate: 7.31,
        price: 8.2,
        quota_per_unit: 500000,
        model_marketplace_default: { vendor: '2', group: 'team premium' },
      },
    }), {
      headers: {
        'content-type': 'application/json',
        'x-newapi-content-contract': 'v1',
      },
    });
  });
  const response = await worker.fetch(new Request('https://public.example/api/status', {
    headers: {
      cookie: 'session=browser',
      authorization: 'Bearer browser',
      'x-api-key': 'browser-key',
      'x-admin-token': 'admin-secret',
      'x-provider-credential': 'provider-secret',
    },
  }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    message: '',
    data: {
      display_in_currency: true,
      quota_display_type: 'CNY',
      custom_currency_symbol: '¤',
      custom_currency_exchange_rate: 1.7,
      usd_exchange_rate: 7.31,
      price: 8.2,
      quota_per_unit: 500000,
      model_marketplace_default: { vendor: '2', group: 'team premium' },
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].url).pathname, '/api/internal/live-content/v1/status');
  assert.deepEqual(Object.fromEntries(seen[0].headers), {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  });
});

test('both public pricing URLs mount the same canonical asset surface', async () => {
  const env = {
    ASSETS: { fetch: async () => new Response('canonical-pricing-bundle') },
  };
  const consolePricing = await worker.fetch(new Request('https://public.example/console/pricing'), env);
  const publicPricing = await worker.fetch(new Request('https://public.example/pricing'), env);
  assert.equal(consolePricing.status, 200);
  assert.equal(publicPricing.status, 200);
  assert.equal(await consolePricing.text(), await publicPricing.text());
});
