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
