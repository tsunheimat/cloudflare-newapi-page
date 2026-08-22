import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  FORBIDDEN_LOCAL_CREDENTIAL_FILES,
  FORBIDDEN_PRODUCTION_ENVIRONMENT_VARIABLES,
  WRANGLER_PRODUCTION_DOTENV_FILES,
  assertCleanCommit,
  assertProductionConfig,
  assertProductionRuntimeContract,
  assertCredentialPrerequisites,
  assertNoLocalCredentialFiles,
  assertNoUnsafeProductionEnvironment,
  productionDeployArgs,
  resolveExecutionMode,
  runProductionDeploy,
  validateProductionCommit,
} from '../scripts/production-deploy.mjs';

const CONFIG_URL = new URL('../wrangler.toml', import.meta.url);
const PACKAGE_URL = new URL('../package.json', import.meta.url);
const execFileAsync = promisify(execFile);

async function createTemporaryRepository(t) {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), 'cloudflare-newapi-page-production-test-'),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryRoot });
  await writeFile(join(repositoryRoot, 'fixture.txt'), 'reviewed\n');
  await execFileAsync('git', ['add', 'fixture.txt'], { cwd: repositoryRoot });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Production contract test',
      '-c',
      'user.email=production-contract@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ],
    { cwd: repositoryRoot },
  );
  return repositoryRoot;
}

const syntheticDeployEnvironment = () => ({
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  CLOUDFLARE_API_TOKEN: 'synthetic-token-value',
});

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
  assert.match(args[3], /\/wrangler\.toml$/);
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

test('production input gate covers every dotenv file loaded by pinned Wrangler', async (t) => {
  const packageJson = JSON.parse(await readFile(PACKAGE_URL, 'utf8'));
  assert.equal(packageJson.devDependencies.wrangler, '4.124.0');
  assert.deepEqual(WRANGLER_PRODUCTION_DOTENV_FILES, [
    '.env',
    '.env.local',
    '.env.production',
    '.env.production.local',
  ]);

  const repositoryRoot = await mkdtemp(
    join(tmpdir(), 'cloudflare-newapi-page-dotenv-test-'),
  );
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));

  for (const name of FORBIDDEN_LOCAL_CREDENTIAL_FILES) {
    const path = join(repositoryRoot, name);
    await writeFile(path, 'SYNTHETIC_VALUE=not-a-credential\n');
    await assert.rejects(assertNoLocalCredentialFiles(repositoryRoot), {
      message: new RegExp(name.replaceAll('.', '\\.')),
    });
    await rm(path);
  }
  await assert.doesNotReject(assertNoLocalCredentialFiles(repositoryRoot));
});

test('production input gate rejects pinned Wrangler control-plane, proxy, log, output, and legacy auth variables', () => {
  assert.ok(FORBIDDEN_PRODUCTION_ENVIRONMENT_VARIABLES.length > 0);
  for (const name of FORBIDDEN_PRODUCTION_ENVIRONMENT_VARIABLES) {
    assert.throws(
      () => assertNoUnsafeProductionEnvironment({ [name]: 'synthetic-value' }),
      new RegExp(name),
    );
  }
  assert.doesNotThrow(() =>
    assertNoUnsafeProductionEnvironment(syntheticDeployEnvironment()),
  );
});

test('production validation independently rejects WRANGLER_WRITE_LOGS before spawning validation', async () => {
  let validationSpawned = false;

  await assert.rejects(
    validateProductionCommit(
      'a'.repeat(40),
      { WRANGLER_WRITE_LOGS: 'false' },
      {
        async runCommand() {
          validationSpawned = true;
        },
      },
    ),
    /WRANGLER_WRITE_LOGS/,
  );
  assert.equal(validationSpawned, false);
});

test('clean snapshot gate rejects tracked and untracked validation output', async (t) => {
  const repositoryRoot = await createTemporaryRepository(t);
  const commit = await assertCleanCommit(repositoryRoot);
  assert.match(commit, /^[0-9a-f]{40}$/);

  await assert.rejects(
    validateProductionCommit(commit, {}, {
      repositoryRoot,
      async runCommand() {
        await writeFile(join(repositoryRoot, 'untracked.txt'), 'validation drift\n');
      },
    }),
    /clean worktree/,
  );
  await rm(join(repositoryRoot, 'untracked.txt'));

  await assert.rejects(
    validateProductionCommit(commit, {}, {
      repositoryRoot,
      async runCommand() {
        await writeFile(
          join(repositoryRoot, 'fixture.txt'),
          'tracked validation drift\n',
        );
      },
    }),
    /clean worktree/,
  );
});

test('validation gate rejects a different clean HEAD after the validation child exits', async (t) => {
  const repositoryRoot = await createTemporaryRepository(t);
  const commit = await assertCleanCommit(repositoryRoot);

  await assert.rejects(
    validateProductionCommit(commit, {}, {
      repositoryRoot,
      async runCommand() {
        await writeFile(join(repositoryRoot, 'second.txt'), 'new clean snapshot\n');
        await execFileAsync('git', ['add', 'second.txt'], { cwd: repositoryRoot });
        await execFileAsync(
          'git',
          [
            '-c',
            'user.name=Production contract test',
            '-c',
            'user.email=production-contract@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'drift',
          ],
          { cwd: repositoryRoot },
        );
      },
    }),
    /changed after validation/,
  );
});

test('real deploy rechecks ignored inputs immediately before the Wrangler child spawn', async (t) => {
  const repositoryRoot = await createTemporaryRepository(t);
  const commit = await assertCleanCommit(repositoryRoot);
  let spawned = false;

  await assert.rejects(
    runProductionDeploy(commit, syntheticDeployEnvironment(), {
      repositoryRoot,
      async resolveCleanCommit() {
        await writeFile(
          join(repositoryRoot, '.env.production.local'),
          'SYNTHETIC_VALUE=not-a-credential\n',
        );
        return commit;
      },
      async runCommand() {
        spawned = true;
      },
    }),
    /\.env\.production\.local is present/,
  );
  assert.equal(spawned, false);

  await rm(join(repositoryRoot, '.env.production.local'));
  const mutatedEnvironment = syntheticDeployEnvironment();
  await assert.rejects(
    runProductionDeploy(commit, mutatedEnvironment, {
      repositoryRoot,
      async resolveCleanCommit() {
        mutatedEnvironment.WRANGLER_WRITE_LOGS = 'false';
        return commit;
      },
      async runCommand() {
        spawned = true;
      },
    }),
    /WRANGLER_WRITE_LOGS/,
  );
  assert.equal(spawned, false);
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
