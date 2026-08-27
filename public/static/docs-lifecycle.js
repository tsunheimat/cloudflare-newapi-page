/**
 * Keep the shell's history navigation and the mounted DocsHub router in sync.
 *
 * DocsHub owns a BrowserRouter that listens for `popstate`. The outer shell
 * uses `pushState` for its own links, so a shell re-entry into Docs needs the
 * same browser-history notification after the Docs root has been reattached.
 */
export function createDocsAwareShellNavigator({
  windowObject,
  isDocsPath,
  isCanonicalDocsMounted,
  renderRoute,
}) {
  return function navigate(path) {
    const wasMounted = isCanonicalDocsMounted();
    windowObject.history.pushState({}, '', path);
    windowObject.scrollTo?.({ top: 0, behavior: 'instant' });
    const targetPath = windowObject.location.pathname;
    const renderResult = renderRoute();

    if (
      wasMounted
      && isDocsPath(targetPath)
    ) {
      return Promise.resolve(renderResult).then(() => {
        // Do not deliver a delayed re-entry signal to a newer shell route.
        if (windowObject.location.pathname === targetPath) {
          dispatchPopState(windowObject);
        }
      });
    }
    return renderResult;
  };
}

// The Docs runtime is intentionally fetched once, but its first data requests
// can be started while the home surface is rendering.  The preload manager
// keeps those requests deterministic and lets the canonical bundle consume
// their results without issuing a second request for the same resource.
const DOCS_PRELOAD_REQUESTS = Object.freeze([
  '/api/docs/v2/config',
  '/api/docs/v2/spaces?locale=zh',
]);

export function createDocsPreloadManager({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  windowObject = globalThis.window,
  requests = DOCS_PRELOAD_REQUESTS,
} = {}) {
  const entries = new Map();
  let started = false;

  const canonicalKey = (value) => {
    const url = new URL(String(value), windowObject?.location?.href || 'http://juapi.local/');
    return `${url.pathname}${url.search}`;
  };

  const request = async (path) => {
    if (typeof fetchImpl !== 'function') throw new Error('Docs preload fetch is unavailable.');
    const response = await fetchImpl(path, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    let body = null;
    try {
      body = await (typeof response.clone === 'function' ? response.clone() : response).json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(body?.message || `Docs preload failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return {
      body,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers?.entries ? [...response.headers.entries()] : { 'content-type': 'application/json' },
    };
  };

  const start = () => {
    if (started) return manager;
    started = true;
    for (const path of requests) {
      const key = canonicalKey(path);
      const entry = { key, path, status: 'pending', value: null, error: null };
      entry.promise = request(path).then((value) => {
        entry.status = 'success';
        entry.value = value;
        return value;
      }).catch((error) => {
        entry.status = 'failure';
        entry.error = error;
        return null;
      });
      entries.set(key, entry);
    }
    return manager;
  };

  const responseFor = async (input) => {
    const inputValue = typeof input === 'string'
      ? input
      : input?.url || input?.href || String(input);
    const key = canonicalKey(inputValue);
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.status === 'pending') await entry.promise;
    if (entry.status !== 'success' || !entry.value) return null;
    const value = entry.value;
    return new Response(JSON.stringify(value.body), {
      status: value.status,
      statusText: value.statusText,
      headers: value.headers,
    });
  };

  const status = () => Object.fromEntries(
    [...entries.entries()].map(([key, entry]) => [key, entry.status]),
  );

  const manager = {
    start,
    responseFor,
    status,
    requests: [...requests],
  };
  return manager;
}

export function installDocsPreloadFetchBridge({
  windowObject = globalThis.window,
  manager,
  fetchImpl = windowObject?.fetch?.bind(windowObject),
} = {}) {
  if (!windowObject || !manager || typeof fetchImpl !== 'function') return () => {};
  const original = windowObject.fetch?.bind(windowObject) || fetchImpl;
  const bridge = async (input, init) => {
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    if (method !== 'GET') return original(input, init);
    const preloaded = await manager.responseFor(input);
    return preloaded || original(input, init);
  };
  windowObject.fetch = bridge;
  return () => {
    if (windowObject.fetch === bridge) windowObject.fetch = original;
  };
}

function dispatchPopState(windowObject) {
  const event = typeof windowObject.PopStateEvent === 'function'
    ? new windowObject.PopStateEvent('popstate')
    : new Event('popstate');
  windowObject.dispatchEvent(event);
}
