import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LAYOUT_URL = new URL('../public/static/canonical-pricing-layout.css', import.meta.url);
const CANONICAL_JS_URL = new URL('../public/static/canonical-pricing.js', import.meta.url);
const APP_URL = new URL('../public/static/app.js', import.meta.url);

const sources = Promise.all([
  readFile(LAYOUT_URL, 'utf8'),
  readFile(CANONICAL_JS_URL, 'utf8'),
  readFile(APP_URL, 'utf8'),
]);

test('English Pricing layout contract wraps translated labels within the canonical panel', async () => {
  const [layout] = await sources;

  // These selectors are the JuAPI canonical bundle selectors, not copied
  // NewAPI paths. Keep this list deterministic as a regression contract.
  for (const selector of [
    '.pricing-vendor-chip > span:nth-child(2)',
    '.pricing-vendor-name',
    '.pricing-group-name',
    '.pricing-model-name',
    '.pricing-model-vendor',
  ]) {
    assert.ok(layout.includes(selector), selector);
  }
  for (const property of ['overflow-wrap: anywhere', 'word-break: break-word', 'white-space: normal']) {
    assert.match(layout, new RegExp(property.replace(/[ :]/g, '\\$&')), property);
  }

  for (const selector of [
    '.pricing-search-actions',
    '.pricing-toolbar-actions',
    '.pricing-price-list-title-row',
    '.pricing-comparison-cell',
    '.pricing-save-badge',
    '.sbg-badge',
    '.pricing-native-tier-cell',
    '.pricing-tier-extra-label',
  ]) {
    assert.ok(layout.includes(selector), selector);
  }
  assert.match(layout, /\.pricing-search-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(layout, /\.pricing-toolbar-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(layout, /@media\s*\(max-width:\s*767px\)/);
  assert.match(layout, /\.pricing-price-list-title-row[\s\S]*?flex-wrap:\s*wrap/);
});

test('layout companion is presentation-only and keeps canonical Pricing authority', async () => {
  const [layout, canonical, app] = await sources;
  assert.match(layout, /b83a0ae06e1fb9735e0cd0be3c9bdd8807cff66b/);
  assert.match(app, /href: '\/static\/canonical-pricing\.css'/);
  assert.match(app, /href: '\/static\/canonical-pricing-layout\.css'/);
  assert.match(app, /data-canonical-pricing-layout-css/);
  assert.match(app, /canonicalPricingLayoutStyles[\s\S]*?disabled = !canonicalPricing/);
  assert.match(app, /canonicalPricingScriptPromise/);
  assert.match(canonical, /__mountCanonicalPricing/);
  assert.match(canonical, /\/api\/pricing/);
  assert.match(app, /function createPricingLanguageSelector/);
  // No formula/data source is introduced by this companion stylesheet.
  assert.doesNotMatch(layout, /group_ratio|quota_type|billing_expr|fixture|hardcode/i);
});
