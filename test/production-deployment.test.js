import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertProductionConfig,
  assertProductionRuntimeContract,
  assertCredentialPrerequisites,
  productionDeployArgs,
  resolveExecutionMode,
} from '../scripts/production-deploy.mjs';

const CONFIG_URL = new URL('../wrangler.toml', import.meta.url);
const PACKAGE_URL = new URL('../package.json', import.meta.url);

test('production preflight accepts the committed deployment contract', async () => {
  const source = await readFile(CONFIG_URL, 'utf8');
  assert.doesNotThrow(() => assertProductionConfig(source));
  await assert.doesNotReject(assertProductionRuntimeContract());
});

test('production preflight rejects disabled, unbound, or non-fixture production config', async () => {
  const source = await readFile(CONFIG_URL, 'utf8');
  const productionStart = source.indexOf('[env.production]');
  assert.ok(productionStart > 0);
  const before = source.slice(0, productionStart);
  const production = source.slice(productionStart);

  assert.throws(() =>
    assertProductionConfig(
      before +
        production.replace(
          'DOWNLOADS_INTEGRATION = "production-service-binding"',
          'DOWNLOADS_INTEGRATION = "disabled"',
        ),
    ),
  );
  assert.throws(() =>
    assertProductionConfig(
      before +
        production.replace(
          /\n\[\[env\.production\.services\]\][\s\S]*$/,
          '\n',
        ),
    ),
  );
  assert.throws(() =>
    assertProductionConfig(
      before + production.replace('CONTENT_ADAPTER = "fixture"', 'CONTENT_ADAPTER = "newapi"'),
    ),
  );
  assert.throws(() =>
    assertProductionConfig(
      `${source}\n[[services]]\nbinding = "DOWNLOADS_SERVICE"\nservice = "cloudflare-download-site"\n`,
    ),
  );
});

test('production deploy command cannot select default, staging, or an alternate config', () => {
  const commit = 'a'.repeat(40);
  const args = productionDeployArgs(commit);
  assert.match(args[0], /node_modules\/wrangler\/bin\/wrangler\.js$/);
  assert.deepEqual(args.slice(1, 7), [
    'deploy',
    '--config',
    args[3],
    '--env',
    'production',
    '--strict',
  ]);
  assert.match(args[3], /cloudflare-newapi-page\/wrangler\.toml$/);
  assert.equal(args.filter((value) => value === '--env').length, 1);
  assert.equal(args.includes('staging'), false);
  assert.equal(args.includes('--dry-run'), false);
  assert.deepEqual(args.slice(7), ['--message', `production source ${commit}`]);

  assert.equal(resolveExecutionMode([]), 'deploy');
  assert.equal(resolveExecutionMode(['--dry-run']), 'dry-run');
  assert.throws(() => resolveExecutionMode(['--env', 'staging']));
  assert.throws(() => resolveExecutionMode(['--dry-run', '--env', 'production']));
});

test('production deploy requires scoped token authentication and rejects legacy global-key auth', () => {
  assert.doesNotThrow(() =>
    assertCredentialPrerequisites({
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'scoped-token-for-test',
    }),
  );
  assert.throws(() => assertCredentialPrerequisites({}));
  assert.throws(() =>
    assertCredentialPrerequisites({
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_API_TOKEN: 'scoped-token-for-test',
      CLOUDFLARE_API_KEY: 'legacy-global-key-for-test',
    }),
  );
  assert.throws(() =>
    assertCredentialPrerequisites({
      CLOUDFLARE_ACCOUNT_ID: 'wrong-account-id',
      CLOUDFLARE_API_TOKEN: 'scoped-token-for-test',
    }),
  );
});

test('package exposes one guarded production deploy entrypoint and keeps build lanes dry-run only', async () => {
  const packageJson = JSON.parse(await readFile(PACKAGE_URL, 'utf8'));
  assert.equal(
    packageJson.scripts['deploy:production'],
    'node scripts/production-deploy.mjs',
  );
  assert.equal(
    packageJson.scripts['build:production'],
    'wrangler deploy --dry-run --env production --outdir dist/production',
  );

  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!command.includes('wrangler deploy')) continue;
    assert.match(command, /--dry-run/, `${name} bypasses the guarded deploy entrypoint`);
  }
});
