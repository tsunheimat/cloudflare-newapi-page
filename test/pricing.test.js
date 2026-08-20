import assert from 'node:assert/strict';
import test from 'node:test';

import { pricingFixture } from '../src/fixtures/pricing.js';
import {
  BILLING_EXPR_CONTRACT,
  BILLING_VARIABLES,
  assertOrdinaryPricingPayload,
  calculateModelPricing,
  convertPricingDisplayValue,
  getOrdinaryUserModels,
  isVideoBillingModel,
  normalizeSourcePriceToUSD,
  parseBillingExpression,
} from '../public/static/pricing.js';

const cloneFixture = () => structuredClone(pricingFixture);

test('public pricing payload is locked to a finite ordinary default/default context', () => {
  const payload = cloneFixture();
  assert.equal(assertOrdinaryPricingPayload(payload), payload);
  assert.equal(payload.context.user_group, 'default');
  assert.equal(payload.context.selected_group, 'default');
  assert.equal(payload.context.locked, true);

  payload.context.selected_group = 'premium';
  assert.throws(() => assertOrdinaryPricingPayload(payload), /default\/default/);

  for (const invalidRatio of [-1, Number.POSITIVE_INFINITY, Number.NaN, '']) {
    const invalid = cloneFixture();
    invalid.group_ratio.default = invalidRatio;
    assert.throws(
      () => assertOrdinaryPricingPayload(invalid),
      /finite and non-negative/,
    );
  }
});

test('ordinary user model filtering follows NewAPI enable_groups semantics', () => {
  const payload = cloneFixture();
  payload.data.push(
    {
      model_name: 'empty-is-universal',
      enable_groups: [],
      quota_type: 1,
      model_price: 1,
    },
    {
      model_name: 'premium-only',
      enable_groups: ['premium'],
      quota_type: 1,
      model_price: 1,
    },
  );
  const names = getOrdinaryUserModels(payload).map((model) => model.model_name);
  assert.ok(names.includes('empty-is-universal'));
  assert.ok(!names.includes('premium-only'));
});

test('per-token pricing uses model ratio, the real default ratio, and shared conversion', () => {
  const payload = cloneFixture();
  const model = payload.data.find((item) => item.model_name === 'demo-chat-standard');
  const pricing = calculateModelPricing(model, payload, {
    currency: 'CNY',
    tokenUnit: 'M',
  });

  assert.equal(pricing.kind, 'per_token');
  assert.equal(pricing.availability, 'available');
  assert.equal(pricing.group, 'default');
  assert.equal(pricing.groupRatio, 1.25);
  assert.equal(pricing.pricesUSD.input, 1.25);
  assert.equal(pricing.pricesUSD.output, 5);
  assert.equal(pricing.pricesUSD.cacheRead, 0.125);
  assert.equal(pricing.items.find((item) => item.key === 'input').value, 9);
  assert.equal(pricing.items.find((item) => item.key === 'output').value, 36);
});

test('per-token K display divides only after the shared currency conversion', () => {
  const payload = cloneFixture();
  const model = payload.data.find((item) => item.model_name === 'demo-chat-standard');
  const pricing = calculateModelPricing(model, payload, {
    currency: 'USD',
    tokenUnit: 'K',
    show_with_recharge: false,
  });
  assert.equal(pricing.items.find((item) => item.key === 'input').value, 0.00125);
  assert.equal(pricing.unit, '1K tokens');
});

test('per-request pricing applies the selected default group ratio', () => {
  const payload = cloneFixture();
  payload.group_ratio.default = 1.5;
  const model = payload.data.find((item) => item.model_name === 'demo-image-request');
  const pricing = calculateModelPricing(model, payload, {
    currency: 'USD',
    show_with_recharge: false,
  });
  assert.equal(pricing.kind, 'per_request');
  assert.equal(pricing.pricesUSD.request, 0.12);
});

test('invalid ordinary model fields are explicitly unavailable instead of partially priced', () => {
  const payload = cloneFixture();
  const model = payload.data.find((item) => item.model_name === 'demo-chat-standard');
  model.completion_ratio = 'future';
  const pricing = calculateModelPricing(model, payload, { currency: 'USD' });
  assert.equal(pricing.availability, 'unavailable');
  assert.equal(pricing.unavailableCode, 'invalid_model_ratio');
  assert.equal('pricesUSD' in pricing, false);
  assert.deepEqual(pricing.items, []);
});

