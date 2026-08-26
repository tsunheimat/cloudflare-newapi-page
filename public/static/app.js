/*
Copyright (C) 2025 QuantumNous

The Docs compatibility renderer in this file adapts the user-facing NewAPI
SPA. The public `/console/pricing` surface is mounted from the
canonical React bundle built from approved NewAPI commit
85143bc49260f9c7ab1efd6a5122558e58d0bee2. These adapted assets remain licensed
under GNU AGPL v3 or later; see LICENSE and THIRD_PARTY_NOTICES.md. The
front-door home and header renderer are original to this Worker.
*/
import {
  contentStatus,
  docsNavigationSlug,
} from './content-meta.js';
import { createDocsAwareShellNavigator } from './docs-lifecycle.js';

const PRICING_MOBILE_QUERY = '(max-width: 767px)';
const THEME_STORAGE_KEY = 'juapi-theme';
const PRICING_GROUP_DATA_ATTRIBUTE = ['data', 'pricing', 'group'].join('-');
const pricingMobileMedia = window.matchMedia?.(PRICING_MOBILE_QUERY) || null;
// Keep this list aligned with the pinned NewAPI header LanguageSelector. The
// canonical bundle owns all translations; the Worker shell only supplies the
// missing public control that invokes its i18n instance.
const CANONICAL_PRICING_LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'ja', label: '日本語' },
  { value: 'ru', label: 'Русский' },
  { value: 'vi', label: 'Tiếng Việt' },
];

const state = {
  docsCatalog: null,
  integration: null,
  downloadCatalog: null,
  docsQuery: '',
  pricingQuery: '',
  vendor: '',
  selectedGroup: '',
  billing: 'all',
  endpoint: 'all',
  tag: 'all',
  currency: 'CNY',
  tokenUnit: 'M',
  showWithRecharge: true,
  pricingMode: 'group',
  viewMode: pricingMobileMedia?.matches ? 'card' : 'table',
  advancedFiltersOpen: false,
};

const main = document.querySelector('#main-content');
let activeDocsSearchButton = null;
let activeDocsTocObserver = null;
let surfaceReturnFocus = null;
let activeSurfaceDismiss = null;
// Public Docs navigation is fetched afresh and is never retained in browser
// memory or validators. Pricing is owned by the canonical bundle.
const contentApiCache = new Map();
let canonicalPricingScriptPromise = null;
let canonicalDocsScriptPromise = null;
let canonicalDocsMounted = false;
let canonicalDocsRoot = null;
let docsHistoryNormalizerInstalled = false;
let pricingLanguageBinding = null;
let pricingLanguageMenuId = 0;

// The live Docs contract has spaces, while the old public URL exposed a few
// page slugs directly below /docs. Keep the compatibility list deliberately
// finite: an arbitrary first path segment must never be guessed to be a page,
// because it may be a real Docs space in the live navigation.
const DOCS_SPACE_SLUGS = new Set([
  'quickstart',
  'api-reference',
  'integrations',
  'models',
  'console',
  'billing',
  'faq',
  'changelog',
]);
const LEGACY_QUICKSTART_PAGE_ALIASES = new Set(['tokenrouter']);

// The mounted DocsHub owns its own React Router history. Intercept only
// same-origin history writes so links emitted by that runtime receive the
// same finite alias mapping as the Worker shell and browser popstate path.
// Non-Docs routes, external URLs, and unknown Docs segments are untouched.
installDocsHistoryNormalizer();

const navigate = createDocsAwareShellNavigator({
  windowObject: window,
  isDocsPath,
  isCanonicalDocsMounted: () => canonicalDocsMounted,
  renderRoute,
});

window.addEventListener('popstate', () => {
  canonicalizeDocsLocation();
  renderRoute();
});
pricingMobileMedia?.addEventListener('change', handlePricingViewportChange);
document.addEventListener('keydown', (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'k' &&
    activeDocsSearchButton?.isConnected &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    activeDocsSearchButton.click();
  }
  if (event.key === 'Escape') {
    dismissSurfaceOverlay();
    closeAllPricingLanguageMenus();
  }
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('[data-pricing-language-selector]')) {
    closeAllPricingLanguageMenus();
  }
  const link = event.target.closest('a[data-link]');
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
  const target = new URL(link.href, window.location.href);
  if (target.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(`${target.pathname}${target.search}`);
});

installThemeToggle();
renderRoute();

/*
`theme.js` has already resolved and applied the theme before first paint. This
only owns the toggle itself, and keeps following the OS while the visitor has
not made an explicit choice.
*/
function installThemeToggle() {
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');
  const syncPressedState = () => {
    toggle?.setAttribute(
      'aria-pressed',
      String(root.getAttribute('data-theme') === 'dark'),
    );
  };

  toggle?.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    root.setAttribute('data-theme-source', 'user');
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private-mode storage denial must not break the toggle itself.
    }
    syncPressedState();
  });

  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener('change', (event) => {
      if (root.getAttribute('data-theme-source') === 'user') return;
      root.setAttribute('data-theme', event.matches ? 'dark' : 'light');
      syncPressedState();
    });

  syncPressedState();
}

function handlePricingViewportChange() {
  if (!isPricingPath(normalizePath(window.location.pathname))) return;
  closeSurfaceOverlay({ restoreFocus: false });
  void renderPricing();
}

