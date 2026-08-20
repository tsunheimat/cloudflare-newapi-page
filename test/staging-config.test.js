import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONFIG_URL = new URL('../wrangler.toml', import.meta.url);

function parseSections(source) {
  const sections = new Map([['<root>', []]]);
  let current = '<root>';

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      current = header[1];
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(line);
  }
  return sections;
}

function value(sections, section, key) {
  const prefix = `${key} = `;
  const line = (sections.get(section) || []).find((entry) =>
    entry.startsWith(prefix),
  );
  assert.ok(line, `missing ${section}.${key}`);
  return JSON.parse(line.slice(prefix.length));
}

test('only staging and production declare the reviewed download service binding', async () => {
  const source = await readFile(CONFIG_URL, 'utf8');
  const sections = parseSections(source);
  const serviceSections = [...sections.keys()].filter((section) =>
    section.endsWith('services'),
  );

  assert.deepEqual(serviceSections, [
    'env.staging.services',
    'env.production.services',
  ]);
  for (const section of serviceSections) {
    assert.equal(value(sections, section, 'binding'), 'DOWNLOADS_SERVICE');
    assert.equal(value(sections, section, 'service'), 'cloudflare-download-site');
    assert.doesNotMatch(
      (sections.get(section) || []).join('\n'),
      /^(?:remote|environment)\s*=/m,
    );
  }
});

test('default stays disabled while staging and production use distinct explicit runtime gates', async () => {
  const source = await readFile(CONFIG_URL, 'utf8');
  const sections = parseSections(source);

  assert.equal(value(sections, 'vars', 'CONTENT_ADAPTER'), 'fixture');
  assert.equal(value(sections, 'vars', 'DOWNLOADS_INTEGRATION'), 'disabled');
  assert.equal(
    value(sections, 'env.production.vars', 'CONTENT_ADAPTER'),
    'fixture',
  );
  assert.equal(
    value(sections, 'env.production.vars', 'DOWNLOADS_INTEGRATION'),
    'production-service-binding',
  );
  assert.equal(
    value(sections, 'env.staging.vars', 'DOWNLOADS_INTEGRATION'),
    'staging-service-binding',
  );
  assert.equal(
    value(sections, 'env.staging.vars', 'CONTENT_ADAPTER'),
    'fixture',
  );
});

test('Phase 2B probe is loopback-only and contains no mutating HTTP method', async () => {
  const source = await readFile(
    new URL('../scripts/phase2b-readonly-probe.mjs', import.meta.url),
    'utf8',
  );

  assert.match(source, /LOOPBACK_HOSTS/);
  assert.match(source, /credentials: 'omit'/);
  assert.match(source, /redirect: 'manual'/);
  assert.match(source, /\['GET', 'HEAD'\]\.includes\(method\)/);
  assert.match(source, /location_kind: classifyLocation/);
  assert.doesNotMatch(source, /method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/);
});
