import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import worker from '../src/worker.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const WRANGLER_CONFIG_PATH = resolve(REPOSITORY_ROOT, 'wrangler.toml');
const WRANGLER_BIN_PATH = resolve(
  REPOSITORY_ROOT,
  'node_modules/wrangler/bin/wrangler.js',
);

export const PRODUCTION_CONTRACT = Object.freeze({
  workerName: 'cloudflare-newapi-page',
  contentAdapter: 'fixture',
  defaultDownloadsMode: 'disabled',
  stagingDownloadsMode: 'staging-service-binding',
  productionDownloadsMode: 'production-service-binding',
  downloadsBinding: 'DOWNLOADS_SERVICE',
  downloadsService: 'cloudflare-download-site',
});

export function resolveExecutionMode(args) {
  if (args.length === 0) return 'deploy';
  if (args.length === 1 && args[0] === '--dry-run') return 'dry-run';
  throw new Error(
    'Unsupported arguments. Use exactly `npm run deploy:production` or append only `-- --dry-run`.',
  );
}

export function productionDeployArgs(commit) {
  assert.match(commit, /^[0-9a-f]{40}$/, 'deployment requires a full Git commit');
  return [
    WRANGLER_BIN_PATH,
    'deploy',
    '--config',
    WRANGLER_CONFIG_PATH,
    '--env',
    'production',
    '--strict',
    '--message',
    `production source ${commit}`,
  ];
}

