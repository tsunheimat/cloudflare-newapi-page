import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOrdinaryUserPricingContext,
  CONTENT_ADAPTER_LIVE,
  createContentAdapter,
  createFixtureAdapter,
  createLiveContentAdapter,
  LIVE_CONTENT_MAX_BODY_BYTES,
  LIVE_CONTENT_MAX_SERIALIZED_REQUEST_BYTES,
  LIVE_CONTENT_DOCS_RENDERER_VERSION,
  LIVE_CONTENT_DOCS_SCHEMA_VERSION,
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
    group_ratio: { default: 10 },
    usable_group: { default: '普通用户' },
  };
  assert.equal(assertOrdinaryUserPricingContext(base), base);

  for (const invalid of [
    { ...base, context: { ...base.context, user_group: 'vip' } },
    { ...base, context: { ...base.context, selected_group: 'vip' } },
    { ...base, context: { ...base.context, locked: false } },
    { ...base, group_ratio: {} },
    { ...base, group_ratio: { default: '1' } },
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

function liveNotModified(etag = '"docs-v1"') {
  return new Response(null, {
    status: 304,
    headers: {
      'x-newapi-content-contract': 'v1',
      etag,
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
  group_ratio: { default: 10, premium: 2 },
  usable_group: { default: '普通用户' },
  supported_endpoint: {},
  auto_groups: [],
  video_resolution_dimensions: {},
  pricing_version: 'live-v1',
};

test('live adapter uses only the VPC binding and private GET contract', async () => {
  const calls = [];
  const liveDocsSlug = 'page-1785606868894-3673ea8d4916890d';
  const adapter = createContentAdapter(liveEnv(async (request) => {
    calls.push(request);
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [{ title: 'Guides', items: [{ slug: liveDocsSlug, title: 'Live quickstart', summary: 'Start here', keywords: [] }] }],
        search_index: [{ slug: liveDocsSlug, anchor: null, title: 'Live quickstart', target_title: 'Live quickstart', text: 'Start here' }],
      },
    });
  }));
  const catalog = await adapter.getDocsCatalog();
  assert.equal(adapter.name, CONTENT_ADAPTER_LIVE);
  assert.equal(adapter.live, true);
  assert.equal(catalog.sections[0].items[0].slug, liveDocsSlug);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).hostname, 'newapi-api.newapi');
  assert.equal(new URL(calls[0].url).port, '3000');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${liveToken}`);
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('if-none-match'), null);
});

test('live adapter forwards only a browser validator and preserves verified ETags', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [],
        search_index: [],
      },
    }, 200, { etag: '"catalog-v1"' });
  }));
  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: '"catalog-old"',
  });
  assert.equal(result.status, 200);
  assert.equal(result.etag, '"catalog-v1"');
  assert.equal(observed.headers.get('if-none-match'), '"catalog-old"');
  assert.equal(observed.headers.get('cookie'), null);
  assert.equal(observed.headers.get('x-api-key'), null);
  assert.equal(observed.headers.get('x-forwarded-authorization'), null);
});

test('live Docs keeps an upstream 200 body when its ETag matches the request', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [{ title: 'Guides', items: [] }],
        search_index: [],
      },
    }, 200, { etag: '"catalog-v1"' });
  }));

  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: '"catalog-v1"',
  });

  assert.equal(result.status, 200);
  assert.equal(result.etag, '"catalog-v1"');
  assert.deepEqual(result.payload.sections, [{ title: 'Guides', items: [] }]);
  assert.equal(observed.headers.get('if-none-match'), '"catalog-v1"');
});

test('matching live conditional responses preserve verified 304 semantics', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveNotModified('W/"catalog-v1"');
  }));
  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: 'W/"catalog-v1"',
  });
  assert.deepEqual(result, {
    status: 304,
    payload: null,
    etag: 'W/"catalog-v1"',
  });
  assert.equal(observed.headers.get('if-none-match'), 'W/"catalog-v1"');
});

test('live adapter validates pricing invariants and does not fall back to fixtures', async () => {
  const adapter = createContentAdapter(liveEnv(async () => liveResponse(livePricing)));
  const pricing = await adapter.getPricing();
  assert.equal(pricing.meta.live, true);
  assert.equal(pricing.context.locked, true);
  assert.equal(pricing.group_ratio.default, 10);
  assert.equal(pricing.group_ratio.premium, 2);

  const invalid = createContentAdapter(liveEnv(async () =>
    liveResponse({ ...livePricing, group_ratio: { default: -1 } }),
  ));
  await assert.rejects(
    () => invalid.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
  );
});

test('live pricing retains the current NewAPI model families through a bounded public projection', async () => {
  const currentModel = {
    model_name: 'live-video-fast',
    description: 'Current model',
    icon: 'https://cdn.example/icon.png',
    tags: 'Video,Fast',
    vendor_id: 7,
    image_generation_model: true,
    video_generation_model: true,
    quota_type: 2,
    model_ratio: 0,
    model_price: 0,
    owner_by: 'provider',
    completion_ratio: 0,
    cache_ratio: 0.1,
    create_cache_ratio: 0.2,
    image_ratio: 0.3,
    audio_ratio: 0.4,
    audio_completion_ratio: 0.5,
    enable_groups: ['default'],
    supported_endpoint_types: ['openai-video'],
    endpoint_map: {
      'openai-video': { method: 'POST', path: '/v1/video/generations', private_secret: 'drop' },
      private_secret: { method: 'POST', path: '/private' },
    },
    billing_mode: 'video',
    billing_expr: 'v1:tier("base", p * 1 + c * 2)',
    video_pricing: {
      version: 1,
      currency: 'USD',
      unit: 'per_1m_completion_tokens',
      rate_multiplier: 1,
      resolution_rates: { '720p': { without_video: 2, with_video: 3, private_secret: 'drop' } },
      private_secret: 'drop',
    },
    codex_fast_pricing: { version: 1, mode: 'prices', input_price: 1, cached_input_price: 0.5, output_price: 2, private_secret: 'drop' },
    codex_fast_base_model: 'base-model',
    video_geometry_contract: 'geometry-v1',
    video_route_contract: 'openai-video-generations-v1',
    video_input_duration_policy: 'included',
    video_capability: {
      model: 'live-video-fast',
      mapped_upstream_models: ['upstream-video'],
      schema_version: 1,
      profile: { name: 'profile', label: 'Profile', revision: 2, checksum: 'checksum-v2', private_secret: 'drop' },
      output: {
        resolutions: ['720p'], default_resolution: '720p', known_unsupported_resolutions: ['4k'],
        ratios: ['16:9'], default_ratio: '16:9', duration_min: 1, duration_max: 10,
        allow_auto_duration: true, default_duration: 5, output_formats: ['mp4'], default_output_format: 'mp4',
      },
      audio: { generate_audio_supported: true, generate_audio_default: false },
      media: {
        max_images: 2, max_videos: 1, max_audios: 1,
        allow_video_only_reference: true, allow_audio_only_reference: false,
        modes: {
          text_generate: {
            selectable: true, ratios: ['16:9'], duration_min: 1, duration_max: 10,
            allow_auto_duration: true, min_images: 0, max_images: 1,
            min_reference_videos: 0, required_video_roles: [], duration_upstream_validated: false,
          },
        },
      },
      geometry: { '720p': { '16:9': [1280, 720] } },
      image_size: { max_single_decoded_bytes: 1024, single_limit_exclusive: true, single_limit_label: 'single', max_total_decoded_bytes: 2048, total_limit_label: 'total' },
      max_serialized_request_bytes: 64_000_000,
    },
    pricing_version: 'model-pricing-v2',
    private_secret: 'drop',
  };
  const adapter = createContentAdapter(liveEnv(async () => liveResponse({
    ...livePricing,
    data: [currentModel],
    vendors: [{ id: 7, name: 'Vendor', description: 'Public', icon: 'vendor-icon', private_secret: 'drop' }],
    supported_endpoint: { openai: { method: 'POST', path: '/v1/chat/completions', private_secret: 'drop' } },
  })));
  const result = await adapter.getPricingResponse();
  const model = result.payload.data[0];
  assert.deepEqual(model, {
    model_name: 'live-video-fast', description: 'Current model', icon: 'https://cdn.example/icon.png', tags: 'Video,Fast', vendor_id: 7,
    quota_type: 2, model_ratio: 0, model_price: 0, owner_by: 'provider', completion_ratio: 0, cache_ratio: 0.1, create_cache_ratio: 0.2,
    image_ratio: 0.3, audio_ratio: 0.4, audio_completion_ratio: 0.5, billing_mode: 'video', billing_expr: 'v1:tier("base", p * 1 + c * 2)',
    codex_fast_base_model: 'base-model', video_geometry_contract: 'geometry-v1', video_route_contract: 'openai-video-generations-v1', video_input_duration_policy: 'included',
    pricing_version: 'model-pricing-v2', image_generation_model: true, video_generation_model: true, enable_groups: ['default'], supported_endpoint_types: ['openai-video'],
    endpoint_map: { 'openai-video': { method: 'POST', path: '/v1/video/generations' } },
    video_pricing: { version: 1, currency: 'USD', unit: 'per_1m_completion_tokens', rate_multiplier: 1, resolution_rates: { '720p': { without_video: 2, with_video: 3 } } },
    codex_fast_pricing: { version: 1, mode: 'prices', input_price: 1, cached_input_price: 0.5, output_price: 2 },
    video_capability: {
      model: 'live-video-fast', mapped_upstream_models: ['upstream-video'], schema_version: 1,
      profile: { name: 'profile', label: 'Profile', revision: 2, checksum: 'checksum-v2' },
      output: { resolutions: ['720p'], default_resolution: '720p', ratios: ['16:9'], default_ratio: '16:9', duration_min: 1, duration_max: 10, allow_auto_duration: true, default_duration: 5, output_formats: ['mp4'], known_unsupported_resolutions: ['4k'], default_output_format: 'mp4' },
      audio: { generate_audio_supported: true, generate_audio_default: false },
      media: { max_images: 2, max_videos: 1, max_audios: 1, allow_video_only_reference: true, allow_audio_only_reference: false, modes: { text_generate: { selectable: true, ratios: ['16:9'], min_images: 0, max_images: 1, duration_min: 1, duration_max: 10, allow_auto_duration: true, min_reference_videos: 0, required_video_roles: [], duration_upstream_validated: false } } },
      geometry: { '720p': { '16:9': [1280, 720] } }, image_size: { max_single_decoded_bytes: 1024, single_limit_exclusive: true, single_limit_label: 'single', max_total_decoded_bytes: 2048, total_limit_label: 'total' }, max_serialized_request_bytes: 64_000_000,
    },
  });
  assert.equal(Object.hasOwn(model, 'private_secret'), false);
  assert.equal(Object.hasOwn(model.endpoint_map, 'private_secret'), false);
  assert.equal(Object.hasOwn(model.video_pricing, 'private_secret'), false);
  assert.equal(Object.hasOwn(result.payload.vendors[0], 'private_secret'), false);
});

test('live pricing accepts the exact finite Seedance 2.5 serialized request bound', async () => {
  assert.equal(LIVE_CONTENT_MAX_SERIALIZED_REQUEST_BYTES, 64_000_000);
  const capability = {
    model: 'live-model',
    mapped_upstream_models: ['upstream'],
    schema_version: 1,
    profile: { name: 'profile', label: 'Profile', revision: 1, checksum: 'sum' },
    output: {
      resolutions: ['720p'], default_resolution: '720p', ratios: ['16:9'],
      default_ratio: '16:9', duration_min: 1, duration_max: 10,
      allow_auto_duration: true, default_duration: 5, output_formats: ['mp4'],
    },
    audio: { generate_audio_supported: true },
    media: {
      max_images: 1, max_videos: 1, max_audios: 0,
      allow_video_only_reference: false, allow_audio_only_reference: false,
      modes: {
        text_generate: { selectable: true, ratios: ['16:9'], min_images: 0, max_images: 1 },
      },
    },
    max_serialized_request_bytes: 64_000_000,
  };
  const accepted = createContentAdapter(liveEnv(async () => liveResponse({
    ...livePricing,
    data: [{ ...livePricing.data[0], video_capability: capability }],
  })));
  const payload = await accepted.getPricing();
  assert.equal(payload.data[0].video_capability.max_serialized_request_bytes, 64_000_000);

  const rejected = createContentAdapter(liveEnv(async () => liveResponse({
    ...livePricing,
    data: [{
      ...livePricing.data[0],
      video_capability: { ...capability, max_serialized_request_bytes: 64_000_001 },
    }],
  })));
  await assert.rejects(
    () => rejected.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
  );
});

test('pricing ETag changes for capability and route-contract-only changes', async () => {
  const base = { ...livePricing, data: [{ model_name: 'video', enable_groups: ['default'], video_route_contract: 'route-v1', video_geometry_contract: 'geometry-v1' }] };
  let requestCount = 0;
  const adapter = createLiveContentAdapter(liveEnv(async () => liveResponse(
    requestCount++ === 0 ? base : { ...base, data: [{ ...base.data[0], video_route_contract: 'route-v2' }] },
    200,
    { etag: '"same-upstream-etag"' },
  )));
  const first = await adapter.getPricingResponse();
  const changed = await adapter.getPricingResponse();
  assert.notEqual(first.etag, changed.etag);
  assert.equal(changed.payload.data[0].video_route_contract, 'route-v2');
});

test('live pricing rejects malformed bounded nested Fast/video capability objects', async () => {
  const invalidRows = [
    {
      ...livePricing.data[0],
      codex_fast_pricing: { version: 1, mode: 'prices', input_price: 1, cached_input_price: 1 },
    },
    {
      ...livePricing.data[0],
      video_capability: {
        model: 'live-model', mapped_upstream_models: ['upstream'], schema_version: 1,
        profile: { name: 'profile', label: 'Profile', revision: 1, checksum: 'sum' },
        output: { resolutions: ['720p'], default_resolution: '720p', ratios: ['16:9'], default_ratio: '16:9', duration_min: 1, duration_max: 10, allow_auto_duration: true, default_duration: 5, output_formats: ['mp4'] },
        audio: { generate_audio_supported: true },
        media: { max_images: 1, max_videos: 1, max_audios: 0, allow_video_only_reference: false, allow_audio_only_reference: false, modes: { text_generate: { selectable: true, ratios: ['16:9'], min_images: 0, max_images: 1, duration_min: 1, duration_max: 10, allow_auto_duration: true, required_video_roles: ['x'.repeat(201)] } } },
      },
    },
  ];
  for (const row of invalidRows) {
    const adapter = createContentAdapter(liveEnv(async () => liveResponse({ ...livePricing, data: [row] })));
    await assert.rejects(
      () => adapter.getPricing(),
      (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
    );
  }
});

test('live pricing uses deterministic model ordering and canonical ETags', async () => {
  const models = [
    { model_name: 'zeta-model', description: 'Zeta', model_ratio: 2, enable_groups: ['default'] },
    { model_name: 'alpha-model', description: 'Alpha', model_ratio: 1, enable_groups: ['default'] },
  ];
  const payloads = [
    { ...livePricing, data: models },
    { ...livePricing, data: [...models].reverse() },
  ];
  const calls = [];
  let requestCount = 0;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    calls.push(request);
    const payload = payloads[Math.min(requestCount, payloads.length - 1)];
    const rawEtag = requestCount++ === 0 ? '"raw-order-a"' : '"raw-order-b"';
    return liveResponse(payload, 200, { etag: rawEtag });
  }));

  const first = await adapter.getPricingResponse();
  const second = await adapter.getPricingResponse();
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual(first.payload.context, {
    user_group: 'default',
    selected_group: 'default',
    locked: true,
  });
  assert.equal(first.payload.group_ratio.default, 10);
  assert.deepEqual(
    first.payload.data.map((model) => model.model_name),
    ['alpha-model', 'zeta-model'],
  );
  assert.deepEqual(first.payload.data, [
    { model_name: 'alpha-model', description: 'Alpha', model_ratio: 1, enable_groups: ['default'] },
    { model_name: 'zeta-model', description: 'Zeta', model_ratio: 2, enable_groups: ['default'] },
  ]);
  assert.deepEqual(second.payload, first.payload);
  assert.equal(second.etag, first.etag);
  assert.notEqual(first.etag, '"raw-order-a"');
  assert.notEqual(second.etag, '"raw-order-b"');

  const conditional = await adapter.getPricingResponse({ ifNoneMatch: first.etag });
  assert.deepEqual(conditional, { status: 304, payload: null, etag: first.etag });
  assert.equal(calls[2].headers.get('if-none-match'), first.etag);
});

test('live pricing canonical ETags ignore vendor and identifier-array order but retain value changes', async () => {
  const base = {
    ...livePricing,
    data: [{
      ...livePricing.data[0],
      model_name: 'order-sensitive-model',
      enable_groups: ['premium', 'default'],
      supported_endpoint_types: ['responses', 'openai'],
    }],
    vendors: [
      { id: 2, name: 'Vendor B' },
      { id: 1, name: 'Vendor A' },
    ],
  };
  const reordered = {
    ...base,
    data: [{
      ...base.data[0],
      enable_groups: [...base.data[0].enable_groups].reverse(),
      supported_endpoint_types: [...base.data[0].supported_endpoint_types].reverse(),
    }],
    vendors: [...base.vendors].reverse(),
  };
  const changed = {
    ...reordered,
    data: [{
      ...reordered.data[0],
      supported_endpoint_types: ['openai', 'chat'],
    }],
    vendors: [{ ...reordered.vendors[0], name: 'Vendor A changed' }, { ...reordered.vendors[1] }],
  };
  const payloads = [base, reordered, changed];
  let requestCount = 0;
  const adapter = createLiveContentAdapter(liveEnv(async () => {
    const payload = payloads[Math.min(requestCount, payloads.length - 1)];
    requestCount += 1;
    return liveResponse(payload, 200, { etag: `"raw-canonical-${requestCount}"` });
  }));

  const first = await adapter.getPricingResponse();
  const reorderedResult = await adapter.getPricingResponse();
  const changedResult = await adapter.getPricingResponse();

  assert.deepEqual(first.payload.vendors.map(({ id }) => id), [1, 2]);
  assert.deepEqual(first.payload.data[0].enable_groups, ['default', 'premium']);
  assert.deepEqual(first.payload.data[0].supported_endpoint_types, ['openai', 'responses']);
  assert.deepEqual(reorderedResult.payload, first.payload);
  assert.equal(reorderedResult.etag, first.etag);
  assert.notEqual(changedResult.etag, first.etag);
  assert.deepEqual(changedResult.payload.data[0].supported_endpoint_types, ['chat', 'openai']);
  assert.equal(changedResult.payload.vendors[0].name, 'Vendor A changed');
});

test('live pricing matches quoted, wildcard, strong, and weak validators correctly', async () => {
  const changedPricing = {
    ...livePricing,
    data: [{
      ...livePricing.data[0],
      model_ratio: 2,
    }],
    pricing_version: 'live-v2',
  };
  const validators = [];
  let requestCount = 0;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    validators.push(request.headers.get('if-none-match'));
    const payload = requestCount++ === 0 ? livePricing : changedPricing;
    return liveResponse(payload, 200, { etag: `"raw-${requestCount}"` });
  }));

  const initial = await adapter.getPricingResponse();
  const changed = await adapter.getPricingResponse({
    ifNoneMatch: '"old,*,tag"',
  });
  assert.equal(initial.status, 200);
  assert.equal(changed.status, 200);
  assert.notEqual(changed.etag, initial.etag);
  assert.equal(changed.payload.data[0].model_ratio, 2);

  const strong = await adapter.getPricingResponse({
    ifNoneMatch: changed.etag,
  });
  assert.deepEqual(strong, { status: 304, payload: null, etag: changed.etag });

  const weakValidator = `W/${changed.etag}`;
  const weakInList = await adapter.getPricingResponse({
    ifNoneMatch: `"unrelated", ${weakValidator}`,
  });
  assert.deepEqual(weakInList, {
    status: 304,
    payload: null,
    etag: changed.etag,
  });

  const wildcard = await adapter.getPricingResponse({ ifNoneMatch: '*' });
  assert.deepEqual(wildcard, {
    status: 304,
    payload: null,
    etag: changed.etag,
  });
  assert.deepEqual(validators, [
    null,
    '"old,*,tag"',
    changed.etag,
    `"unrelated", ${weakValidator}`,
    '*',
  ]);
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
    liveResponse({ success: false, message: 'document page not found' }, 404),
  ));
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404 && error.message === 'Document page not found.',
  );
});

test('live document 404 fails closed when its contract is missing', async () => {
  const privateBody = 'private backend details';
  const adapter = createContentAdapter(liveEnv(async () => new Response(privateBody, {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  })));
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) =>
      error instanceof HttpError &&
      error.status === 503 &&
      error.message === 'Live content is temporarily unavailable.' &&
      !JSON.stringify(error).includes(privateBody),
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

test('live adapter deadline covers a stalled response body and cancels its reader', async () => {
  let cancelled = false;
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"success":true'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const adapter = createLiveContentAdapter(liveEnv(async () =>
    new Response(stalled, {
      headers: {
        'content-type': 'application/json',
        'x-newapi-content-contract': 'v1',
      },
    }),
  ), { timeoutMs: 15 });
  await assert.rejects(
    () => adapter.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'upstream_timeout',
  );
  assert.equal(cancelled, true);
});

test('live Docs require the exact supported schema and renderer versions', async () => {
  assert.equal(LIVE_CONTENT_DOCS_SCHEMA_VERSION, 1);
  assert.equal(LIVE_CONTENT_DOCS_RENDERER_VERSION, 1);
  for (const kind of ['catalog', 'page']) {
    for (const field of ['schema_version', 'renderer_version']) {
      const data = kind === 'catalog'
        ? {
            meta: { ...liveMeta(true), [field]: 99 },
            sections: [],
            search_index: [],
          }
        : {
            meta: { ...liveMeta(true), [field]: 99 },
            page: {
              slug: 'quickstart',
              title: 'Quickstart',
              summary: 'Start here',
              section: 'Guides',
              keywords: [],
              updated_at: 1,
              blocks: [],
            },
          };
      const adapter = createLiveContentAdapter(liveEnv(async () => liveResponse({
        success: true,
        data,
      })));
      await assert.rejects(
        () => kind === 'catalog'
          ? adapter.getDocsCatalog()
          : adapter.getDocPage('quickstart'),
        (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
      );
    }
  }
});

test('live Docs preserve an empty heading text while retaining heading validation', async () => {
  const liveDocsSlug = 'page-1785606868894-3673ea8d4916890d';
  const emptyHeading = {
    type: 'heading',
    id: 'final-heading',
    level: 2,
    text: '',
  };
  const pagePayload = (block = emptyHeading) => ({
    success: true,
    data: {
      meta: liveMeta(true),
      page: {
        slug: liveDocsSlug,
        title: 'Live page',
        summary: 'Live page summary',
        section: 'Guides',
        keywords: [],
        updated_at: 1,
        blocks: [block],
      },
    },
  });

  const adapter = createLiveContentAdapter(liveEnv(async () => liveResponse(pagePayload())));
  const page = await adapter.getDocPage(liveDocsSlug);
  assert.deepEqual(page.page.blocks, [emptyHeading]);

  for (const invalidBlock of [
    { ...emptyHeading, text: undefined },
    { ...emptyHeading, text: 0 },
    { ...emptyHeading, level: 1 },
    { ...emptyHeading, level: 4 },
    { ...emptyHeading, id: '' },
    { ...emptyHeading, id: 123 },
    { ...emptyHeading, id: undefined },
  ]) {
    const invalid = createLiveContentAdapter(liveEnv(async () => liveResponse(pagePayload(invalidBlock))));
    await assert.rejects(
      () => invalid.getDocPage(liveDocsSlug),
      (error) =>
        error instanceof HttpError &&
        error.status === 503 &&
        error.details.reason === 'invalid_upstream_schema',
    );
  }
});

test('unknown fixture document slugs return 404', async () => {
  const adapter = createFixtureAdapter();
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
