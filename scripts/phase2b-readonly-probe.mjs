import assert from 'node:assert/strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const baseUrl = new URL(process.env.PHASE2B_PREVIEW_URL || 'http://127.0.0.1:8787');

if (!LOOPBACK_HOSTS.has(baseUrl.hostname)) {
  throw new Error(
    'PHASE2B_PREVIEW_URL must be a loopback URL exposed by wrangler dev --remote.',
  );
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
      'user-agent': 'cloudflare-newapi-page-phase2b-readonly-probe',
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
  if (json) {
    payload = await response.json();
  } else if (textIncludes.length > 0) {
    const body = await response.text();
    for (const marker of textIncludes) {
      assert.ok(body.includes(marker), `${method} ${path}: Worker SPA marker missing: ${marker}`);
    }
  } else if (response.body) {
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
assert.ok(['r2-binding', 'production-r2-binding', 'production-service-binding', 'staging-service-binding'].includes(health.downloads.mode));
assert.equal(health.downloads.configured, true);
assert.equal(health.downloads.bound, true);
assert.equal(health.downloads.active, true);
assert.equal(health.downloads.healthy, null);
assert.equal(health.downloads.live, false);
assert.equal(health.downloads.phase, 'bound-unverified');

await probe({
  method: 'GET',
  path: '/downloads?probe=phase2b',
  statuses: [200],
  contentType: 'text/html',
  textIncludes: ['<title>JuAPI 开发者中心</title>', 'id="main-content"', '/static/app.js'],
});
await probe({
  method: 'HEAD',
  path: '/downloads?probe=phase2b',
  statuses: [404],
  contentType: 'text/html',
});
const catalog = await probe({
  method: 'GET',
  path: '/api/downloads/catalog?probe=phase2b',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
assert.equal(catalog?.success, true, 'download catalog did not return success=true');
const discoveredSoftware = catalog?.data?.software;
assert.ok(
  Array.isArray(discoveredSoftware) && discoveredSoftware.length > 0,
  'download catalog discovered no software IDs',
);
const discoveredIds = new Set();
for (const software of discoveredSoftware) {
  assert.ok(
    software && typeof software.id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(software.id),
    'download catalog returned an invalid software ID',
  );
  assert.equal(
    discoveredIds.has(software.id),
    false,
    `download catalog returned duplicate software ID: ${software.id}`,
  );
  discoveredIds.add(software.id);
  assert.equal(
    software.href,
    `/downloads/software/${encodeURIComponent(software.id)}`,
    `download catalog returned an invalid SPA href for ${software.id}`,
  );
}

await probe({
  method: 'GET',
  path: `/software/${encodeURIComponent(discoveredSoftware[0].id)}?probe=phase2b`,
  statuses: [200],
  contentType: 'text/html',
});
await probe({
  method: 'GET',
  path: `/downloads/software/${encodeURIComponent(discoveredSoftware[0].id)}?probe=phase2b`,
  statuses: [200],
  contentType: 'text/html',
  // Both the root and detail compatibility URLs enter the same shell. The
  // panel fetches R2-backed metadata after the document loads.
  textIncludes: ['<title>JuAPI 开发者中心</title>', 'id="main-content"', '/static/app.js'],
});
await probe({
  method: 'GET',
  path: '/assets/favicon.png?probe=phase2b',
  statuses: [200],
  contentType: 'image/png',
});
await probe({
  method: 'GET',
  path: '/admin?probe=phase2b',
  statuses: [200],
  contentType: 'text/html',
});
await probe({
  method: 'GET',
  path: '/api/wechat-group-qrcode/latest?probe=phase2b',
  statuses: [200],
  contentType: 'application/json',
});
await probe({
  method: 'GET',
  path: '/wechat-group-qrcode?probe=phase2b',
  statuses: [200, 302],
});

const metadataBySoftware = [];
for (const software of discoveredSoftware) {
  const metadataProbe = await probe({
    method: 'GET',
    path: `/downloads/api/${encodeURIComponent(software.id)}/public?probe=phase2b`,
    statuses: [200, 404],
    contentType: 'application/json',
    json: true,
    returnSummary: true,
  });
  let metadata = metadataProbe.payload;
  if (metadataProbe.status === 404) {
    const latest = await probe({
      method: 'GET',
      path: `/downloads/api/${encodeURIComponent(software.id)}/latest?probe=phase2b`,
      statuses: [200],
      contentType: 'application/json',
      json: true,
      returnSummary: true,
    });
    metadata = latest.payload;
  }
  assert.ok(metadata && typeof metadata === 'object', `metadata missing for ${software.id}`);
  assert.ok(Array.isArray(metadata.files), `metadata files missing for ${software.id}`);
  metadataBySoftware.push({ software, metadata });
}

const publicMetadata = await probe({
  method: 'GET',
  path: '/api/public?probe=phase2b',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
await probe({
  method: 'HEAD',
  path: '/api/public?probe=phase2b',
  statuses: [404],
  contentType: 'application/json',
});

const representative = metadataBySoftware
  .flatMap(({ software, metadata }) => (metadata.files || []).map((file) => ({ software, file })))
  .find(({ file }) => file?.site && file?.platform && file?.arch)
  || (() => {
    const file = publicMetadata?.files?.find(
      (item) => item?.site && item?.platform && item?.arch,
    );
    return file ? { software: { id: 'default' }, file } : null;
  })();
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
  path: representative.software.id === 'default'
    ? `/downloads/download/${target}`
    : `/downloads/download/${encodeURIComponent(representative.software.id)}/${target}`,
  statuses: [200, 302],
});

process.stdout.write(
  `${JSON.stringify({ success: true, probes: summaries.length })}\n`,
);
