import assert from 'node:assert/strict';

if (!process.env.PRODUCTION_BASE_URL) {
  throw new Error('PRODUCTION_BASE_URL is required.');
}
const baseUrl = new URL(process.env.PRODUCTION_BASE_URL);
if (baseUrl.protocol !== 'https:') {
  throw new Error('PRODUCTION_BASE_URL must be the HTTPS URL returned by the production deployment.');
}

const summaries = [];

async function probe({
  method,
  path,
  statuses,
  contentType,
  json = false,
  textIncludes = [],
  returnSummary = false,
}) {
  assert.ok(['GET', 'HEAD'].includes(method), `unsafe probe method: ${method}`);
  const url = new URL(path, baseUrl);
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    credentials: 'omit',
    headers: {
      accept: contentType || '*/*',
      'user-agent': 'cloudflare-newapi-page-production-download-readonly-probe',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const actualContentType = response.headers.get('content-type') || '';
  assert.ok(
    statuses.includes(response.status),
    `${method} ${path}: expected ${statuses.join('/')} but received ${response.status}`,
  );
  if (contentType && response.status !== 302) {
    assert.match(
      actualContentType,
      new RegExp(`^${contentType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:;|$)`),
      `${method} ${path}: unexpected content-type`,
    );
  }
  const summary = {
    method,
    path: url.pathname,
    status: response.status,
    content_type: actualContentType || null,
    location_kind: classifyLocation(response.headers.get('location')),
    content_length: response.headers.get('content-length'),
  };
  summaries.push(summary);
  process.stdout.write(`${JSON.stringify(summary)}\n`);

  let payload = null;
  if (json) payload = await response.json();
  else if (textIncludes.length > 0) {
    const body = await response.text();
    for (const marker of textIncludes) {
      assert.ok(body.includes(marker), `${method} ${path}: Worker SPA marker missing: ${marker}`);
    }
  } else if (response.body) {
    // Header-only evidence: never buffer a representative installer artifact.
    await response.body.cancel();
  }
  return returnSummary ? { ...summary, payload } : payload;
}

function classifyLocation(location) {
  if (!location) return null;
  if (location.startsWith('/')) return 'root-relative';
  try {
    const parsed = new URL(location);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? 'external'
      : 'other-absolute';
  } catch {
    return 'relative';
  }
}

const health = await probe({
  method: 'GET',
  path: '/api/health',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
assert.equal(health.phase, '2');
assert.equal(health.content_adapter, 'newapi');
assert.equal(health.live_newapi, true);
assert.equal(health.live_newapi_healthy, true);
// Production is accepted only when the migrated callable R2 binding is the
// reported authority. The retained service binding is rollback-only.
assert.equal(health.downloads.mode, 'r2-binding');
assert.equal(health.downloads.configured, true);
assert.equal(health.downloads.bound, true);
assert.equal(health.downloads.active, true);
assert.equal(health.downloads.healthy, null);
assert.equal(health.downloads.live, false);
assert.equal(health.downloads.phase, 'bound-unverified');

const integration = await probe({
  method: 'GET',
  path: '/api/integrations/downloads?probe=production-downloads',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
assert.equal(integration?.data?.mode, 'r2-binding');
assert.equal(integration?.data?.transport, 'cloudflare-r2-binding');

await probe({
  method: 'GET',
  path: '/downloads?probe=production-downloads',
  statuses: [200],
  contentType: 'text/html',
  textIncludes: ['<title>JuAPI 软件下载中心</title>', 'Codex 安装器', 'Codex 聊天记录迁移器', 'download-group-grid'],
});

const catalog = await probe({
  method: 'GET',
  path: '/api/downloads/catalog?probe=production-downloads',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
assert.equal(catalog?.success, true);
const discoveredSoftware = catalog?.data?.software;
assert.ok(Array.isArray(discoveredSoftware) && discoveredSoftware.length > 0);
const ids = new Set();
for (const software of discoveredSoftware) {
  assert.ok(software && typeof software.id === 'string');
  assert.match(software.id, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.equal(ids.has(software.id), false, `duplicate catalog ID: ${software.id}`);
  ids.add(software.id);
  assert.equal(software.href, `/downloads/software/${encodeURIComponent(software.id)}`);
}

await probe({
  method: 'GET',
  path: `/software/${encodeURIComponent(discoveredSoftware[0].id)}?probe=production-downloads`,
  statuses: [200],
  contentType: 'text/html',
});
await probe({
  method: 'GET',
  path: `/downloads/software/${encodeURIComponent(discoveredSoftware[0].id)}?probe=production-downloads`,
  statuses: [200],
  contentType: 'text/html',
  // Legacy SPA markers (<main id="main-content", /static/app.js) are not
  // required after the Downloads R2 authority migration.
  textIncludes: ['Codex'],
});

const metadataBySoftware = [];
for (const software of discoveredSoftware) {
  const publicMetadata = await probe({
    method: 'GET',
    path: `/downloads/api/${encodeURIComponent(software.id)}/public?probe=production-downloads`,
    statuses: [200, 404],
    contentType: 'application/json',
    json: true,
    returnSummary: true,
  });
  let metadata = publicMetadata.payload;
  if (publicMetadata.status === 404) {
    const latestMetadata = await probe({
      method: 'GET',
      path: `/downloads/api/${encodeURIComponent(software.id)}/latest?probe=production-downloads`,
      statuses: [200],
      contentType: 'application/json',
      json: true,
      returnSummary: true,
    });
    metadata = latestMetadata.payload;
  }
  assert.ok(metadata && typeof metadata === 'object');
  assert.ok(Array.isArray(metadata.files), `metadata files missing for ${software.id}`);
  metadataBySoftware.push({ software, metadata });
}

const publicMetadata = await probe({
  method: 'GET',
  path: '/api/public?probe=production-downloads',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
const representative = metadataBySoftware
  .flatMap(({ software, metadata }) => (metadata.files || []).map((file) => ({ software, file })))
  .find(({ file }) => file?.site && file?.platform && file?.arch);
assert.ok(representative, 'catalog metadata contains no probeable download target');
const target = [representative.file.site, representative.file.platform, representative.file.arch]
  .map((part) => encodeURIComponent(String(part)))
  .join('/');
const defaultFile = publicMetadata?.files?.find((item) => item?.site && item?.platform && item?.arch);
assert.ok(defaultFile, 'default public metadata contains no probeable download target');
const defaultTarget = [defaultFile.site, defaultFile.platform, defaultFile.arch]
  .map((part) => encodeURIComponent(String(part)))
  .join('/');
await probe({ method: 'GET', path: `/download/${defaultTarget}`, statuses: [200, 302] });
await probe({
  method: 'GET',
  path: `/downloads/download/${encodeURIComponent(representative.software.id)}/${target}`,
  statuses: [200, 302],
});

process.stdout.write(`${JSON.stringify({ success: true, probes: summaries.length })}\n`);