async function renderRoute() {
  const path = canonicalizeDocsLocation();
  const canonicalDocs = isDocsPath(path);
  if (!canonicalDocs) deactivateCanonicalDocs();
  const canonicalPricing = isPricingPath(path);
  document.body.classList.toggle('canonical-pricing-active', canonicalPricing);
  const canonicalStyles = document.querySelector('link[data-canonical-pricing-css]');
  if (canonicalStyles) canonicalStyles.disabled = !canonicalPricing;
  if (!canonicalPricing) {
    globalThis.__unmountCanonicalPricing?.();
    unbindPricingLanguageSelector();
  }
  activeDocsSearchButton = null;
  activeDocsTocObserver?.disconnect();
  activeDocsTocObserver = null;
  closeSurfaceOverlay();
  updateActiveNavigation(path);
  main.setAttribute('aria-busy', 'true');

  try {
    if (isDocsPath(path)) {
      await renderCanonicalDocs();
      return;
    }
    if (path === '/') {
      await renderHome();
    } else if (isPricingPath(path)) {
      await renderPricing();
    } else if (isDownloadsPath(path)) {
      await renderDownloads(path);
    } else {
      await ensureDocsCatalog();
      renderNotFound();
    }
  } catch (error) {
    renderError(error);
  } finally {
    main.removeAttribute('aria-busy');
  }
}

async function renderCanonicalDocs() {
  document.body.classList.add('canonical-docs-active', 'docs-hub-worker-body');
  document.body.classList.remove('canonical-pricing-active');
  const canonicalStyles = document.querySelector('link[data-canonical-docs-css]') || node('link', {
    rel: 'stylesheet',
    href: '/static/docs-hub.css',
    'data-canonical-docs-css': '',
  });
  if (!canonicalStyles.isConnected) document.head.append(canonicalStyles);

  if (canonicalDocsMounted && canonicalDocsRoot?.isConnected) {
    document.title = '文档';
    return;
  }
  if (!canonicalDocsRoot) canonicalDocsRoot = node('div', { id: 'root' });
  main.replaceChildren(canonicalDocsRoot);
  if (!canonicalDocsScriptPromise) {
    canonicalDocsScriptPromise = import('./docs-hub.js');
  }
  await canonicalDocsScriptPromise;
  canonicalDocsMounted = true;
  document.title = '文档';
}

function deactivateCanonicalDocs() {
  if (
    !canonicalDocsMounted
    && !canonicalDocsRoot?.isConnected
    && !document.body.classList.contains('canonical-docs-active')
  ) return;
  canonicalDocsRoot?.remove();
  document.querySelector('link[data-canonical-docs-css]')?.remove();
  document.body.classList.remove('canonical-docs-active', 'docs-hub-worker-body');
}

async function renderHome() {
  const [integration, content] = await Promise.all([
    state.integration || api('/api/integrations/downloads'),
    loadContentSurfaces(),
  ]);
  state.integration = integration;
  const docsHref = content.docs.defaultSlug ? docsPath(content.docs.defaultSlug) : '/docs';
  document.title = 'JuAPI 开发者中心';
  const downloads = state.integration.data;
  const fragment = document.createDocumentFragment();

  const hero = node('section', { class: 'home-hero' });
  const heroInner = node('div', { class: 'home-hero__inner' });
  const actions = node('div', { class: 'hero-actions' });
  actions.append(
    linkButton(docsHref, '开始阅读文档', 'primary'),
    linkButton('/pricing', '查看模型价格', 'secondary'),
  );
  heroInner.append(
    node('div', { class: 'eyebrow' }, 'NEWAPI PUBLIC SURFACE'),
    node('h1', {}, '把接口能力，变成清晰的开发体验。'),
    node(
      'p',
      { class: 'home-lead' },
      `开发文档、模型价格与客户端下载的公共入口，运行在独立的 Cloudflare Worker 上。Docs ${content.docs.sourceText}，Pricing ${content.pricing.sourceText}。`,
    ),
    actions,
    heroMeta(downloads, content),
  );
  hero.append(heroInner);

  const overview = node('section', { class: 'home-section' });
  const head = node('div', { class: 'home-section__head' });
  head.append(
    node('div', { class: 'eyebrow' }, 'SITE MAP'),
    node('h2', {}, '三个入口，一套界面语言。'),
    node(
      'p',
      {},
      '文档、价格与下载共用同一套排版、色板与组件，切换页面时不会有断层。',
    ),
  );
  const cards = node('div', {
    class: 'home-grid',
    'aria-label': '站点入口',
  });
  cards.append(
    featureCard(
      '01',
      '开发文档',
      '结构化导航、页内目录、全站搜索和可一键复制的请求示例。',
      docsHref,
      '打开文档',
    ),
    featureCard(
      '02',
      '模型价格',
      '按供应商、计费方式与能力筛选，支持表格与卡片两种阅读视图。',
      '/pricing',
      '打开模型价格',
    ),
    downloadsCard(downloads),
  );
  overview.append(head, cards);

  const boundary = node('section', { class: 'boundary-panel' });
  const boundaryCard = node('div', { class: 'boundary-panel__card' });
  boundaryCard.append(
    node('div', { class: 'eyebrow' }, 'PHASE 2 DEPLOYMENT BOUNDARY'),
    node('h2', {}, 'Production downloads 可接入，内容状态随响应 metadata 标识。'),
    node(
      'p',
      {},
      `Docs：${content.docs.badge}；Pricing：${content.pricing.badge}。Downloads、admin、R2、rollback 和微信群二维码由 NewAPI Worker 的 DOWNLOADS R2 authority 持有；状态仍明确区分 binding、healthy 与 live。`,
    ),
  );
  boundary.append(boundaryCard);

  fragment.append(hero, overview, boundary);
  replaceMain(fragment);
}

