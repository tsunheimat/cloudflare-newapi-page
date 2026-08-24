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

const PRICING_MOBILE_QUERY = '(max-width: 767px)';
const THEME_STORAGE_KEY = 'juapi-theme';
const PRICING_GROUP_DATA_ATTRIBUTE = ['data', 'pricing', 'group'].join('-');
const pricingMobileMedia = window.matchMedia?.(PRICING_MOBILE_QUERY) || null;

const state = {
  docsCatalog: null,
  integration: null,
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

window.addEventListener('popstate', () => {
  canonicalizeDocsLocation();
  if (document.body.classList.contains('canonical-docs-active')) return;
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
  if (event.key === 'Escape') dismissSurfaceOverlay();
});
document.addEventListener('click', (event) => {
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
  const canonicalPricing = isPricingPath(path);
  document.body.classList.toggle('canonical-pricing-active', canonicalPricing);
  const canonicalStyles = document.querySelector('link[data-canonical-pricing-css]');
  if (canonicalStyles) canonicalStyles.disabled = !canonicalPricing;
  if (!canonicalPricing) globalThis.__unmountCanonicalPricing?.();
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
  if (canonicalDocsMounted) return;
  document.body.classList.add('canonical-docs-active');
  document.body.classList.remove('canonical-pricing-active');
  const canonicalStyles = document.querySelector('link[data-canonical-docs-css]') || node('link', {
    rel: 'stylesheet',
    href: '/static/docs-hub.css',
    'data-canonical-docs-css': '',
  });
  if (!canonicalStyles.isConnected) document.head.append(canonicalStyles);
  main.replaceChildren();
  const root = node('div', { id: 'root' });
  main.append(root);
  if (!canonicalDocsScriptPromise) {
    canonicalDocsScriptPromise = import('./docs-hub.js');
  }
  await canonicalDocsScriptPromise;
  canonicalDocsMounted = true;
  document.title = '文档';
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
      `Docs：${content.docs.badge}；Pricing：${content.pricing.badge}。只有命名 staging／production 的对应 runtime gate 与 callable binding 同时成立才会转发。即使 bound，下载状态仍是未验证健康、非 live。下载、admin、R2、rollback 和微信群二维码继续由原 Worker 持有。`,
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

async function renderCanonicalPricing() {
  // `/console/pricing` is the public default view. It has no browser session
  // or end-user credential boundary; the canonical bundle calls the public
  // Worker Pricing endpoint backed by the server-side live-content adapter.
  const root = node('div', {
    id: 'canonical-pricing-root',
    class: 'canonical-pricing-root',
    'aria-label': '模型价格',
  });
  replaceMain(root);
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
  const svg = node('svg', {
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
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
      svg.append(node('circle', { cx, cy, r }));
    } else {
      svg.append(node('path', { d: definition }));
    }
  });
  return svg;
}

function navigate(path) {
  window.history.pushState({}, '', path);
  window.scrollTo({ top: 0, behavior: 'instant' });
  renderRoute();
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
  const cached = publicDocsNavigation ? null : contentApiCache.get(path);
  const headers = new Headers({ accept: 'application/json' });
  if (!publicDocsNavigation && cached?.etag) headers.set('if-none-match', cached.etag);
  const response = await fetch(path, {
    headers,
    credentials: path.startsWith('/api/content/docs') || publicDocsNavigation ? 'omit' : undefined,
    ...(path.startsWith('/api/content/') || publicDocsNavigation
      ? { cache: publicDocsNavigation ? 'no-store' : 'no-cache' }
      : {}),
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

function isDocsPath(path) {
  return path === '/docs'
    || path.startsWith('/docs/')
    || isConsoleDocsPath(path);
}

function isConsoleDocsPath(path) {
  return path === '/console/docs' || path.startsWith('/console/docs/');
}

function canonicalDocsPath(path) {
  return isConsoleDocsPath(path)
    ? `/docs${path.slice('/console/docs'.length)}`
    : path;
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
