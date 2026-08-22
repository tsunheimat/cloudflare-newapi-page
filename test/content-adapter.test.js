import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOrdinaryUserPricingContext,
  CONTENT_ADAPTER_LIVE,
  createContentAdapter,
  createFixtureAdapter,
  createLiveContentAdapter,
  LIVE_CONTENT_MAX_BODY_BYTES,
  LIVE_CONTENT_TIMEOUT_MS,
  LIVE_CONTENT_VPC_BINDING,
} from '../src/adapters/content-adapter.js';
import { HttpError } from '../src/http.js';

test('fixture adapter exposes a structured Docs catalog and pages', async () => {
  const adapter = createContentAdapter({ CONTENT_ADAPTER: 'fixture' });
  const catalog = await adapter.getDocsCatalog();

  assert.equal(adapter.name, 'fixture');
  assert.equal(adapter.live, false);
  assert.equal(catalog.meta.fixture, true);
  assert.equal(catalog.meta.live, false);
  assert.ok(catalog.sections.length >= 3);

  const temperature = catalog.search_index.find((entry) =>
    entry.text.includes('temperature'),
  );
  assert.equal(temperature.slug, 'chat-completions');
  assert.equal(temperature.anchor, 'body');

  const responsesEndpoint = catalog.search_index.find((entry) =>
    entry.text.includes('/v1/responses'),
  );
  assert.equal(responsesEndpoint.slug, 'responses');
  assert.equal(responsesEndpoint.anchor, 'responses-endpoint');
  assert.match(responsesEndpoint.target_title, /POST \/v1\/responses/);

  const quickstart = await adapter.getDocPage('quickstart');
  assert.equal(quickstart.page.title, '快速开始');
  assert.ok(quickstart.page.blocks.some((block) => block.type === 'code'));
});

test('fixture adapter returns independent payload copies', async () => {
  const adapter = createFixtureAdapter();
  const first = await adapter.getPricing();
  first.context.user_group = 'mutated';
  first.data[0].model_name = 'mutated';

  const second = await adapter.getPricing();
  assert.equal(second.context.user_group, 'default');
  assert.notEqual(second.data[0].model_name, 'mutated');
});

test('unknown adapters fail closed without inventing a live endpoint', () => {
  assert.throws(
    () => createContentAdapter({ CONTENT_ADAPTER: 'unconfigured' }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.details.live_integration, false);
      return true;
    },
  );
});

test('pricing adapter contract requires locked default/default context', () => {
  const base = {
    context: {
      user_group: 'default',
      selected_group: 'default',
      locked: true,
    },
    group_ratio: { default: 1.25 },
    usable_group: { default: '普通用户' },
  };
  assert.equal(assertOrdinaryUserPricingContext(base), base);

  for (const invalid of [
    { ...base, context: { ...base.context, user_group: 'vip' } },
    { ...base, context: { ...base.context, selected_group: 'vip' } },
    { ...base, context: { ...base.context, locked: false } },
    { ...base, group_ratio: {} },
    { ...base, group_ratio: { default: 1 } },
    { ...base, group_ratio: { default: -1 } },
    { ...base, group_ratio: { default: Number.POSITIVE_INFINITY } },
    { ...base, group_ratio: { default: Number.NaN } },
    { ...base, usable_group: {} },
  ]) {
    assert.throws(() => assertOrdinaryUserPricingContext(invalid), HttpError);
  }
});

const liveToken = 'test-live-content-token-' + 'x'.repeat(32);

function liveResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-newapi-content-contract': 'v1',
      ...headers,
    },
  });
}

function liveEnv(fetch) {
  return {
    CONTENT_ADAPTER: CONTENT_ADAPTER_LIVE,
    LIVE_CONTENT_ADAPTER_TOKEN: liveToken,
    [LIVE_CONTENT_VPC_BINDING]: { fetch },
  };
}

const liveMeta = (docs = false) => ({
  source: 'newapi',
  fixture: false,
  live: true,
  label: 'NewAPI live content',
  updated_at: null,
  contract_version: 'v1',
  ...(docs ? { schema_version: 1, renderer_version: 1 } : {}),
});

