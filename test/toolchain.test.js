import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('declared Node minimum matches the locked Wrangler engine floor', async () => {
  const packageJson = await readJson(new URL('../package.json', import.meta.url));
  const lock = await readJson(new URL('../package-lock.json', import.meta.url));
  const lockedWrangler = lock.packages['node_modules/wrangler'];

  assert.equal(packageJson.engines.node, '>=22.0.0');
  assert.equal(packageJson.devDependencies.wrangler, lockedWrangler.version);
  assert.equal(lockedWrangler.engines.node, '>=22.0.0');
  assert.equal(lock.packages[''].engines.node, packageJson.engines.node);
});

test('lockfile artifacts use only the public HTTPS npm registry', async () => {
  const lock = await readJson(new URL('../package-lock.json', import.meta.url));
  const packageEntries = Object.entries(lock.packages).filter(
    ([name, entry]) => name !== '' && entry.link !== true,
  );

  assert.ok(packageEntries.length > 0);
  for (const [name, entry] of packageEntries) {
    assert.equal(
      typeof entry.resolved,
      'string',
      `${name} is missing a resolved artifact URL`,
    );
    assert.ok(entry.resolved.length > 0, `${name} has an empty resolved URL`);
    assert.equal(
      typeof entry.integrity,
      'string',
      `${name} is missing artifact integrity`,
    );
    assert.ok(entry.integrity.length > 0, `${name} has empty integrity`);

    const { resolved } = entry;
    const url = new URL(resolved);
    assert.equal(url.protocol, 'https:', `${name} uses a non-HTTPS artifact`);
    assert.equal(
      url.hostname,
      'registry.npmjs.org',
      `${name} uses a non-public registry hostname`,
    );
  }

  const serialized = JSON.stringify(lock);
  assert.doesNotMatch(serialized, /nexus|tsunhei|credential|password|token=/i);
});
