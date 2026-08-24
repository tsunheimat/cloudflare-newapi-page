import { docsFixture } from '../fixtures/docs.js';
import { createContentAdapter, CONTENT_ADAPTER_LIVE } from './content-adapter.js';

const FIXTURE_SPACE = Object.freeze({
  id: 1,
  slug: 'quickstart',
  title: '开发文档',
  description: 'Worker DocsHub fixture',
  icon_key: 'book-open',
  sort_order: 1,
});

export function createDocsHubAdapter(env = {}) {
  const mode = String(env.CONTENT_ADAPTER || 'fixture').trim().toLowerCase();
  if (mode === CONTENT_ADAPTER_LIVE) {
    const adapter = createContentAdapter(env);
    return {
      live: true,
      async getResponse(path, options = {}) {
        return adapter.getDocsV2Response(path, options);
      },
      async getAssetResponse(id, options = {}) {
        return adapter.getDocsV2AssetResponse(id, options);
      },
    };
  }
  if (mode !== 'fixture') throw new Error(`Content adapter "${mode}" is not configured.`);
  return {
    live: false,
    async getResponse(path) {
      return { status: 200, payload: fixtureDocsV2(path), etag: null };
    },
    async getAssetResponse() {
      return { status: 404, body: null, etag: null, contentType: 'application/json' };
    },
  };
}

function fixtureDocsV2(path) {
  const url = new URL(path, 'https://worker.invalid');
  const pathname = url.pathname;
  const locale = url.searchParams.get('locale') || 'zh';
  if (pathname.endsWith('/config')) {
    return { success: true, data: { enabled: true, require_auth: false, schema_version: 1, renderer_version: 1, default_locale: 'zh', supported_ui_locales: ['zh', 'en', 'fr', 'ru', 'ja', 'vi'], content_locales: ['zh', 'en'] } };
  }
  if (pathname.endsWith('/spaces')) return { success: true, data: [{ ...FIXTURE_SPACE }] };
  if (pathname.endsWith('/tree')) return { success: true, data: fixtureTree() };
  if (pathname.endsWith('/navigation')) return { success: true, data: fixtureNavigation() };
  if (pathname.endsWith('/featured') || pathname.endsWith('/recent')) return { success: true, data: [] };
  if (pathname.endsWith('/redirect')) return { success: true, data: { to_path: '/docs/quickstart' } };
  if (pathname.endsWith('/search')) {
    const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase();
    const data = docsFixture.search_index
      .filter((record) => !query || `${record.title} ${record.target_title} ${record.text}`.toLocaleLowerCase().includes(query))
      .slice(0, 20)
      .map((record, index) => ({
        page_id: docsFixture.pages.findIndex((page) => page.slug === record.slug) + 1 || index + 1,
        title: record.title,
        summary: docsFixture.pages.find((page) => page.slug === record.slug)?.summary || '',
        snippet: record.text,
        anchor: record.anchor,
        locale,
        path: `/docs/${FIXTURE_SPACE.slug}/${record.slug}`,
        space: FIXTURE_SPACE.slug,
      }));
    return { success: true, data };
  }
  if (pathname.includes('/pages/by-id/')) {
    const id = Number(pathname.split('/').pop());
    const page = docsFixture.pages[id - 1];
    return page ? { success: true, data: fixturePage(page, id) } : { success: false, message: 'page not found' };
  }
  if (pathname.includes('/pages/')) {
    const pageSlug = url.searchParams.get('path') || decodeURIComponent(pathname.split('/pages/')[1] || '');
    const page = docsFixture.pages.find((candidate) => candidate.slug === pageSlug.split('/').pop());
    return page ? { success: true, data: fixturePage(page, docsFixture.pages.indexOf(page) + 1) } : { success: false, message: 'page not found' };
  }
  return { success: false, message: 'DocsHub route not found.' };
}

function fixtureNavigation() {
  return docsFixture.sections.map((section, sectionIndex) => ({
    type: 'group',
    id: sectionIndex + 1,
    title: section.title,
    children: section.items.map((item) => ({
      type: 'page',
      id: docsFixture.pages.findIndex((page) => page.slug === item.slug) + 1,
      slug: item.slug,
      path: item.slug,
      title: item.title,
      locale: 'zh',
      children: [],
    })),
  }));
}

function fixtureTree() {
  return docsFixture.pages.map((page, index) => ({
    id: index + 1,
    space_id: FIXTURE_SPACE.id,
    parent_id: 0,
    slug: page.slug,
    path: page.slug,
    title: page.title,
    summary: page.summary,
    locale: 'zh',
    children: [],
  }));
}

function fixturePage(page, id) {
  const content = {
    schema_version: 1,
    renderer_version: 1,
    blocks: page.blocks.map((block) => fixtureBlock(block)),
  };
  return {
    id,
    space_id: FIXTURE_SPACE.id,
    space_slug: FIXTURE_SPACE.slug,
    parent_id: 0,
    slug: page.slug,
    title: page.title,
    summary: page.summary,
    icon_key: '',
    locale: 'zh',
    featured: false,
    path: `/docs/${FIXTURE_SPACE.slug}/${page.slug}`,
    content,
    updated_at: 0,
    related: [],
  };
}

function fixtureBlock(block) {
  switch (block.type) {
    case 'lead':
    case 'paragraph':
      return { type: block.type, content: [{ type: 'text', text: block.text, styles: {} }], props: {} };
    case 'heading':
      return { type: 'heading', id: block.id, content: [{ type: 'text', text: block.text, styles: {} }], props: { level: block.level, anchor: block.id } };
    case 'callout':
      return { type: 'callout', content: [{ type: 'text', text: block.text, styles: {} }], props: { variant: block.tone === 'fixture' ? 'warning' : block.tone, title: block.title } };
    case 'code':
      return { type: 'codeGroup', content: [], props: { tabs: [{ language: block.language, label: block.label, code: block.code }] } };
    case 'bullets':
      return { type: 'bulletListItem', content: [{ type: 'text', text: block.items.join('\n'), styles: {} }], props: {} };
    case 'endpoint':
      return { type: 'apiEndpoint', content: [], props: { method: block.method, path: block.path, summary: block.text, anchor: block.id } };
    case 'table':
      return { type: 'table', content: [], props: { rows: [block.columns, ...block.rows].map((cells) => ({ cells: cells.map((text) => ({ text })) })), headerRows: 1, headerCols: 0 } };
    case 'link-cards':
      return { type: 'paragraph', content: [{ type: 'text', text: block.items.map((item) => `${item.title}: ${item.text}`).join(' · '), styles: {} }], props: {} };
    default:
      return { type: 'paragraph', content: [], props: {} };
  }
}
