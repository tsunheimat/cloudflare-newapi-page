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

function dispatchPopState(windowObject) {
  const event = typeof windowObject.PopStateEvent === 'function'
    ? new windowObject.PopStateEvent('popstate')
    : new Event('popstate');
  windowObject.dispatchEvent(event);
}