test('billing variable registry matches the NewAPI v1 pricing variables', () => {
  assert.deepEqual(
    BILLING_VARIABLES.map(({ key }) => key),
    ['p', 'c', 'cr', 'cc', 'cc1h', 'img', 'img_o', 'ai', 'ao'],
  );
});

test('tier parser accepts complete v1 multiplication grammar and every registered field', () => {
  const parsed = parseBillingExpression(
    'v1:tier("base", p * 3 + c * 15 + cr * 0.3 + cc * 3.75 + cc1h * 6 + img * 2 + img_o * 4 + ai * 5 + ao * 10)',
  );
  assert.equal(parsed.contract, BILLING_EXPR_CONTRACT);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.complete, true);
  assert.deepEqual(parsed.tiers[0].pricesUSD, {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheCreate: 3.75,
    cacheCreate1h: 6,
    image: 2,
    imageOutput: 4,
    audioInput: 5,
    audioOutput: 10,
  });
});

test('tier parser preserves ternary tiers and the documented request-rule suffix', () => {
  const model = cloneFixture().data.find(
    (item) => item.model_name === 'demo-tiered-context',
  );
  const parsed = parseBillingExpression(model.billing_expr);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.conditional, true);
  assert.equal(parsed.tiers.length, 2);
  assert.equal(parsed.tiers[0].condition, 'len <= 32000');
  assert.equal(parsed.tiers[0].pricesUSD.cacheCreate1h, 4);
  assert.equal(parsed.tiers[0].pricesUSD.imageOutput, 5);
  assert.equal(parsed.tiers[1].condition, 'otherwise(len <= 32000)');
  assert.equal(parsed.requestRule.multiplier, 2);
  assert.match(parsed.requestRule.condition, /x-priority/);
});

test('one unknown field in any tier rejects the whole expression without partial tiers', () => {
  const parsed = parseBillingExpression(
    'len <= 10 ? tier("known", p * 3 + c * 15) : tier("future", p * 4 + new_var * 9)',
  );
  assert.equal(parsed.complete, false);
  assert.equal(parsed.errorCode, 'unsupported_expression');
  assert.deepEqual(parsed.tiers, []);
});

test('unknown versions and malformed request suffixes fail closed', () => {
  const unknownVersion = parseBillingExpression(
    'v2:tier("base", p * 3 + c * 15)',
  );
  assert.equal(unknownVersion.complete, false);
  assert.equal(unknownVersion.errorCode, 'unsupported_version');

  const malformedSuffix = parseBillingExpression(
    'tier("base", p * 3 + c * 15)|||future_rule()',
  );
  assert.equal(malformedSuffix.complete, false);
  assert.equal(malformedSuffix.errorCode, 'invalid_request_rule');
  assert.deepEqual(malformedSuffix.tiers, []);
});

test('tiered calculation never promotes the first tier to a complete model price', () => {
  const payload = cloneFixture();
  const model = payload.data.find((item) => item.model_name === 'demo-tiered-context');
  const pricing = calculateModelPricing(model, payload, {
    currency: 'USD',
    tokenUnit: 'M',
    show_with_recharge: false,
  });
  assert.equal(pricing.kind, 'tiered_expr');
  assert.equal(pricing.availability, 'context_required');
  assert.equal(pricing.parseComplete, true);
  assert.equal(pricing.tiers.length, 2);
  assert.equal(pricing.tiers[0].pricesUSD.input, 1);
  assert.equal(pricing.tiers[0].pricesUSD.output, 4);
  assert.deepEqual(pricing.items, []);
  assert.equal('pricesUSD' in pricing, false);
});

test('unparseable tier expressions stay unavailable and never fall back to legacy fields', () => {
  const payload = cloneFixture();
  const model = {
    model_name: 'opaque-dynamic',
    enable_groups: ['default'],
    billing_mode: 'tiered_expr',
    billing_expr: 'v1:tier("base", p * 3 + future * 9)',
    quota_type: 1,
    model_price: 999,
  };
  const pricing = calculateModelPricing(model, payload, { currency: 'USD' });
  assert.equal(pricing.kind, 'tiered_expr');
  assert.equal(pricing.availability, 'unavailable');
  assert.equal(pricing.parseComplete, false);
  assert.deepEqual(pricing.tiers, []);
  assert.equal('pricesUSD' in pricing, false);
});

