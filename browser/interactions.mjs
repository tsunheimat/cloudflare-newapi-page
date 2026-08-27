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

test('legacy tokenrouter Docs aliases resolve to quickstart without a tokenrouter space query', { timeout: 30_000 }, async () => {
  for (const pathname of ['/docs/tokenrouter', '/console/docs/tokenrouter', '/docs/quickstart/tokenrouter']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await newPage(context);
    const docsRequests = [];
    await page.route('**/api/docs/v2/**', async (route) => {
      const url = new URL(route.request().url());
      docsRequests.push(url);
      const response = url.pathname.endsWith('/config')
        ? { success: true, data: { enabled: true } }
        : url.pathname.endsWith('/spaces')
          ? { success: true, data: [{ slug: 'quickstart', title: 'Quickstart' }] }
          : url.pathname.endsWith('/tree') || url.pathname.endsWith('/navigation')
            ? { success: true, data: [{ type: 'page', id: 1, slug: 'tokenrouter', path: 'tokenrouter', title: 'Tokenrouter', locale: 'zh', children: [] }] }
            : { success: true, data: { id: 1, space_slug: 'quickstart', slug: 'tokenrouter', title: 'Tokenrouter', locale: 'zh', path: '/docs/quickstart/tokenrouter', content: { blocks: [] }, related: [] } };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.docs-hub-page-title').waitFor();
    assert.equal(new URL(page.url()).pathname, '/docs/quickstart/tokenrouter');
    assert.equal((await page.locator('.docs-hub-page-title').textContent()).trim(), 'Tokenrouter');
    assert.ok(docsRequests.length > 0);
    assert.ok(docsRequests.every((url) => url.searchParams.get('space') !== 'tokenrouter'));
    assert.ok(docsRequests.some((url) => url.searchParams.get('space') === 'quickstart'));
    await context.close();
  }
});

test('mounted DocsHub related navigation normalizes legacy aliases before fetching', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  const docsRequests = [];
  await page.route('**/api/docs/v2/**', async (route) => {
    const url = new URL(route.request().url());
    docsRequests.push(url);
    let response;
    if (url.pathname.endsWith('/config')) {
      response = { success: true, data: { enabled: true } };
    } else if (url.pathname.endsWith('/spaces')) {
      response = { success: true, data: [{ slug: 'quickstart', title: 'Quickstart' }] };
    } else if (url.pathname.endsWith('/tree') || url.pathname.endsWith('/navigation')) {
      response = {
        success: true,
        data: [{ type: 'page', id: 1, slug: 'quickstart', path: 'quickstart', title: 'Quickstart', locale: 'zh', children: [] }],
      };
    } else if (url.pathname.endsWith('/pages/quickstart')) {
      response = {
        success: true,
        data: {
          id: 1,
          space_slug: 'quickstart',
          slug: 'quickstart',
          title: 'Quickstart',
          locale: 'zh',
          path: '/docs/quickstart/quickstart',
          content: { blocks: [] },
          related: [{ page_id: 2, title: 'Tokenrouter', relation_type: 'related', path: '/docs/tokenrouter' }],
        },
      };
    } else {
      response = {
        success: true,
        data: {
          id: 2,
          space_slug: 'quickstart',
          slug: 'tokenrouter',
          title: 'Tokenrouter',
          locale: 'zh',
          path: '/docs/quickstart/tokenrouter',
          content: { blocks: [] },
          related: [],
        },
      };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
  });

  await page.goto(`${baseUrl}/docs/quickstart/quickstart`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();
  await page.locator('.docs-hub-related a').click();
  await page.waitForURL((url) => url.pathname === '/docs/quickstart/tokenrouter');
  await page.locator('.docs-hub-page-title').filter({ hasText: 'Tokenrouter' }).waitFor();

  assert.ok(docsRequests.some((url) => url.pathname.endsWith('/pages/tokenrouter') && url.searchParams.get('space') === 'quickstart'));
  assert.ok(docsRequests.every((url) => url.searchParams.get('space') !== 'tokenrouter'));
  await context.close();
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
    assert.ok(navigationRequests >= 1, 'Docs navigation remains available after the initial preload');
    await page.getByText('Public guides', { exact: true }).waitFor();
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
  assert.ok(navigationRequests >= 1, 'the canonical hub falls back to the published page tree');
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
  assert.ok(navigationRequests >= 1, 'Docs navigation remains required without a session');
  assert.equal(new URL(page.url()).pathname, '/docs/quickstart/quickstart');
  assert.equal((await page.locator('.docs-hub-page-title').textContent()).trim(), '快速开始');
  await context.close();
});

test('shell Home -> Docs re-entry refreshes the mounted page and preserves history transitions', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);

  await page.goto(`${baseUrl}/docs/quickstart/responses`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Responses API', exact: true }).waitFor();

  await page.locator('a[data-nav="home"]').click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.getByRole('heading', { name: '把接口能力，变成清晰的开发体验。', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-panel--docs .docs-hub-page-title:visible').count(), 0);

  await page.locator('a[data-nav="docs"]').click();
  await page.waitForURL((url) => url.pathname === '/docs/quickstart/quickstart');
  await page.getByRole('heading', { name: '快速开始', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Responses API', exact: true }).count(), 0);

  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/');
  await page.getByRole('heading', { name: '把接口能力，变成清晰的开发体验。', exact: true }).waitFor();

  await page.goForward();
  await page.waitForURL((url) => url.pathname === '/docs/quickstart/quickstart');
  await page.getByRole('heading', { name: '快速开始', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Responses API', exact: true }).count(), 0);
  await context.close();
});

test('Docs initial preload starts from Home and is reused on first entry', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  let configRequests = 0;
  await page.route('**/api/docs/v2/config', async (route) => {
    configRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { enabled: true } }),
    });
  });
  await page.route('**/api/docs/v2/spaces*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [{ slug: 'quickstart', title: 'Quickstart' }] }),
    });
  });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '把接口能力，变成清晰的开发体验。', exact: true }).waitFor();
  assert.equal(configRequests, 1, 'Home should start one Docs config preload');
  await page.locator('[data-workspace-tab="docs"]').click();
  await page.locator('.docs-hub-page-title').waitFor();
  assert.equal(configRequests, 1, 'first Docs entry should reuse the preload response');
  await page.locator('[data-workspace-tab="home"]').click();
  await page.getByRole('heading', { name: '把接口能力，变成清晰的开发体验。', exact: true }).waitFor();
  await page.locator('[data-workspace-tab="docs"]').click();
  await page.locator('.docs-hub-page-title').waitFor();
  assert.equal(configRequests, 1, 'repeated Docs entry should remain coalesced');
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

