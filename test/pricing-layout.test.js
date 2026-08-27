import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LAYOUT_URL = new URL('../public/static/canonical-pricing-layout.css', import.meta.url);
const CANONICAL_JS_URL = new URL('../public/static/canonical-pricing.js', import.meta.url);
const APP_URL = new URL('../public/static/app.js', import.meta.url);
const FIXTURE_URL = new URL('../src/fixtures/pricing.js', import.meta.url);

const sources = Promise.all([
  readFile(LAYOUT_URL, 'utf8'),
  readFile(CANONICAL_JS_URL, 'utf8'),
  readFile(APP_URL, 'utf8'),
]);
const fixtureSource = readFile(FIXTURE_URL, 'utf8');

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

test('customer pricing cards have a deterministic hierarchy at laptop and mobile widths', async () => {
  const [layout, canonical, app] = await sources;
  const fixture = await fixtureSource;

  // The card view is the canonical bundle's actual DOM seam. Keep the
  // selectors tied to that runtime so a future bundle cannot silently fall
  // back to a copied/fixture pricing renderer.
  for (const selector of [
    'pricing-model-card-header',
    'pricing-card-price-block',
    'pricing-card-price-row',
    'pricing-card-comparison',
    'pricing-card-comparison-formula',
    'pricing-dynamic-card-prices',
    'pricing-card-meta',
  ]) {
    assert.ok(canonical.includes(selector), selector);
  }

  // At the approximately 1042px customer viewport, cards retain a usable
  // minimum rather than becoming three narrow table-like columns.
  assert.match(layout, /\.pricing-card-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*380px\),\s*1fr\)/);
  assert.match(layout, /\.pricing-model-card\s*\{[\s\S]*?overflow:\s*hidden/);
  assert.match(layout, /\.pricing-model-card-header\s*>\s*\.flex\.items-start\s*\{[\s\S]*?grid-template-columns:\s*44px\s+minmax\(0,\s*1fr\)/);

  // Names/badges, primary values, unit labels, and comparison/formula copy
  // each have independent layout contracts; this prevents overlap without
  // changing any value supplied by NewAPI.
  assert.match(layout, /\.pricing-model-card-header[\s\S]*?\.pricing-model-name\s*\{[\s\S]*?flex:\s*1 1 100%/);
  assert.match(layout, /\.pricing-card-price-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(92px,\s*max-content\)\s+minmax\(0,\s*1fr\)/);
  assert.match(layout, /\.pricing-card-price-row\s+small\s*\{[\s\S]*?grid-column:\s*2/);
  assert.match(layout, /\.pricing-card-comparison\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/);
  assert.match(layout, /\.pricing-dynamic-card-prices\s+details\s*\{[\s\S]*?border-top:\s*1px dashed/);

  // Mobile is explicitly one card per row and keeps the same value hierarchy.
  assert.match(layout, /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pricing-card-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(layout, /@media\s*\(max-width:\s*767px\)[\s\S]*?\.pricing-card-price-row\s*\{[\s\S]*?minmax\(78px,\s*max-content\)/);

  // Exercise the contract against a realistic payload shape containing
  // mixed-language/long model names and a real dynamic billing expression.
  assert.match(fixture, /model_name:\s*'demo-tiered-context'/);
  assert.match(fixture, /billing_expr:\s*'/);
  assert.match(fixture, /custom_currency_symbol:/);
  assert.match(fixture, /supported_endpoint_types:/);
  assert.match(app, /lower\.startsWith\('zh-hans'\)/);
  assert.match(app, /lower\.startsWith\('zh-hant'\)/);
});
