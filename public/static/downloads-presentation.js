const SOFTWARE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Customer-facing discovery is intentionally bounded. The catalog and the
// authority routes may contain more entries; this projection only controls
// what the SPA renders and never changes backend availability or direct URLs.
export const MAX_DOWNLOAD_PROGRAMS = 4;

export function projectDownloadSoftwareCatalog(entries, limit = MAX_DOWNLOAD_PROGRAMS) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : MAX_DOWNLOAD_PROGRAMS;
  const byId = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = typeof entry?.id === 'string' ? entry.id.trim().toLowerCase() : '';
    if (!SOFTWARE_ID_PATTERN.test(id) || byId.has(id)) continue;
    byId.set(id, { ...entry, id });
  }
  return [...byId.values()]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, boundedLimit);
}

// Only stable release fields are customer-facing. In particular, do not
// expose implementation, deployment, phase, binding, or status metadata from
// the downstream authority in rendered JSON or labels.
export function projectDownloadMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const result = {};
  for (const key of ['name', 'title', 'release_id', 'release_date', 'generated_at', 'updated_at', 'channel', 'files']) {
    if (metadata[key] !== undefined) result[key] = key === 'files'
      ? projectDownloadFiles(metadata[key])
      : metadata[key];
  }
  if (metadata.details && typeof metadata.details === 'object' && !Array.isArray(metadata.details)) {
    const details = {};
    if (typeof metadata.details.notes === 'string') details.notes = metadata.details.notes;
    if (Object.keys(details).length) result.details = details;
  }
  return result;
}

function projectDownloadFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) return null;
    const result = {};
    for (const key of ['site', 'platform', 'arch', 'filename', 'size', 'sha256', 'content_type', 'url']) {
      if (file[key] !== undefined) result[key] = file[key];
    }
    return result;
  }).filter(Boolean);
}
