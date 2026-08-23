/*
Copyright (C) 2025 QuantumNous

The Docs and Pricing surface renderers in this file adapt the user-facing
NewAPI SPA at commit 4d27865ce8342530f362595fdcd134eb83062a35. They remain
licensed under GNU AGPL v3 or later; see LICENSE and THIRD_PARTY_NOTICES.md.
The front-door home and header renderer are original to this Worker.
*/
import {
  calculateModelPricing,
  getOrdinaryUserModels,
  modelSupportsGroup,
} from './pricing.js';
import {
  DEFAULT_DOCS_SLUG,
  contentStatus,
  docsCatalogHasSlug,
  docsNavigationSlug,
} from './content-meta.js';

const PRICING_MOBILE_QUERY = '(max-width: 767px)';
const THEME_STORAGE_KEY = 'juapi-theme';
const PRICING_GROUP_DATA_ATTRIBUTE = ['data', 'pricing', 'group'].join('-');
const pricingMobileMedia = window.matchMedia?.(PRICING_MOBILE_QUERY) || null;

const state = {
  docsCatalog: null,
  docsNavigation: null,
  pricing: null,
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
const contentApiCache = new Map();

window.addEventListener('popstate', () => renderRoute());
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
  if (normalizePath(window.location.pathname) !== '/pricing' || !state.pricing) return;
  closeSurfaceOverlay({ restoreFocus: false });
  void renderPricing();
}

