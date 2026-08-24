import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTENT_ADAPTER_LIVE,
  createDocsNavigationAdapter,
  createContentAdapter,
  createFixtureAdapter,
  createLiveContentAdapter,
  LIVE_CONTENT_MAX_BODY_BYTES,
  LIVE_CONTENT_DOCS_RENDERER_VERSION,
  LIVE_CONTENT_DOCS_SCHEMA_VERSION,
  LIVE_CONTENT_TIMEOUT_MS,
  LIVE_CONTENT_VPC_BINDING,
} from '../src/adapters/content-adapter.js';
import { HttpError } from '../src/http.js';

test('fixture adapter exposes a structured Docs catalog and pages', async () => {
  const adapter = createContentAdapter({ CONTENT_ADAPTER: 'fixture' });
  const catalog = await adapter.getDocsCatalog();

  assert.equal(adapter.name, 'fixture');
  assert.equal(adapter.live, false);
  assert.equal(catalog.meta.fixture, true);
  assert.equal(catalog.meta.live, false);
  assert.ok(catalog.sections.length >= 3);

  const temperature = catalog.search_index.find((entry) =>
    entry.text.includes('temperature'),
  );
  assert.equal(temperature.slug, 'chat-completions');
  assert.equal(temperature.anchor, 'body');

  const responsesEndpoint = catalog.search_index.find((entry) =>
    entry.text.includes('/v1/responses'),
  );
  assert.equal(responsesEndpoint.slug, 'responses');
  assert.equal(responsesEndpoint.anchor, 'responses-endpoint');
  assert.match(responsesEndpoint.target_title, /POST \/v1\/responses/);

  const quickstart = await adapter.getDocPage('quickstart');
  assert.equal(quickstart.page.title, '快速开始');
  assert.ok(quickstart.page.blocks.some((block) => block.type === 'code'));
});

test('fixture adapter returns independent payload copies', async () => {
  const adapter = createFixtureAdapter();
  const first = await adapter.getPricing();
  first.context.user_group = 'mutated';
  first.data[0].model_name = 'mutated';

  const second = await adapter.getPricing();
  assert.equal(second.context.user_group, 'default');
  assert.notEqual(second.data[0].model_name, 'mutated');
});

test('unknown adapters fail closed without inventing a live endpoint', () => {
  assert.throws(
    () => createContentAdapter({ CONTENT_ADAPTER: 'unconfigured' }),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal(error.details.live_integration, false);
      return true;
    },
  );
});

const liveToken = 'test-live-content-token-' + 'x'.repeat(32);

function liveResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-newapi-content-contract': 'v1',
      ...headers,
    },
  });
}

function liveNotModified(etag = '"docs-v1"') {
  return new Response(null, {
    status: 304,
    headers: { 'x-newapi-content-contract': 'v1', etag },
  });
}

function liveEnv(fetch) {
  return {
    CONTENT_ADAPTER: CONTENT_ADAPTER_LIVE,
    LIVE_CONTENT_ADAPTER_TOKEN: liveToken,
    [LIVE_CONTENT_VPC_BINDING]: { fetch },
  };
}

const liveMeta = (docs = false) => ({
  source: 'newapi', fixture: false, live: true,
  label: 'NewAPI live content', updated_at: null,
  contract_version: 'v1',
  ...(docs ? { schema_version: 1, renderer_version: 1 } : {}),
});

test('live adapter uses only the VPC binding and private GET contract', async () => {
  const calls = [];
  const liveDocsSlug = 'page-1785606868894-3673ea8d4916890d';
  const adapter = createContentAdapter(liveEnv(async (request) => {
    calls.push(request);
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [{ title: 'Guides', items: [{ slug: liveDocsSlug, title: 'Live quickstart', summary: 'Start here', keywords: [] }] }],
        search_index: [{ slug: liveDocsSlug, anchor: null, title: 'Live quickstart', target_title: 'Live quickstart', text: 'Start here' }],
      },
    });
  }));
  const catalog = await adapter.getDocsCatalog();
  assert.equal(adapter.name, CONTENT_ADAPTER_LIVE);
  assert.equal(adapter.live, true);
  assert.equal(catalog.sections[0].items[0].slug, liveDocsSlug);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(new URL(calls[0].url).hostname, 'newapi-api.newapi');
  assert.equal(new URL(calls[0].url).port, '3000');
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${liveToken}`);
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('if-none-match'), null);
});

test('Docs navigation adapter uses the approved token-only recursive endpoint', async () => {
  const seen = [];
  const payload = {
    success: true,
    data: [{
      type: 'group', id: 1, slug: 'guides', title: 'Guides',
      description: 'Public folder', space_id: 2, locale: 'zh', enabled: true,
      children: [{
        type: 'page', id: 2, slug: 'quickstart', path: 'guides/quickstart',
        title: 'Quickstart', space_id: 2, parent_id: 1, locale: 'zh',
        children: [{
          type: 'page', id: 3, slug: 'nested', path: 'guides/quickstart/nested',
          title: 'Nested', space_id: 2, parent_id: 2, locale: 'zh', children: [],
          private_secret: 'drop',
        }],
        private_secret: 'drop',
      }],
      private_secret: 'drop',
    }],
    private_secret: 'drop',
  };
  const adapter = createDocsNavigationAdapter(liveEnv(async (request) => {
    seen.push({
      path: new URL(request.url).pathname,
      search: new URL(request.url).search,
      method: request.method,
      headers: Object.fromEntries(request.headers),
    });
    return liveResponse(payload, 200, { etag: '"navigation-v1"' });
  }));
  const result = await adapter.getDocsNavigationResponse();
  assert.equal(adapter.name, 'docs-navigation-token');
  assert.equal(adapter.live, true);
  assert.equal(result.status, 200);
  assert.equal(result.etag, '"navigation-v1"');
  assert.equal(result.payload.data[0].children[0].children[0].path, 'guides/quickstart/nested');
  assert.doesNotMatch(JSON.stringify(result.payload), /private_secret/);
  assert.deepEqual(seen, [{
    path: '/api/internal/live-content/v1/docs/v2/navigation',
    search: '?locale=zh',
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${liveToken}` },
  }]);
});

