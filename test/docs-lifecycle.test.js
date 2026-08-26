import assert from 'node:assert/strict';
import test from 'node:test';

import { createDocsAwareShellNavigator } from '../public/static/docs-lifecycle.js';

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
