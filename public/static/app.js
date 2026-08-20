import {
  calculateModelPricing,
  getOrdinaryUserModels,
} from './pricing.js';

const state = {
  docsCatalog: null,
  pricing: null,
  integration: null,
  docsQuery: '',
  pricingQuery: '',
  vendor: 'all',
  billing: 'all',
  currency: 'CNY',
  tokenUnit: 'M',
  showWithRecharge: true,
};

const main = document.querySelector('#main-content');
let activeDocsSearchInput = null;

window.addEventListener('popstate', () => renderRoute());
document.addEventListener('keydown', (event) => {
  if (
    event.key === '/' &&
    activeDocsSearchInput?.isConnected &&
    !isTypingTarget(event.target)
  ) {
    event.preventDefault();
    activeDocsSearchInput.focus();
  }
});
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey) return;
  const target = new URL(link.href, window.location.href);
  if (target.origin !== window.location.origin) return;
  event.preventDefault();
  navigate(`${target.pathname}${target.search}`);
});

renderRoute();

async function renderRoute() {
  const path = normalizePath(window.location.pathname);
  activeDocsSearchInput = null;
  updateActiveNavigation(path);
  main.setAttribute('aria-busy', 'true');

  try {
    if (path === '/') {
      await renderHome();
    } else if (path === '/docs' || path.startsWith('/docs/')) {
      await renderDocs(path === '/docs' ? 'quickstart' : path.slice('/docs/'.length));
    } else if (path === '/pricing') {
      await renderPricing();
    } else {
      renderNotFound();
    }
  } catch (error) {
    renderError(error);
  } finally {
    main.removeAttribute('aria-busy');
  }
}

async function renderHome() {
  if (!state.integration) {
    state.integration = await api('/api/integrations/downloads');
  }
  document.title = 'JuAPI 开发者中心';
  const fragment = document.createDocumentFragment();
  const hero = node('section', { class: 'home-hero' });
  const eyebrow = node('div', { class: 'eyebrow' }, 'NEWAPI PUBLIC SURFACE');
  const heading = node('h1', {}, '把接口能力，变成清晰的开发体验。');
  const copy = node(
    'p',
    { class: 'home-lead' },
    '独立的 Cloudflare Worker 公共站点。第一阶段聚焦 Docs 与 Pricing，并把 live NewAPI 和既有下载 Worker 留在明确的 integration boundary 之后。',
  );
  const actions = node('div', { class: 'hero-actions' });
  actions.append(
    linkButton('/docs/quickstart', '开始阅读', 'primary'),
    linkButton('/pricing', '查看价格', 'secondary'),
  );
  hero.append(eyebrow, heading, copy, actions);

  const cards = node('section', {
    class: 'home-grid',
    'aria-label': '第一阶段功能',
  });
  cards.append(
    featureCard('01', 'Docs', '结构化导航、页内目录、搜索和可复制示例。', '/docs/quickstart', '打开文档'),
    featureCard('02', 'Pricing', '固定普通用户 default/default 上下文，沿用 NewAPI 价格字段和计算分支。', '/pricing', '打开价格'),
    statusCard(state.integration.data),
  );

  const boundary = node('section', { class: 'boundary-panel' });
  boundary.append(
    node('div', { class: 'eyebrow' }, 'PHASE 1 BOUNDARY'),
    node('h2', {}, '现在可验证，未来可替换。'),
    node(
      'p',
      {},
      '页面明确标识 fixture 来源；live adapter 不会在没有 service binding、私网连通性与已核对 API contract 时静默启用。下载、admin、R2、rollback 和微信群二维码继续由原 Worker 持有。',
    ),
  );
  fragment.append(hero, cards, boundary);
  replaceMain(fragment);
}