test('Docs navigation adapter fails closed on schema drift and upstream failure', async () => {
  for (const response of [
    liveResponse({ success: true, data: [{ type: 'page', id: 1, slug: 'bad', title: 'Bad', space_id: 1, locale: 'zh' }] }),
    new Response('private upstream details', {
      status: 502,
      headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' },
    }),
  ]) {
    const adapter = createDocsNavigationAdapter(liveEnv(async () => response.clone()));
    await assert.rejects(
      () => adapter.getDocsNavigationResponse(),
      (error) => error instanceof HttpError && error.status === 503 &&
        ['invalid_upstream_schema', 'upstream_status'].includes(error.details.reason) &&
        !JSON.stringify(error).includes('private upstream details'),
    );
  }
});

test('live adapter forwards only a browser validator and preserves verified ETags', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [],
        search_index: [],
      },
    }, 200, { etag: '"catalog-v1"' });
  }));
  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: '"catalog-old"',
  });
  assert.equal(result.status, 200);
  assert.equal(result.etag, '"catalog-v1"');
  assert.equal(observed.headers.get('if-none-match'), '"catalog-old"');
  assert.equal(observed.headers.get('cookie'), null);
  assert.equal(observed.headers.get('x-api-key'), null);
  assert.equal(observed.headers.get('x-forwarded-authorization'), null);
});

test('live Docs keeps an upstream 200 body when its ETag matches the request', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveResponse({
      success: true,
      data: {
        meta: liveMeta(true),
        sections: [{ title: 'Guides', items: [] }],
        search_index: [],
      },
    }, 200, { etag: '"catalog-v1"' });
  }));

  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: '"catalog-v1"',
  });

  assert.equal(result.status, 200);
  assert.equal(result.etag, '"catalog-v1"');
  assert.deepEqual(result.payload.sections, [{ title: 'Guides', items: [] }]);
  assert.equal(observed.headers.get('if-none-match'), '"catalog-v1"');
});

test('matching live conditional responses preserve verified 304 semantics', async () => {
  let observed;
  const adapter = createLiveContentAdapter(liveEnv(async (request) => {
    observed = request;
    return liveNotModified('W/"catalog-v1"');
  }));
  const result = await adapter.getDocsCatalogResponse({
    ifNoneMatch: 'W/"catalog-v1"',
  });
  assert.deepEqual(result, {
    status: 304,
    payload: null,
    etag: 'W/"catalog-v1"',
  });
  assert.equal(observed.headers.get('if-none-match'), 'W/"catalog-v1"');
});

test('live Docs reject upstream 304 responses without a matching browser validator', async () => {
  for (const ifNoneMatch of [undefined, '"catalog-other"']) {
    const adapter = createLiveContentAdapter(liveEnv(async () => liveNotModified('"catalog-v1"')));
    await assert.rejects(
      () => adapter.getDocsCatalogResponse({ ifNoneMatch }),
      (error) =>
        error instanceof HttpError &&
        error.status === 503 &&
        error.details.reason === 'invalid_upstream_etag',
    );
  }
});

test('live adapter bounds upstream failures and redacts backend responses', async () => {
  for (const response of [
    liveResponse({ success: false, message: 'secret backend details' }, 503),
    new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('{bad', { status: 200, headers: { 'content-type': 'application/json', 'x-newapi-content-contract': 'v1' } }),
  ]) {
    const adapter = createContentAdapter(liveEnv(async () => response));
    await assert.rejects(
      () => adapter.getPricing(),
      (error) => error instanceof HttpError && error.status === 503 && error.message === 'Live content is temporarily unavailable.',
    );
  }
});