function heroMeta(downloads, content) {
  const list = node('dl', { class: 'hero-meta' });
  [
    ['内容来源', `${content.docs.badge} / ${content.pricing.badge}`],
    ['价格上下文', 'default / default · 已锁定'],
    ['客户端下载', downloadsSummary(downloads)],
  ].forEach(([term, description]) => {
    const item = node('div', { class: 'hero-meta__item' });
    item.append(node('dt', {}, term), node('dd', {}, description));
    list.append(item);
  });
  return list;
}

function downloadsSummary(status) {
  if (status.active) return 'Bound-unverified · 非 live';
  if (!status.enabled) return '当前环境 disabled · fail closed';
  return status.binding_present ? '当前环境 binding 无效' : '当前环境 binding 未提供';
}

async function loadContentSurfaces() {
  const docsResponse = state.docsCatalog || await api('/api/content/docs');
  if (!state.docsCatalog) state.docsCatalog = docsResponse;
  await ensureDocsNavigation();
  return {
    docs: {
      ...contentStatus(docsResponse.data.meta),
      defaultSlug: docsNavigationSlug(docsResponse),
    },
    pricing: {
      badge: 'NewAPI · Canonical',
      sourceText: 'NewAPI（canonical）',
    },
  };
}

async function ensureDocsCatalog() {
  if (!state.docsCatalog) state.docsCatalog = await api('/api/content/docs');
  return state.docsCatalog;
}

async function ensureDocsNavigation() {
  try {
    return await api(
      '/api/front-door/v1/docs/v2/navigation?locale=zh',
      { publicDocsNavigation: true },
    );
  } catch (error) {
    const unavailable = new Error('文档导航暂时不可用，请稍后重试。');
    unavailable.cause = error;
    throw unavailable;
  }
}

async function renderPricing() {
  // Both public pricing URLs are the same canonical NewAPI runtime. There is
  // no handcrafted compatibility renderer for `/pricing`.
  await renderCanonicalPricing();
  return;
}

async function renderDownloads(path) {
  document.title = path === '/downloads' ? '软件下载中心 · JuAPI' : '软件详情 · JuAPI';
  const softwareId = downloadSoftwareId(path);
  if (softwareId) {
    await renderDownloadSoftware(state.downloadCatalog || { software: [] }, softwareId);
    return;
  }
  const catalog = await ensureDownloadCatalog();

  const cards = await Promise.all(catalog.software.map(async (software) => {
    let metadata = null;
    let error = null;
    let fallback = false;
    try {
      const loaded = await loadPublicDownloadMetadata(software.id);
      metadata = loaded.metadata;
      fallback = loaded.fallback;
    } catch (caught) {
      error = caught;
    }
    return downloadSoftwareCard(software, metadata, error, fallback);
  }));

  const content = node('div', { class: 'downloads-page' });
  content.append(
    node('section', { class: 'downloads-hero' },
      node('div', { class: 'eyebrow' }, 'JUAPI PUBLIC DOWNLOADS'),
      node('h1', {}, '软件下载中心'),
      node('p', { class: 'downloads-lead' }, '从现有下载服务读取公开版本、平台目标、校验信息与下载入口。'),
    ),
    node('section', { class: 'downloads-section', 'aria-labelledby': 'downloads-software-heading' },
      node('div', { class: 'downloads-section-heading' },
        node('div', { class: 'eyebrow' }, 'AVAILABLE SOFTWARE'),
        node('h2', { id: 'downloads-software-heading' }, '软件'),
      ),
      cards.length
        ? node('div', { class: 'downloads-card-grid' }, cards)
        : downloadsEmpty('当前没有配置可展示的软件。'),
    ),
  );
  replaceMain(content);
}

