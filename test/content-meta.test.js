import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contentStatus,
  docsCatalogHasSlug,
  docsDefaultSlug,
  docsNavigationSlug,
} from '../public/static/content-meta.js';

test('content status metadata distinguishes validated live and fixture sources', () => {
  assert.deepEqual(
    contentStatus({
      source: 'newapi',
      fixture: false,
      live: true,
      label: 'NewAPI live content',
    }),
    {
      kind: 'live',
      label: 'NewAPI live content',
      badge: 'NewAPI · Live',
      sourceText: 'NewAPI（live）',
    },
  );
  assert.deepEqual(
    contentStatus({
      source: 'fixture',
      fixture: true,
      live: false,
      label: '演示价格数据',
    }),
    {
      kind: 'fixture',
      label: '演示价格数据',
      badge: 'Fixture · 非 live',
      sourceText: 'Fixture（非 live）',
    },
  );
});

test('content status metadata does not claim a source when flags disagree', () => {
  assert.equal(
    contentStatus({ source: 'newapi', fixture: true, live: true, label: 'bad' }).badge,
    'bad · 状态待确认',
  );
});

test('Docs navigation selects the first generated live catalog slug', () => {
  const catalog = {
    sections: [{
      title: 'Guides',
      items: [{
        slug: 'page-1785606868894-3673ea8d4916890d',
        title: 'Live quickstart',
        summary: 'Generated live page',
        keywords: [],
      }],
    }],
  };
  assert.equal(docsDefaultSlug(catalog), 'page-1785606868894-3673ea8d4916890d');
  assert.equal(
    docsCatalogHasSlug(catalog, 'page-1785606868894-3673ea8d4916890d'),
    true,
  );
  assert.equal(docsCatalogHasSlug(catalog, 'quickstart'), false);
});

test('Docs navigation preserves recursive page paths and group descendants', () => {
  const navigation = {
    navigation: [{
      type: 'group', id: 1, title: 'Guides', children: [{
        type: 'page', id: 2, slug: 'setup', path: 'setup', title: 'Setup', children: [{
          type: 'page', id: 3, slug: 'windows', path: 'setup/windows', title: 'Windows',
        }],
      }],
    }],
    sections: [],
    meta: { source: 'newapi', fixture: false, live: true },
  };
  assert.equal(docsDefaultSlug(navigation), 'setup');
  assert.equal(docsCatalogHasSlug(navigation, 'setup/windows'), true);
  assert.equal(docsCatalogHasSlug(navigation, 'windows'), true);
});

test('Docs navigation keeps the fixture fallback when a catalog has no pages', () => {
  assert.equal(docsDefaultSlug({ sections: [] }), 'quickstart');
});

test('Docs 404 navigation uses a generated live slug and never fabricates quickstart', () => {
  const liveCatalog = {
    success: true,
    data: {
      meta: { source: 'newapi', fixture: false, live: true },
      sections: [{
        title: 'Guides',
        items: [{ slug: 'page-1785606868894-3673ea8d4916890d', title: 'Live page' }],
      }],
    },
  };
  assert.equal(
    docsNavigationSlug(liveCatalog),
    'page-1785606868894-3673ea8d4916890d',
  );
  assert.equal(
    docsNavigationSlug({
      ...liveCatalog,
      data: { ...liveCatalog.data, sections: [] },
    }),
    null,
  );
  assert.equal(docsNavigationSlug(null), null);
  assert.equal(
    docsNavigationSlug({
      success: true,
      data: {
        meta: { source: 'fixture', fixture: true, live: false },
        sections: [],
      },
    }),
    'quickstart',
  );
});
