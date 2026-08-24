import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const BROWSER_EXECUTABLE = process.env.BROWSER_EXECUTABLE_PATH
  || ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'].find((path) => existsSync(path))
  || '/usr/bin/google-chrome';
const SERVER_START_TIMEOUT_MS = 20_000;
const UI_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 15_000;

let browser;
let workerProcess;
let baseUrl;
let workerOutput = '';

before(async () => {
  await access(BROWSER_EXECUTABLE);
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  workerProcess = spawn(
    process.execPath,
    [WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)],
    {
      cwd: ROOT,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const capture = (chunk) => {
    workerOutput = `${workerOutput}${chunk}`.slice(-20_000);
  };
  workerProcess.stdout.on('data', capture);
  workerProcess.stderr.on('data', capture);
  await waitForWorker();
  browser = await chromium.launch({
    executablePath: BROWSER_EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
});

after(async () => {
  await browser?.close();
  if (!workerProcess || workerProcess.exitCode !== null) return;
  workerProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => workerProcess.once('exit', resolve)),
    delay(2_000),
  ]);
  if (workerProcess.exitCode === null) workerProcess.kill('SIGKILL');
});

test('direct /docs replace-navigates before the canonical page renders', { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    window.__historyCalls = [];
    for (const method of ['pushState', 'replaceState']) {
      const original = window.history[method].bind(window.history);
      window.history[method] = (...args) => {
        window.__historyCalls.push({ method, url: String(args[2] || '') });
        return original(...args);
      };
    }
    window.__renderedRoutes = [];
    document.addEventListener('DOMContentLoaded', () => {
      const main = document.querySelector('#main-content');
      new MutationObserver(() => {
        const heading = main.querySelector('h1');
        if (heading) {
          window.__renderedRoutes.push({
            path: window.location.pathname,
            heading: heading.textContent,
          });
        }
      }).observe(main, { childList: true, subtree: true });
    }, { once: true });
  });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();

  assert.equal(new URL(page.url()).pathname, '/docs/quickstart/quickstart');
  const evidence = await page.evaluate(() => ({
    calls: window.__historyCalls,
    rendered: window.__renderedRoutes,
  }));
  assert.ok(evidence.calls.some((call) => call.method === 'replaceState' && call.url === '/docs/quickstart'));
  assert.equal(evidence.rendered[0].path, '/docs/quickstart/quickstart');
  assert.equal(evidence.rendered[0].heading, '快速开始');
  await context.close();
});

test('console Docs alias mounts the same runtime for root and nested paths', { timeout: 25_000 }, async () => {
  for (const pathname of ['/console/docs', '/console/docs/quickstart']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await newPage(context);
    await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.docs-hub-page-title').waitFor();

    assert.equal(new URL(page.url()).pathname, '/docs/quickstart/quickstart');
    assert.equal(await page.locator('.error-page').count(), 0);
    assert.equal(await page.locator('a[data-nav="docs"][aria-current="page"]').count(), 1);
    assert.equal((await page.locator('.docs-hub-page-title').textContent()).trim(), '快速开始');
    await context.close();
  }
});

test('public Docs navigation ignores browser sessions and stale localStorage', { timeout: 30_000 }, async () => {
  for (const storedUser of [null, { public_id: 'stale-browser-user' }]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (storedUser) {
      await context.addInitScript((user) => {
        localStorage.setItem('user', JSON.stringify(user));
      }, storedUser);
    }
    await context.addCookies([
      { name: 'session', value: 'docs-session', domain: '127.0.0.1', path: '/' },
    ]);
    const page = await newPage(context);
    let navigationRequests = 0;
    await page.route('**/api/docs/v2/navigation*', async (route) => {
      navigationRequests += 1;
      assert.equal(route.request().headers().cookie, undefined);
      assert.equal(route.request().headers().authorization, undefined);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{
            type: 'group',
            id: 900,
            slug: 'authenticated-guides',
            title: 'Public guides',
            space_id: 1,
            locale: 'zh',
            children: [{
              type: 'page',
              id: 901,
              slug: 'quickstart',
              path: 'quickstart',
              title: 'Public quickstart',
              space_id: 1,
              locale: 'zh',
              children: [],
            }],
          }],
        }),
      });
    });
    await page.goto(`${baseUrl}/docs`, { waitUntil: 'domcontentloaded' });
    await page.locator('.docs-hub-page-title').waitFor();
    assert.equal(navigationRequests, 2, 'the canonical DocsHub refreshes navigation during root and page mounting');
    assert.equal(await page.locator('.docs-hub-tree-group').getByText('Public guides', { exact: true }).count(), 1);
    assert.equal(await page.locator('.docs-hub-tree-group').getByText('快速开始', { exact: true }).count(), 0);
    await context.close();
  }
});