async function renderDocs(slug) {
  if (!state.docsCatalog) {
    state.docsCatalog = await api('/api/content/docs');
  }
  const response = await api(`/api/content/docs/${encodeURIComponent(slug)}`);
  const catalog = state.docsCatalog.data;
  const page = response.data.page;
  document.title = `${page.title} · JuAPI 文档`;

  const shell = node('div', { class: 'docs-shell' });
  const sidebar = renderDocsSidebar(catalog, slug);
  const article = node('article', { class: 'docs-article' });
  article.append(renderDataBadge(response.data.meta));
  const headingWrap = node('header', { class: 'article-header' });
  headingWrap.append(
    node('div', { class: 'article-kicker' }, page.section),
    node('h1', {}, page.title),
    node('p', {}, page.summary),
  );
  article.append(headingWrap);
  page.blocks.forEach((block) => article.append(renderDocBlock(block)));

  const toc = node('aside', { class: 'toc', 'aria-label': '本页目录' });
  toc.append(node('div', { class: 'toc-title' }, '本页目录'));
  const headings = page.blocks.filter((block) => block.type === 'heading');
  headings.forEach((heading) => {
    const anchor = node('a', { href: `#${heading.id}` }, heading.text.replace(/^\d+\.\s*/, ''));
    toc.append(anchor);
  });
  shell.append(sidebar, article, toc);
  replaceMain(shell);
}

function renderDocsSidebar(catalog, activeSlug) {
  const aside = node('aside', { class: 'docs-sidebar', 'aria-label': '文档导航' });
  const search = node('label', { class: 'search-field' });
  search.append(icon('search'), node('span', { class: 'sr-only' }, '搜索文档'));
  const input = node('input', {
    type: 'search',
    placeholder: '搜索文档',
    value: state.docsQuery,
    'aria-label': '搜索文档',
  });
  search.append(input, node('kbd', {}, '/'));
  aside.append(search);

  const navigation = node('nav', { class: 'docs-navigation' });
  const draw = () => {
    navigation.replaceChildren();
    const query = state.docsQuery.trim().toLowerCase();
    let matches = 0;
    catalog.sections.forEach((section) => {
      const items = section.items.filter((item) => {
        const haystack = [item.title, item.summary, ...(item.keywords || [])]
          .join(' ')
          .toLowerCase();
        return !query || haystack.includes(query);
      });
      if (items.length === 0) return;
      matches += items.length;
      const group = node('div', { class: 'docs-nav-group' });
      group.append(node('div', { class: 'docs-nav-title' }, section.title));
      items.forEach((item) => {
        const link = node(
          'a',
          {
            href: `/docs/${item.slug}`,
            'data-link': '',
            class: item.slug === activeSlug ? 'active' : '',
          },
          item.title,
        );
        group.append(link);
      });
      navigation.append(group);
    });
    if (matches === 0) {
      navigation.append(node('p', { class: 'empty-small' }, '没有匹配的文档。'));
    }
  };
  input.addEventListener('input', () => {
    state.docsQuery = input.value;
    draw();
  });
  activeDocsSearchInput = input;
  draw();
  aside.append(navigation);
  return aside;
}

function renderDocBlock(block) {
  switch (block.type) {
    case 'lead':
      return node('p', { class: 'doc-lead' }, block.text);
    case 'paragraph':
      return node('p', {}, block.text);
    case 'heading':
      return node(`h${block.level || 2}`, { id: block.id }, block.text);
    case 'callout': {
      const callout = node('aside', { class: `callout ${block.tone || 'info'}` });
      callout.append(node('strong', {}, block.title), node('p', {}, block.text));
      return callout;
    }
    case 'code':
      return codeBlock(block);
    case 'bullets': {
      const list = node('ul', { class: 'doc-list' });
      block.items.forEach((item) => list.append(node('li', {}, item)));
      return list;
    }
    case 'endpoint': {
      const endpoint = node('div', { class: 'endpoint' });
      endpoint.append(
        node('span', { class: 'method' }, block.method),
        node('code', {}, block.path),
        node('span', {}, block.text),
      );
      return endpoint;
    }
    case 'table':
      return dataTable(block.columns, block.rows);
    case 'link-cards': {
      const grid = node('div', { class: 'doc-link-grid' });
      block.items.forEach((item) => {
        const link = node('a', {
          href: `/docs/${item.slug}`,
          'data-link': '',
          class: 'doc-link-card',
        });
        link.append(node('strong', {}, item.title), node('span', {}, item.text), node('b', {}, '→'));
        grid.append(link);
      });
      return grid;
    }
    default:
      return node('div');
  }
}