async function renderDownloadSoftware(catalog, softwareId) {
  const software = catalog.software.find((item) => item.id === softwareId) || {
    id: softwareId,
    label: humanizeSoftwareId(softwareId),
  };
  const content = node('div', { class: 'downloads-page downloads-detail-page' });
  const hero = node('section', { class: 'downloads-hero downloads-detail-hero' });
  hero.append(
    // The mounted downloads root is downstream-owned HTML. A normal browser
    // navigation is required here so the detail SPA does not recreate a
    // client-only root shell at `/downloads`.
    node('a', { class: 'downloads-back-link', href: '/downloads' }, '← 全部软件'),
    node('div', { class: 'eyebrow' }, 'PUBLIC RELEASE'),
    node('h1', {}, software.label || humanizeSoftwareId(software.id)),
    node('p', { class: 'downloads-lead' }, `软件 ID：${software.id}`),
  );
  content.append(hero);
  replaceMain(content);

  let resolved;
  try {
    resolved = await loadPublicDownloadMetadata(software.id);
  } catch (error) {
    content.append(downloadError(error));
    return;
  }
  const metadata = resolved.metadata;
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const releaseDate = metadata?.release_date || metadata?.generated_at || metadata?.updated_at;
  const summary = node('section', { class: 'downloads-release-summary', 'aria-labelledby': 'downloads-release-heading' });
  summary.append(
    node('div', { class: 'downloads-section-heading' },
      node('div', { class: 'eyebrow' }, 'PUBLIC RELEASE'),
      node('h2', { id: 'downloads-release-heading' }, metadata?.release_id || '公开版本'),
    ),
    node('dl', { class: 'downloads-kv' },
      downloadDefinition('发布日期', formatDownloadDate(releaseDate)),
      downloadDefinition('文件数量', String(files.length)),
      metadata?.channel ? downloadDefinition('频道', metadata.channel) : null,
    ),
  );
  content.append(summary);
  if (resolved.fallback) {
    content.append(node('p', { class: 'downloads-fallback-notice', role: 'status' }, '公开版本暂不可用，当前显示下游最新公开元数据。'));
  }
  if (!files.length) {
    content.append(downloadsEmpty('这个软件当前没有可下载文件。'));
  } else {
    const fileSection = node('section', { class: 'downloads-section', 'aria-labelledby': 'downloads-files-heading' });
    fileSection.append(
      node('div', { class: 'downloads-section-heading' },
        node('div', { class: 'eyebrow' }, 'DOWNLOAD TARGETS'),
        node('h2', { id: 'downloads-files-heading' }, '可用下载'),
      ),
      node('div', { class: 'downloads-file-grid' }, files.map((file) => downloadFileCard(software.id, file))),
    );
    content.append(fileSection);
  }
  const details = node('details', { class: 'downloads-metadata-details' });
  details.append(node('summary', {}, '查看完整公开元数据'));
  details.append(node('pre', {}, JSON.stringify(metadata, null, 2)));
  content.append(details);
}

async function ensureDownloadCatalog() {
  if (state.downloadCatalog) return state.downloadCatalog;
  const response = await api('/api/downloads/catalog');
  const software = Array.isArray(response?.data?.software)
    ? response.data.software.filter((item) => item && /^[a-z0-9][a-z0-9-]{0,62}$/.test(item.id))
    : [];
  state.downloadCatalog = { software };
  return state.downloadCatalog;
}

async function loadPublicDownloadMetadata(softwareId) {
  const encoded = encodeURIComponent(softwareId);
  try {
    return {
      metadata: normalizeDownloadMetadata(await api(`/downloads/api/${encoded}/public`)),
      fallback: false,
    };
  } catch (error) {
    if (error?.status !== 404) throw error;
    return {
      metadata: normalizeDownloadMetadata(await api(`/downloads/api/${encoded}/latest`)),
      fallback: true,
    };
  }
}

function downloadSoftwareId(path) {
  const match = path.match(/^\/downloads\/software\/([a-z0-9][a-z0-9-]{0,62})$/);
  return match ? match[1] : '';
}

function downloadSoftwareCard(software, metadata, error, fallback = false) {
  const card = node('a', {
    class: 'downloads-software-card',
    href: `/downloads/software/${encodeURIComponent(software.id)}`,
    'data-link': '',
  });
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const targets = [...new Set(files.map((file) => [file?.platform, file?.arch].filter(Boolean).join(' · ')))];
  card.append(
    node('span', { class: 'downloads-card-kicker' }, 'SOFTWARE'),
    node('h2', {}, software.label || metadata?.name || metadata?.title || humanizeSoftwareId(software.id)),
    node('code', {}, software.id),
    error
      ? node('span', { class: 'downloads-card-status downloads-card-status--error' }, error.message || '公开元数据暂时不可用')
      : node('span', { class: `downloads-card-status${fallback ? ' downloads-card-status--fallback' : ''}` }, `${fallback ? '当前为最新版本 · ' : ''}${formatDownloadDate(metadata?.release_date || metadata?.generated_at || metadata?.updated_at)} · ${files.length} 个目标`),
    targets.length ? node('span', { class: 'downloads-card-targets' }, targets.join('、')) : null,
    node('span', { class: 'downloads-card-action' }, '查看公开版本 →'),
  );
  return card;
}

function normalizeDownloadMetadata(payload) {
  if (payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)) return payload.data;
  return payload && typeof payload === 'object' ? payload : {};
}

function downloadFileCard(softwareId, file) {
  const target = [file?.site, file?.platform, file?.arch].every(Boolean)
    ? `/downloads/download/${encodeURIComponent(softwareId)}/${encodeURIComponent(file.site)}/${encodeURIComponent(file.platform)}/${encodeURIComponent(file.arch)}`
    : safeDownloadHref(file?.url);
  const card = node('article', { class: 'downloads-file-card' });
  card.append(
    node('div', { class: 'downloads-file-target' }, `${humanizeDownloadValue(file?.platform)} · ${humanizeDownloadValue(file?.arch)}`),
    node('h3', {}, file?.filename || '未命名文件'),
    node('dl', { class: 'downloads-kv downloads-file-kv' },
      downloadDefinition('平台', file?.platform || '未提供'),
      downloadDefinition('架构', file?.arch || '未提供'),
      downloadDefinition('大小', formatDownloadBytes(file?.size)),
      downloadDefinition('SHA-256', file?.sha256 || '未提供'),
      file?.content_type ? downloadDefinition('类型', file.content_type) : null,
    ),
    target
      ? node('a', { class: 'button primary downloads-download-button', href: target }, '下载')
      : node('span', { class: 'downloads-unavailable' }, '下载目标待补充'),
  );
  if (file && typeof file === 'object') {
    const details = node('details', { class: 'downloads-file-details' });
    details.append(node('summary', {}, '详情'));
    details.append(node('pre', {}, JSON.stringify(file, null, 2)));
    card.append(details);
  }
  return card;
}

