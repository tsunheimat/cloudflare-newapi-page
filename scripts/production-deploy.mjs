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
  defaultContentAdapter: 'fixture',
  stagingContentAdapter: 'fixture',
  productionContentAdapter: 'newapi',
  defaultDownloadsMode: 'disabled',
  stagingDownloadsMode: 'staging-service-binding',
  productionDownloadsMode: 'production-service-binding',
  downloadsBinding: 'DOWNLOADS_SERVICE',
  downloadsService: 'cloudflare-download-site',
  newApiVpcBinding: 'NEWAPI_VPC_SERVICE',
  newApiVpcServiceId: '01a027bb-280d-7630-b837-7afd6a0ca196',
  docsProbeSlug: 'page-1785606868894-3673ea8d4916890d',
});

// Wrangler 4.124.0 loads these files, in this order, for `--env production`.
// They are gitignored here, so Git cleanliness alone cannot make them safe.
export const WRANGLER_PRODUCTION_DOTENV_FILES = Object.freeze([
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
]);

export const FORBIDDEN_LOCAL_CREDENTIAL_FILES = Object.freeze([
  ...WRANGLER_PRODUCTION_DOTENV_FILES,
  '.dev.vars',
  '.dev.vars.production',
]);

// These variables are read by the pinned Wrangler release and can redirect the
// control plane, select a proxy, or change audit log/machine-output handling.
// Production accepts only the scoped credential names checked below.
export const FORBIDDEN_PRODUCTION_ENVIRONMENT_VARIABLES = Object.freeze([
  'CLOUDFLARE_API_BASE_URL',
  'CF_API_BASE_URL',
  'CLOUDFLARE_BASE_URL',
  'WRANGLER_API_ENVIRONMENT',
  'CLOUDFLARE_COMPLIANCE_REGION',
  'CLOUDFLARE_ENV',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'WRANGLER_LOG',
  'WRANGLER_LOG_PATH',
  'WRANGLER_LOG_SANITIZE',
  'WRANGLER_WRITE_LOGS',
  'WRANGLER_OUTPUT_FILE_DIRECTORY',
  'WRANGLER_OUTPUT_FILE_PATH',
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_API_KEY',
  'CF_API_KEY',
  'CLOUDFLARE_EMAIL',
  'CF_EMAIL',
]);

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
  const expectedVpcSections = [
    'env.production.vpc_services',
    'env.staging.vpc_services',
  ];
  const actualVpcSections = [...sections.keys()]
    .filter((name) => name === 'vpc_services' || name.endsWith('.vpc_services'))
    .sort();
  assert.deepEqual(
    actualVpcSections,
    expectedVpcSections,
    'only staging and production may declare the reviewed NewAPI VPC Service',
  );

  assert.equal(value(sections, '<root>', 'name'), PRODUCTION_CONTRACT.workerName);
  assert.equal(
    value(sections, 'vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.defaultContentAdapter,
  );
  assert.equal(
    value(sections, 'vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.defaultDownloadsMode,
  );
  assert.equal(value(sections, 'env.staging', 'workers_dev'), true);
  assert.equal(
    value(sections, 'env.staging.vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.stagingContentAdapter,
  );
  assert.equal(
    value(sections, 'env.staging.vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.stagingDownloadsMode,
  );
  assertServiceBinding(sections, 'env.staging.services');
  assertVpcServiceBinding(sections, 'env.staging.vpc_services');

  assert.equal(value(sections, 'env.production', 'workers_dev'), true);
  assert.equal(
    value(sections, 'env.production.vars', 'CONTENT_ADAPTER'),
    PRODUCTION_CONTRACT.productionContentAdapter,
  );
  assert.equal(
    value(sections, 'env.production.vars', 'DOWNLOADS_INTEGRATION'),
    PRODUCTION_CONTRACT.productionDownloadsMode,
  );
  assertServiceBinding(sections, 'env.production.services');
  assertVpcServiceBinding(sections, 'env.production.vpc_services');
}

export async function assertProductionRuntimeContract() {
  let forwarded = false;
  const upstreamPaths = [];
  const liveToken = `production-contract-${'x'.repeat(32)}`;
  const env = {
    CONTENT_ADAPTER: PRODUCTION_CONTRACT.productionContentAdapter,
    LIVE_CONTENT_ADAPTER_TOKEN: liveToken,
    DOWNLOADS_INTEGRATION: PRODUCTION_CONTRACT.productionDownloadsMode,
    NEWAPI_VPC_SERVICE: {
      async fetch(request) {
        const url = new URL(request.url);
        upstreamPaths.push(url.pathname);
        assert.equal(request.method, 'GET');
        assert.equal(
          request.headers.get('authorization'),
          `Bearer ${liveToken}`,
        );
        const headers = {
          'content-type': 'application/json; charset=utf-8',
          'x-newapi-content-contract': 'v1',
        };
        if (url.pathname.endsWith('/health')) {
          return new Response(JSON.stringify({
            success: true,
            service: 'newapi-live-content',
            contract_version: 'v1',
            read_only: true,
          }), { headers });
        }
        if (url.pathname.endsWith('/docs')) {
          return new Response(JSON.stringify({
            success: true,
            data: {
              meta: {
                source: 'newapi',
                fixture: false,
                live: true,
                label: 'NewAPI live content',
                updated_at: null,
                contract_version: 'v1',
                schema_version: 1,
                renderer_version: 1,
              },
              sections: [{
                title: 'Guides',
                items: [{
                  slug: PRODUCTION_CONTRACT.docsProbeSlug,
                  title: 'Live quickstart',
                  summary: 'Start here with the live API.',
                  keywords: ['quickstart'],
                }],
              }],
              search_index: [{
                slug: PRODUCTION_CONTRACT.docsProbeSlug,
                anchor: null,
                title: 'Live quickstart',
                target_title: 'Live quickstart',
                text: 'Start here with the live API.',
              }],
            },
          }), { headers });
        }
        if (url.pathname.endsWith(`/docs/${PRODUCTION_CONTRACT.docsProbeSlug}`)) {
          return new Response(JSON.stringify({
            success: true,
            data: {
              meta: {
                source: 'newapi',
                fixture: false,
                live: true,
                label: 'NewAPI live content',
                updated_at: null,
                contract_version: 'v1',
                schema_version: 1,
                renderer_version: 1,
              },
              page: {
                slug: PRODUCTION_CONTRACT.docsProbeSlug,
                title: 'Live quickstart',
                summary: 'Start here with the live API.',
                section: 'Guides',
                keywords: ['quickstart'],
                updated_at: 0,
                blocks: [{
                  type: 'lead',
                  text: 'This is a successful live Docs page response.',
                }],
              },
            },
          }), { headers });
        }
        if (url.pathname.endsWith('/pricing')) {
          return new Response(JSON.stringify({
            success: true,
            meta: {
              source: 'newapi',
              fixture: false,
              live: true,
              label: 'NewAPI live content',
              updated_at: null,
              contract_version: 'v1',
            },
            context: {
              user_group: 'default',
              selected_group: 'default',
              locked: true,
            },
            display: {
              quota_display_type: 'USD',
              default_currency: 'CNY',
              price: 7.2,
              usd_exchange_rate: 7.2,
              custom_currency_exchange_rate: 1,
              custom_currency_symbol: '¤',
              show_with_recharge: true,
            },
            data: [],
            vendors: [],
            group_ratio: { default: 10, premium: 2 },
            usable_group: { default: '普通用户' },
            supported_endpoint: {},
            auto_groups: [],
            video_resolution_dimensions: {},
            pricing_version: 'live-v1',
          }), { headers });
        }
        throw new Error(`unexpected live contract path: ${url.pathname}`);
      },
    },
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
  assert.equal(health.status, 'ok');
  assert.equal(health.content_adapter, 'newapi');
  assert.equal(health.live_newapi, true);
  assert.equal(health.live_newapi_healthy, true);
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
  assert.equal(docs.data.meta.source, 'newapi');
  assert.equal(docs.data.meta.fixture, false);
  assert.equal(docs.data.meta.live, true);
  assert.equal(docs.data.meta.schema_version, 1);
  assert.equal(docs.data.meta.renderer_version, 1);

  const docsPage = await fetchJson(
    `/api/content/docs/${PRODUCTION_CONTRACT.docsProbeSlug}`,
    env,
  );
  assert.equal(docsPage.data.meta.source, 'newapi');
  assert.equal(docsPage.data.meta.fixture, false);
  assert.equal(docsPage.data.meta.live, true);
  assert.equal(docsPage.data.meta.schema_version, 1);
  assert.equal(docsPage.data.meta.renderer_version, 1);
  assert.equal(docsPage.data.page.slug, PRODUCTION_CONTRACT.docsProbeSlug);
  assert.equal(docsPage.data.page.title, 'Live quickstart');
  assert.equal(docsPage.data.page.section, 'Guides');
  assert.equal(docsPage.data.page.updated_at, 0);
  assert.ok(docsPage.data.page.blocks.length > 0);
  assert.equal(docsPage.data.page.blocks[0].type, 'lead');

  const pricing = await fetchJson('/api/content/pricing', env);
  assert.equal(pricing.meta.source, 'newapi');
  assert.equal(pricing.meta.fixture, false);
  assert.equal(pricing.meta.live, true);
  assert.deepEqual(pricing.context, {
    user_group: 'default',
    selected_group: 'default',
    locked: true,
  });
  assert.equal(pricing.group_ratio.default, 10);

  const downstream = await worker.fetch(
    new Request('https://production.invalid/downloads'),
    env,
  );
  assert.equal(downstream.status, 200);
  assert.equal(forwarded, true);
  assert.deepEqual(upstreamPaths, [
    '/api/internal/live-content/v1/health',
    '/api/internal/live-content/v1/docs',
    `/api/internal/live-content/v1/docs/${PRODUCTION_CONTRACT.docsProbeSlug}`,
    '/api/internal/live-content/v1/pricing',
  ]);
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const mode = resolveExecutionMode(args);
  assertNodeVersion();
  await assertProductionInvocationInputs(env);
  const config = await readFile(WRANGLER_CONFIG_PATH, 'utf8');
  assertProductionConfig(config);
  await assertProductionRuntimeContract();

  if (mode === 'deploy') assertCredentialPrerequisites(env);
  const commit = await assertCleanCommit();
  process.stdout.write(
    `[production preflight] PASS: clean commit ${commit}; production uses the authorized NewAPI live Docs/Pricing adapter with validated health contract; download forwarding uses the production service-binding gate.\n`,
  );

  await validateProductionCommit(commit, env);
  process.stdout.write(
    `[production validation] PASS: clean commit ${commit}; HEAD and tracked/untracked worktree are unchanged.\n`,
  );

  if (mode === 'dry-run') {
    process.stdout.write(
      `[production preflight] DRY RUN ONLY: clean commit ${commit} validated; no Cloudflare upload or deployment occurred.\n`,
    );
    return;
  }

  await runProductionDeploy(commit, env);
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

function assertVpcServiceBinding(sections, sectionName) {
  const occurrences = sections.get(sectionName);
  assert.equal(occurrences?.length, 1, `expected one [[${sectionName}]]`);
  assert.equal(occurrences[0].array, true, `${sectionName} must be an array table`);
  assert.deepEqual(
    [...occurrences[0].values.keys()].sort(),
    ['binding', 'service_id'],
    `${sectionName} may only select the reviewed NewAPI VPC Service`,
  );
  assert.equal(
    occurrences[0].values.get('binding'),
    PRODUCTION_CONTRACT.newApiVpcBinding,
  );
  assert.equal(
    occurrences[0].values.get('service_id'),
    PRODUCTION_CONTRACT.newApiVpcServiceId,
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

export async function assertNoLocalCredentialFiles(
  repositoryRoot = REPOSITORY_ROOT,
) {
  for (const name of FORBIDDEN_LOCAL_CREDENTIAL_FILES) {
    try {
      await access(resolve(repositoryRoot, name));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error(
      `${name} is present. Production credentials must come from the current shell or an external secret manager, not repository files.`,
    );
  }
}

export function assertNoUnsafeProductionEnvironment(env) {
  const present = FORBIDDEN_PRODUCTION_ENVIRONMENT_VARIABLES.filter((name) =>
    Object.hasOwn(env, name),
  );
  assert.deepEqual(
    present,
    [],
    `production environment contains forbidden Wrangler controls: ${present.join(', ')}`,
  );
}

export async function assertProductionInvocationInputs(
  env,
  repositoryRoot = REPOSITORY_ROOT,
) {
  assertNoUnsafeProductionEnvironment(env);
  await assertNoLocalCredentialFiles(repositoryRoot);
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
  for (const name of [
    'CF_API_TOKEN',
    'CF_ACCOUNT_ID',
    'CLOUDFLARE_API_KEY',
    'CF_API_KEY',
    'CLOUDFLARE_EMAIL',
    'CF_EMAIL',
  ]) {
    assert.equal(env[name], undefined, `legacy credential ${name} is not allowed`);
  }
}

export async function assertCleanCommit(repositoryRoot = REPOSITORY_ROOT) {
  const commitBeforeStatus = (
    await capture(
      'git',
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      repositoryRoot,
    )
  ).trim();
  assert.match(
    commitBeforeStatus,
    /^[0-9a-f]{40}$/,
    'unable to resolve a full deployment commit',
  );

  const status = await capture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    repositoryRoot,
  );
  assert.equal(status.trim(), '', 'production deployment requires a clean worktree');
  const commitAfterStatus = (
    await capture(
      'git',
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      repositoryRoot,
    )
  ).trim();
  assert.equal(
    commitAfterStatus,
    commitBeforeStatus,
    'HEAD changed while verifying the production snapshot',
  );
  return commitAfterStatus;
}

export async function assertSameCleanCommit(
  expectedCommit,
  repositoryRoot = REPOSITORY_ROOT,
  resolveCleanCommit = assertCleanCommit,
) {
  assert.match(expectedCommit, /^[0-9a-f]{40}$/, 'expected a full Git commit');
  const actualCommit = await resolveCleanCommit(repositoryRoot);
  assert.equal(
    actualCommit,
    expectedCommit,
    'worktree or HEAD changed after validation; refusing deployment',
  );
  return actualCommit;
}

export async function validateProductionCommit(
  commit,
  env,
  {
    repositoryRoot = REPOSITORY_ROOT,
    runCommand = run,
    resolveCleanCommit = assertCleanCommit,
  } = {},
) {
  // Recheck immediately before spawning validation: ignored dotenv files are
  // outside Git's clean-worktree proof and are loaded by Wrangler itself.
  await assertProductionInvocationInputs(env, repositoryRoot);
  await runCommand(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'validate'],
    env,
    null,
    repositoryRoot,
  );
  await assertSameCleanCommit(commit, repositoryRoot, resolveCleanCommit);
  await assertProductionInvocationInputs(env, repositoryRoot);
}

export async function runProductionDeploy(
  commit,
  env,
  {
    repositoryRoot = REPOSITORY_ROOT,
    runCommand = run,
    resolveCleanCommit = assertCleanCommit,
  } = {},
) {
  assertCredentialPrerequisites(env);
  await assertProductionInvocationInputs(env, repositoryRoot);
  await assertSameCleanCommit(commit, repositoryRoot, resolveCleanCommit);
  // This final check is intentionally adjacent to the real Wrangler spawn. It
  // catches ignored dotenv or environment drift after validation/provenance.
  await assertProductionInvocationInputs(env, repositoryRoot);
  process.stdout.write(
    `[production deploy] deploying clean commit ${commit} with fixed --env production --strict.\n`,
  );
  await runCommand(
    process.execPath,
    productionDeployArgs(commit),
    env,
    null,
    repositoryRoot,
  );
}

async function capture(command, args, repositoryRoot = REPOSITORY_ROOT) {
  let output = '';
  await run(
    command,
    args,
    process.env,
    (chunk) => {
      output += chunk;
    },
    repositoryRoot,
  );
  return output;
}

async function run(
  command,
  args,
  env = process.env,
  onStdout = null,
  repositoryRoot = REPOSITORY_ROOT,
) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
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