async function renderPricing() {
  if (!state.pricing) {
    state.pricing = await api('/api/content/pricing');
    state.currency = state.pricing.display?.default_currency || 'CNY';
    state.showWithRecharge = state.pricing.display?.show_with_recharge === true;
  }
  const payload = state.pricing;
  document.title = '模型价格 · JuAPI 开发者中心';
  const fragment = document.createDocumentFragment();

  const intro = node('header', { class: 'pricing-intro' });
  const titleGroup = node('div');
  titleGroup.append(
    renderDataBadge(payload.meta),
    node('h1', {}, '模型价格'),
    node('p', {}, '在普通用户上下文中比较模型的输入、输出与原生计费方式。'),
  );
  const context = node('div', { class: 'context-lock' });
  context.append(
    node('span', { class: 'lock-icon', 'aria-hidden': 'true' }, '⌁'),
    node('div', {},
      node('small', {}, '固定价格上下文'),
      node('strong', {}, 'default / default'),
    ),
  );
  intro.append(titleGroup, context);
  fragment.append(intro);

  const notice = node('section', { class: 'pricing-notice' });
  notice.append(
    node('strong', {}, '第一阶段 fixture'),
    node('span', {}, payload.meta.notice),
    node('span', { class: 'formula' }, '按量输入价 = model_ratio × 2 × default group ratio'),
  );
  fragment.append(notice);

  const workspace = node('section', { class: 'pricing-workspace' });
  const toolbar = renderPricingToolbar(payload, () => redrawPricingResults(payload, results));
  const results = node('div', { class: 'pricing-results', 'aria-live': 'polite' });
  workspace.append(toolbar, results);
  fragment.append(workspace);
  replaceMain(fragment);
  redrawPricingResults(payload, results);
}

function renderPricingToolbar(payload, onChange) {
  const toolbar = node('div', { class: 'pricing-toolbar' });
  const search = node('label', { class: 'search-field pricing-search' });
  search.append(icon('search'), node('span', { class: 'sr-only' }, '搜索模型'));
  const input = node('input', {
    type: 'search',
    placeholder: '搜索模型、标签或能力',
    value: state.pricingQuery,
    'aria-label': '搜索模型',
  });
  input.addEventListener('input', () => {
    state.pricingQuery = input.value;
    onChange();
  });
  search.append(input);

  const models = getOrdinaryUserModels(payload);
  const vendorSelect = node('select', { 'aria-label': '供应商筛选' });
  vendorSelect.append(node('option', { value: 'all' }, '全部供应商'));
  const vendorIds = new Set(models.map((model) => String(model.vendor_id || 'unknown')));
  payload.vendors
    .filter((vendor) => vendorIds.has(String(vendor.id)))
    .forEach((vendor) => vendorSelect.append(node('option', { value: String(vendor.id) }, vendor.name)));
  vendorSelect.value = state.vendor;
  vendorSelect.addEventListener('change', () => {
    state.vendor = vendorSelect.value;
    onChange();
  });

  const billingSelect = node('select', { 'aria-label': '计费类型筛选' });
  [
    ['all', '全部计费'],
    ['per_token', '按量计费'],
    ['per_request', '按次计费'],
    ['tiered_expr', '动态计费'],
    ['video', '影片计费'],
  ].forEach(([value, label]) => billingSelect.append(node('option', { value }, label)));
  billingSelect.value = state.billing;
  billingSelect.addEventListener('change', () => {
    state.billing = billingSelect.value;
    onChange();
  });

  const toggles = node('div', { class: 'pricing-toggles' });
  toggles.append(
    segmentedControl('currency', [
      ['CNY', 'CNY'],
      ['USD', 'USD'],
      ['CUSTOM', payload.display?.custom_currency_symbol || 'CUSTOM'],
    ], state.currency, (value) => {
      state.currency = value;
      onChange();
    }),
    segmentedControl('unit', [
      ['M', '/ 1M'],
      ['K', '/ 1K'],
    ], state.tokenUnit, (value) => {
      state.tokenUnit = value;
      onChange();
    }),
    segmentedControl('recharge', [
      [true, '含充值换算'],
      [false, '基础价格'],
    ], state.showWithRecharge, (value) => {
      state.showWithRecharge = value;
      onChange();
    }),
  );
  toolbar.append(search, vendorSelect, billingSelect, toggles);
  return toolbar;
}