function safeDownloadHref(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    const resolved = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : '';
  } catch {
    return '';
  }
}

function downloadDefinition(label, value) {
  return [node('dt', {}, label), node('dd', {}, value)];
}

function downloadsEmpty(message) {
  return node('div', { class: 'downloads-empty', role: 'status' },
    node('h3', {}, '暂无可用下载'),
    node('p', {}, message),
  );
}

function downloadError(error) {
  return node('div', { class: 'downloads-empty downloads-error', role: 'alert' },
    node('h2', {}, '公开元数据暂时无法载入'),
    node('p', {}, error?.message || '下载服务暂时不可用，请稍后重试。'),
  );
}

function humanizeSoftwareId(id) {
  return String(id || '').split('-').filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join(' ') || '软件';
}

function humanizeDownloadValue(value) {
  return value ? humanizeSoftwareId(String(value).replace(/_/g, '-')) : '未提供';
}

function formatDownloadBytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '未提供';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = number;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDownloadDate(value) {
  if (!value) return '未提供';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

async function renderCanonicalPricing() {
  // `/console/pricing` is the public default view. It has no browser session
  // or end-user credential boundary; the canonical bundle calls the public
  // Worker Pricing endpoint backed by the server-side live-content adapter.
  const languageBar = node('div', { class: 'pricing-language-bar' });
  languageBar.append(createPricingLanguageSelector());
  const root = node('div', {
    id: 'canonical-pricing-root',
    class: 'canonical-pricing-root',
    'aria-label': '模型价格',
  });
  const surface = node('div', { class: 'canonical-pricing-surface' });
  surface.append(languageBar, root);
  replaceMain(surface);
  // Semi's distributed CommonJS helpers retain a guarded process.env read;
  // provide the browser-safe production value before the canonical module is
  // evaluated without shipping a Node runtime shim.
  globalThis.process ||= {};
  globalThis.process.env ||= {};
  globalThis.process.env.NODE_ENV ||= 'production';
  if (!document.querySelector('link[data-canonical-pricing-css]')) {
    const stylesheet = node('link', {
      rel: 'stylesheet',
      href: '/static/canonical-pricing.css',
      'data-canonical-pricing-css': '1',
    });
    document.head.append(stylesheet);
  } else {
    document.querySelector('link[data-canonical-pricing-css]').disabled = false;
  }
  if (!canonicalPricingScriptPromise) {
    canonicalPricingScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = '/static/canonical-pricing.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Canonical Pricing bundle failed to load.'));
      document.head.append(script);
    });
  }
  await canonicalPricingScriptPromise;
  await globalThis.__mountCanonicalPricing?.();
  bindPricingLanguageSelector(languageBar.firstElementChild);
}

function createPricingLanguageSelector() {
  const menuId = `pricing-language-menu-${++pricingLanguageMenuId}`;
  let hoverCloseTimer = null;
  let openedByHover = false;
  const selector = node('div', {
    class: 'pricing-language-selector',
    'data-pricing-language-selector': '',
  });
  const trigger = node('button', {
    type: 'button',
    class: 'pricing-language-trigger',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    'aria-label': 'common.changeLanguage',
  });
  trigger.append(pricingLanguageIcon());
  const menu = node('ul', {
    id: menuId,
    class: 'pricing-language-menu',
    role: 'menu',
    'aria-orientation': 'vertical',
    hidden: '',
  });
  for (const { value, label } of CANONICAL_PRICING_LANGUAGES) {
    const option = node('li', {
      class: 'pricing-language-option',
      role: 'menuitem',
      tabindex: '-1',
      'data-language': value,
    }, label);
    option.addEventListener('click', () => {
      closePricingLanguageMenu(selector, true);
      void changePricingLanguage(value, selector);
    });
    menu.append(option);
  }
  selector.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(hoverCloseTimer);
    if (menu.hidden) {
      closeAllPricingLanguageMenus(selector);
      openedByHover = true;
      openPricingLanguageMenu(selector);
    }
  });
  selector.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      openedByHover = false;
      closePricingLanguageMenu(selector);
    }, 100);
  });
  trigger.addEventListener('click', () => {
    clearTimeout(hoverCloseTimer);
    if (openedByHover && !menu.hidden) {
      openedByHover = false;
      openPricingLanguageMenu(selector, 'first');
      return;
    }
    const willOpen = menu.hidden;
    openedByHover = false;
    closeAllPricingLanguageMenus(selector);
    if (willOpen) openPricingLanguageMenu(selector, 'first');
    else closePricingLanguageMenu(selector);
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closePricingLanguageMenu(selector, true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openPricingLanguageMenu(selector, event.key === 'ArrowDown' ? 'first' : 'last');
    }
  });
  menu.addEventListener('keydown', (event) => {
    const options = [...menu.querySelectorAll('[role="menuitem"]')];
    const current = event.target.closest('[role="menuitem"]');
    if (!current) return;
    const currentIndex = options.indexOf(current);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        closePricingLanguageMenu(selector, true);
        break;
      case 'ArrowDown':
        event.preventDefault();
        options[(currentIndex + 1) % options.length]?.focus();
        break;
      case 'ArrowUp':
        event.preventDefault();
        options[(currentIndex - 1 + options.length) % options.length]?.focus();
        break;
      case 'Home':
        event.preventDefault();
        options[0]?.focus();
        break;
      case 'End':
        event.preventDefault();
        options.at(-1)?.focus();
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        current.click();
        break;
      case 'Tab':
        closePricingLanguageMenu(selector);
        break;
      default:
        focusPricingLanguageByFirstCharacter(options, currentIndex, event.key);
    }
  });
  selector.append(trigger, menu);
  return selector;
}

