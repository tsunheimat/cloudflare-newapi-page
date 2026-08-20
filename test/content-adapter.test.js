import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertOrdinaryUserPricingContext,
  createContentAdapter,
  createFixtureAdapter,
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
    () => createContentAdapter({ CONTENT_ADAPTER: 'newapi' }),
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
    group_ratio: { default: 1 },
    usable_group: { default: '普通用户' },
  };
  assert.equal(assertOrdinaryUserPricingContext(base), base);

  for (const invalid of [
    { ...base, context: { ...base.context, user_group: 'vip' } },
    { ...base, context: { ...base.context, selected_group: 'vip' } },
    { ...base, context: { ...base.context, locked: false } },
    { ...base, group_ratio: {} },
    { ...base, group_ratio: { default: -1 } },
    { ...base, group_ratio: { default: Number.POSITIVE_INFINITY } },
    { ...base, group_ratio: { default: Number.NaN } },
    { ...base, usable_group: {} },
  ]) {
    assert.throws(() => assertOrdinaryUserPricingContext(invalid), HttpError);
  }
});

test('unknown fixture document slugs return 404', async () => {
  const adapter = createFixtureAdapter();
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