function redrawPricingResults(payload, container) {
  const vendorMap = new Map(payload.vendors.map((vendor) => [String(vendor.id), vendor]));
  const query = state.pricingQuery.trim().toLowerCase();
  const calculated = getOrdinaryUserModels(payload)
    .map((model) => ({
      model,
      price: calculateModelPricing(model, payload, {
        currency: state.currency,
        tokenUnit: state.tokenUnit,
        show_with_recharge: state.showWithRecharge,
      }),
    }))
    .filter(({ model, price }) => {
      const matchesQuery = !query || [model.model_name, model.description, model.tags]
        .join(' ')
        .toLowerCase()
        .includes(query);
      const matchesVendor = state.vendor === 'all' || String(model.vendor_id) === state.vendor;
      const matchesBilling = state.billing === 'all' || price.kind === state.billing;
      return matchesQuery && matchesVendor && matchesBilling;
    });

  container.replaceChildren();
  const summary = node('div', { class: 'results-summary' });
  summary.append(
    node('span', {}, `显示 ${calculated.length} 个模型`),
    node(
      'span',
      {},
      `普通用户 · default group ratio ${payload.group_ratio.default}x · ${state.showWithRecharge ? '含充值换算' : '基础价格'}`,
    ),
  );
  container.append(summary);

  if (calculated.length === 0) {
    container.append(node('div', { class: 'empty-state' },
      node('strong', {}, '没有匹配的模型'),
      node('p', {}, '尝试清除搜索文字或更换筛选条件。'),
    ));
    return;
  }

  const list = node('div', { class: 'pricing-list' });
  calculated.forEach(({ model, price }) => {
    list.append(pricingCard(model, price, vendorMap.get(String(model.vendor_id))));
  });
  container.append(list);
}

function pricingCard(model, price, vendor) {
  const card = node('article', { class: 'pricing-card' });
  const identity = node('div', { class: 'model-identity' });
  const monogram = node('span', { class: `model-monogram kind-${price.kind}` }, model.model_name.slice(0, 1).toUpperCase());
  const text = node('div');
  text.append(
    node('h2', {}, model.model_name),
    node('p', { class: 'model-vendor' }, vendor?.name || '未知供应商'),
  );
  identity.append(monogram, text);

  const tags = node('div', { class: 'model-tags' });
  tags.append(node('span', { class: 'billing-tag' }, billingLabel(price.kind)));
  String(model.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag && tag.toLowerCase() !== 'fixture')
    .slice(0, 2)
    .forEach((tag) => tags.append(node('span', {}, tag)));

  const heading = node('header', { class: 'pricing-card-header' });
  heading.append(identity, tags);
  card.append(heading, node('p', { class: 'model-description' }, model.description || ''));

  const priceGrid = node('div', { class: 'price-grid' });
  const items = price.items.slice(0, 4);
  if (price.availability === 'unavailable') {
    priceGrid.append(
      node(
        'div',
        { class: 'price-placeholder price-unavailable' },
        price.unavailableReason || '价格不可计算。',
      ),
    );
  } else if (price.kind === 'tiered_expr') {
    priceGrid.append(
      node(
        'div',
        { class: 'price-placeholder' },
        '需按完整档位与请求上下文计算，未选择上下文时不显示单一价格。',
      ),
    );
  } else if (items.length === 0) {
    priceGrid.append(node('div', { class: 'price-placeholder' }, '价格不可计算。'));
  } else {
    items.forEach((item) => {
      const entry = node('div', { class: 'price-item' });
      entry.append(
        node('span', {}, item.label),
        node('strong', {}, item.formatted),
        node('small', {}, `/ ${price.unit}`),
      );
      priceGrid.append(entry);
    });
  }
  card.append(priceGrid);

  if (price.kind === 'tiered_expr') card.append(renderTierDetails(price));
  if (price.kind === 'video') card.append(renderVideoDetails(price));

  const footer = node('footer', { class: 'pricing-card-footer' });
  footer.append(
    node('span', {}, `selected group: ${price.group}`),
    node('span', {}, `倍率 ${price.groupRatio}x`),
  );
  card.append(footer);
  return card;
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

function codeBlock(block) {
  const figure = node('figure', { class: 'code-block' });
  const caption = node('figcaption');
  caption.append(
    node('span', {}, block.label || block.language || 'Code'),
    copyButton(block.code),
  );
  const pre = node('pre');
  pre.append(node('code', { class: `language-${block.language || 'text'}` }, block.code));
  figure.append(caption, pre);
  return figure;
}

function copyButton(text) {
  const button = node('button', { type: 'button', class: 'copy-button' }, '复制');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
      toast('代码已复制');
      setTimeout(() => { button.textContent = '复制'; }, 1600);
    } catch {
      toast('复制失败，请手动选择代码');
    }
  });
  return button;
}

