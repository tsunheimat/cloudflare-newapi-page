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
const CANONICAL_DOCS_JS_URL = new URL('../public/static/docs-hub.js', import.meta.url);
const CANONICAL_DOCS_CSS_URL = new URL('../public/static/docs-hub.css', import.meta.url);

const sources = Promise.all([
  readFile(APP_URL, 'utf8'),
  readFile(STYLES_URL, 'utf8'),
  readFile(INDEX_URL, 'utf8'),
]);

test('Docs presentation carries the pinned NewAPI Hub hierarchy and reader states', async () => {
  const [app, styles] = await sources;
  const [docsBundle, docsStyles] = await Promise.all([
    readFile(CANONICAL_DOCS_JS_URL, 'utf8'),
    readFile(CANONICAL_DOCS_CSS_URL, 'utf8'),
  ]);
  assert.match(app, /renderCanonicalDocs/);
  assert.match(app, /docs-hub\.js/);
  assert.match(docsBundle, /\/api\/docs\/v2\/config/);
  assert.match(docsBundle, /credentials:"omit"/);
  assert.doesNotMatch(docsBundle, /New-API-User/);
  assert.doesNotMatch(docsBundle, /localStorage\.getItem\("user"\)/);
  for (const contract of [
    'docs-hub-shell',
    'docs-hub-sidebar',
    'docs-hub-canvas',
    'docs-block-renderer',
    'docs-hub-page-nav',
    'docs-hub-search-results',
    'docs-hub-mobile-bar',
  ]) {
    assert.ok(docsBundle.includes(contract), contract);
  }
  assert.match(docsBundle, /搜索标题、正文、接口路径…/);
  assert.match(docsBundle, /未找到匹配的文档/);
  assert.match(docsBundle, /docs-navigation-group-/);

  assert.match(docsStyles, /--docs-sidebar-width:\s*272px/);
  assert.match(docsStyles, /--docs-gutter:\s*clamp\(32px, 4vw, 48px\)/);
  assert.match(docsStyles, /--docs-canvas-max:\s*1000px/);
  assert.match(docsStyles, /@media \(max-width: 768px\)[\s\S]*?\.docs-hub-sidebar-wrap\.is-open/);
  assert.match(docsStyles, /\.docs-code-group\s*\{[\s\S]*?--docs-code-bg:\s*#0f1218/);
});

test('Docs compatibility alias maps root and nested console paths to the canonical runtime', async () => {
  const [app] = await sources;
  assert.match(app, /function isDocsPath\(path\)[\s\S]*?isConsoleDocsPath\(path\)/);
  assert.match(app, /function isConsoleDocsPath\(path\)[\s\S]*?path === '\/console\/docs'[\s\S]*?path\.startsWith\('\/console\/docs\/'\)/);
  assert.match(app, /function canonicalDocsPath\(path\)[\s\S]*?`\/docs\$\{path\.slice\('\/console\/docs'\.length\)\}`/);
  assert.match(app, /function canonicalizeDocsLocation\(\)[\s\S]*?window\.history\.replaceState[\s\S]*?window\.location\.search[\s\S]*?window\.location\.hash/);
  assert.match(app, /function installDocsHistoryNormalizer\(\)[\s\S]*?window\.history\[method\][\s\S]*?normalizeDocsHistoryUrl\(url\)/);
  assert.match(app, /function normalizeDocsHistoryUrl\(value\)[\s\S]*?canonicalDocsPath\(currentPath\)/);
  assert.match(app, /if \(isDocsPath\(path\)\)[\s\S]*?await renderCanonicalDocs\([^)]*\)/);
});

test('Docs route mapping keeps real spaces generic and resolves only the known legacy page alias', async () => {
  const [app] = await sources;
  for (const space of [
    'quickstart', 'api-reference', 'integrations', 'models',
    'console', 'billing', 'faq', 'changelog',
  ]) {
    assert.match(app, new RegExp(`['"]${space}['"]`));
  }
  assert.match(app, /LEGACY_QUICKSTART_PAGE_ALIASES\s*=\s*new Set\(\['tokenrouter'\]\)/);
  assert.match(app, /function canonicalDocsPageAlias\(path\)[\s\S]*?DOCS_SPACE_SLUGS\.has\(first\)[\s\S]*?return `\/docs\/quickstart\/\$\{segments\.join\('\/'\)\}`/);
});

test('Pricing presentation mounts one canonical runtime at both public URLs', async () => {
  const [app, _styles, index] = await sources;
  assert.match(index, /href="\/console\/pricing" data-link data-nav="pricing"/);
  assert.match(app, /function isPricingPath\(path\)[\s\S]*?\/console\/pricing'[\s\S]*?'\/pricing'/);
  assert.match(app, /renderCanonicalPricing/);
  assert.match(app, /canonical-pricing\.js/);
  assert.doesNotMatch(app, /legacyPricing|pricing-page-intro|renderPricingProviders/);
});

test('Downloads presentation is a workspace panel with the existing authority flows', async () => {
  const [app, styles, index] = await sources;
  assert.match(index, /href="\/downloads" data-link data-nav="downloads"/);
  assert.match(app, /WORKSPACE_SURFACES/);
  assert.match(app, /workspace-tabs/);
  assert.match(app, /workspace-panel--\$\{surface\.id\}/);
  assert.match(app, /function surfaceForPath\(path\)/);
  assert.match(app, /function isDownloadsPath\(path\)/);
  assert.match(app, /function downloadSoftwareId\(path\)/);
  assert.match(app, /class: 'downloads-back-link', href: '\/downloads', 'data-link'/);
  assert.match(app, /\/api\/downloads\/catalog/);
  assert.match(app, /\/downloads\/api\/\$\{encoded\}\/public/);
  assert.match(app, /\/downloads\/download\/\$\{encodeURIComponent\(softwareId\)\}/);
  assert.match(app, /JSON\.stringify\(metadata, null, 2\)/);
  assert.match(app, /暂无可用下载/);
  assert.match(app, /公开元数据暂时无法载入/);
  assert.match(styles, /\.downloads-file-grid/);
  assert.match(styles, /\.downloads-metadata-details/);
  assert.match(styles, /\.workspace-shell/);
  assert.match(styles, /\.workspace-panel\[hidden\]/);
  assert.doesNotMatch(styles, /body\.canonical-(?:docs|pricing)-active[^}]*display:\s*none/);
});
test('public Pricing route ships the canonical component bundle without browser auth', async () => {
  const [app, bundle, stylesheet] = await Promise.all([
    readFile(APP_URL, 'utf8'),
    readFile(CANONICAL_PRICING_JS_URL, 'utf8'),
    readFile(CANONICAL_PRICING_CSS_URL, 'utf8'),
  ]);
  assert.match(app, /path === '\/console\/pricing'/);
  assert.match(app, /renderCanonicalPricing/);
  assert.match(app, /__mountCanonicalPricing/);
  assert.match(bundle, /\/api\/pricing/);
  assert.doesNotMatch(bundle, /\/api\/front-door\/v1\/pricing/);
  assert.match(bundle, /dy\.get\("\/api\/status"/);
  assert.match(bundle, /Canonical NewAPI status bootstrap is unavailable/);
  assert.match(bundle, /statusResponse\.data\.data/);
  assert.match(bundle, /localStorage\.setItem\("status", JSON\.stringify\(statusResponse\.data\.data\)\)/);
  assert.match(bundle, /__mountCanonicalPricing/);
  assert.match(bundle, /__unmountCanonicalPricing/);
  assert.match(app, /cache: publicDocsNavigation \? 'no-store' : 'no-cache'/);
  assert.doesNotMatch(app, /const cacheKey = options\.publicDocsNavigation/);
  assert.doesNotMatch(app, /contentApiCache\.set\(cacheKey/);
  assert.doesNotMatch(bundle, /Lto = 3e4|class Hto|new Hto/);
  assert.match(bundle, /cache: "no-store"/);
  assert.match(bundle, /disableDuplicate: !0/);
  assert.match(bundle, /withCredentials: !1/);
  assert.match(bundle, /secureApi: !1/);
  assert.doesNotMatch(bundle, /"New-API-User": Wto\(\)/);
  assert.doesNotMatch(bundle, /localStorage\.getItem\("user"\)/);
  assert.doesNotMatch(bundle, /userId: _t|language: \$t/);
  assert.match(bundle, /Bto\.get\(\{\s*fetcher: async/);
  assert.ok(bundle.length > 1_000_000);
  assert.ok(stylesheet.includes('.pricing-page-shell'));
});

test('public Pricing language control preserves canonical labels and runtime seam', async () => {
  const [app, styles] = await sources;
  assert.match(app, /canonical-pricing-surface/);
  assert.match(app, /data-pricing-language-selector/);
  assert.match(app, /window\.__i18n/);
  assert.match(app, /i18n\.on\('languageChanged'/);
  assert.match(app, /localStorage\.setItem\('i18nextLng', language\)/);
  assert.match(app, /lower\.startsWith\('zh-hans'\)/);
  assert.match(app, /lower\.startsWith\('zh-hant'\)/);
  assert.doesNotMatch(app, /\/api\/user\/self/);
  assert.doesNotMatch(app, /writeScopedPreference|readScopedPreference/);
  for (const label of [
    '简体中文',
    '繁體中文',
    'English',
    'Français',
    '日本語',
    'Русский',
    'Tiếng Việt',
  ]) {
    assert.match(app, new RegExp(label));
  }
  assert.match(styles, /\.pricing-language-bar/);
  assert.match(styles, /\.pricing-language-menu/);
  assert.match(styles, /\.pricing-language-trigger\s*\{[\s\S]*?border:\s*0 transparent solid/);
  assert.match(styles, /\.pricing-language-option\s*\{[\s\S]*?padding:\s*6px 12px/);
  assert.match(styles, /@media \(max-width: 820px\)/);
});

test('architecture pricing contract preserves upstream ratios without a fixed substitute', async () => {
  const architecture = await readFile(ARCHITECTURE_URL, 'utf8');
  assert.match(architecture, /byte-for-byte/);
  assert.match(architecture, /future public fields remain unchanged/);
  assert.match(architecture, /does not add a\ncontext or display object/);
  assert.match(architecture, /token-only GET/);
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
  assert.doesNotMatch(app, /api\('\/api\/content\/pricing'\)/);
  assert.match(app, /NewAPI（canonical）/);
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
