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
    '.pricing-tax-note',
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
  assert.match(layout, /\.pricing-tax-note\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
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
  assert.match(canonical, /className: "pricing-tax-note"/);
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

test('Pricing group cards render the group name in the former discount-label slot', async () => {
  const [layout, canonical] = await sources;

  // The canonical renderer must not emit the retired blue discount node. The
  // comparison/savings data remains computed upstream for the surrounding
  // Pricing surfaces; only this card label is removed.
  assert.doesNotMatch(canonical, /className:\s*["']pricing-group-discount["']/);
  assert.match(canonical, /className:\s*["']pricing-group-name["']/);
  assert.match(canonical, /discount:\s*F/);
  assert.match(canonical, /pricePercent:\s*F\s*==\s*null\s*\?\s*null\s*:\s*F\s*\*\s*10/);
  assert.match(canonical, /className:\s*["']pricing-group-rate["']/);

  // The existing name node is enlarged to the former label's visual size and
  // aligned to the card's upper-right edge while retaining safe wrapping.
  assert.match(layout, /\.pricing-group-card \.pricing-group-name\s*\{[\s\S]*?font-size:\s*19px/);
  assert.match(layout, /\.pricing-group-card \.pricing-group-name\s*\{[\s\S]*?text-align:\s*right/);
  assert.match(layout, /\.pricing-group-card \.pricing-group-name\s*\{[\s\S]*?overflow-wrap:\s*anywhere/);
  assert.match(layout, /\.pricing-group-card \.pricing-group-name\s*\{[\s\S]*?white-space:\s*normal/);
});

test('in-card savings badge keeps a primary-blue, large, wrapping presentation contract', async () => {
  const [layout, canonical] = await sources;

  // The savings value is emitted by the canonical card comparison node. Keep
  // the assertion tied to that existing DOM seam so this remains a
  // presentation-only repair and cannot reintroduce the retired group badge.
  assert.match(canonical, /className:\s*`pricing-card-comparison is-\$\{de\.kind\}`/);
  assert.doesNotMatch(canonical, /pricing-group-discount/);
  assert.match(canonical, /pricing-card-comparison-price-prefix/);
  assert.match(canonical, /pricing-card-savings-badge/);
  assert.match(canonical, /pricing-group-price-prefix/);
  assert.match(canonical, /pricing-group-saving-badge/);

  const badgeRule = /body\.canonical-pricing-active \.pricing-card-comparison\.is-saving > strong\s*\{([\s\S]*?)\}/.exec(layout)?.[1] || '';
  assert.match(badgeRule, /display:\s*inline-flex/);
  assert.match(badgeRule, /color:\s*var\(--semi-color-primary\)\s*!important/);
  // 18px is the explicit lower bound: materially larger than the 13px
  // secondary treatment this companion stylesheet previously supplied.
  assert.match(badgeRule, /font-size:\s*clamp\(18px,/);
  assert.match(badgeRule, /max-width:\s*100%/);
  assert.match(badgeRule, /overflow-wrap:\s*anywhere/);
  assert.match(badgeRule, /word-break:\s*break-word/);
  assert.match(badgeRule, /white-space:\s*normal/);
  assert.match(badgeRule, /background:\s*var\(--semi-color-primary-light-default\)/);
  assert.match(layout, /pricing-card-comparison-price-prefix[\s\S]*?color:\s*var\(--semi-color-text-3\)\s*!important/);
  assert.match(layout, /pricing-group-saving-badge[\s\S]*?font-size:\s*clamp\(18px,/);
});

test('public Pricing initializes the canonical runtime in card view at every public breakpoint', async () => {
  const [_layout, canonical, app] = await sources;

  // The mounted NewAPI component owns view state. Keep this contract tied to
  // its initial state rather than a shell-side click or copied renderer.
  assert.match(canonical, /\[o, i\] = z\.useState\(\s*"card"\s*\)/);
  assert.match(canonical, /defaultViewMode:\s*"card"/);
  assert.match(canonical, /onClick:\s*\(\) => y\("table"\)/);
  assert.match(canonical, /onClick:\s*\(\) => y\("card"\)/);

  // Both public aliases mount this same canonical bundle and do not replace
  // its initial mode with a shell-side desktop table default.
  assert.match(app, /function isPricingPath\(path\)[\s\S]*?\/console\/pricing'[\s\S]*?'\/pricing'/);
  assert.match(app, /viewMode:\s*'card'/);
});
