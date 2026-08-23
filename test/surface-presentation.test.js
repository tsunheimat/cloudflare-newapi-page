import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const APP_URL = new URL('../public/static/app.js', import.meta.url);
const STYLES_URL = new URL('../public/static/styles.css', import.meta.url);
const INDEX_URL = new URL('../public/index.html', import.meta.url);
const LICENSE_URL = new URL('../LICENSE', import.meta.url);
const NOTICE_URL = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);
const PACKAGE_URL = new URL('../package.json', import.meta.url);
const ARCHITECTURE_URL = new URL('../docs/architecture.md', import.meta.url);
const CANONICAL_PRICING_JS_URL = new URL('../public/static/canonical-pricing.js', import.meta.url);
const CANONICAL_PRICING_CSS_URL = new URL('../public/static/canonical-pricing.css', import.meta.url);

const sources = Promise.all([
  readFile(APP_URL, 'utf8'),
  readFile(STYLES_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
]);

test('Docs presentation carries the pinned NewAPI Hub hierarchy and reader states', async () => {
  const [app, styles] = await sources;

  assert.match(app, /canonical React bundle built from approved NewAPI commit/);
  assert.match(app, /85143bc49260f9c7ab1efd6a5122558e58d0bee2/);
  for (const contract of [
    "class: 'newapi-surface docs-hub-shell'",
    "class: 'docs-hub-sidebar'",
    "class: 'docs-hub-canvas'",
    "class: 'docs-block-renderer'",
    "class: 'docs-hub-page-nav'",
    "class: 'docs-hub-search-results'",
    "class: 'docs-hub-mobile-bar'",
  ]) {
    assert.ok(app.includes(contract), contract);
  }
  assert.match(app, /\(event\.metaKey \|\| event\.ctrlKey\)/);
  assert.match(app, /搜索标题、正文、接口路径…/);
  assert.match(app, /未找到匹配的文档/);
  assert.match(app, /catalog\.search_index/);
  assert.match(app, /if \(headings\.length > 0\)/);
  assert.match(app, /docsNavigationSlug\(catalog\)/);
  assert.match(app, /docsPath\(slug\)/);
  assert.match(app, /front-door\/v1\/docs\/v2\/navigation\?locale=zh/);
  assert.match(app, /renderDocsNavigationNodes/);
  assert.match(app, /item\?\.type === 'group'/);
  assert.match(app, /item\.children/);
  assert.match(app, /return slug \? `\/docs\/\$\{encodeURIComponent\(slug\)\}` : '\/docs';/);
  assert.doesNotMatch(app, /encodeURIComponent\(slug \|\| DEFAULT_DOCS_SLUG\)/);
  assert.doesNotMatch(app, /replaceState\(window\.history\.state, '', '\/docs\/quickstart'\)/);

  assert.match(styles, /--docs-sidebar-width:\s*272px/);
  assert.match(styles, /--docs-gutter:\s*clamp\(32px, 4vw, 48px\)/);
  assert.match(styles, /--docs-canvas-max:\s*1000px/);
  assert.match(styles, /@media \(min-width: 1560px\)[\s\S]*?\.docs-hub-toc/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*?\.docs-hub-sidebar-wrap\.is-open/);
  assert.match(styles, /\.docs-code-group\s*\{[\s\S]*?--docs-code-bg:\s*#0f1218/);
});

test('Pricing presentation reuses canonical session groups, fields, and both compatible routes', async () => {
  const [app, styles, index] = await sources;

  for (const contract of [
    "class: 'newapi-surface pricing-page-shell'",
    "class: 'pricing-page-intro'",
    "class: 'pricing-provider-section'",
    "class: 'pricing-rule-inline'",
    "class: 'pricing-price-list-card'",
    "class: 'pricing-comparison-toolbar'",
    "class: 'pricing-model-table'",
    "class: 'pricing-card-grid'",
  ]) {
    assert.ok(app.includes(contract), contract);
  }

  assert.match(index, /href="\/console\/pricing" data-link data-nav="pricing"/);
  assert.match(app, /path === '\/console\/pricing' \|\| path === '\/pricing'/);
  assert.match(app, /renderCanonicalPricing/);
  assert.match(app, /canonical-pricing\.js/);
  assert.match(app, /card\.setAttribute\('data-pricing-group', group\)/);
  assert.match(app, /card\.disabled = true/);
  assert.match(app, /data-user-group/);
  assert.match(app, /data-selected-group/);
  assert.match(app, /data-group-locked/);
  assert.match(app, /front-door\/v1\/pricing/);
  assert.match(app, /payload\.context\.user_group/);
  assert.match(app, /payload\.context\.selected_group/);
  assert.match(app, /payload\.context\.locked/);
  assert.match(app, /price\.items\.forEach/);
  assert.doesNotMatch(app, /price\.items\.slice\(0, 4\)/);
  assert.match(app, /detail\.method/);
  assert.match(app, /detail\.path/);
  assert.match(app, /\['group', '分组价格'\]/);
  assert.match(app, /\['official', '官方价格'\]/);
  assert.match(app, /\['table', '表格视图', 'table'\]/);
  assert.match(app, /\['card', '卡片视图', 'grid'\]/);
  assert.match(app, /openPricingFilterModal\(payload, filter\)/);
  assert.match(app, /class: 'pricing-filter-modal-body'/);
  assert.match(app, /class: 'pricing-filter-modal-footer'/);
  assert.match(app, /data-pricing-filter-group', state\.selectedGroup/);

  assert.match(styles, /\.pricing-page-container\s*\{[\s\S]*?1500px/);
  assert.match(styles, /\.pricing-vendor-list\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.match(styles, /\.pricing-group-card\.is-locked/);
  assert.match(styles, /\.pricing-filter-modal-body\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /\.pricing-card-grid\s*\{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*?\.pricing-card-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('authenticated Pricing route ships the canonical component bundle without a fixture fallback', async () => {
  const [app, bundle, stylesheet] = await Promise.all([
    readFile(APP_URL, 'utf8'),
    readFile(CANONICAL_PRICING_JS_URL, 'utf8'),
    readFile(CANONICAL_PRICING_CSS_URL, 'utf8'),
  ]);
  assert.match(app, /path === '\/console\/pricing'/);
  assert.match(app, /renderCanonicalPricing/);
  assert.match(app, /__mountCanonicalPricing/);
  assert.match(bundle, /\/api\/front-door\/v1\/pricing/);
  assert.match(bundle, /dy\.get\("\/api\/status"/);
  assert.match(bundle, /Canonical NewAPI status bootstrap is unavailable/);
  assert.match(bundle, /statusResponse\.data\.data/);
  assert.match(bundle, /localStorage\.setItem\("status", JSON\.stringify\(statusResponse\.data\.data\)\)/);
  assert.match(bundle, /__mountCanonicalPricing/);
  assert.match(bundle, /__unmountCanonicalPricing/);
  assert.ok(bundle.length > 1_000_000);
  assert.ok(stylesheet.includes('.pricing-page-shell'));
});

test('architecture pricing contract preserves upstream ratios without a fixed substitute', async () => {
  const architecture = await readFile(ARCHITECTURE_URL, 'utf8');

  assert.match(architecture, /finite、non-negative/);
  assert.match(architecture, /适配器保留 NewAPI 的 group ratios[\s\S]*原值/);
  assert.match(architecture, /hard-code[\s\S]*normalize、clamp、[\s\S]*substitute/);
  assert.match(architecture, /group_ratio\.default\s+=\s+finite non-negative upstream default value/);
  assert.match(architecture, /group_ratio\.\*\s+=\s+NewAPI upstream public map unchanged/);
  assert.doesNotMatch(architecture, /group_ratio\.default\s*=\s*\d/);
});

test('front-door home/header remain present and content calls stay API-relative', async () => {
  const [app, _styles, index] = await sources;

  assert.match(index, /<header class="site-header">/);
  assert.match(index, /src="\/brand\/juapi-logo\.png"[\s\S]*?alt="JuAPI"/);
  assert.match(index, /class="brand-logo brand-logo--dark"/);
  assert.match(index, /<span class="nav-phase">Phase 2<\/span>/);
  assert.match(app, /把接口能力，变成清晰的开发体验。/);
  assert.match(app, /PHASE 2 DEPLOYMENT BOUNDARY/);
  assert.doesNotMatch(app, /node\('main'/, 'route renderers must not nest a second main landmark');

  assert.match(app, /api\('\/api\/content\/docs'\)/);
  assert.match(app, /api\('\/api\/content\/pricing'\)/);
  assert.match(app, /contentStatus\(payload\.meta\)/);
  assert.match(app, /loadContentSurfaces\(\)/);
  assert.doesNotMatch(app, /官方价格为 fixture 中配置/);
  assert.doesNotMatch(app, /内容仍是 fixture/);
  assert.doesNotMatch(app, /group_ratio:\s*\{\s*\.\.\.payload\.group_ratio,\s*default:\s*1\s*\}/);
  assert.doesNotMatch(app, /const official = 10/);
  assert.doesNotMatch(app, /fetch\(['"]https?:\/\//);
  assert.doesNotMatch(app, /newapi\.(?:internal|local)|tunnel|vpc/i);
});

test('adapted surfaces retain QuantumNous attribution and the complete AGPL license', async () => {
  const [license, notice, packageSource] = await Promise.all([
    readFile(LICENSE_URL, 'utf8'),
    readFile(NOTICE_URL, 'utf8'),
    readFile(PACKAGE_URL, 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);

  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(license, /Version 3, 19 November 2007/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(notice, /copyright \(C\) 2025 QuantumNous/i);
  assert.match(notice, /85143bc49260f9c7ab1efd6a5122558e58d0bee2/);
  assert.equal(packageJson.license, 'AGPL-3.0-or-later');
});