test('live document 404 stays a public not-found response', async () => {
  const adapter = createContentAdapter(liveEnv(async () =>
    liveResponse({ success: false, message: 'document page not found' }, 404),
  ));
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404 && error.message === 'Document page not found.',
  );
});

test('live document 404 fails closed when its contract is missing', async () => {
  const privateBody = 'private backend details';
  const adapter = createContentAdapter(liveEnv(async () => new Response(privateBody, {
    status: 404,
    headers: { 'content-type': 'text/plain' },
  })));
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) =>
      error instanceof HttpError &&
      error.status === 503 &&
      error.message === 'Live content is temporarily unavailable.' &&
      !JSON.stringify(error).includes(privateBody),
  );
});

test('live adapter aborts slow upstreams and rejects oversized bodies', async () => {
  const slow = createLiveContentAdapter(liveEnv(() => new Promise(() => {})), {
    timeoutMs: 10,
  });
  await assert.rejects(
    () => slow.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'upstream_timeout',
  );

  const oversized = createLiveContentAdapter(liveEnv(async () => new Response('x'.repeat(20), {
    headers: {
      'content-type': 'application/json',
      'x-newapi-content-contract': 'v1',
      'content-length': '20',
    },
  })), { maxBodyBytes: 10 });
  await assert.rejects(
    () => oversized.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_body',
  );
  assert.equal(LIVE_CONTENT_TIMEOUT_MS, 5_000);
  assert.equal(LIVE_CONTENT_MAX_BODY_BYTES, 2 * 1024 * 1024);
});

test('live adapter deadline covers a stalled response body and cancels its reader', async () => {
  let cancelled = false;
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"success":true'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const adapter = createLiveContentAdapter(liveEnv(async () =>
    new Response(stalled, {
      headers: {
        'content-type': 'application/json',
        'x-newapi-content-contract': 'v1',
      },
    }),
  ), { timeoutMs: 15 });
  await assert.rejects(
    () => adapter.getPricing(),
    (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'upstream_timeout',
  );
  assert.equal(cancelled, true);
});

test('live Docs require the exact supported schema and renderer versions', async () => {
  assert.equal(LIVE_CONTENT_DOCS_SCHEMA_VERSION, 1);
  assert.equal(LIVE_CONTENT_DOCS_RENDERER_VERSION, 1);
  for (const kind of ['catalog', 'page']) {
    for (const field of ['schema_version', 'renderer_version']) {
      const data = kind === 'catalog'
        ? {
            meta: { ...liveMeta(true), [field]: 99 },
            sections: [],
            search_index: [],
          }
        : {
            meta: { ...liveMeta(true), [field]: 99 },
            page: {
              slug: 'quickstart',
              title: 'Quickstart',
              summary: 'Start here',
              section: 'Guides',
              keywords: [],
              updated_at: 1,
              blocks: [],
            },
          };
      const adapter = createLiveContentAdapter(liveEnv(async () => liveResponse({
        success: true,
        data,
      })));
      await assert.rejects(
        () => kind === 'catalog'
          ? adapter.getDocsCatalog()
          : adapter.getDocPage('quickstart'),
        (error) => error instanceof HttpError && error.status === 503 && error.details.reason === 'invalid_upstream_schema',
      );
    }
  }
});

test('live Docs preserve an empty heading text while retaining heading validation', async () => {
  const liveDocsSlug = 'page-1785606868894-3673ea8d4916890d';
  const emptyHeading = {
    type: 'heading',
    id: 'final-heading',
    level: 2,
    text: '',
  };
  const pagePayload = (block = emptyHeading) => ({
    success: true,
    data: {
      meta: liveMeta(true),
      page: {
        slug: liveDocsSlug,
        title: 'Live page',
        summary: 'Live page summary',
        section: 'Guides',
        keywords: [],
        updated_at: 1,
        blocks: [block],
      },
    },
  });

  const adapter = createLiveContentAdapter(liveEnv(async () => liveResponse(pagePayload())));
  const page = await adapter.getDocPage(liveDocsSlug);
  assert.deepEqual(page.page.blocks, [emptyHeading]);

  for (const invalidBlock of [
    { ...emptyHeading, text: undefined },
    { ...emptyHeading, text: 0 },
    { ...emptyHeading, level: 1 },
    { ...emptyHeading, level: 4 },
    { ...emptyHeading, id: '' },
    { ...emptyHeading, id: 123 },
    { ...emptyHeading, id: undefined },
  ]) {
    const invalid = createLiveContentAdapter(liveEnv(async () => liveResponse(pagePayload(invalidBlock))));
    await assert.rejects(
      () => invalid.getDocPage(liveDocsSlug),
      (error) =>
        error instanceof HttpError &&
        error.status === 503 &&
        error.details.reason === 'invalid_upstream_schema',
    );
  }
});

test('unknown fixture document slugs return 404', async () => {
  const adapter = createFixtureAdapter();
  await assert.rejects(
    () => adapter.getDocPage('missing'),
    (error) => error instanceof HttpError && error.status === 404,
  );
});