const livePricing = {
  success: true,
  meta: liveMeta(),
  context: { user_group: 'default', selected_group: 'default', locked: true },
  display: {
    quota_display_type: 'USD',
    default_currency: 'CNY',
    price: 7.2,
    usd_exchange_rate: 7.2,
    custom_currency_exchange_rate: 1,
    custom_currency_symbol: '¤',
    show_with_recharge: true,
  },
  data: [{ model_name: 'live-model', enable_groups: ['default'] }],
  vendors: [{ id: 1, name: 'Live vendor' }],
  group_ratio: { default: 1.25 },
  usable_group: { default: '普通用户' },
  supported_endpoint: {},
  auto_groups: [],
  video_resolution_dimensions: {},
  pricing_version: 'live-v1',
};

test('live adapter uses only the VPC binding and private GET contract', async () => {
  const calls = [];
  const adapter = createContentAdapter(liveEnv(async (request) => {
    calls.push(request);
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [{ title: 'Guides', items: [{ slug: 'quickstart', title: 'Quickstart', summary: 'Start here', keywords: [] }] }],
        search_index: [{ slug: 'quickstart', anchor: null, title: 'Quickstart', target_title: 'Quickstart', text: 'Start here' }],
      },
    });
  }));
  const catalog = await adapter.getDocsCatalog();
  assert.equal(adapter.name, CONTENT_ADAPTER_LIVE);
  assert.equal(adapter.live, true);
  assert.equal(catalog.sections[0].items[0].slug, 'quickstart');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).hostname, 'newapi-api.newapi');
  assert.equal(new URL(calls[0].url).port, '3000');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${liveToken}`);
  assert.equal(calls[0].headers.get('cookie'), null);
});

test('live adapter validates pricing invariants and does not fall back to fixtures', async () => {
  const adapter = createContentAdapter(liveEnv(async () => liveResponse(livePricing)));
  const pricing = await adapter.getPricing();
  assert.equal(pricing.meta.live, true);
  assert.equal(pricing.context.locked, true);
  assert.equal(pricing.group_ratio.default, 1.25);

  const invalid = createContentAdapter(liveEnv(async () =>
    liveResponse({ ...livePricing, group_ratio: { default: 1 } }),
  ));
  await assert.rejects(
    () => invalid.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
  );
});

test('live adapter bounds upstream failures and redacts backend responses', async () => {
  for (const response of [
    liveResponse({ success: false, message: 'secret backend details' }, 503),
    new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('{bad', { status: 200, headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } }),
  ]) {
    const adapter = createContentAdapter(liveEnv(async () => response));
    await assert.rejects(
      () => adapter.getPricing(),
      (error) => error instanceof HttpError && error.status === 503 && error.message === 'Live content is temporarily unavailable.',
    );
  }
});

test('live document 404 stays a public not-found response', async () => {
  const adapter = createContentAdapter(liveEnv(async () =>
    liveResponse({ success: false, message: 'private backend message' }, 404),
  ));
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404 && error.message === 'Document page not found.',
  );
});

test('live adapter aborts slow upstreams and rejects oversized bodies', async () => {
  const slow = createLiveContentAdapter(liveEnv(() => new Promise(() => {})), {
    timeoutMs: 10,
  });
  await assert.rejects(
    () => slow.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'upstream_timeout',
  );

  const oversized = createLiveContentAdapter(liveEnv(async () => new Response('x'.repeat(20), {
    headers: {
      'content-type': 'application/json',
      'x-newapi-content-contract': 'v1',
      'content-length': '20',
    },
  })), { maxBodyBytes: 10 });
  await assert.rejects(
    () => oversized.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_body',
  );
  assert.equal(LIVE_CONTENT_TIMEOUT_MS, 5_000);
  assert.equal(LIVE_CONTENT_MAX_BODY_BYTES, 2 * 1024 * 1024);
});

test('unknown fixture document slugs return 404', async () => {
  const adapter = createFixtureAdapter();
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