test('public Docs navigation failure follows the canonical tree fallback', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ public_id: 'stale-browser-user' }));
  });
  await context.addCookies([
    { name: 'session', value: 'docs-session', domain: '127.0.0.1', path: '/' },
  ]);
  const page = await newPage(context);
  let navigationRequests = 0;
  await page.route('**/api/docs/v2/navigation*', async (route) => {
    navigationRequests += 1;
    assert.equal(route.request().headers().cookie, undefined);
    assert.equal(route.request().headers().authorization, undefined);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        error: {
          code: 'integration_unavailable',
        message: 'DocsHub navigation is unavailable.',
        },
      }),
    });
  });
  await page.goto(`${baseUrl}/docs`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();
  assert.equal(navigationRequests, 2, 'the canonical hub falls back to the published page tree');
  assert.equal(await page.locator('.error-page').count(), 0);
  assert.equal(await page.locator('.docs-hub-tree-group').count() > 0, true);
  await context.close();
});

test('public Docs navigation is required even when a browser has no session', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  let navigationRequests = 0;
  await page.route('**/api/docs/v2/navigation*', async (route) => {
    navigationRequests += 1;
    assert.equal(route.request().headers().cookie, undefined);
    assert.equal(route.request().headers().authorization, undefined);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{
          type: 'group', id: 902, slug: 'public-guides', title: 'Public guides',
          space_id: 1, locale: 'zh', children: [{
            type: 'page', id: 903, slug: 'quickstart', path: 'quickstart',
            title: 'Public quickstart', space_id: 1, locale: 'zh', children: [],
          }],
        }],
      }),
    });
  });
  await page.goto(`${baseUrl}/docs`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();
  assert.equal(navigationRequests, 2, 'the canonical DocsHub refreshes navigation during root and page mounting');
  assert.equal(new URL(page.url()).pathname, '/docs/quickstart/quickstart');
  assert.equal((await page.locator('.docs-hub-page-title').textContent()).trim(), '快速开始');
  await context.close();
});

test('desktop Ctrl/Cmd+K finds rendered text and endpoint paths with exact anchors', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs/quickstart`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();

  await searchWithShortcut(page, 'temperature', '/docs/quickstart/chat-completions#body');
  await assertAnchorTarget(page, '/docs/quickstart/chat-completions', '#body', 'body');
  await searchWithShortcut(
    page,
    '/v1/responses',
    '/docs/quickstart/responses#responses-endpoint',
    'Meta+K',
  );
  await assertAnchorTarget(
    page,
    '/docs/quickstart/responses',
    '#responses-endpoint',
    'responses-endpoint',
  );
  await context.close();
});

test('mobile Docs search finds the same deterministic text and endpoint targets', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs/quickstart`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-mobile-bar').waitFor();

  await searchWithMobileButton(page, 'temperature', '/docs/quickstart/chat-completions#body');
  await assertAnchorTarget(page, '/docs/quickstart/chat-completions', '#body', 'body');
  await searchWithMobileButton(page, '/v1/responses', '/docs/quickstart/responses#responses-endpoint');
  await assertAnchorTarget(
    page,
    '/docs/quickstart/responses',
    '#responses-endpoint',
    'responses-endpoint',
  );
  await context.close();
});

