import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDocsAwareShellNavigator,
  createDocsPreloadManager,
  installDocsPreloadFetchBridge,
} from '../public/static/docs-lifecycle.js';

test('Docs preload manager coalesces initial resources and exposes deterministic lifecycle states', async () => {
  const pending = new Map();
  const calls = [];
  const fetchImpl = (path) => {
    calls.push(path);
    return new Promise((resolve, reject) => pending.set(path, { resolve, reject }));
  };
  const manager = createDocsPreloadManager({
    fetchImpl,
    windowObject: { location: { href: 'https://juaiapi.wdtokenacc.top/' } },
    requests: ['/api/docs/v2/config', '/api/docs/v2/spaces?locale=zh'],
  });

  manager.start();
  assert.deepEqual(manager.status(), {
    '/api/docs/v2/config': 'pending',
    '/api/docs/v2/spaces?locale=zh': 'pending',
  });
  manager.start();
  assert.equal(calls.length, 2, 'repeated starts must not duplicate requests');

  pending.get('/api/docs/v2/config').resolve(new Response(JSON.stringify({ success: true, data: { version: 1 } }), {
    headers: { 'content-type': 'application/json' },
  }));
  pending.get('/api/docs/v2/spaces?locale=zh').reject(new Error('offline'));
  await Promise.all([
    manager.responseFor('/api/docs/v2/config'),
    manager.responseFor('/api/docs/v2/spaces?locale=zh'),
  ]);
  assert.equal(manager.status()['/api/docs/v2/config'], 'success');
  assert.equal(manager.status()['/api/docs/v2/spaces?locale=zh'], 'failure');
  assert.doesNotMatch(JSON.stringify(manager.requests), /pricing/i);
});

test('Docs preload fetch bridge reuses a successful response and falls back for uncached paths', async () => {
  const calls = [];
  const originalFetch = async (path) => {
    calls.push(String(path));
    return new Response(JSON.stringify({ success: true, source: 'network' }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const windowObject = {
    location: { href: 'https://juaiapi.wdtokenacc.top/' },
    fetch: originalFetch,
  };
  const manager = createDocsPreloadManager({
    fetchImpl: originalFetch,
    windowObject,
    requests: ['/api/docs/v2/config'],
  });
  installDocsPreloadFetchBridge({ windowObject, manager });
  manager.start();
  const [preloaded, uncached] = await Promise.all([
    windowObject.fetch('/api/docs/v2/config'),
    windowObject.fetch('/api/docs/v2/pages/quickstart'),
  ]);
  assert.deepEqual(await preloaded.json(), { success: true, source: 'network' });
  assert.deepEqual(await uncached.json(), { success: true, source: 'network' });
  assert.equal(calls.length, 2, 'the preload request and one uncached request are expected');
});

test('Docs shell re-entry synchronizes a mounted router and browser history', async () => {
  const windowObject = new FakeWindow('/docs/quickstart/quickstart');
  const canonicalDocsMounted = true;
  let docsRootAttached = true;
  let docsRouterPath = windowObject.location.pathname;
  const renderCalls = [];

  windowObject.addEventListener('popstate', () => {
    docsRouterPath = windowObject.location.pathname;
    docsRootAttached = windowObject.location.pathname.startsWith('/docs');
  });

  const navigate = createDocsAwareShellNavigator({
    windowObject,
    isDocsPath: (path) => path === '/docs' || path.startsWith('/docs/'),
    isCanonicalDocsMounted: () => canonicalDocsMounted,
    renderRoute: () => {
      renderCalls.push(windowObject.location.pathname);
      // The shell removes the Docs root on leave but keeps the mounted
      // BrowserRouter alive for a later re-entry.
      docsRootAttached = windowObject.location.pathname.startsWith('/docs');
    },
  });

  await navigate('/');
  assert.deepEqual(renderCalls, ['/']);
  assert.equal(windowObject.location.pathname, '/');
  assert.equal(docsRootAttached, false);
  assert.equal(docsRouterPath, '/docs/quickstart/quickstart');
  assert.deepEqual(windowObject.popstatePaths, []);

  // Re-enter at a different Docs route. The shell render reattaches the
  // existing root, and the navigator emits the history event that updates the
  // embedded BrowserRouter to the new URL.
  const reentry = navigate('/docs/api-reference/responses');
  assert.deepEqual(windowObject.popstatePaths, []);
  await reentry;
  assert.deepEqual(renderCalls, ['/', '/docs/api-reference/responses']);
  assert.equal(windowObject.location.pathname, '/docs/api-reference/responses');
  assert.equal(docsRootAttached, true);
  assert.deepEqual(windowObject.popstatePaths, ['/docs/api-reference/responses']);
  assert.equal(docsRouterPath, '/docs/api-reference/responses');

  // Browser Back/Forward dispatches the same transition signal and keeps the
  // shell URL and embedded router location coherent in both directions.
  windowObject.history.back();
  assert.equal(windowObject.location.pathname, '/');
  assert.equal(docsRootAttached, false);
  assert.equal(docsRouterPath, '/');
  windowObject.history.forward();
  assert.equal(windowObject.location.pathname, '/docs/api-reference/responses');
  assert.equal(docsRootAttached, true);
  assert.equal(docsRouterPath, '/docs/api-reference/responses');
});

class FakeWindow {
  constructor(initialPath) {
    this.location = { pathname: initialPath };
    this.history = new FakeHistory(this);
    this.listeners = new Map();
    this.popstatePaths = [];
    this.PopStateEvent = class PopStateEvent {
      constructor(type) {
        this.type = type;
      }
    };
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    if (event.type === 'popstate') this.popstatePaths.push(this.location.pathname);
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    return true;
  }

  scrollTo() {}
}

class FakeHistory {
  constructor(windowObject) {
    this.windowObject = windowObject;
    this.entries = [windowObject.location.pathname];
    this.index = 0;
  }

  pushState(_state, _title, path) {
    this.entries.splice(this.index + 1);
    this.entries.push(path);
    this.index += 1;
    this.windowObject.location.pathname = path;
  }

  back() {
    this.go(-1);
  }

  forward() {
    this.go(1);
  }

  go(delta) {
    const nextIndex = this.index + delta;
    if (nextIndex < 0 || nextIndex >= this.entries.length) return;
    this.index = nextIndex;
    this.windowObject.location.pathname = this.entries[this.index];
    this.windowObject.dispatchEvent(new this.windowObject.PopStateEvent('popstate'));
  }
}