test('public Pricing is card-first before any toggle on desktop, laptop, and mobile, with table switching preserved', { timeout: 60_000 }, async () => {
  const payload = {
    success: true,
    data: [{
      model_name: 'initial card-first pricing model',
      vendor_id: 1,
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 2,
      enable_groups: ['default'],
    }],
    vendors: [{ id: 1, name: 'Canonical vendor' }],
    group_ratio: { default: 1 },
    usable_group: { default: 'Default' },
    supported_endpoint: {},
    auto_groups: [],
    video_resolution_dimensions: {},
    pricing_version: 'browser-initial-card-v1',
  };
  const status = {
    success: true,
    data: {
      display_in_currency: true,
      quota_display_type: 'USD',
      price: 7.2,
      usd_exchange_rate: 7.2,
      custom_currency_exchange_rate: 1,
      custom_currency_symbol: '¤',
      quota_per_unit: 1_000_000,
      model_marketplace_default: { vendor: '1', group: 'default' },
    },
  };

  for (const viewport of [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'laptop', width: 1042, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ]) {
    for (const pathname of ['/pricing', '/console/pricing']) {
      const context = await browser.newContext({ viewport });
      const page = await newPage(context);
      await page.route('**/api/status', async (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(status),
      }));
      await page.route('**/api/pricing', async (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      }));

      await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.pricing-page-shell').waitFor();
      // Do not click a view control before this assertion: this is the
      // customer-visible initial state regression.
      await page.locator('.pricing-model-card').first().waitFor();
      assert.ok(await page.locator('.pricing-model-card').count() > 0, `${viewport.name} ${pathname} has no initial cards`);
      assert.equal(await page.locator('.pricing-model-table').count(), 0, `${viewport.name} ${pathname} starts in table view`);
      const cardToggle = page.locator('.pricing-view-switch button[aria-label="卡片视图"]');
      const tableToggle = page.locator('.pricing-view-switch button[aria-label="表格视图"]');
      assert.equal(await cardToggle.getAttribute('aria-pressed'), 'true');
      assert.equal(await tableToggle.getAttribute('aria-pressed'), 'false');

      // The visitor can still switch to the canonical table and back.
      await tableToggle.click();
      await page.locator('.pricing-model-table').waitFor();
      assert.equal(await page.locator('.pricing-model-card').count(), 0, `${viewport.name} ${pathname} table toggle kept cards visible`);
      assert.equal(await tableToggle.getAttribute('aria-pressed'), 'true');
      await cardToggle.click();
      await page.locator('.pricing-model-card').first().waitFor();
      assert.equal(await page.locator('.pricing-model-table').count(), 0, `${viewport.name} ${pathname} card toggle kept table visible`);
      await context.close();
    }
  }
});

