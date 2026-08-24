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
  calculateModelPricing,
  getOrdinaryUserModels,
  modelSupportsGroup,
} from './pricing.js';
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
  legacyPricing: null,
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
// Only legacy public `/api/content/*` responses may be reused in this
// compatibility layer. Public Docs navigation is fetched afresh and is never
// retained in browser memory or validators.
const contentApiCache = new Map();
let canonicalPricingScriptPromise = null;
let canonicalDocsScriptPromise = null;
let canonicalDocsMounted = false;

window.addEventListener('popstate', () => {
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
  let path = normalizePath(window.location.pathname);
  const canonicalPricing = path === '/console/pricing';
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
    if (path === '/docs' || path.startsWith('/docs/')) {
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
  const pricingResponse = state.legacyPricing || await api('/api/content/pricing');
  if (!state.docsCatalog) state.docsCatalog = docsResponse;
  state.legacyPricing ||= pricingResponse;
  await ensureDocsNavigation();
  return {
    docs: {
      ...contentStatus(docsResponse.data.meta),
      defaultSlug: docsNavigationSlug(docsResponse),
    },
    pricing: contentStatus(pricingResponse.meta),
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
  if (normalizePath(window.location.pathname) === '/console/pricing') {
    await renderCanonicalPricing();
    return;
  }
  // `/pricing` is the public compatibility surface. Keep its fixture/live
  // public-content state separate from recursive Docs navigation.
  // The public API helper may reuse only this legacy response and its ETag;
  // no Docs navigation body, validator, or in-flight promise is retained here.
  const payload = state.legacyPricing || await api('/api/content/pricing');
  state.legacyPricing ||= payload;
  state.currency = payload.display?.default_currency || 'CNY';
  state.showWithRecharge = payload.display?.show_with_recharge === true;
  const models = getOrdinaryUserModels(payload);
  if (!state.selectedGroup || !(state.selectedGroup in (payload.usable_group || {}))) {
    state.selectedGroup = payload.context.selected_group || Object.keys(payload.usable_group || {})[0] || '';
  }
  const vendorIds = new Set(models.map((model) => String(model.vendor_id || 'unknown')));
  const vendors = payload.vendors.filter((vendor) => vendorIds.has(String(vendor.id)));
  const activeVendorIds = new Set(
    models
      .filter((model) => modelSupportsGroup(model, state.selectedGroup))
      .map((model) => String(model.vendor_id || 'unknown')),
  );
  if (!activeVendorIds.has(state.vendor)) {
    state.vendor = String(vendors.find((vendor) => activeVendorIds.has(String(vendor.id)))?.id || 'unknown');
  }
  document.title = '模型价格 · JuAPI 开发者中心';
  const shell = node('div', {
    class: 'newapi-surface pricing-page-shell',
    'data-pricing-surface': '1',
    'data-user-group': payload.context.user_group,
    'data-selected-group': state.selectedGroup,
    'data-group-locked': String(payload.context.locked),
  });
  const container = node('div', { class: 'pricing-page-container' });
  const content = node('div', { class: 'pricing-top-section' });
  const intro = node('header', { class: 'pricing-page-intro' });
  intro.append(
    node('h1', {}, '模型价格'),
    node('p', {}, '比较模型价格，按供应商、分组和能力快速找到适合你的模型。'),
  );
  content.append(intro, renderPricingProviders(payload, vendors), renderPricingRule(payload));

  const calculated = getFilteredPricing(payload);
  const listCard = node('section', { class: 'pricing-price-list-card' });
  const listHeader = node('div', { class: 'pricing-price-list-header' });
  const listTitle = node('div');
  const titleRow = node('div', { class: 'pricing-price-list-title-row' });
  const countTag = node('span', { class: 'surface-tag surface-tag-blue' }, `共 ${calculated.length} 个模型`);
  titleRow.append(node('h2', {}, '模型价格'), countTag);
  listTitle.append(node('div', { class: 'pricing-section-label' }, '价格清单'), titleRow);
  listHeader.append(listTitle, renderPricingModeSwitch());
  listCard.append(
    listHeader,
    renderLockedPricingGroup(payload, calculated.length),
  );

  const toolbar = node('div', { class: 'pricing-comparison-toolbar' });
  const results = node('div', { class: 'pricing-view-container', 'aria-live': 'polite' });
  toolbar.append(renderPricingSearchActions(payload, results, countTag));
  listCard.append(toolbar);
  if (state.advancedFiltersOpen && !isNarrowPricingViewport()) {
    listCard.append(renderPricingAdvancedFilters(payload));
  }
  listCard.append(results);
  renderPricingResults(payload, results, countTag);
  content.append(listCard);
  container.append(content);
  shell.append(container);
  replaceMain(shell);
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

function renderPricingProviders(payload, vendors) {
  const section = node('section', { class: 'pricing-provider-section' });
  section.append(node('div', { class: 'pricing-section-label' }, '供应商'));
  const list = node('div', { class: 'pricing-vendor-list', role: 'group', 'aria-label': '供应商' });
  const models = getOrdinaryUserModels(payload);
  vendors.forEach((vendor) => {
    const vendorId = String(vendor.id);
    const active = vendorId === state.vendor;
    const count = models.filter((model) => String(model.vendor_id) === vendorId).length;
    const button = surfaceButton('', `pricing-vendor-chip${active ? ' is-active' : ''}`);
    button.setAttribute('data-vendor-id', vendorId);
    button.setAttribute('aria-pressed', String(active));
    button.append(
      node('span', { class: 'pricing-vendor-icon', 'aria-hidden': 'true' }, vendor.name.slice(0, 1).toUpperCase()),
      node('span', {}, vendor.name),
      node('span', { class: 'pricing-chip-count' }, String(count)),
    );
    button.addEventListener('click', () => {
      state.vendor = vendorId;
      const vendorModels = models.filter((model) => String(model.vendor_id) === vendorId);
      if (!vendorModels.some((model) => modelSupportsGroup(model, state.selectedGroup))) {
        state.selectedGroup = Object.keys(payload.usable_group || {}).find((group) =>
          vendorModels.some((model) => modelSupportsGroup(model, group)),
        ) || payload.context.selected_group;
      }
      state.billing = 'all';
      state.endpoint = 'all';
      state.tag = 'all';
      void renderPricing();
    });
    list.append(button);
  });
  section.append(list);
  const selected = vendors.find((vendor) => String(vendor.id) === state.vendor);
  if (selected?.description) {
    section.append(node('p', { class: 'pricing-provider-description' }, selected.description));
  }
  return section;
}

function renderPricingRule(payload) {
  const section = node('section', { class: 'pricing-rule-inline' });
  const copy = node('div');
  const title = node('div', { class: 'pricing-rule-title' });
  title.append('计价规则', renderDataBadge(payload.meta));
  const summary = node('div', { class: 'pricing-rule-summary' });
  const source = contentStatus(payload.meta).sourceText;
  const group = state.selectedGroup || payload.context.selected_group || '';
  const ratio = payload.group_ratio[group];
  if (state.pricingMode === 'official') {
    summary.append(
      node('div', {}, `官方价格为 ${source}提供的原始美元基础价。`),
      node('div', {}, `官方模式 effective 倍率为 1x；${group} 分组配置为 ${formatNumber(ratio)}x，价格数据保持 NewAPI 上游值。`),
    );
  } else {
    const conversion = pricingConversion(payload);
    summary.append(
      node('div', {}, `官方价格为 ${source}提供的原始美元基础价。`),
      node('div', {}, `实付金额（${conversion.currency}） = 官方价格（USD） × 分组倍率 × 当前换算（${formatNumber(conversion.rate)} ${conversion.currency}/USD）`),
      node('div', {}, `当前 ${group} 分组倍率为 ${formatNumber(ratio)}x；展示值直接使用 NewAPI 上游价格数据。`),
    );
  }
  summary.append(node('div', { class: 'pricing-source-notice' }, payload.meta.notice || `${contentStatus(payload.meta).badge}。`));
  copy.append(title, summary);
  section.append(copy);
  return section;
}

function pricingConversion(payload) {
  const display = payload.display || {};
  if (state.currency === 'USD') {
    return {
      currency: 'USD',
      symbol: '$',
      rate: state.showWithRecharge
        ? Number(display.price) / Number(display.usd_exchange_rate)
        : 1,
    };
  }
  if (state.currency === 'CUSTOM') {
    const recharge = state.showWithRecharge
      ? Number(display.price) / Number(display.usd_exchange_rate)
      : 1;
    return {
      currency: 'CUSTOM',
      symbol: display.custom_currency_symbol || '¤',
      rate: recharge * (Number(display.custom_currency_exchange_rate) || 1),
    };
  }
  return {
    currency: 'CNY',
    symbol: '¥',
    rate: state.showWithRecharge
      ? Number(display.price)
      : Number(display.usd_exchange_rate),
  };
}

function renderPricingModeSwitch() {
  const group = node('div', { class: 'pricing-mode-switch', role: 'group', 'aria-label': '分组价格 / 官方价格' });
  [
    ['group', '分组价格'],
    ['official', '官方价格'],
  ].forEach(([value, label]) => {
    const active = state.pricingMode === value;
    const button = surfaceButton(label, `surface-button${active ? ' is-primary' : ''}`);
    button.setAttribute('data-pricing-mode', value);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      state.pricingMode = value;
      void renderPricing();
    });
    group.append(button);
  });
  return group;
}

function renderLockedPricingGroup(payload, count) {
  const list = node('div', { class: 'pricing-group-list', 'aria-label': '可用令牌分组' });
  const group = payload.context.selected_group;
  const card = surfaceButton('', 'pricing-group-card is-active is-locked');
  card.setAttribute('data-pricing-group', group);
  card.setAttribute('aria-pressed', 'true');
  card.setAttribute('aria-disabled', 'true');
  card.disabled = true;
  card.append(
    node('span', { class: 'pricing-group-name' }, group),
    node('span', { class: 'pricing-group-rate' }, `${payload.usable_group[group]}${payload.context.locked ? '（固定）' : ''}`),
    node('span', { class: 'pricing-group-formula' }, `官方价 × ${formatNumber(payload.group_ratio[group])}x`),
    node('span', { class: 'pricing-group-meter', 'aria-hidden': 'true' },
      node('span', { class: 'pricing-group-meter-fill pricing-group-meter-fill-locked' }),
    ),
    node('span', { class: 'pricing-group-count' }, `共 ${count} 个模型`),
  );
  list.append(card);
  const description = node('div', { class: 'pricing-group-description' });
  description.append(
    node('strong', {}, group),
    node('span', {}, `${payload.usable_group[group]} · user_group=${payload.context.user_group} · selected_group=${group} · locked=${payload.context.locked}`),
  );
  const fragment = document.createDocumentFragment();
  fragment.append(list, description);
  return fragment;
}

function renderPricingSearchActions(payload, results, countTag) {
  const wrapper = node('div', { class: 'pricing-search-actions' });
  const search = node('label', { class: 'surface-input pricing-search-input' });
  const input = node('input', {
    type: 'search',
    value: state.pricingQuery,
    placeholder: '模糊搜索模型名称',
    'aria-label': '模糊搜索模型名称',
  });
  input.addEventListener('input', () => {
    state.pricingQuery = input.value;
    renderPricingResults(payload, results, countTag);
  });
  search.append(icon('search'), input);

  const actions = node('div', { class: 'pricing-toolbar-actions' });
  const activeCount = [state.billing !== 'all', state.endpoint !== 'all', state.tag !== 'all'].filter(Boolean).length;
  const inlineOpen = state.advancedFiltersOpen && !isNarrowPricingViewport();
  const filter = surfaceButton(`筛选${activeCount ? ` (${activeCount})` : ''}${inlineOpen ? ' · 收起' : ''}`, 'surface-button', icon('sliders'));
  filter.setAttribute('data-pricing-filter-trigger', '');
  if (isNarrowPricingViewport()) filter.setAttribute('aria-haspopup', 'dialog');
  filter.setAttribute('aria-expanded', String(inlineOpen));
  filter.addEventListener('click', () => {
    if (isNarrowPricingViewport()) {
      openPricingFilterModal(payload, filter);
      return;
    }
    state.advancedFiltersOpen = !state.advancedFiltersOpen;
    void renderPricing();
  });
  const switcher = node('div', { class: 'pricing-view-switch', role: 'group', 'aria-label': '表格视图 / 卡片视图' });
  const viewButtons = [];
  const syncViewButtons = () => {
    viewButtons.forEach(([button, value]) => {
      const selected = state.viewMode === value;
      button.classList.toggle('is-primary', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  };
  [
    ['table', '表格视图', 'table'],
    ['card', '卡片视图', 'grid'],
  ].forEach(([value, label, iconName]) => {
    const active = state.viewMode === value;
    const button = surfaceButton(label, `surface-button${active ? ' is-primary' : ''}`, icon(iconName));
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      state.viewMode = value;
      // Only the result list is re-rendered here, so the switch keeps its own
      // selected state in step by hand.
      syncViewButtons();
      renderPricingResults(payload, results, countTag);
    });
    viewButtons.push([button, value]);
    switcher.append(button);
  });
  actions.append(filter, switcher);
  wrapper.append(search, actions);
  return wrapper;
}

function renderPricingAdvancedFilters(payload) {
  const panel = node('div', { class: 'pricing-advanced-filters' });
  const header = node('div', { class: 'pricing-advanced-header' });
  const reset = surfaceButton('重置', 'surface-button is-borderless');
  reset.addEventListener('click', () => {
    Object.assign(state, defaultPricingFilters(payload));
    void renderPricing();
  });
  header.append(node('span', {}, '筛选'), reset);
  panel.append(header);
  panel.append(renderPricingFilterControls(
    payload,
    currentPricingFilters(),
    (key, value) => {
      state[key] = value;
      void renderPricing();
    },
  ));
  return panel;
}

function renderPricingFilterControls(payload, values, onChange, includeLockedGroup = false) {
  const fragment = document.createDocumentFragment();
  if (includeLockedGroup) {
    fragment.append(
      renderLockedPricingFilterGroup(payload),
    );
  }
  const vendorModels = getOrdinaryUserModels(payload).filter((model) => String(model.vendor_id) === state.vendor);
  fragment.append(
    renderPricingFilterGroup('计费类型', [
      ['all', '全部类型'],
      ['per_token', '按量计费'],
      ['per_request', '按次计费'],
      ['tiered_expr', '动态计费'],
      ['codex_fast', 'Codex Fast'],
      ['video', '影片计费'],
    ], values.billing, (value) => onChange('billing', value), 'billing'),
  );
  const endpoints = [...new Set(vendorModels.flatMap((model) => model.supported_endpoint_types || []))].sort();
  fragment.append(renderPricingFilterGroup(
    '端点类型',
    [['all', '全部端点'], ...endpoints.map((value) => [value, value])],
    values.endpoint,
    (value) => onChange('endpoint', value),
    'endpoint',
  ));
  const tags = [...new Set(vendorModels.flatMap((model) => String(model.tags || '').split(/[,;|]+/).map((tag) => tag.trim()).filter(Boolean)))].sort();
  fragment.append(renderPricingFilterGroup(
    '标签',
    [['all', '全部标签'], ...tags.map((value) => [value.toLowerCase(), value])],
    values.tag,
    (value) => onChange('tag', value),
    'tag',
  ));
  fragment.append(
    renderPricingFilterGroup('货币单位', [
      ['CNY', 'CNY (¥)'],
      ['USD', 'USD ($)'],
      ['CUSTOM', `自定义货币 (${payload.display.custom_currency_symbol || '¤'})`],
    ], values.currency, (value) => onChange('currency', value), 'currency'),
    renderPricingFilterGroup('显示设置', [
      ['M', '按 1M 显示'],
      ['K', '按 1K 显示'],
    ], values.tokenUnit, (value) => onChange('tokenUnit', value), 'tokenUnit'),
    renderPricingFilterGroup('价格换算', [
      ['recharge', '充值价格显示'],
      ['base', '基础价格'],
    ], values.showWithRecharge ? 'recharge' : 'base', (value) => onChange('showWithRecharge', value === 'recharge'), 'showWithRecharge'),
  );
  return fragment;
}

function renderPricingFilterGroup(title, items, active, onChange, filterKey) {
  const group = node('section', { class: 'pricing-filter-group' });
  group.append(node('div', { class: 'pricing-filter-title' }, title));
  const options = node('div', { class: 'pricing-filter-options', role: 'group', 'aria-label': title });
  items.forEach(([value, label]) => {
    const selected = value === active;
    const button = surfaceButton(label, `pricing-filter-chip${selected ? ' is-active' : ''}`);
    button.setAttribute('data-filter-key', filterKey);
    button.setAttribute('data-filter-value', String(value));
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => {
      onChange(value);
    });
    options.append(button);
  });
  group.append(options);
  return group;
}

function renderLockedPricingFilterGroup(payload) {
  const group = node('section', { class: 'pricing-filter-group pricing-filter-group--locked' });
  group.append(node('div', { class: 'pricing-filter-title' }, '用户分组'));
  const options = node('div', { class: 'pricing-filter-options', role: 'group', 'aria-label': '用户分组' });
  const locked = surfaceButton(
    `${state.selectedGroup} · ${payload.context.locked ? '固定' : '可切换'} · ${formatNumber(payload.group_ratio[state.selectedGroup])}x`,
    'pricing-filter-chip is-active is-locked',
  );
  locked.setAttribute('data-pricing-filter-group', state.selectedGroup);
  locked.setAttribute('aria-pressed', 'true');
  locked.setAttribute('aria-disabled', 'true');
  locked.disabled = true;
  options.append(locked);
  group.append(options);
  return group;
}

function currentPricingFilters() {
  return {
    billing: state.billing,
    endpoint: state.endpoint,
    tag: state.tag,
    currency: state.currency,
    tokenUnit: state.tokenUnit,
    showWithRecharge: state.showWithRecharge,
    selectedGroup: state.selectedGroup,
  };
}

function defaultPricingFilters(payload) {
  return {
    billing: 'all',
    endpoint: 'all',
    tag: 'all',
    currency: payload.display.default_currency || 'CNY',
    tokenUnit: 'M',
    showWithRecharge: payload.display.show_with_recharge === true,
    selectedGroup: payload.context.selected_group,
  };
}

function isNarrowPricingViewport() {
  return pricingMobileMedia?.matches === true;
}

function openPricingFilterModal(payload, trigger) {
  closeSurfaceOverlay();
  trigger.setAttribute('aria-expanded', 'true');
  const dismiss = () => {
    closeSurfaceOverlay({ restoreFocus: false });
    void renderPricing().then(() => {
      document.querySelector('[data-pricing-filter-trigger]')?.focus();
    });
  };
  const dialog = createSurfaceDialog('筛选', 'pricing-filter-modal', false, dismiss);
  const body = node('div', { class: 'pricing-filter-modal-body' });
  const footer = node('footer', { class: 'pricing-filter-modal-footer' });
  const reset = surfaceButton('重置', 'surface-button');
  const confirm = surfaceButton('确定', 'surface-button is-primary');

  const draw = (focusKey, focusValue) => {
    body.replaceChildren(renderPricingFilterControls(
      payload,
      currentPricingFilters(),
      (key, value) => {
        if (key === 'selectedGroup') selectPricingGroup(payload, value);
        else state[key] = value;
        draw(key, value);
      },
      true,
    ));
    if (focusKey) {
      requestAnimationFrame(() => {
        [...body.querySelectorAll('[data-filter-key]')]
          .find((button) => (
            button.dataset.filterKey === focusKey &&
            button.dataset.filterValue === String(focusValue)
          ))
          ?.focus();
      });
    }
  };

  reset.addEventListener('click', () => {
    Object.assign(state, defaultPricingFilters(payload));
    draw();
  });
  confirm.addEventListener('click', dismiss);
  footer.append(reset, confirm);
  draw();
  dialog.content.append(body, footer);
  document.body.append(dialog.overlay);
  requestAnimationFrame(() => {
    body.querySelector('.pricing-filter-chip:not(:disabled)')?.focus();
  });
}

function getFilteredPricing(payload) {
  const vendorMap = new Map(payload.vendors.map((vendor) => [String(vendor.id), vendor]));
  const query = state.pricingQuery.trim().toLowerCase();
  return getOrdinaryUserModels(payload)
    .filter((model) => modelSupportsGroup(model, state.selectedGroup))
    .filter((model) => String(model.vendor_id || 'unknown') === state.vendor)
    .map((model) => ({
      model,
      vendor: vendorMap.get(String(model.vendor_id)),
      price: calculatePricingView(model, payload),
    }))
    .filter(({ model, vendor, price }) => {
      const matchesQuery = !query || [model.model_name, model.description, model.tags, vendor?.name]
        .join(' ')
        .toLowerCase()
        .includes(query);
      const matchesBilling = state.billing === 'all' || price.kind === state.billing;
      const matchesEndpoint = state.endpoint === 'all' || (model.supported_endpoint_types || []).includes(state.endpoint);
      const modelTags = String(model.tags || '').toLowerCase().split(/[,;|]+/).map((tag) => tag.trim());
      const matchesTag = state.tag === 'all' || modelTags.includes(state.tag);
      return matchesQuery && matchesBilling && matchesEndpoint && matchesTag;
    });
}

function selectPricingGroup(payload, group) {
  state.selectedGroup = group;
  const selectedVendorHasGroup = getOrdinaryUserModels(payload).some((model) =>
    String(model.vendor_id) === state.vendor && modelSupportsGroup(model, group),
  );
  if (!selectedVendorHasGroup) {
    const replacement = getOrdinaryUserModels(payload).find((model) => modelSupportsGroup(model, group));
    state.vendor = String(replacement?.vendor_id || state.vendor);
  }
}

function calculatePricingView(model, payload) {
  if (state.pricingMode === 'official') {
    return calculateModelPricing(model, payload, {
      pricingMode: 'official',
      selectedGroup: state.selectedGroup,
      currency: 'USD',
      tokenUnit: state.tokenUnit,
      show_with_recharge: false,
    });
  }
  return calculateModelPricing(model, payload, {
    pricingMode: 'group',
    selectedGroup: state.selectedGroup,
    currency: state.currency,
    tokenUnit: state.tokenUnit,
    show_with_recharge: state.showWithRecharge,
  });
}

function renderPricingResults(payload, container, countTag) {
  const calculated = getFilteredPricing(payload);
  countTag.textContent = `共 ${calculated.length} 个模型`;
  const groupCount = document.querySelector('.pricing-group-count');
  if (groupCount) groupCount.textContent = `共 ${calculated.length} 个模型`;
  container.replaceChildren();
  if (calculated.length === 0) {
    container.append(node('div', { class: 'pricing-empty-state' },
      node('strong', {}, '搜索无结果'),
      node('p', {}, '尝试清除搜索文字或更换筛选条件。'),
    ));
    return;
  }
  if (state.viewMode === 'card') container.append(renderPricingCards(calculated, payload));
  else container.append(renderPricingTable(calculated, payload));
}

function renderPricingTable(calculated, payload) {
  const wrap = node('div', { class: 'pricing-table-scroll' });
  const table = node('table', { class: 'pricing-model-table' });
  const head = node('thead');
  const headRow = node('tr');
  ['模型 ID', '档位', '输入价格', '输出价格', '缓存创建', '缓存读取', '其他价格', '倍率与优惠'].forEach((label) => {
    headRow.append(node('th', { scope: 'col' }, label));
  });
  head.append(headRow);
  const body = node('tbody');
  calculated.forEach(({ model, price, vendor }) => {
    const row = node('tr');
    const identity = node('td');
    const open = surfaceButton(model.model_name, 'pricing-model-link');
    open.addEventListener('click', () => openPricingDetail(model, price, vendor, payload));
    identity.append(open, node('small', {}, vendor?.name || '未知供应商'));
    row.append(
      identity,
      node('td', {}, renderPricingTierCell(price)),
      node('td', {}, renderPricingPriceCell(price, ['input', 'request'])),
      node('td', {}, renderPricingPriceCell(price, ['output', 'starting'])),
      node('td', {}, renderPricingPriceCell(price, ['cacheCreate', 'cacheCreate1h'])),
      node('td', {}, renderPricingPriceCell(price, ['cacheRead'])),
      node('td', {}, renderPricingExtraPriceCell(price)),
      node('td', {}, renderPricingComparison(payload)),
    );
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}

function renderPricingExtraPriceCell(price) {
  const extra = price.items.filter((item) => !['input', 'request', 'output', 'starting', 'cacheCreate', 'cacheCreate1h', 'cacheRead'].includes(item.key));
  if (extra.length === 0) return node('span', { class: 'pricing-empty-price' }, '—');
  const cell = node('div', { class: 'pricing-tier-extra-prices' });
  extra.forEach((item) => cell.append(node('div', { class: 'pricing-tier-extra-price' }, node('span', { class: 'pricing-tier-extra-label' }, item.label), node('strong', {}, item.formatted), node('span', { class: 'pricing-price-unit' }, `/ ${price.unit}`))));
  return cell;
}

function renderPricingTierCell(price) {
  const cell = node('div', { class: 'pricing-native-tier-cell' });
  cell.append(node('span', { class: `surface-tag billing-${price.kind}` }, billingLabel(price.kind)));
  if (price.kind === 'tiered_expr' || (price.kind === 'codex_fast' && price.parseComplete)) {
    cell.append(node('span', { class: 'pricing-native-tier-condition' }, price.parseComplete ? `${price.tiers.length} 个原生档位 · 需请求上下文` : '动态价格不可计算'));
  } else if (price.kind === 'codex_fast') {
    cell.append(node('span', { class: 'pricing-native-tier-condition' }, 'Fast 显式价格'));
  } else if (price.kind === 'video') {
    cell.append(node('span', { class: 'pricing-native-tier-condition' }, price.availability === 'available' ? `${price.rows.length} 个分辨率档位` : '影片价格不可计算'));
  }
  return cell;
}

function renderPricingPriceCell(price, keys) {
  const items = price.items.filter((candidate) => keys.includes(candidate.key));
  if (items.length === 0) {
    if (['tiered_expr', 'codex_fast'].includes(price.kind) && price.parseComplete) {
      return node('span', { class: 'pricing-context-required' }, '需请求上下文');
    }
    return node('span', { class: 'pricing-empty-price' }, '—');
  }
  const cell = node('div', { class: `pricing-price-cell${state.pricingMode === 'official' ? ' is-official' : ''}` });
  items.forEach((item) => cell.append(
    node('div', { class: 'pricing-price-item' },
      node('span', { class: 'pricing-tier-extra-label' }, item.label),
      node('strong', {}, item.formatted),
      node('span', { class: 'pricing-price-unit' }, `/ ${price.unit}`),
    ),
  ));
  cell.append(node('span', {}, state.pricingMode === 'official' ? '官方基础价格' : '实付金额'));
  return cell;
}

function renderPricingComparison(payload) {
  const cell = node('div', { class: 'pricing-comparison-cell' });
  const group = state.selectedGroup || payload.context.selected_group;
  const locked = payload.context.locked === true;
  if (state.pricingMode === 'official') {
    cell.append(
      node('strong', {}, '官方价格'),
      node('span', {}, `${group} · 官方倍率 1x${locked ? ' · 已锁定' : ''}`),
    );
  } else {
    cell.append(
      node('strong', {}, group),
      node('span', {}, `${formatNumber(payload.group_ratio[group])}x${locked ? ' · 已锁定' : ''}`),
      node('span', { class: 'pricing-comparison-formula' }, state.showWithRecharge ? '含充值换算' : '基础价格换算'),
    );
  }
  return cell;
}

function renderPricingCards(calculated, payload) {
  const view = node('div', { class: 'pricing-card-view' });
  const grid = node('div', { class: 'pricing-card-grid' });
  calculated.forEach(({ model, price, vendor }) => {
    const card = node('article', { class: 'pricing-model-card' });
    const header = node('header', { class: 'pricing-model-card-header' });
    const avatar = node('span', { class: 'pricing-model-avatar', 'aria-hidden': 'true' }, model.model_name.slice(0, 2).toUpperCase());
    const identity = node('div', { class: 'pricing-model-card-identity' });
    identity.append(
      node('h3', { class: 'pricing-model-name' }, model.model_name),
      node('div', { class: 'pricing-model-vendor' }, vendor?.name || '未知供应商'),
    );
    header.append(avatar, identity, node('span', { class: `surface-tag billing-${price.kind}` }, billingLabel(price.kind)));
    const priceBlock = node('div', { class: 'pricing-card-price-block' });
    priceBlock.append(renderPricingCardPriceLines(price));
    const description = node('div', { class: 'pricing-card-description' }, node('p', {}, model.description || ''));
    const tags = node('div', { class: 'pricing-card-tags' });
    String(model.tags || '').split(/[,;|]+/).map((tag) => tag.trim()).filter(Boolean).slice(0, 3).forEach((tag) => {
      tags.append(node('span', { class: 'surface-tag' }, tag));
    });
    const detail = surfaceButton('查看详情', 'surface-button pricing-detail-button');
    detail.addEventListener('click', () => openPricingDetail(model, price, vendor, payload));
    card.append(header, priceBlock, description, tags, renderPricingComparison(payload), detail);
    grid.append(card);
  });
  view.append(grid);
  return view;
}

function renderPricingCardPriceLines(price) {
  const lines = node('div', { class: 'pricing-card-price-lines' });
  if (price.availability === 'unavailable') {
    lines.append(node('p', { class: 'pricing-unavailable' }, price.unavailableReason || '价格不可计算。'));
    return lines;
  }
  if (price.kind === 'tiered_expr' || (price.kind === 'codex_fast' && price.parseComplete)) {
    lines.append(node('p', { class: 'pricing-context-required' }, '需按完整档位与请求上下文计算，不显示单一价格。'));
    return lines;
  }
  price.items.forEach((item) => {
    lines.append(node('div', { class: 'pricing-card-price-row' },
      node('span', {}, item.label),
      node('strong', {}, `${item.formatted} / ${price.unit}`),
    ));
  });
  if (price.items.length === 0) lines.append(node('span', { class: 'pricing-empty-price' }, '—'));
  return lines;
}

function openPricingDetail(model, price, vendor, payload) {
  closeSurfaceOverlay();
  const dialog = createSurfaceDialog(model.model_name, 'pricing-detail-sheet', true);
  const group = state.selectedGroup || payload.context.selected_group;
  dialog.content.append(
    node('p', { class: 'pricing-detail-vendor' }, vendor?.name || '未知供应商'),
    node('p', { class: 'pricing-detail-description' }, model.description || ''),
    node('div', { class: 'pricing-detail-context' },
      node('strong', {}, '价格上下文'),
      node('span', {}, `user_group=${payload.context.user_group} · selected_group=${group} · locked=${payload.context.locked} · effective_ratio=${formatNumber(state.pricingMode === 'official' ? 1 : payload.group_ratio[group])}`),
    ),
    renderPricingCardPriceLines(price),
  );
  if (price.kind === 'tiered_expr' || (price.kind === 'codex_fast' && price.parseComplete)) dialog.content.append(renderTierDetails(price));
  if (price.kind === 'video') dialog.content.append(renderVideoDetails(price));
  const endpoints = node('div', { class: 'pricing-detail-endpoints' });
  (model.supported_endpoint_types || []).forEach((endpoint) => {
    const detail = model.endpoint_map?.[endpoint] || payload.supported_endpoint?.[endpoint];
    const label = detail ? `${endpoint} · ${detail.method} ${detail.path}` : endpoint;
    endpoints.append(node('span', { class: 'surface-tag' }, label));
  });
  dialog.content.append(endpoints);
  document.body.append(dialog.overlay);
  requestAnimationFrame(() => dialog.panel.querySelector('button')?.focus());
}

function renderTierDetails(price) {
  const details = node('details', { class: 'native-pricing-details' });
  details.append(
    node(
      'summary',
      {},
      price.parseComplete
        ? `${price.tiers.length} 个完整原生档位（需请求上下文）`
        : '动态价格不可计算',
    ),
  );
  if (!price.parseComplete) {
    details.append(
      node(
        'p',
        {},
        `${price.unavailableReason || '表达式未能完整解析。'} 页面不会回退到 legacy quota_type。`,
      ),
    );
  } else {
    price.tiers.forEach((tier) => {
      const row = node('div', { class: 'tier-row' });
      row.append(
        node('strong', {}, tier.label || '未命名档位'),
        node('span', {}, tier.condition || '默认档位'),
        node('span', {}, tier.items.map((item) => `${item.label} ${item.formatted}`).join(' · ')),
      );
      details.append(row);
    });
    if (price.requestRule) {
      details.append(
        node(
          'p',
          { class: 'request-rule-note' },
          `请求规则可能应用 ${price.requestRule.multiplier}x 乘数；未提供请求上下文时不可得出最终价格。`,
        ),
      );
    }
  }
  return details;
}

function renderVideoDetails(price) {
  const details = node('details', { class: 'native-pricing-details' });
  details.append(
    node(
      'summary',
      {},
      price.availability === 'unavailable'
        ? '影片价格不可计算'
        : `查看分辨率价格矩阵（来源 ${price.sourceCurrency}）`,
    ),
  );
  if (price.availability === 'unavailable') {
    details.append(node('p', {}, price.unavailableReason));
    return details;
  }
  const rows = price.rows.map((row) => [
    row.dimensions ? `${row.resolution} · ${row.dimensions}` : row.resolution,
    row.withoutVideo.formatted,
    row.withVideo.formatted,
  ]);
  details.append(
    dataTable(
      ['分辨率', `无输入视频 / ${price.unit}`, `有输入视频 / ${price.unit}`],
      rows,
    ),
  );
  return details;
}

function dataTable(columns, rows) {
  const wrap = node('div', { class: 'table-wrap' });
  const table = node('table');
  const head = node('thead');
  const headerRow = node('tr');
  columns.forEach((column) => headerRow.append(node('th', { scope: 'col' }, column)));
  head.append(headerRow);
  const body = node('tbody');
  rows.forEach((row) => {
    const tr = node('tr');
    row.forEach((cell) => tr.append(node('td', {}, String(cell))));
    body.append(tr);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
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