function renderDataBadge(meta) {
  const badge = node('span', { class: `data-badge ${meta.live ? 'live' : 'fixture'}` });
  badge.append(node('i', { 'aria-hidden': 'true' }), document.createTextNode(meta.label || meta.source));
  return badge;
}

function segmentedControl(name, options, active, onChange) {
  const group = node('div', { class: 'segmented', role: 'group', 'aria-label': name });
  options.forEach(([value, label]) => {
    const button = node('button', {
      type: 'button',
      class: active === value ? 'active' : '',
      'aria-pressed': active === value ? 'true' : 'false',
    }, label);
    button.addEventListener('click', () => {
      [...group.children].forEach((child) => {
        child.classList.remove('active');
        child.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      onChange(value);
    });
    group.append(button);
  });
  return group;
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

function statusCard(status) {
  const card = node('article', { class: 'feature-card status-card' });
  card.append(
    node('span', { class: 'feature-number' }, '03'),
    node('h2', {}, 'Downloads binding'),
    node('p', {}, '既有 Worker 保持独立；新站只保留 Cloudflare service binding 入口。'),
    node(
      'strong',
      { class: status.bound ? 'status-on' : 'status-off' },
      status.bound
        ? '已绑定 · 健康状态未探测'
        : status.configured
          ? '配置无效'
          : '待配置',
    ),
  );
  return card;
}

function linkButton(href, label, style) {
  return node('a', { href, 'data-link': '', class: `button ${style}` }, label);
}

function billingLabel(kind) {
  return {
    per_token: '按量计费',
    per_request: '按次计费',
    tiered_expr: '动态计费',
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
  if (name === 'search') {
    const svg = node('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.append(
      node('circle', { cx: '11', cy: '11', r: '6.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' }),
      node('path', { d: 'M16 16l4 4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' }),
    );
    return svg;
  }
  return node('span');
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
  replaceMain(node('section', { class: 'error-page' },
    node('span', {}, '404'),
    node('h1', {}, '没有找到这个页面'),
    node('p', {}, '链接可能已经移动，或者尚未在第一阶段开放。'),
    linkButton('/docs/quickstart', '返回文档', 'primary'),
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

async function api(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`API 返回了非 JSON 响应（${response.status}）。`);
  }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error?.message || body?.message || `请求失败（${response.status}）。`);
  }
  return body;
}

function updateActiveNavigation(path) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = path.startsWith(`/${link.dataset.nav}`);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function normalizePath(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function isTypingTarget(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function toast(message) {
  const region = document.querySelector('#toast-region');
  const item = node('div', { class: 'toast' }, message);
  region.append(item);
  setTimeout(() => item.remove(), 2200);
}