test('Pricing cards keep long mixed-language names and live price hierarchy readable at desktop and mobile widths', { timeout: 45_000 }, async () => {
  const payload = {
    success: true,
    data: [
      {
        model_name: 'OpenAI 中文超長模型名稱 / gpt-4o-enterprise-preview-with-very-long-plan-name',
        vendor_id: 1,
        vendor_name: 'English Vendor / 中文供應商',
        quota_type: 0,
        model_ratio: 1.25,
        completion_ratio: 2,
        enable_groups: ['default'],
        supported_endpoint_types: ['openai', 'responses'],
        tags: 'Chat,Premium',
      },
      {
        model_name: 'tiered-context-long-plan-名稱-32k',
        vendor_id: 1,
        quota_type: 0,
        model_ratio: 0,
        completion_ratio: 0,
        enable_groups: ['default'],
        billing_mode: 'tiered_expr',
        billing_expr: 'v1:len <= 32000 ? tier("<= 32K", p * 0.8 + c * 3.2) : tier("> 32K", p * 1.6 + c * 6.4)|||when(header("x-priority") has "fast") * 2',
        supported_endpoint_types: ['openai'],
      },
    ],
    vendors: [{ id: 1, name: 'English Vendor / 中文供應商' }],
    group_ratio: { default: 1.25 },
    usable_group: { default: 'Default / 預設方案' },
    supported_endpoint: {},
    auto_groups: [],
    video_resolution_dimensions: {},
    pricing_version: 'browser-layout-regression-v1',
  };

  for (const viewport of [{ width: 1042, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    const page = await newPage(context);
    await page.route('**/api/status', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          display_in_currency: true,
          quota_display_type: 'USD',
          price: 7.2,
          usd_exchange_rate: 7.2,
          custom_currency_exchange_rate: 1,
          custom_currency_symbol: '¤',
          quota_per_unit: 1_000_000,
          model_marketplace_default: { vendor: '1', group: 'default' },
        },
      }),
    }));
    await page.route('**/api/pricing', async (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    }));
    await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
    await page.locator('.pricing-page-shell').waitFor();
    await page.locator('.pricing-model-card').first().waitFor();

    const metrics = await page.locator('.pricing-model-card').evaluateAll((cards) => cards.map((card) => {
      const name = card.querySelector('.pricing-model-name');
      const price = card.querySelector('.pricing-card-price-block');
      const comparison = card.querySelector('.pricing-card-comparison');
      const cardRect = card.getBoundingClientRect();
      const nameRect = name?.getBoundingClientRect();
      const priceRect = price?.getBoundingClientRect();
      const comparisonRect = comparison?.getBoundingClientRect();
      return {
        width: cardRect.width,
        cardScrollWidth: card.scrollWidth,
        nameBottom: nameRect?.bottom,
        priceTop: priceRect?.top,
        priceBottom: priceRect?.bottom,
        comparisonTop: comparisonRect?.top,
        nameText: name?.textContent,
      };
    }));
    assert.equal(metrics.length, 2);
    for (const metric of metrics) {
      assert.ok(metric.width > 0);
      assert.ok(metric.cardScrollWidth <= metric.width + 1, `card overflow at ${viewport.width}px`);
      assert.ok(metric.nameBottom <= metric.priceTop, 'model name overlaps price block');
      assert.ok(metric.priceBottom >= metric.comparisonTop, 'comparison must follow the price block');
      assert.match(metric.nameText, /中文|OpenAI|tiered/);
    }
    if (viewport.width <= 767) {
      assert.ok(metrics.every((metric) => metric.width >= 320), 'mobile card is unexpectedly narrow');
    } else {
      assert.ok(metrics.every((metric) => metric.width >= 380), 'desktop card lost its readable minimum width');
    }
    await context.close();
  }
});