function openPricingLanguageMenu(selector, focusEdge = null) {
  const trigger = selector.querySelector('.pricing-language-trigger');
  const menu = selector.querySelector('.pricing-language-menu');
  if (!trigger || !menu) return;
  menu.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  const options = [...menu.querySelectorAll('[role="menuitem"]')];
  if (focusEdge === 'first') options[0]?.focus();
  if (focusEdge === 'last') options.at(-1)?.focus();
}

function focusPricingLanguageByFirstCharacter(options, currentIndex, key) {
  if (key.length !== 1 || key.trim() === '') return;
  const character = key.toLocaleLowerCase();
  for (let offset = 1; offset <= options.length; offset += 1) {
    const candidate = options[(currentIndex + offset) % options.length];
    if (candidate.textContent.trim().toLocaleLowerCase().startsWith(character)) {
      candidate.focus();
      return;
    }
  }
}

function closeAllPricingLanguageMenus(except = null) {
  document.querySelectorAll('[data-pricing-language-selector]').forEach((selector) => {
    if (selector !== except) closePricingLanguageMenu(selector);
  });
}

function closePricingLanguageMenu(selector, restoreFocus = false) {
  if (!selector) return;
  const trigger = selector.querySelector('.pricing-language-trigger');
  const menu = selector.querySelector('.pricing-language-menu');
  if (!trigger || !menu) return;
  menu.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus();
}

async function changePricingLanguage(language, selector) {
  const i18n = window.__i18n;
  if (!i18n || typeof i18n.changeLanguage !== 'function') return;
  try {
    // This is the anonymous half of canonical NewAPI's language handler. It
    // deliberately excludes scoped/user persistence and its API request.
    const languageChange = i18n.changeLanguage(language);
    localStorage.setItem('i18nextLng', language);
    document.documentElement.lang = language;
    await languageChange;
    syncPricingLanguageSelector(selector);
  } catch (error) {
    console.error('Unable to change Pricing language.', error);
  }
}

function syncPricingLanguageSelector(selector) {
  if (!selector) return;
  const i18n = window.__i18n;
  const current = normalizePricingLanguage(
    i18n?.language || localStorage.getItem('i18nextLng') || 'zh-CN',
  );
  document.documentElement.lang = current;
  const trigger = selector.querySelector('.pricing-language-trigger');
  const label = i18n?.t?.('common.changeLanguage') || 'common.changeLanguage';
  trigger?.setAttribute('aria-label', label);
  selector.querySelectorAll('[data-language]').forEach((option) => {
    const selected = option.getAttribute('data-language') === current;
    option.classList.toggle('is-selected', selected);
    option.setAttribute('aria-current', selected ? 'true' : 'false');
  });
}

function bindPricingLanguageSelector(selector) {
  unbindPricingLanguageSelector();
  const i18n = window.__i18n;
  if (i18n && typeof i18n.on === 'function') {
    const handleLanguageChanged = () => syncPricingLanguageSelector(selector);
    i18n.on('languageChanged', handleLanguageChanged);
    pricingLanguageBinding = { i18n, handleLanguageChanged };
  }
  syncPricingLanguageSelector(selector);
}

function unbindPricingLanguageSelector() {
  if (!pricingLanguageBinding) return;
  const { i18n, handleLanguageChanged } = pricingLanguageBinding;
  i18n.off?.('languageChanged', handleLanguageChanged);
  pricingLanguageBinding = null;
}

function normalizePricingLanguage(language) {
  if (!language) return language;
  const normalized = language.trim().replace(/_/g, '-');
  const lower = normalized.toLowerCase();
  if (
    lower === 'zh'
    || lower === 'zh-cn'
    || lower === 'zh-sg'
    || lower.startsWith('zh-hans')
  ) return 'zh-CN';
  if (
    lower === 'zh-tw'
    || lower === 'zh-hk'
    || lower === 'zh-mo'
    || lower.startsWith('zh-hant')
  ) return 'zh-TW';
  return CANONICAL_PRICING_LANGUAGES.find(
    ({ value }) => value.toLowerCase() === lower,
  )?.value || normalized;
}

function pricingLanguageIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [attribute, value] of Object.entries({
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) {
    svg.setAttribute(attribute, value);
  }
  for (const definition of [
    'm5 8 6 6',
    'm4 14 6-6 2-3',
    'M2 5h12',
    'M7 2h1',
    'm22 22-5-10-5 10',
    'M14 18h6',
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}


function renderDataBadge(meta, label = undefined) {
  const status = contentStatus(meta);
  const badge = node('span', { class: `data-badge ${status.kind}` });
  const displayLabel = label || status.badge;
  badge.append(node('i', { 'aria-hidden': 'true' }), document.createTextNode(displayLabel));
  return badge;
}

function featureCard(number, title, description, href, action) {
  const card = node('a', { class: 'feature-card', href, 'data-link': '' });
  card.append(
    node('span', { class: 'feature-number' }, number),
    node('h2', {}, title),
    node('p', {}, description),
    node('strong', {}, `${action} →`),
  );
  return card;
}

function downloadsCard(status) {
  const copy = [
    node('span', { class: 'feature-number' }, '03'),
    node('h2', {}, '客户端下载'),
    node(
      'p',
      {},
      '安装包由既有下载 Worker 提供；命名 staging／production 环境通过 Service Binding 显式挂载在 /downloads。',
    ),
  ];
  if (status.active) {
    const card = node('a', {
      class: 'feature-card status-card',
      href: '/downloads',
    });
    card.append(...copy, node('strong', { class: 'status-on' }, '打开下载页 →'));
    return card;
  }
  const card = node('article', { class: 'feature-card status-card' });
  card.append(
    ...copy,
    node('strong', { class: 'status-off' }, downloadsSummary(status)),
  );
  return card;
}

function linkButton(href, label, style) {
  return node('a', { href, 'data-link': '', class: `button ${style}` }, label);
}

function surfaceButton(label, className = 'surface-button', leadingIcon = null) {
  const button = node('button', { type: 'button', class: className });
  if (leadingIcon) button.append(leadingIcon);
  if (label) button.append(node('span', { class: 'surface-button-label' }, label));
  return button;
}

let surfaceDialogId = 0;

function createSurfaceDialog(title, className = '', sheet = false, onDismiss = closeSurfaceOverlay) {
  surfaceReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  activeSurfaceDismiss = onDismiss;
  const titleId = `surface-dialog-title-${++surfaceDialogId}`;
  const overlay = node('div', { class: `surface-overlay${sheet ? ' is-sheet' : ''}` });
  const backdrop = node('button', {
    type: 'button',
    class: 'surface-overlay-backdrop',
    'aria-label': '关闭',
  });
  const panel = node('section', {
    class: `surface-dialog ${className}`.trim(),
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
  });
  const header = node('header', { class: 'surface-dialog-header' });
  const close = surfaceButton('', 'surface-dialog-close', icon('close'));
  close.setAttribute('aria-label', '关闭');
  header.append(node('h2', { id: titleId }, title), close);
  const content = node('div', { class: 'surface-dialog-content' });
  panel.append(header, content);
  overlay.append(backdrop, panel);
  backdrop.addEventListener('click', dismissSurfaceOverlay);
  close.addEventListener('click', dismissSurfaceOverlay);
  panel.addEventListener('keydown', trapSurfaceDialogFocus);
  document.body.classList.add('surface-overlay-open');
  return { overlay, panel, content };
}

function dismissSurfaceOverlay() {
  if (activeSurfaceDismiss) {
    activeSurfaceDismiss();
    return;
  }
  closeSurfaceOverlay();
}

function closeSurfaceOverlay({ restoreFocus = true } = {}) {
  const returnFocus = surfaceReturnFocus;
  surfaceReturnFocus = null;
  activeSurfaceDismiss = null;
  document.querySelectorAll('.surface-overlay').forEach((overlay) => overlay.remove());
  document.querySelector('.docs-hub-sidebar-wrap.is-open')?.classList.remove('is-open');
  document.querySelectorAll('[data-pricing-filter-trigger][aria-expanded="true"]')
    .forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'));
  document.body.classList.remove('surface-overlay-open');
  if (restoreFocus && returnFocus) {
    requestAnimationFrame(() => {
      if (returnFocus.isConnected) returnFocus.focus();
    });
  }
}

function trapSurfaceDialogFocus(event) {
  if (event.key !== 'Tab') return;
  const focusable = [...event.currentTarget.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  )].filter((element) => getComputedStyle(element).visibility !== 'hidden');
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function billingLabel(kind) {
  return {
    per_token: '按量计费',
    per_request: '按次计费',
    tiered_expr: '动态计费',
    codex_fast: 'Codex Fast',
    video: '影片计费',
  }[kind] || '计费待确认';
}

function node(tagName, attributes = {}, ...children) {
  const element = document.createElement(tagName);
  Object.entries(attributes).forEach(([name, value]) => {
    if (value === undefined || value === null) return;
    if (name === 'class') element.className = value;
    else if (name === 'value') element.value = value;
    else element.setAttribute(name, value);
  });
  children.flat(Infinity).forEach((child) => {
    if (child === undefined || child === null) return;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return element;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [attribute, value] of Object.entries({
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })) {
    svg.setAttribute(attribute, value);
  }
  const paths = {
    search: ['circle|11|11|6.5', 'M16 16l4 4'],
    menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
    chevron: ['M9 18l6-6-6-6'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    sliders: ['M4 6h10', 'M18 6h2', 'M4 18h2', 'M10 18h10', 'M14 3v6', 'M6 15v6'],
    table: ['M4 5h16v14H4z', 'M4 10h16', 'M10 5v14'],
    grid: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
    file: ['M6 3h8l4 4v14H6z', 'M14 3v5h5'],
    code: ['M8 9l-3 3 3 3', 'M16 9l3 3-3 3', 'M14 6l-4 12'],
  };
  (paths[name] || []).forEach((definition) => {
    if (definition.startsWith('circle|')) {
      const [, cx, cy, r] = definition.split('|');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', r);
      svg.append(circle);
    } else {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', definition);
      svg.append(path);
    }
  });
  return svg;
}

function replaceMain(content) {
  main.replaceChildren(content);
  main.focus({ preventScroll: true });
}

function renderNotFound() {
  document.title = '页面不存在 · JuAPI';
  const docsSlug = docsNavigationSlug(state.docsCatalog);
  replaceMain(node('section', { class: 'error-page' },
    node('span', {}, '404'),
    node('h1', {}, '没有找到这个页面'),
    node('p', {}, '链接可能已经移动，或者尚未开放。'),
    docsSlug ? linkButton(docsPath(docsSlug), '返回文档', 'primary') : null,
  ));
}

function renderError(error) {
  console.error(error);
  replaceMain(node('section', { class: 'error-page' },
    node('span', {}, 'ERROR'),
    node('h1', {}, '内容暂时无法载入'),
    node('p', {}, error.message || '请稍后重试。'),
    linkButton('/', '返回首页', 'primary'),
  ));
}

async function api(path, options = {}) {
  const publicDocsNavigation = options.publicDocsNavigation === true;
  const publicDownloads = path === '/api/downloads/catalog' || path.startsWith('/downloads/api/');
  const cached = publicDocsNavigation ? null : contentApiCache.get(path);
  const headers = new Headers({ accept: 'application/json' });
  if (!publicDocsNavigation && cached?.etag) headers.set('if-none-match', cached.etag);
  const response = await fetch(path, {
    headers,
    credentials: path.startsWith('/api/content/docs') || publicDocsNavigation || publicDownloads ? 'omit' : undefined,
    ...(path.startsWith('/api/content/') || publicDocsNavigation
      ? { cache: publicDocsNavigation ? 'no-store' : 'no-cache' }
      : publicDownloads ? { cache: 'no-store' } : {}),
  });
  if (response.status === 304) {
    if (publicDocsNavigation || !cached || response.headers.get('etag') !== cached.etag) {
      throw new Error('API 返回了无法验证的缓存响应。');
    }
    return cached.body;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`API 返回了非 JSON 响应（${response.status}）。`);
  }
  if (!response.ok || body.success === false) {
    const error = new Error(body?.error?.message || body?.message || `请求失败（${response.status}）。`);
    error.status = response.status;
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    throw error;
  }
  if (path.startsWith('/api/content/') && !publicDocsNavigation) {
    contentApiCache.set(path, {
      body,
      etag: response.headers.get('etag'),
    });
  }
  return body;
}

function updateActiveNavigation(path) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active =
      link.dataset.nav === 'home'
        ? path === '/'
        : link.dataset.nav === 'pricing'
          ? isPricingPath(path)
          : link.dataset.nav === 'downloads'
            ? isDownloadsPath(path)
            : path.startsWith(`/${link.dataset.nav}`);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isPricingPath(path) {
  return path === '/console/pricing' || path === '/pricing';
}

function isDownloadsPath(path) {
  return path === '/downloads' || downloadSoftwareId(path) !== '';
}

function isDocsPath(path) {
  return path === '/docs'
    || path.startsWith('/docs/')
    || isConsoleDocsPath(path);
}

function isConsoleDocsPath(path) {
  return path === '/console/docs' || path.startsWith('/console/docs/');
}

function canonicalDocsPath(path) {
  const canonical = isConsoleDocsPath(path)
    ? `/docs${path.slice('/console/docs'.length)}`
    : path;
  return canonicalDocsPageAlias(canonical);
}

function canonicalDocsPageAlias(path) {
  if (!path.startsWith('/docs/')) return path;
  const segments = path.slice('/docs/'.length).split('/').filter(Boolean);
  const first = segments[0]?.toLowerCase();
  if (
    !first
    || DOCS_SPACE_SLUGS.has(first)
    || !LEGACY_QUICKSTART_PAGE_ALIASES.has(first)
  ) {
    return path;
  }
  return `/docs/quickstart/${segments.join('/')}`;
}

function canonicalizeDocsLocation() {
  const currentPath = normalizePath(window.location.pathname);
  const path = canonicalDocsPath(currentPath);
  if (path !== currentPath) {
    window.history.replaceState(
      window.history.state,
      '',
      `${path}${window.location.search}${window.location.hash}`,
    );
  }
  return path;
}

function installDocsHistoryNormalizer() {
  if (docsHistoryNormalizerInstalled) return;
  for (const method of ['pushState', 'replaceState']) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (state, title, url) => original(
      state,
      title,
      normalizeDocsHistoryUrl(url),
    );
  }
  docsHistoryNormalizerInstalled = true;
}

function normalizeDocsHistoryUrl(value) {
  if (value === null || value === undefined) return value;
  let target;
  try {
    target = new URL(String(value), window.location.href);
  } catch {
    return value;
  }
  if (target.origin !== window.location.origin) return value;
  const currentPath = normalizePath(target.pathname);
  const canonical = canonicalDocsPath(currentPath);
  if (canonical === currentPath) return value;
  return `${canonical}${target.search}${target.hash}`;
}

function docsPath(slug) {
  return slug ? `/docs/${encodeURIComponent(slug)}` : '/docs';
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return String(Number(numeric.toFixed(6)));
}

function toast(message) {
  const region = document.querySelector('#toast-region');
  const item = node('div', { class: 'toast' }, message);
  region.append(item);
  setTimeout(() => item.remove(), 2200);
}
