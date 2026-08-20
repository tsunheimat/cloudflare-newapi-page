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

  if (json) return response.json();
  if (response.body) await response.body.cancel();
  return null;
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
assert.equal(health.phase, '2A');
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
});
await probe({
  method: 'HEAD',
  path: '/downloads?probe=phase2b',
  statuses: [404],
  contentType: 'text/html',
});
await probe({
  method: 'GET',
  path: '/software/codex-installer?probe=phase2b',
  statuses: [200],
  contentType: 'text/html',
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

const publicMetadata = await probe({
  method: 'GET',
  path: '/api/public?probe=phase2b',
  statuses: [200],
  contentType: 'application/json',
  json: true,
});
await probe({
  method: 'GET',
  path: '/downloads/api/codex-installer/public?probe=phase2b',
  statuses: [200],
  contentType: 'application/json',
});
await probe({
  method: 'HEAD',
  path: '/api/public?probe=phase2b',
  statuses: [404],
  contentType: 'application/json',
});

const file = publicMetadata?.files?.find(
  (item) => item?.site && item?.platform && item?.arch,
);
assert.ok(file, 'public metadata contains no probeable download target');
const target = [file.site, file.platform, file.arch]
  .map((part) => encodeURIComponent(String(part)))
  .join('/');

for (const path of [`/download/${target}`, `/downloads/download/${target}`]) {
  await probe({ method: 'GET', path, statuses: [200, 302] });
}

process.stdout.write(
  `${JSON.stringify({ success: true, probes: summaries.length })}\n`,
);