async function renderRoute() {
  let path = normalizePath(window.location.pathname);
  activeDocsSearchButton = null;
  activeDocsTocObserver?.disconnect();
  activeDocsTocObserver = null;
  closeSurfaceOverlay();
  updateActiveNavigation(path);
  main.setAttribute('aria-busy', 'true');

  try {
    if (path === '/docs') {
      const catalog = await ensureDocsCatalog();
      await ensureDocsNavigation();
      const slug = docsNavigationSlug(catalog);
      if (!slug) throw new Error('Docs catalog has no public pages.');
      path = docsPath(slug);
      window.history.replaceState(window.history.state, '', path);
    } else if (path.startsWith('/docs/')) {
      const requestedSlug = path.slice('/docs/'.length);
      const catalog = await ensureDocsCatalog();
      await ensureDocsNavigation();
      // Keep old fixture links stable while repairing the live legacy entrypoint.
      if (requestedSlug === DEFAULT_DOCS_SLUG && !docsCatalogHasSlug(catalog.data, requestedSlug)) {
        const slug = docsNavigationSlug(catalog);
        if (slug && slug !== requestedSlug) {
          path = docsPath(slug);
          window.history.replaceState(window.history.state, '', path);
        }
      }
    }
    if (path === '/') {
      await renderHome();
    } else if (path.startsWith('/docs/')) {
      await renderDocs(path.slice('/docs/'.length));
    } else if (path === '/pricing') {
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
  let pricingResponse = state.pricing;
  if (!pricingResponse) {
    const canonicalPricing = await api('/api/front-door/v1/pricing', { frontDoor: true }).catch((error) => {
      if (readBrowserUser()?.public_id) throw error;
      return null;
    });
    // The approved GetPricing alias intentionally returns the exact NewAPI
    // response. Its display settings are already loaded by the canonical SPA
    // status bootstrap; if that snapshot is absent, normalization fails closed
    // rather than inventing exchange rates or labels.
    state.frontDoorPricing = canonicalPricing;
    if (canonicalPricing && !canonicalPricing.context) {
      pricingResponse = normalizeFrontDoorPricing(canonicalPricing);
    } else {
      pricingResponse = canonicalPricing || await api('/api/content/pricing');
    }
  }
  if (!state.docsCatalog) state.docsCatalog = docsResponse;
  if (!state.pricing) state.pricing = pricingResponse;
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
  if (state.docsNavigation) return state.docsNavigation;
  try {
    state.docsNavigation = await api(
      '/api/front-door/v1/docs/v2/navigation?locale=zh',
      { frontDoor: true },
    );
    if (state.docsCatalog?.data && Array.isArray(state.docsNavigation?.data)) {
      state.docsCatalog.data.navigation = state.docsNavigation.data;
    }
  } catch (error) {
    // Anonymous/fixture browsing keeps the existing catalog navigation. A
    // normal-user session uses the canonical recursive response above.
    if (readBrowserUser()?.public_id) throw error;
    state.docsNavigation = null;
  }
  return state.docsNavigation;
}

async function renderDocs(slug) {
  await ensureDocsCatalog();
  await ensureDocsNavigation();
  const response = await api(`/api/content/docs/${encodeURIComponent(slug)}`);
  const catalog = state.docsCatalog.data;
  const page = response.data.page;
  document.title = `${page.title} · JuAPI 文档`;

  const shell = node('div', {
    class: 'newapi-surface docs-hub-shell',
    'data-docs-hub': '1',
    'data-content-source': response.data.meta.source,
  });
  const mobileBar = node('div', { class: 'docs-hub-mobile-bar' });
  const menuButton = surfaceButton('菜单', 'docs-hub-mobile-nav-btn', icon('menu'));
  menuButton.setAttribute('aria-label', '打开文档导航');
  const mobileTitle = node('span', { class: 'docs-hub-mobile-bar__title' }, page.title);
  const mobileSearch = surfaceButton('搜索', 'docs-hub-mobile-nav-btn', icon('search'));
  mobileSearch.setAttribute('aria-label', '搜索文档');
  mobileBar.append(menuButton, mobileTitle, mobileSearch);

  const sidebarWrap = node('div', { class: 'docs-hub-sidebar-wrap' });
  const backdrop = node('button', {
    type: 'button',
    class: 'docs-hub-sidebar-backdrop',
    'aria-label': '关闭文档导航',
  });
  const sidebar = renderDocsSidebar(catalog, slug, () => {
    sidebarWrap.classList.remove('is-open');
  }, state.docsNavigation?.data);
  sidebarWrap.append(backdrop, sidebar);

  const article = node('article', {
    class: 'docs-hub-canvas',
    id: 'docs-page-content',
  });
  const headingWrap = node('header', { class: 'docs-hub-page-header' });
  const breadcrumbs = node('nav', {
    class: 'docs-hub-breadcrumbs',
    'aria-label': '面包屑导航',
  });
  const docsHomeSlug = docsNavigationSlug(catalog);
  breadcrumbs.append(
    node('a', {
      href: docsHomeSlug ? docsPath(docsHomeSlug) : '/docs',
      'data-link': '',
    }, '开发文档'),
    node('span', { 'aria-hidden': 'true' }, '/'),
    node('span', {}, page.section),
    renderDataBadge(response.data.meta),
  );
  headingWrap.append(
    breadcrumbs,
    node('h1', { class: 'docs-hub-page-title' }, page.title),
    node('p', { class: 'docs-hub-page-summary' }, page.summary),
  );
  const blocks = node('div', { class: 'docs-block-renderer' });
  page.blocks.forEach((block) => blocks.append(renderDocBlock(block)));
  article.append(headingWrap, blocks, renderDocsPageNavigation(catalog, page));

  const headings = page.blocks.filter(
    (block) => block.type === 'heading' && [2, 3].includes(block.level || 2),
  );
  const mainColumn = node('div', { class: 'docs-hub-main' });
  mainColumn.append(article);
  if (headings.length > 0) mainColumn.append(renderDocsToc(headings));

  shell.append(mobileBar, sidebarWrap, mainColumn);
  replaceMain(shell);
  menuButton.addEventListener('click', () => sidebarWrap.classList.add('is-open'));
  backdrop.addEventListener('click', () => sidebarWrap.classList.remove('is-open'));
  mobileSearch.addEventListener('click', () => openDocsSearch(catalog));
  requestAnimationFrame(() => {
    scrollToCurrentHash();
    installDocsTocObserver();
  });
}

function renderDocsSidebar(catalog, activeSlug, onPageNavigate, navigation = null) {
  const aside = node('aside', { class: 'docs-hub-sidebar', 'aria-label': '文档导航' });
  const search = surfaceButton('搜索文档', 'docs-hub-sidebar-search', icon('search'));
  search.append(node('kbd', { 'aria-hidden': 'true' }, 'Ctrl K'));
  search.addEventListener('click', () => openDocsSearch(catalog));
  activeDocsSearchButton = search;
  aside.append(search, node('span', { class: 'docs-hub-rail-label' }, '开发文档'));

  const tree = node('nav', { class: 'docs-hub-tree-group' });
  if (Array.isArray(navigation) && navigation.length > 0) {
    tree.append(...renderDocsNavigationNodes(navigation, catalog, activeSlug, onPageNavigate));
  } else {
    catalog.sections.forEach((section, sectionIndex) => {
      const children = section.items.map((item) => ({
        type: 'page',
        id: `fixture-${sectionIndex}-${item.slug}`,
        slug: item.slug,
        path: item.slug,
        title: item.title,
        children: [],
      }));
      tree.append(...renderDocsNavigationNodes([
        { type: 'group', id: `fixture-${sectionIndex}`, title: section.title, children },
      ], catalog, activeSlug, onPageNavigate));
    });
  }
  aside.append(tree);
  return aside;
}

function renderDocsNavigationNodes(nodes, catalog, activeSlug, onPageNavigate) {
  return (nodes || []).map((item) => {
    if (item?.type === 'group') {
      const children = renderDocsNavigationNodes(item.children, catalog, activeSlug, onPageNavigate);
      const containsActive = children.some((child) => child.querySelector?.('[aria-current="page"]'));
      const group = node('div', { class: 'docs-hub-nav-group' });
      const groupId = `docs-navigation-group-${item.id}`;
      const groupButton = surfaceButton(item.title, 'docs-hub-group-label', icon('chevron'));
      groupButton.setAttribute('aria-expanded', String(containsActive));
      groupButton.setAttribute('aria-controls', groupId);
      groupButton.querySelector('svg')?.classList.toggle('is-open', containsActive);
      const childWrap = node('div', { id: groupId, role: 'group' });
      childWrap.hidden = !containsActive;
      childWrap.append(...children);
      groupButton.addEventListener('click', () => {
        if (containsActive) return;
        const nextOpen = childWrap.hidden;
        childWrap.hidden = !nextOpen;
        groupButton.setAttribute('aria-expanded', String(nextOpen));
        groupButton.querySelector('svg')?.classList.toggle('is-open', nextOpen);
      });
      group.append(groupButton, childWrap);
      return group;
    }
    const target = docsNavigationTarget(item, catalog);
    const active = target === activeSlug || item.path === activeSlug || item.slug === activeSlug;
    const wrapper = node('div');
    const button = surfaceButton(item.title, `docs-hub-tree-item${active ? ' is-active' : ''}`);
    if (active) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => {
      onPageNavigate?.();
      navigate(`/docs/${encodeURIComponent(target)}`);
    });
    wrapper.append(button);
    const nested = renderDocsNavigationNodes(item.children, catalog, activeSlug, onPageNavigate);
    if (nested.length) {
      const nestedWrap = node('div', { role: 'group', class: 'docs-hub-tree-nested' });
      nestedWrap.append(...nested);
      wrapper.append(nestedWrap);
    }
    return wrapper;
  });
}

function docsNavigationTarget(item, catalog) {
  const pages = (catalog?.sections || []).flatMap((section) => section.items || []);
  const direct = pages.find((page) => page.slug === item.slug || page.slug === item.path);
  const titled = pages.find((page) => page.title === item.title);
  return direct?.slug || titled?.slug || item.slug || item.path;
}

function renderDocBlock(block) {
  switch (block.type) {
    case 'lead':
      return node('p', { class: 'docs-page-lead' }, block.text);
    case 'paragraph':
      return node('p', {}, block.text);
    case 'heading':
      return node(`h${block.level || 2}`, { id: block.id }, block.text);
    case 'callout': {
      const tone = block.tone === 'fixture' ? 'warning' : block.tone || 'info';
      const callout = node('aside', { class: `docs-callout docs-callout--${tone}` });
      const body = node('div', { class: 'docs-callout__main' });
      body.append(
        node('div', { class: 'docs-callout__title' }, block.title),
        node('div', { class: 'docs-callout__body' }, node('p', {}, block.text)),
      );
      callout.append(node('span', { class: 'docs-callout__icon', 'aria-hidden': 'true' }, '●'), body);
      return callout;
    }
    case 'code':
      return codeBlock(block);
    case 'bullets': {
      const list = node('ul', { class: 'docs-list' });
      block.items.forEach((item) => list.append(node('li', {}, item)));
      return list;
    }
    case 'endpoint': {
      const endpoint = node('div', { class: 'docs-api-endpoint', id: block.id });
      const header = node('div', { class: 'docs-api-endpoint__header' });
      header.append(
        node('span', { class: 'docs-api-endpoint__method', 'data-method': block.method }, block.method),
        node('code', { class: 'docs-api-endpoint__path' }, block.path),
      );
      endpoint.append(
        header,
        node('p', { class: 'docs-api-endpoint__summary' }, block.text),
      );
      return endpoint;
    }
    case 'table':
      return docsDataTable(block.columns, block.rows);
    case 'link-cards': {
      const list = node('div', { class: 'docs-related-inline' });
      block.items.forEach((item) => {
        const link = node('a', {
          href: `/docs/${item.slug}`,
          'data-link': '',
          class: 'docs-doc-link',
        });
        link.append(
          icon('file'),
          node('span', { class: 'docs-doc-link__copy' },
            node('strong', { class: 'docs-doc-link__title' }, item.title),
            node('small', {}, item.text),
          ),
          node('span', { class: 'docs-doc-link__arrow', 'aria-hidden': 'true' }, '→'),
        );
        list.append(node('div', { class: 'docs-doc-link-row' }, link));
      });
      return list;
    }
    default:
      return node('div');
  }
}

function renderDocsToc(headings) {
  const toc = node('nav', { class: 'docs-hub-toc', 'aria-label': '本页目录' });
  toc.append(node('div', { class: 'docs-hub-toc-label' }, '本页目录'));
  const list = node('ul', { class: 'docs-hub-toc-list' });
  headings.forEach((heading, index) => {
    const link = node('a', {
      href: `#${encodeURIComponent(heading.id)}`,
      class: `docs-hub-toc-link${index === 0 ? ' is-active' : ''}`,
      ...(index === 0 ? { 'aria-current': 'true' } : {}),
    }, heading.text);
    list.append(node('li', { 'data-level': String(heading.level || 2) }, link));
  });
  toc.append(list);
  return toc;
}

function renderDocsPageNavigation(catalog, page) {
  const section = catalog.sections.find((item) => item.title === page.section);
  const index = section?.items.findIndex((item) => item.slug === page.slug) ?? -1;
  const previous = index > 0 ? section.items[index - 1] : null;
  const next = index >= 0 && index < section.items.length - 1 ? section.items[index + 1] : null;
  if (!previous && !next) return node('span');
  const nav = node('nav', { class: 'docs-hub-page-nav', 'aria-label': '文档翻页导航' });
  nav.append(
    previous
      ? docsPageNavLink(previous, '上一页', false)
      : node('span'),
    next
      ? docsPageNavLink(next, '下一页', true)
      : node('span'),
  );
  return nav;
}

function docsPageNavLink(item, direction, isNext) {
  const link = node('a', {
    href: `/docs/${item.slug}`,
    'data-link': '',
    class: isNext ? 'is-next' : '',
  });
  link.append(
    node('span', { class: 'docs-hub-page-nav__dir' }, isNext ? `${direction} →` : `← ${direction}`),
    node('span', { class: 'docs-hub-page-nav__title' }, item.title),
  );
  return link;
}

function openDocsSearch(catalog) {
  closeSurfaceOverlay();
  const dialog = createSurfaceDialog('搜索文档', 'docs-search-dialog');
  const inputWrap = node('label', { class: 'surface-input docs-search-input' });
  const input = node('input', {
    type: 'search',
    value: state.docsQuery,
    placeholder: '搜索标题、正文、接口路径…',
    'aria-label': '搜索文档',
  });
  inputWrap.append(icon('search'), input);
  const results = node('div', { class: 'docs-hub-search-results', 'aria-live': 'polite' });
  const draw = () => {
    state.docsQuery = input.value;
    results.replaceChildren();
    const query = state.docsQuery.trim().toLowerCase();
    if (!query) return;
    const matches = docsSearchEntries(catalog).filter((item) =>
      item.text.toLowerCase().includes(query),
    );
    matches.forEach((item) => {
      const href = docsSearchHref(item);
      const button = surfaceButton('', 'docs-hub-search-item');
      button.setAttribute('data-search-target', href);
      const title = node('span', { class: 'docs-hub-search-item__title' });
      appendHighlightedText(
        title,
        item.target_title === item.title
          ? item.title
          : `${item.title} · ${item.target_title}`,
        state.docsQuery,
      );
      const snippet = node('span', { class: 'docs-hub-search-item__snippet' });
      appendHighlightedText(snippet, item.text, state.docsQuery);
      button.append(title, snippet);
      button.addEventListener('click', () => {
        closeSurfaceOverlay();
        navigate(href);
      });
      results.append(button);
    });
    if (matches.length === 0) {
      results.append(node('p', { class: 'docs-hub-search-empty' }, '未找到匹配的文档'));
    }
  };
  input.addEventListener('input', draw);
  dialog.content.append(inputWrap, results);
  document.body.append(dialog.overlay);
  input.focus();
  draw();
}

function docsSearchEntries(catalog) {
  if (Array.isArray(catalog.search_index)) return catalog.search_index;
  return catalog.sections.flatMap((section) => section.items).map((item) => ({
    slug: item.slug,
    anchor: null,
    title: item.title,
    target_title: item.title,
    text: [item.title, item.summary, ...(item.keywords || [])].join(' '),
  }));
}

function docsSearchHref(item) {
  const anchor = item.anchor ? `#${encodeURIComponent(item.anchor)}` : '';
  return `/docs/${encodeURIComponent(item.slug)}${anchor}`;
}

function appendHighlightedText(container, text, query) {
  const source = String(text || '');
  const needle = String(query || '').trim();
  if (!needle) {
    container.append(source);
    return;
  }
  const lowerSource = source.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let cursor = 0;
  let matchIndex = lowerSource.indexOf(lowerNeedle);
  while (matchIndex >= 0) {
    container.append(source.slice(cursor, matchIndex));
    container.append(node('mark', {}, source.slice(matchIndex, matchIndex + needle.length)));
    cursor = matchIndex + needle.length;
    matchIndex = lowerSource.indexOf(lowerNeedle, cursor);
  }
  container.append(source.slice(cursor));
}

function scrollToCurrentHash() {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return;
  let id = raw;
  try { id = decodeURIComponent(raw); } catch { /* Preserve malformed hash text. */ }
  const target = document.getElementById(id);
  if (!target) return;
  target.classList.add('docs-hub-anchor-target');
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function installDocsTocObserver() {
  if (!window.IntersectionObserver) return;
  const links = [...document.querySelectorAll('.docs-hub-toc-link')];
  const targets = links.map((link) => document.getElementById(decodeURIComponent(link.hash.slice(1))));
  activeDocsTocObserver = new IntersectionObserver((entries) => {
    const visible = entries.find((entry) => entry.isIntersecting);
    if (!visible) return;
    links.forEach((link) => {
      const active = decodeURIComponent(link.hash.slice(1)) === visible.target.id;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-88px 0px -70% 0px' });
  targets.filter(Boolean).forEach((target) => activeDocsTocObserver.observe(target));
}

async function renderPricing() {
  if (!state.pricing) {
    const canonicalPricing = await api('/api/front-door/v1/pricing', { frontDoor: true }).catch((error) => {
      if (readBrowserUser()?.public_id) throw error;
      return null;
    });
    state.frontDoorPricing = canonicalPricing;
    if (canonicalPricing && !canonicalPricing.context) {
      state.pricing = normalizeFrontDoorPricing(canonicalPricing);
    } else {
      state.pricing = canonicalPricing || await api('/api/content/pricing');
    }
    state.currency = state.pricing.display?.default_currency || 'CNY';
    state.showWithRecharge = state.pricing.display?.show_with_recharge === true;
  }
  const payload = state.pricing;
  const models = getOrdinaryUserModels(payload);
  if (!state.selectedGroup || !(state.selectedGroup in (payload.usable_group || {}))) {
    state.selectedGroup = payload.context.selected_group || Object.keys(payload.usable_group || {})[0] || 'default';
  }
  const vendorIds = new Set(models.map((model) => String(model.vendor_id || 'unknown')));
  const vendors = payload.vendors.filter((vendor) => vendorIds.has(String(vendor.id)));
  if (!vendors.some((vendor) => String(vendor.id) === state.vendor)) {
    state.vendor = String(vendors[0]?.id || 'unknown');
  }
  document.title = '模型价格 · JuAPI 开发者中心';
  const shell = node('div', {
    class: 'newapi-surface pricing-page-shell',
    'data-pricing-surface': '1',
    'data-user-group': payload.context.user_group,
    'data-selected-group': payload.context.selected_group,
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
    payload.__frontDoor
      ? renderSessionPricingGroups(payload, calculated.length)
      : renderLockedPricingGroup(payload, calculated.length),
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

function normalizeFrontDoorPricing(payload) {
  const status = readBrowserStatus();
  if (!status || typeof status !== 'object') throw new Error('Canonical normal-user Pricing display status is unavailable.');
  const user = readBrowserUser();
  const availableGroups = Object.keys(payload.usable_group || {});
  const userGroup = availableGroups.includes(user?.group) ? user.group : availableGroups[0] || 'default';
  const quotaDisplayType = status.quota_display_type || 'USD';
  const usdExchangeRate = Number(status.usd_exchange_rate ?? status.price ?? 1);
  const price = Number(status.price ?? usdExchangeRate);
  return {
    ...payload,
    __frontDoor: true,
    meta: { source: 'newapi', fixture: false, live: true, label: 'NewAPI', updated_at: null, notice: '' },
    context: {
      user_group: userGroup,
      selected_group: userGroup,
      locked: false,
    },
    display: {
      quota_display_type: quotaDisplayType,
      default_currency: quotaDisplayType === 'TOKENS' ? 'USD' : 'CNY',
      price: Number.isFinite(price) && price > 0 ? price : 1,
      usd_exchange_rate: Number.isFinite(usdExchangeRate) && usdExchangeRate > 0 ? usdExchangeRate : 1,
      custom_currency_exchange_rate: Number(status.custom_currency_exchange_rate) > 0 ? Number(status.custom_currency_exchange_rate) : 1,
      custom_currency_symbol: String(status.custom_currency_symbol || '¤'),
      show_with_recharge: quotaDisplayType !== 'TOKENS',
    },
  };
}

function readBrowserStatus() {
  try {
    const raw = window.localStorage.getItem('status');
    const status = raw ? JSON.parse(raw) : null;
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
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
  const group = state.selectedGroup || payload.context.selected_group || 'default';
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
  const card = surfaceButton('', 'pricing-group-card is-active is-locked');
  card.setAttribute('data-pricing-group', 'default');
  card.setAttribute('aria-pressed', 'true');
  card.setAttribute('aria-disabled', 'true');
  card.disabled = true;
  card.append(
    node('span', { class: 'pricing-group-name' }, 'default'),
    node('span', { class: 'pricing-group-rate' }, '当前普通用户分组（固定）'),
    node('span', { class: 'pricing-group-formula' }, `官方价 × ${formatNumber(payload.group_ratio.default)}x`),
    node('span', { class: 'pricing-group-meter', 'aria-hidden': 'true' },
      node('span', { class: 'pricing-group-meter-fill pricing-group-meter-fill-locked' }),
    ),
    node('span', { class: 'pricing-group-count' }, `共 ${count} 个模型`),
  );
  list.append(card);
  const description = node('div', { class: 'pricing-group-description' });
  description.append(
    node('strong', {}, 'default'),
    node('span', {}, `${payload.usable_group.default} · user_group=default · selected_group=default · locked=true`),
  );
  const fragment = document.createDocumentFragment();
  fragment.append(list, description);
  return fragment;
}

function renderSessionPricingGroups(payload, count) {
  const list = node('div', { class: 'pricing-group-list', 'aria-label': '可用令牌分组' });
  Object.keys(payload.usable_group || {}).forEach((group) => {
    const active = group === state.selectedGroup;
    const card = surfaceButton('', `pricing-group-card${active ? ' is-active' : ''}`);
    card.setAttribute(PRICING_GROUP_DATA_ATTRIBUTE, group);
    card.setAttribute('aria-pressed', String(active));
    card.append(
      node('span', { class: 'pricing-group-name' }, group),
      node('span', { class: 'pricing-group-rate' }, payload.usable_group[group]),
      node('span', { class: 'pricing-group-formula' }, `官方价 × ${formatNumber(payload.group_ratio[group])}x`),
      node('span', { class: 'pricing-group-count' }, `共 ${getOrdinaryUserModels(payload).filter((model) => modelSupportsGroup(model, group)).length} 个模型`),
    );
    card.addEventListener('click', () => {
      state.selectedGroup = group;
      void renderPricing();
    });
    list.append(card);
  });
  return list;
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
  if (includeLockedGroup) fragment.append(renderLockedPricingFilterGroup(payload));
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
    `default · 固定 · ${formatNumber(payload.group_ratio.default)}x`,
    'pricing-filter-chip is-active is-locked',
  );
  locked.setAttribute('data-pricing-filter-group', 'default');
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
        state[key] = value;
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
  const item = price.items.find((candidate) => keys.includes(candidate.key));
  if (!item) {
    if (['tiered_expr', 'codex_fast'].includes(price.kind) && price.parseComplete) {
      return node('span', { class: 'pricing-context-required' }, '需请求上下文');
    }
    return node('span', { class: 'pricing-empty-price' }, '—');
  }
  const cell = node('div', { class: `pricing-price-cell${state.pricingMode === 'official' ? ' is-official' : ''}` });
  cell.append(
    node('strong', {}, item.formatted),
    node('span', { class: 'pricing-price-unit' }, `/ ${price.unit}`),
    node('span', {}, state.pricingMode === 'official' ? '官方基础价格' : '实付金额'),
  );
  return cell;
}

function renderPricingComparison(payload) {
  const cell = node('div', { class: 'pricing-comparison-cell' });
  if (state.pricingMode === 'official') {
    cell.append(
      node('strong', {}, '官方价格'),
      node('span', {}, 'default · 官方倍率 1x · 已锁定'),
    );
  } else {
    cell.append(
      node('strong', {}, 'default'),
      node('span', {}, `${formatNumber(payload.group_ratio.default)}x · 已锁定`),
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
  price.items.slice(0, 4).forEach((item) => {
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
  dialog.content.append(
    node('p', { class: 'pricing-detail-vendor' }, vendor?.name || '未知供应商'),
    node('p', { class: 'pricing-detail-description' }, model.description || ''),
    node('div', { class: 'pricing-detail-context' },
      node('strong', {}, '价格上下文'),
      node('span', {}, `user_group=default · selected_group=default · locked=true · effective_ratio=${formatNumber(state.pricingMode === 'official' ? 1 : payload.group_ratio.default)}`),
    ),
    renderPricingCardPriceLines(price),
  );
  if (price.kind === 'tiered_expr' || (price.kind === 'codex_fast' && price.parseComplete)) dialog.content.append(renderTierDetails(price));
  if (price.kind === 'video') dialog.content.append(renderVideoDetails(price));
  const endpoints = node('div', { class: 'pricing-detail-endpoints' });
  (model.supported_endpoint_types || []).forEach((endpoint) => endpoints.append(node('span', { class: 'surface-tag' }, endpoint)));
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

function docsDataTable(columns, rows) {
  const wrap = node('div', { class: 'docs-table-wrap' });
  const table = node('table', { class: 'docs-table' });
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

function codeBlock(block) {
  const figure = node('figure', { class: 'docs-code-group' });
  const caption = node('figcaption', { class: 'docs-code-group__header' });
  caption.append(
    node('span', { class: 'docs-code-group__title' },
      icon('code'),
      node('span', { class: 'docs-code-group__title-text' }, block.label || block.language || 'Code'),
    ),
    node('span', { class: 'docs-code-group__badge docs-code-group__badge--lang' }, block.language || 'text'),
    copyButton(block.code),
  );
  const pre = node('pre', { class: 'docs-code-group__pre', tabindex: '0' });
  pre.append(node('code', { class: `language-${block.language || 'text'}` }, block.code));
  figure.append(caption, pre);
  return figure;
}

function copyButton(text) {
  const button = node('button', { type: 'button', class: 'docs-code-group__copy', 'aria-label': '复制代码' }, '复制');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
      button.dataset.state = 'copied';
      toast('代码已复制');
      setTimeout(() => {
        button.textContent = '复制';
        delete button.dataset.state;
      }, 1600);
    } catch {
      button.dataset.state = 'failed';
      toast('复制失败，请手动选择代码');
    }
  });
  return button;
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
  const cached = contentApiCache.get(path);
  const headers = new Headers({ accept: 'application/json' });
  if (cached?.etag) headers.set('if-none-match', cached.etag);
  if (options.frontDoor) {
    const user = readBrowserUser();
    if (user?.public_id) headers.set('new-api-user', user.public_id);
  }
  const response = await fetch(path, {
    headers,
    ...(path.startsWith('/api/content/') ? { cache: 'no-cache' } : {}),
  });
  if (response.status === 304 && cached) return cached.body;
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`API 返回了非 JSON 响应（${response.status}）。`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error?.message || body?.message || `请求失败（${response.status}）。`);
  }
  if (path.startsWith('/api/content/')) {
    contentApiCache.set(path, {
      body,
      etag: response.headers.get('etag'),
    });
  }
  return body;
}

function readBrowserUser() {
  try {
    const raw = window.localStorage.getItem('user');
    const user = raw ? JSON.parse(raw) : null;
    return user && typeof user === 'object' ? user : null;
  } catch {
    return null;
  }
}

function updateActiveNavigation(path) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active =
      link.dataset.nav === 'home'
        ? path === '/'
        : path.startsWith(`/${link.dataset.nav}`);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
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