test('currency conversion follows NewAPI recharge/display order for USD, CNY, and CUSTOM', () => {
  const cases = [
    { currency: 'USD', applyRecharge: false, expected: 2 },
    { currency: 'CNY', applyRecharge: false, expected: 14.4 },
    { currency: 'CUSTOM', applyRecharge: false, expected: 10 },
    { currency: 'USD', applyRecharge: true, expected: 2 * (6 / 7.2) },
    { currency: 'CNY', applyRecharge: true, expected: 12 },
    { currency: 'CUSTOM', applyRecharge: true, expected: 2 * (6 / 7.2) * 5 },
  ];
  for (const current of cases) {
    assert.equal(
      convertPricingDisplayValue({
        usdPrice: 2,
        currency: current.currency,
        priceRate: 6,
        usdExchangeRate: 7.2,
        customExchangeRate: 5,
        applyRecharge: current.applyRecharge,
      }),
      current.expected,
      `${current.currency} recharge=${current.applyRecharge}`,
    );
  }
  assert.equal(
    convertPricingDisplayValue({
      usdPrice: 2,
      currency: 'CUSTOM',
      customExchangeRate: 0,
    }),
    2,
  );
});

test('video card and resolution rows share display semantics across all currencies and recharge modes', () => {
  const cases = [
    { currency: 'USD', recharge: false, expected: 1.5, symbol: '$' },
    { currency: 'CNY', recharge: false, expected: 10.8, symbol: '¥' },
    { currency: 'CUSTOM', recharge: false, expected: 7.5, symbol: '¤' },
    { currency: 'USD', recharge: true, expected: 1.25, symbol: '$' },
    { currency: 'CNY', recharge: true, expected: 9, symbol: '¥' },
    { currency: 'CUSTOM', recharge: true, expected: 6.25, symbol: '¤' },
  ];

  for (const current of cases) {
    const payload = cloneFixture();
    payload.group_ratio.default = 1.5;
    payload.display.price = 6;
    payload.display.custom_currency_exchange_rate = 5;
    const model = payload.data.find(
      (item) => item.model_name === 'demo-video-generation',
    );
    assert.equal(isVideoBillingModel(model), true);
    const pricing = calculateModelPricing(model, payload, {
      currency: current.currency,
      show_with_recharge: current.recharge,
    });
    assert.equal(pricing.availability, 'available');
    assert.equal(pricing.sourceCurrency, 'CNY');
    assert.equal(pricing.rows[0].withoutVideo.usdPrice, 1.5);
    assert.equal(pricing.rows[0].withoutVideo.value, current.expected);
    assert.equal(pricing.items[0].value, current.expected);
    assert.ok(pricing.rows[0].withoutVideo.formatted.startsWith(current.symbol));
    assert.equal(pricing.rows[0].dimensions, '1280×720');
  }
});

test('video source currency normalization preserves CNY/USD profile distinction', () => {
  assert.equal(
    normalizeSourcePriceToUSD({
      sourcePrice: 7.2,
      sourceCurrency: 'CNY',
      usdExchangeRate: 7.2,
    }),
    1,
  );
  assert.equal(
    normalizeSourcePriceToUSD({
      sourcePrice: 7.2,
      sourceCurrency: 'USD',
      usdExchangeRate: 7.2,
    }),
    7.2,
  );

  const payload = cloneFixture();
  const model = payload.data.find(
    (item) => item.model_name === 'demo-video-generation',
  );
  model.video_pricing.currency = 'USD';
  model.video_pricing.resolution_rates['720p'].without_video = 2;
  const pricing = calculateModelPricing(model, payload, {
    currency: 'USD',
    show_with_recharge: false,
  });
  assert.equal(pricing.sourceCurrency, 'USD');
  assert.equal(pricing.rows[0].withoutVideo.sourcePrice, 2);
  assert.equal(pricing.rows[0].withoutVideo.usdPrice, 1.25);
});

test('an incomplete video matrix fails closed instead of using the remaining rows', () => {
  const payload = cloneFixture();
  const model = payload.data.find(
    (item) => item.model_name === 'demo-video-generation',
  );
  delete model.video_pricing.resolution_rates['1080p'].with_video;
  const pricing = calculateModelPricing(model, payload, { currency: 'USD' });
  assert.equal(pricing.kind, 'video');
  assert.equal(pricing.availability, 'unavailable');
  assert.equal(pricing.unavailableCode, 'invalid_video_profile');
  assert.deepEqual(pricing.rows, []);
  assert.equal('pricesUSD' in pricing, false);
});