export function assertProductionConfig(source) {
  const sections = parseWranglerSections(source);
  const expectedServiceSections = [
    'env.production.services',
    'env.staging.services',
  ];
  const actualServiceSections = [...sections.keys()]
    .filter((name) => name === 'services' || name.endsWith('.services'))
    .sort();
  assert.deepEqual(
    actualServiceSections,
    expectedServiceSections,
    'only staging and production may declare service bindings',
  );

  assert.equal(value(sections, '<root>', 'name'), PRODUCTION_CONTRACT.workerName);
  assert.equal(
    value(sections, 'vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.contentAdapter,
  );
  assert.equal(
    value(sections, 'vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.defaultDownloadsMode,
  );
  assert.equal(value(sections, 'env.staging', 'workers_dev'), true);
  assert.equal(
    value(sections, 'env.staging.vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.contentAdapter,
  );
  assert.equal(
    value(sections, 'env.staging.vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.stagingDownloadsMode,
  );
  assertServiceBinding(sections, 'env.staging.services');

  assert.equal(value(sections, 'env.production', 'workers_dev'), true);
  assert.equal(
    value(sections, 'env.production.vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.contentAdapter,
  );
  assert.equal(
    value(sections, 'env.production.vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.productionDownloadsMode,
  );
  assertServiceBinding(sections, 'env.production.services');
}

export async function assertProductionRuntimeContract() {
  let forwarded = false;
  const env = {
    CONTENT_ADAPTER: PRODUCTION_CONTRACT.contentAdapter,
    DOWNLOADS_INTEGRATION: PRODUCTION_CONTRACT.productionDownloadsMode,
    DOWNLOADS_SERVICE: {
      async fetch() {
        forwarded = true;
        return new Response('download service fixture transport');
      },
    },
    ASSETS: {
      fetch: async () => new Response('asset'),
    },
  };

  const health = await fetchJson('/api/health', env);
  assert.equal(health.phase, '2');
  assert.equal(health.content_adapter, 'fixture');
  assert.equal(health.live_newapi, false);
  assert.deepEqual(health.pricing_context, {
    user_group: 'default',
    selected_group: 'default',
  });
  assert.equal(health.downloads.mode, 'production-service-binding');
  assert.equal(health.downloads.configured, true);
  assert.equal(health.downloads.bound, true);
  assert.equal(health.downloads.active, true);
  assert.equal(health.downloads.healthy, null);
  assert.equal(health.downloads.live, false);
  assert.equal(health.downloads.phase, 'bound-unverified');

  const docs = await fetchJson('/api/content/docs', env);
  assert.equal(docs.data.meta.source, 'fixture');
  assert.equal(docs.data.meta.fixture, true);
  assert.equal(docs.data.meta.live, false);

  const pricing = await fetchJson('/api/content/pricing', env);
  assert.equal(pricing.meta.source, 'fixture');
  assert.equal(pricing.meta.fixture, true);
  assert.equal(pricing.meta.live, false);
  assert.deepEqual(pricing.context, {
    user_group: 'default',
    selected_group: 'default',
    locked: true,
  });

  const downstream = await worker.fetch(
    new Request('https://production.invalid/downloads'),
    env,
  );
  assert.equal(downstream.status, 200);
  assert.equal(forwarded, true);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const mode = resolveExecutionMode(args);
  assertNodeVersion();
  await assertNoLocalCredentialFiles();
  const config = await readFile(WRANGLER_CONFIG_PATH, 'utf8');
  assertProductionConfig(config);
  await assertProductionRuntimeContract();
  process.stdout.write(
    '[production preflight] PASS: production is fixture/non-live for Docs and Pricing; download forwarding uses the production service-binding gate.\n',
  );

  if (mode === 'deploy') assertCredentialPrerequisites(env);
  const commit = mode === 'deploy' ? await assertCleanCommit() : null;
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'validate']);

  if (mode === 'dry-run') {
    process.stdout.write(
      '[production preflight] DRY RUN ONLY: validation completed; no Cloudflare upload or deployment occurred.\n',
    );
    return;
  }

  assert.equal(
    await assertCleanCommit(),
    commit,
    'worktree or HEAD changed after validation; refusing deployment',
  );
  process.stdout.write(
    `[production deploy] deploying clean commit ${commit} with fixed --env production --strict.\n`,
  );
  await run(process.execPath, productionDeployArgs(commit), env);
}

function parseWranglerSections(source) {
  const sections = new Map([['<root>', [{ values: new Map(), array: false }]]]);
  let current = sections.get('<root>')[0];

  source.split(/\r?\n/).forEach((rawLine, index) => {
    const line = stripTomlComment(rawLine).trim();
    if (!line) return;
    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]$/);
    const tableHeader = line.match(/^\[([^\]]+)\]$/);
    if (arrayHeader || tableHeader) {
      const name = (arrayHeader || tableHeader)[1].trim();
      const occurrences = sections.get(name) || [];
      if (tableHeader && occurrences.length > 0) {
        throw new Error(`duplicate TOML table [${name}]`);
      }
      current = { values: new Map(), array: Boolean(arrayHeader) };
      occurrences.push(current);
      sections.set(name, occurrences);
      return;
    }

    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) throw new Error(`unsupported TOML at line ${index + 1}`);
    const [, key, rawValue] = assignment;
    if (current.values.has(key)) {
      throw new Error(`duplicate TOML key ${key} at line ${index + 1}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      throw new Error(`unsupported TOML value for ${key} at line ${index + 1}`);
    }
    if (!['string', 'boolean', 'number'].includes(typeof parsed)) {
      throw new Error(`unsupported non-scalar TOML value for ${key}`);
    }
    current.values.set(key, parsed);
  });
  return sections;
}

function stripTomlComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && !escaped) quoted = !quoted;
    if (character === '#' && !quoted) return line.slice(0, index);
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  return line;
}

function value(sections, sectionName, key) {
  const occurrences = sections.get(sectionName);
  assert.equal(occurrences?.length, 1, `expected exactly one [${sectionName}]`);
  assert.equal(
    occurrences[0].values.has(key),
    true,
    `missing ${sectionName}.${key}`,
  );
  return occurrences[0].values.get(key);
}

function assertServiceBinding(sections, sectionName) {
  const occurrences = sections.get(sectionName);
  assert.equal(occurrences?.length, 1, `expected one [[${sectionName}]]`);
  assert.equal(occurrences[0].array, true, `${sectionName} must be an array table`);
  assert.deepEqual(
    [...occurrences[0].values.keys()].sort(),
    ['binding', 'service'],
    `${sectionName} may only select the reviewed Worker service`,
  );
  assert.equal(
    occurrences[0].values.get('binding'),
    PRODUCTION_CONTRACT.downloadsBinding,
  );
  assert.equal(
    occurrences[0].values.get('service'),
    PRODUCTION_CONTRACT.downloadsService,
  );
}

async function fetchJson(path, env) {
  const response = await worker.fetch(
    new Request(`https://production.invalid${path}`),
    env,
  );
  assert.equal(response.status, 200, `${path} preflight returned ${response.status}`);
  return response.json();
}

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  assert.ok(major >= 22, `Node >=22 is required; found ${process.versions.node}`);
}

async function assertNoLocalCredentialFiles() {
  const forbidden = ['.env', '.env.production', '.dev.vars', '.dev.vars.production'];
  for (const name of forbidden) {
    try {
      await access(resolve(REPOSITORY_ROOT, name));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `${name} is present. Production credentials must come from the current shell or an external secret manager, not repository files.`,
    );
  }
}

export function assertCredentialPrerequisites(env) {
  assert.match(
    String(env.CLOUDFLARE_ACCOUNT_ID || ''),
    /^[0-9a-f]{32}$/i,
    'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID',
  );
  assert.ok(
    typeof env.CLOUDFLARE_API_TOKEN === 'string' &&
      env.CLOUDFLARE_API_TOKEN.trim().length > 0,
    'CLOUDFLARE_API_TOKEN is required for production deployment',
  );
  assert.equal(
    env.CLOUDFLARE_API_KEY,
    undefined,
    'legacy CLOUDFLARE_API_KEY authentication is not allowed',
  );
}

async function assertCleanCommit() {
  const status = await capture('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  assert.equal(status.trim(), '', 'production deployment requires a clean worktree');
  const commit = (await capture('git', ['rev-parse', 'HEAD'])).trim();
  assert.match(commit, /^[0-9a-f]{40}$/, 'unable to resolve deployment commit');
  return commit;
}

async function capture(command, args) {
  let output = '';
  await run(command, args, process.env, (chunk) => {
    output += chunk;
  });
  return output;
}

async function run(command, args, env = process.env, onStdout = null) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env,
      shell: false,
      stdio: onStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    if (onStdout) child.stdout.on('data', onStdout);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal || `exit ${code}`}`));
    });
  });
}

if (resolve(process.argv[1] || '') === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`[production deploy] FAIL: ${error.message}\n`);
    process.exitCode = 1;
  });
}
