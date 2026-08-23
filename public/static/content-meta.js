export const DEFAULT_DOCS_SLUG = 'quickstart';

export function contentStatus(meta = {}) {
  const source = typeof meta.source === 'string' && meta.source.trim() !== ''
    ? meta.source.trim()
    : 'content';
  const label = typeof meta.label === 'string' && meta.label.trim() !== ''
    ? meta.label.trim()
    : source;
  const canonicalSource = source === 'newapi'
    ? 'NewAPI'
    : source === 'fixture'
      ? 'Fixture'
      : label;
  if (meta.live === true && meta.fixture === false) {
    return {
      kind: 'live',
      label,
      badge: `${canonicalSource} · Live`,
      sourceText: `${canonicalSource}（live）`,
    };
  }
  if (meta.fixture === true && meta.live === false) {
    return {
      kind: 'fixture',
      label,
      badge: `${canonicalSource} · 非 live`,
      sourceText: `${canonicalSource}（非 live）`,
    };
  }
  return {
    kind: 'unknown',
    label,
    badge: `${label} · 状态待确认`,
    sourceText: `${label}（状态待确认）`,
  };
}

export function docsDefaultSlug(catalog, fallback = DEFAULT_DOCS_SLUG) {
  for (const section of catalog?.sections || []) {
    for (const item of section?.items || []) {
      if (isDocsSlug(item?.slug)) return item.slug;
    }
  }
  return fallback;
}

/**
 * Resolve a safe Docs destination for navigation that may run before the
 * catalog has been loaded. Live content must use a slug published by NewAPI;
 * only a validated fixture catalog may use the quickstart fallback.
 */
export function docsNavigationSlug(catalogResponse, fallback = DEFAULT_DOCS_SLUG) {
  const catalog = catalogResponse && typeof catalogResponse === 'object' && Object.hasOwn(catalogResponse, 'data')
    ? catalogResponse.data
    : catalogResponse;
  const slug = docsDefaultSlug(catalog, null);
  if (slug) return slug;
  return contentStatus(catalog?.meta).kind === 'fixture' ? fallback : null;
}

export function docsCatalogHasSlug(catalog, slug) {
  return (catalog?.sections || []).some((section) =>
    (section?.items || []).some((item) => item?.slug === slug),
  );
}

function isDocsSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}