test('single-heading TOC occupies a column only at the desktop breakpoint', { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs/quickstart/responses`, { waitUntil: 'domcontentloaded' });
  const toc = page.locator('.docs-hub-toc');
  await page.waitForSelector('.docs-hub-page-title');
  assert.equal(await toc.count(), 0, 'canonical DocsHub omits a one-item outline');

  await page.setViewportSize({ width: 1559, height: 1000 });
  assert.equal(await page.locator('.docs-hub-toc').count(), 0);
  await context.close();
});

test('both public Pricing URLs mount the canonical runtime and share the same request path', { timeout: 35_000 }, async () => {
  for (const pathname of ['/console/pricing', '/pricing']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem('user', JSON.stringify({ public_id: 'hostile-browser-user' }));
      localStorage.setItem('status', JSON.stringify({ price: 999, custom_currency_symbol: 'STALE' }));
    });
    const page = await newPage(context);
    const pricingPaths = [];
    const statusPaths = [];
    await page.route('**/api/status', async (route) => {
      statusPaths.push(new URL(route.request().url()).pathname);
      assert.equal(route.request().headers().cookie, undefined);
      assert.equal(route.request().headers().authorization, undefined);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: '',
          data: {
            display_in_currency: true,
            quota_display_type: 'CNY',
            price: 7.2,
            usd_exchange_rate: 7.2,
            custom_currency_exchange_rate: 1,
            custom_currency_symbol: '¤',
            quota_per_unit: 500000,
            model_marketplace_default: { vendor: '1', group: 'default' },
          },
        }),
      });
    });
    await page.route('**/api/pricing', async (route) => {
      pricingPaths.push(new URL(route.request().url()).pathname);
      const headers = route.request().headers();
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [{ model_name: 'canonical parity model', vendor_id: 1, quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ['default'] }],
          vendors: [{ id: 1, name: 'Canonical vendor' }],
          group_ratio: { default: 1 },
          usable_group: { default: 'Default' },
          supported_endpoint: {},
          auto_groups: [],
          video_resolution_dimensions: {},
          pricing_version: 'browser-parity-v1',
        }),
      });
    });
    await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
    assert.deepEqual(pricingPaths, ['/api/pricing']);
    assert.deepEqual(statusPaths, ['/api/status']);
    assert.equal(await page.locator('.pricing-page-shell').count(), 1);
    await context.close();
  }
});

async function newPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(UI_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
  return page;
}

async function searchWithShortcut(page, query, target, shortcut = 'Control+K') {
  await page.keyboard.press(shortcut);
  await searchAndSelect(page, query, target);
}

async function searchWithMobileButton(page, query, target) {
  await page.locator('.docs-hub-mobile-bar button[aria-label="搜索文档"]').click();
  await searchAndSelect(page, query, target);
}

async function searchAndSelect(page, query, target) {
  const input = page.locator('.semi-modal input[placeholder="搜索标题、正文、接口路径…"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(query);
  const result = page.locator('.docs-hub-search-item').filter({ hasText: query });
  await result.waitFor({ state: 'visible' });
  assert.match((await result.textContent()).toLowerCase(), new RegExp(escapeRegExp(query.toLowerCase())));
  await result.click();
}

async function assertAnchorTarget(page, pathname, hash, id) {
  await page.waitForURL((url) => url.pathname === pathname && url.hash === hash);
  const target = page.locator(`#${id}`);
  await target.waitFor({ state: 'visible' });
  await page.waitForFunction((targetId) => document.activeElement?.id === targetId, id);
  assert.equal(await target.getAttribute('tabindex'), '-1');
  assert.match(await target.getAttribute('class'), /docs-hub-anchor-target/);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForWorker() {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (workerProcess.exitCode !== null) {
      throw new Error(`Wrangler exited before readiness (${workerProcess.exitCode}).\n${workerOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The local listener is not ready yet.
    }
    await delay(100);
  }
  throw new Error(`Wrangler did not become ready within ${SERVER_START_TIMEOUT_MS}ms.\n${workerOutput}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