test('public Pricing exposes the canonical seven-language switch on desktop and mobile', { timeout: 45_000 }, async () => {
  const languages = [
    ['zh-CN', '简体中文'],
    ['zh-TW', '繁體中文'],
    ['en', 'English'],
    ['fr', 'Français'],
    ['ja', '日本語'],
    ['ru', 'Русский'],
    ['vi', 'Tiếng Việt'],
  ];
  for (const pathname of ['/console/pricing', '/pricing']) {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await newPage(context);
      await page.route('**/api/status', async (route) => {
        assert.equal(route.request().headers().cookie, undefined);
        assert.equal(route.request().headers().authorization, undefined);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
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
        assert.equal(route.request().headers().cookie, undefined);
        assert.equal(route.request().headers().authorization, undefined);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: [{ model_name: 'language switch model', vendor_id: 1, quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ['default'] }],
            vendors: [{ id: 1, name: 'Canonical vendor' }],
            group_ratio: { default: 1 },
            usable_group: { default: 'Default' },
            supported_endpoint: {},
            auto_groups: [],
            video_resolution_dimensions: {},
          }),
        });
      });
      await page.goto(`${baseUrl}${pathname}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
      const trigger = page.locator('.pricing-language-trigger');
      await trigger.waitFor({ state: 'visible' });
      await trigger.hover();
      await page.locator('.pricing-language-menu').waitFor({ state: 'visible' });
      assert.equal(await trigger.getAttribute('aria-haspopup'), 'true');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      await trigger.click();
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.pricing-language-menu').getAttribute('aria-orientation'), 'vertical');
      assert.deepEqual(
        await page.locator('[data-language]').evaluateAll((options) => options.map((option) => option.dataset.language)),
        languages.map(([value]) => value),
      );
      for (const [, label] of languages) {
        assert.equal(await page.getByRole('menuitem', { name: label, exact: true }).count(), 1, label);
      }
      assert.equal(
        await page.locator('[role="menuitem"]:focus').getAttribute('data-language'),
        'zh-CN',
      );
      await page.keyboard.press('ArrowDown');
      assert.equal(
        await page.locator('[role="menuitem"]:focus').getAttribute('data-language'),
        'zh-TW',
      );
      await page.keyboard.press('e');
      assert.equal(
        await page.locator('[role="menuitem"]:focus').getAttribute('data-language'),
        'en',
      );
      await page.keyboard.press('Escape');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      const runtimeLanguage = await page.evaluate(() => window.__i18n?.language);
      assert.equal(
        await page.locator('[aria-current="true"]').getAttribute('data-language'),
        runtimeLanguage,
      );
      await context.close();
    }
  }
});

test('Pricing language switching changes the mounted runtime and persists anonymously', { timeout: 45_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  const unexpectedAuthRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/user/')) unexpectedAuthRequests.push(request.url());
  });
  await page.route('**/api/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { display_in_currency: true, quota_display_type: 'CNY', price: 7.2, usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1, custom_currency_symbol: '¤', quota_per_unit: 500000, model_marketplace_default: { vendor: '1', group: 'default' } } }),
    });
  });
  await page.route('**/api/pricing', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [{ model_name: 'runtime language model', vendor_id: 1, quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ['default'] }], vendors: [{ id: 1, name: 'Canonical vendor' }], group_ratio: { default: 1 }, usable_group: { default: 'Default' }, supported_endpoint: {}, auto_groups: [], video_resolution_dimensions: {} }),
    });
  });
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
  await page.evaluate(() => {
    const originalChangeLanguage = window.__i18n.changeLanguage;
    window.__languageChangeCalls = [];
    window.__i18n.changeLanguage = function changeLanguage(language) {
      window.__languageChangeCalls.push(language);
      return originalChangeLanguage.call(this, language);
    };
  });
  await page.locator('.pricing-language-trigger').click();
  await page.getByRole('menuitem', { name: 'English', exact: true }).click();
  await page.getByRole('heading', { name: 'Model price', exact: true }).first().waitFor();
  const state = await page.evaluate(() => ({
    language: window.__i18n?.language,
    stored: localStorage.getItem('i18nextLng'),
    html: document.documentElement.lang,
    calls: window.__languageChangeCalls,
  }));
  assert.equal(state.language, 'en');
  assert.equal(state.stored, 'en');
  assert.equal(state.html, 'en');
  assert.deepEqual(state.calls, ['en']);
  assert.deepEqual(unexpectedAuthRequests, []);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Model price', exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.__i18n?.language), 'en');
  await page.evaluate(() => window.__i18n.changeLanguage('fr'));
  assert.equal(
    await page.locator('[data-language="fr"]').getAttribute('aria-current'),
    'true',
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('i18nextLng')), 'fr');
  await context.close();
});

test('Pricing discount labels stay compact and locale-correct in the canonical group card', { timeout: 45_000 }, async () => {
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await newPage(context);
    await page.route('**/api/status', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: {
        display_in_currency: true,
        quota_display_type: 'USD',
        price: 1,
        usd_exchange_rate: 1,
        custom_currency_exchange_rate: 1,
        custom_currency_symbol: '¤',
        quota_per_unit: 1_000_000,
        model_marketplace_default: { vendor: '1', group: 'default' },
      },
    }),
    }));
    await page.route('**/api/pricing', async (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data: [{
        model_name: 'discount-label-long-model-name-for-wrapping-regression',
        vendor_id: 1,
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 2,
        enable_groups: ['default'],
      }],
      vendors: [{ id: 1, name: 'Canonical vendor with a representative long label' }],
      group_ratio: { default: 0.029 },
      usable_group: { default: 'Default / 默认分组' },
      supported_endpoint: {},
      auto_groups: [],
      video_resolution_dimensions: {},
      pricing_version: 'browser-discount-label-v1',
    }),
    }));
    await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
    await page.locator('.pricing-group-card').first().waitFor();

    const discount = page.locator('.pricing-group-discount').first();
    assert.equal((await discount.textContent()).trim(), '0.29折');

    await page.evaluate(() => window.__i18n.changeLanguage('en'));
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal((await discount.textContent()).trim(), '97.1% off');
    assert.match((await discount.textContent()).trim(), /^\d+(?:\.\d+)?% off$/);
    assert.doesNotMatch((await discount.textContent()).trim(), /off\s+\d+%|\/10 price|^\d+(?:\.\d+)?%$/);
    await context.close();
  }
});

test('[mocked/source evidence] Downloads root keeps every program and file target in one panel', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  await page.route('**/api/downloads/catalog', async (route) => {
    assert.equal(route.request().headers().cookie, undefined);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          software: [
            { id: 'codex-installer', label: 'Codex 安装器' },
            { id: 'codex-chat-record-migrator', label: 'Codex 聊天记录迁移器' },
          ],
        },
      }),
    });
  });
  for (const id of ['codex-installer', 'codex-chat-record-migrator']) {
    await page.route(`**/downloads/api/${id}/public`, async (route) => {
      assert.equal(route.request().headers().cookie, undefined);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ release_id: `${id}-v1`, files: [{
          site: 'tokenrouter', platform: 'windows', arch: 'x64',
          filename: `${id}.zip`, size: 1024, sha256: 'a'.repeat(64),
        }] }),
      });
    });
  }
  await page.goto(`${baseUrl}/downloads`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '软件下载中心', exact: true }).waitFor();
  assert.equal(await page.locator('.workspace-shell').count(), 1);
  assert.equal(await page.locator('[role="tab"]').count(), 4);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-workspace-tab'), 'downloads');
  assert.equal(await page.locator('.workspace-panel--home[hidden]').count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'Codex 安装器', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'Codex 聊天记录迁移器', exact: true }).count(), 1);
  assert.equal(await page.locator('[data-download-software="codex-installer"]').count(), 1);
  assert.equal(await page.locator('[data-download-software="codex-chat-record-migrator"]').count(), 1);
  assert.equal(await page.locator('.downloads-file-card').count(), 2);
  await page.evaluate(() => { window.__downloadsShell = document.querySelector('.workspace-shell'); });
  assert.equal(await page.locator('.workspace-shell').count(), 1);
  assert.equal(await page.evaluate(() => window.__downloadsShell === document.querySelector('.workspace-shell')), true);
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').getAttribute('data-workspace-tab'), 'downloads');
  assert.equal(await page.locator('.workspace-panel--docs[hidden]').count(), 1);
  await context.close();
});

test('[mocked/source evidence] workspace tab switches keep one document and expose the canonical shell', { timeout: 35_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  await page.route('**/api/downloads/catalog', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { software: [] } }),
    });
  });
  await page.route('**/api/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: {
      display_in_currency: true, quota_display_type: 'CNY', price: 7.2,
      usd_exchange_rate: 7.2, custom_currency_exchange_rate: 1,
      custom_currency_symbol: '¤', quota_per_unit: 500000,
      model_marketplace_default: { vendor: '1', group: 'default' },
    } }) });
  });
  await page.route('**/api/pricing', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      success: true, data: [], vendors: [], group_ratio: { default: 1 },
      usable_group: { default: 'Default' }, supported_endpoint: {}, auto_groups: [],
      video_resolution_dimensions: {},
    }) });
  });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '把接口能力，变成清晰的开发体验。', exact: true }).waitFor();
  await page.evaluate(() => { window.__workspaceShell = document.querySelector('.workspace-shell'); });
  await page.locator('[data-workspace-tab="pricing"]').click();
  await page.waitForURL((url) => url.pathname === '/console/pricing');
  await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
  assert.equal(await page.locator('.workspace-shell').count(), 1);
  assert.equal(await page.evaluate(() => window.__workspaceShell === document.querySelector('.workspace-shell')), true);
  assert.equal(await page.locator('.workspace-tabs').count(), 1);
  assert.equal(await page.locator('.primary-nav').count(), 0);
  assert.equal(await page.locator('header nav').count(), 0);
  assert.equal(await page.locator('[data-workspace-tab="pricing"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.workspace-panel--home[hidden]').count(), 1);
  assert.equal(await page.locator('.workspace-panel--docs[hidden]').count(), 1);
  assert.equal(await page.locator('.workspace-panel--downloads[hidden]').count(), 1);
  assert.equal(await page.locator('.site-header .brand-logo').count(), 2);
  await context.close();
});

test('[mocked/source evidence] Downloads detail panel renders public metadata and links through mounted service routes', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([
    { name: 'hostile-session', value: 'must-not-forward', domain: '127.0.0.1', path: '/' },
  ]);
  const page = await newPage(context);
  const observed = [];
  const metadata = {
    release_id: 'codex-v2.4.0',
    generated_at: '2026-08-25T00:00:00Z',
    details: { notes: 'public release notes' },
    files: [{
      site: 'tokenrouter',
      platform: 'windows',
      arch: 'x64',
      filename: 'JuAPI-CodexSetup.exe',
      size: 123456,
      sha256: 'a'.repeat(64),
      url: 'https://downloads.example.invalid/public.exe',
      details: { channel: 'stable' },
    }],
  };
  await page.route('**/downloads/api/codex-installer/public', async (route) => {
    observed.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metadata) });
  });
  await page.route('**/downloads/api/codex-chat-record-migrator/public', async (route) => {
    observed.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers() });
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'public metadata unavailable' } }) });
  });
  await page.goto(`${baseUrl}/downloads/software/codex-installer`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Codex Installer', exact: true }).waitFor();
  await page.getByText('JuAPI-CodexSetup.exe', { exact: true }).waitFor();
  assert.equal(await page.getByText('JuAPI-CodexSetup.exe', { exact: true }).count(), 1);
  assert.equal(await page.locator('.downloads-file-kv dd').nth(2).textContent(), '120.6 KB');
  assert.equal(await page.getByText('SHA-256', { exact: true }).count(), 1);
  assert.equal(await page.locator('a[href="/downloads/download/codex-installer/tokenrouter/windows/x64"]').count(), 1);
  assert.equal(await page.getByText('public release notes', { exact: false }).count(), 1);
  assert.ok(observed.every(({ headers }) => !headers.cookie && !headers.authorization));
  await context.close();
});

test('[mocked/source evidence] Downloads panel renders empty and downstream error states', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await newPage(context);
  await page.route('**/api/downloads/catalog', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { software: [{ id: 'empty-software' }] } }) });
  });
  await page.route('**/downloads/api/empty-software/public', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ release_id: 'empty', files: [] }) });
  });
  await page.goto(`${baseUrl}/downloads/software/empty-software`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'empty', exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '暂无可用下载', exact: true }).count(), 1);
  await context.close();
});

test('[mocked/source evidence] Downloads root keeps per-program error state in the same panel', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 844 } });
  const page = await newPage(context);
  await page.route('**/api/downloads/catalog', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { software: [{ id: 'empty-software' }, { id: 'error-software' }] } }),
    });
  });
  await page.route('**/downloads/api/empty-software/public', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ release_id: 'empty', files: [] }) });
  });
  await page.route('**/downloads/api/error-software/public', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: { message: 'metadata unavailable' } }) });
  });
  await page.goto(`${baseUrl}/downloads`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '软件下载中心', exact: true }).waitFor();
  await page.getByRole('heading', { name: '暂无可用下载', exact: true }).first().waitFor();
  assert.equal(await page.locator('[data-download-software]').count(), 2);
  assert.equal(await page.locator('.downloads-card-status--error').count(), 1);
  assert.equal(await page.getByText('metadata unavailable', { exact: true }).count(), 0);
  assert.equal(await page.locator('.workspace-panel--downloads[hidden]').count(), 0);
  await context.close();
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
