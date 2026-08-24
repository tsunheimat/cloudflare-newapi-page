import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const BROWSER_EXECUTABLE = process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/google-chrome';
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

  assert.equal(new URL(page.url()).pathname, '/docs/quickstart');
  const evidence = await page.evaluate(() => ({
    calls: window.__historyCalls,
    rendered: window.__renderedRoutes,
  }));
  assert.deepEqual(evidence.calls, [
    { method: 'replaceState', url: '/docs/quickstart' },
  ]);
  assert.equal(evidence.rendered[0].path, '/docs/quickstart');
  assert.equal(evidence.rendered[0].heading, '快速开始');
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
    await page.route('**/api/front-door/v1/docs/v2/navigation?locale=zh', async (route) => {
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
    assert.equal(navigationRequests, 2, 'the redirect and final Docs render each use the fresh front-door result');
    assert.equal(await page.locator('.docs-hub-tree-group').getByText('Public guides', { exact: true }).count(), 1);
    assert.equal(await page.locator('.docs-hub-tree-group').getByText('快速开始', { exact: true }).count(), 0);
    await context.close();
  }
});

test('public Docs navigation failure renders a bounded error instead of fixture navigation', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ public_id: 'stale-browser-user' }));
  });
  await context.addCookies([
    { name: 'session', value: 'docs-session', domain: '127.0.0.1', path: '/' },
  ]);
  const page = await newPage(context);
  let navigationRequests = 0;
  await page.route('**/api/front-door/v1/docs/v2/navigation?locale=zh', async (route) => {
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
          message: 'Front-door Docs navigation is unavailable.',
        },
      }),
    });
  });
  await page.goto(`${baseUrl}/docs`, { waitUntil: 'domcontentloaded' });
  await page.locator('.error-page').waitFor();
  assert.equal(navigationRequests, 1, 'the failed front-door request stops the route before the final Docs render');
  assert.equal(await page.locator('.docs-hub-page-title').count(), 0);
  assert.match(await page.locator('.error-page h1').textContent(), /内容暂时无法载入/);
  assert.equal(
    (await page.locator('.error-page p').textContent()).trim(),
    '文档导航暂时不可用，请稍后重试。',
  );
  assert.equal(await page.locator('.docs-hub-tree-group').count(), 0);
  await context.close();
});

test('public Docs navigation is required even when a browser has no session', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await newPage(context);
  let navigationRequests = 0;
  await page.route('**/api/front-door/v1/docs/v2/navigation?locale=zh', async (route) => {
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
  assert.equal(navigationRequests, 2, 'the redirect and final Docs render each use the fresh front-door result');
  assert.equal(new URL(page.url()).pathname, '/docs/quickstart');
  assert.equal((await page.locator('.docs-hub-page-title').textContent()).trim(), '快速开始');
  await context.close();
});

test('desktop Ctrl/Cmd+K finds rendered text and endpoint paths with exact anchors', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs/quickstart`, { waitUntil: 'domcontentloaded' });
  await page.locator('.docs-hub-page-title').waitFor();

  await searchWithShortcut(page, 'temperature', '/docs/chat-completions#body');
  await assertAnchorTarget(page, '/docs/chat-completions', '#body', 'body');
  await searchWithShortcut(
    page,
    '/v1/responses',
    '/docs/responses#responses-endpoint',
    'Meta+K',
  );
  await assertAnchorTarget(
    page,
    '/docs/responses',
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

  await searchWithMobileButton(page, 'temperature', '/docs/chat-completions#body');
  await assertAnchorTarget(page, '/docs/chat-completions', '#body', 'body');
  await searchWithMobileButton(page, '/v1/responses', '/docs/responses#responses-endpoint');
  await assertAnchorTarget(
    page,
    '/docs/responses',
    '#responses-endpoint',
    'responses-endpoint',
  );
  await context.close();
});

test('single-heading TOC occupies a column only at the desktop breakpoint', { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/docs/responses`, { waitUntil: 'domcontentloaded' });
  const toc = page.locator('.docs-hub-toc');
  await toc.waitFor({ state: 'visible' });
  assert.equal(await toc.locator('.docs-hub-toc-link').count(), 1);
  assert.equal((await toc.locator('.docs-hub-toc-link').textContent()).trim(), '基础结构');

  await page.setViewportSize({ width: 1559, height: 1000 });
  await toc.waitFor({ state: 'hidden' });
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector('.docs-hub-canvas');
    const outline = document.querySelector('.docs-hub-toc');
    const before = canvas.getBoundingClientRect();
    const display = getComputedStyle(outline).display;
    const width = outline.getBoundingClientRect().width;
    outline.remove();
    const after = canvas.getBoundingClientRect();
    return {
      display,
      width,
      before: [before.x, before.width],
      after: [after.x, after.width],
    };
  });
  assert.equal(geometry.display, 'none');
  assert.equal(geometry.width, 0);
  assert.deepEqual(geometry.before, geometry.after);
  await context.close();
});

test('phone Pricing keeps live modal changes across Escape, backdrop, close, and Confirm', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).pathname, '/pricing');
  const trigger = page.locator('[data-pricing-filter-trigger]');
  await trigger.waitFor();
  assert.equal(await page.locator('.pricing-advanced-filters').count(), 0);

  await trigger.click();
  const dialog = page.locator('.pricing-filter-modal');
  await dialog.waitFor({ state: 'visible' });
  const modalEvidence = await page.evaluate(() => {
    const panel = document.querySelector('.pricing-filter-modal');
    const body = document.querySelector('.pricing-filter-modal-body');
    const rect = panel.getBoundingClientRect();
    return {
      panelTop: rect.top,
      panelBottom: rect.bottom,
      viewportHeight: window.innerHeight,
      bodyOverflowY: getComputedStyle(body).overflowY,
      bodyClientHeight: body.clientHeight,
      bodyScrollHeight: body.scrollHeight,
      focusInside: panel.contains(document.activeElement),
    };
  });
  assert.ok(modalEvidence.panelTop >= 0);
  assert.ok(modalEvidence.panelBottom <= modalEvidence.viewportHeight);
  assert.equal(modalEvidence.bodyOverflowY, 'auto');
  assert.ok(modalEvidence.bodyScrollHeight > modalEvidence.bodyClientHeight);
  assert.equal(modalEvidence.focusInside, true);

  const lockedGroups = dialog.locator('[data-pricing-filter-group]');
  assert.equal(await lockedGroups.count(), 1);
  assert.equal(await lockedGroups.first().getAttribute('data-pricing-filter-group'), 'default');
  assert.equal(await lockedGroups.first().isDisabled(), true);

  const allBilling = dialog.locator('[data-filter-key="billing"][data-filter-value="all"]');
  const perToken = dialog.locator('[data-filter-key="billing"][data-filter-value="per_token"]');
  const perRequest = dialog.locator('[data-filter-key="billing"][data-filter-value="per_request"]');
  const tiered = dialog.locator('[data-filter-key="billing"][data-filter-value="tiered_expr"]');
  await perRequest.click();
  assert.equal(await perRequest.getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '重置', exact: true }).click();
  assert.equal(await allBilling.getAttribute('aria-pressed'), 'true');
  assert.equal(await perRequest.getAttribute('aria-pressed'), 'false');

  await perRequest.click();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));
  assert.match(await trigger.textContent(), /筛选 \(1\)/);
  assert.equal(await page.locator('.pricing-advanced-filters').count(), 0);

  await trigger.click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await perRequest.getAttribute('aria-pressed'), 'true');
  await perToken.click();
  await page.locator('.surface-overlay-backdrop').click({ position: { x: 2, y: 2 } });
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));

  await trigger.click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await perToken.getAttribute('aria-pressed'), 'true');
  await tiered.click();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));

  await trigger.click();
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await tiered.getAttribute('aria-pressed'), 'true');
  await perRequest.click();
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));
  assert.match(await trigger.textContent(), /筛选 \(1\)/);
  await context.close();
});

test('public /console/pricing mounts canonical ordering, pagination, filters, cards, and detail sheet', { timeout: 35_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem('user', JSON.stringify({ public_id: 'stale-browser-user' }));
    localStorage.setItem('i18nextLng', 'zh-CN');
    localStorage.setItem('status', JSON.stringify({
      price: 999,
      custom_currency_symbol: 'STALE',
    }));
  });
  const models = Array.from({ length: 24 }, (_, index) => ({
    model_name: index < 12
      ? `gpt-canonical-${String(index).padStart(2, '0')}`
      : `zeta-canonical-${String(index).padStart(2, '0')}`,
    description: index === 0 ? 'Canonical detail marker' : `Canonical model ${index}`,
    icon: '',
    tags: index % 2 === 0 ? 'chat,fast' : 'embedding',
    vendor_id: index < 22 ? 1 : 2,
    image_generation_model: false,
    video_generation_model: false,
    quota_type: index === 23 ? 1 : 0,
    model_ratio: 1 + index / 10,
    model_price: index === 23 ? 0.5 : 0,
    owner_by: 'canonical-owner',
    completion_ratio: 2,
    cache_ratio: 0.5,
    create_cache_ratio: 1.25,
    image_ratio: 1,
    audio_ratio: 1,
    audio_completion_ratio: 1,
    enable_groups: ['token-public'],
    supported_endpoint_types: ['openai'],
  }));
  const payload = {
    success: true,
    data: models,
    vendors: [
      { id: 1, name: 'Canonical Vendor A', description: 'Primary canonical vendor', icon: '' },
      { id: 2, name: 'Canonical Vendor B', description: 'Secondary canonical vendor', icon: '' },
    ],
    group_ratio: { 'token-public': 1.25 },
    usable_group: { 'token-public': 'Token public group' },
    supported_endpoint: { openai: { method: 'POST', path: '/v1/chat/completions' } },
    auto_groups: ['token-public'],
    video_resolution_dimensions: {},
    pricing_version: 'canonical-browser-v1',
  };
  const page = await newPage(context);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let statusRequests = 0;
  await page.route('**/api/status', async (route) => {
    statusRequests += 1;
    assert.equal(route.request().method(), 'GET');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        message: '',
        data: {
          quota_display_type: 'CNY',
          price: 7.2,
          usd_exchange_rate: 7.2,
          custom_currency_exchange_rate: 1,
          custom_currency_symbol: '¤',
          model_marketplace_default: { vendor: '1', group: 'token-public' },
        },
      }),
    });
  });
  let pricingRequests = 0;
  const pricingRequestsHeaders = [];
  await page.route('**/api/content/pricing', async (route) => {
    pricingRequests += 1;
    const headers = route.request().headers();
    assert.equal(headers['new-api-user'], undefined);
    assert.equal(headers.cookie, undefined);
    assert.equal(headers.authorization, undefined);
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['if-none-match'], undefined);
    assert.equal(route.request().headers()['cache-control'], 'no-store');
    pricingRequestsHeaders.push(headers);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  await page.goto(`${baseUrl}/console/pricing`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
  assert.deepEqual(pageErrors, [], 'canonical Pricing must mount without runtime errors');
  assert.equal(pricingRequests, 1, 'canonical Pricing must issue its public request');
  assert.equal(statusRequests, 1);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('status'))), {
    quota_display_type: 'CNY',
    price: 7.2,
    usd_exchange_rate: 7.2,
    custom_currency_exchange_rate: 1,
    custom_currency_symbol: '¤',
    model_marketplace_default: { vendor: '1', group: 'token-public' },
  });

  assert.equal(await page.locator('.site-header').isVisible(), false);
  assert.equal((await page.locator('.pricing-page-intro p').textContent()).trim(), '比较模型价格，按供应商、分组和能力快速找到适合你的模型。');
  const visibleVendors = page.locator('.pricing-provider-section .pricing-vendor-chip');
  assert.equal(await visibleVendors.count(), 2);
  assert.equal((await visibleVendors.first().textContent()).includes('Canonical Vendor A'), true);
  assert.equal(await page.locator('[data-pricing-group="token-public"]').count(), 1);
  assert.equal(await page.locator('.pricing-model-table').count(), 1);

  const rows = page.locator('.pricing-model-table tbody tr');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 20);
  assert.match(await rows.first().textContent(), /gpt-canonical-00/);
  assert.match(await rows.nth(19).textContent(), /zeta-canonical-19/);

  await visibleVendors.nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.pricing-model-table tbody tr').length === 2);
  assert.match(await rows.first().textContent(), /zeta-canonical-22/);
  await visibleVendors.first().click();
  await page.waitForFunction(() => document.querySelectorAll('.pricing-model-table tbody tr').length === 20);

  await page.locator('.semi-page-next').click();
  await page.waitForFunction(() => document.querySelector('.pricing-model-table tbody')?.textContent?.includes('zeta-canonical-20'));
  assert.equal(await rows.count(), 2);

  await page.getByRole('button', { name: '卡片视图' }).click();
  await page.locator('.pricing-card-grid').waitFor();
  assert.equal(await page.locator('.pricing-model-card').count(), 2);

  await page.getByPlaceholder('模糊搜索模型名称').fill('gpt-canonical-00');
  await page.locator('.pricing-model-card').first().waitFor();
  assert.equal(await page.locator('.pricing-model-card').count(), 1);
  await page.locator('.pricing-model-card').click();
  const detail = page.locator('.semi-sidesheet');
  await detail.waitFor({ state: 'visible' });
  assert.match(await detail.textContent(), /Canonical detail marker/);
  assert.match(await detail.textContent(), /\/v1\/chat\/completions/);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '模型价格', exact: true }).first().waitFor();
  assert.equal(pricingRequests, 2, 'canonical Pricing must fetch a fresh body after navigation');
  assert.equal(pricingRequestsHeaders.length, 2);
  assert.equal(pricingRequestsHeaders[0].cookie, undefined);
  assert.equal(pricingRequestsHeaders[1].cookie, undefined);
  await context.close();
});

test('Pricing switches between desktop inline filters and the mobile modal at 768px', { timeout: 30_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await newPage(context);
  let legacyPricingRequests = 0;
  let frontDoorPricingRequests = 0;
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/content/pricing') legacyPricingRequests += 1;
    if (pathname === '/api/front-door/v1/pricing') frontDoorPricingRequests += 1;
  });
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
  assert.equal(new URL(page.url()).pathname, '/pricing');
  assert.equal(legacyPricingRequests, 1, 'legacy Pricing loads its public payload once');
  assert.equal(frontDoorPricingRequests, 0, 'legacy Pricing never loads front-door Pricing');
  const trigger = page.locator('[data-pricing-filter-trigger]');
  await trigger.click();
  const inline = page.locator('.pricing-advanced-filters');
  await inline.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pricing-filter-modal').count(), 0);
  assert.equal(await trigger.getAttribute('aria-haspopup'), null);

  await inline.locator('[data-filter-key="billing"][data-filter-value="per_request"]').click();
  await page.locator('.pricing-advanced-filters').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-pricing-filter-trigger]').textContent(), /筛选 \(1\) · 收起/);
  assert.equal(await page.locator('[data-pricing-group]').count(), 1);
  assert.equal(await page.locator('[data-pricing-group="default"]').isDisabled(), true);

  await page.setViewportSize({ width: 767, height: 844 });
  await page.waitForFunction(() => (
    window.matchMedia('(max-width: 767px)').matches &&
    !document.querySelector('.pricing-advanced-filters')
  ));
  assert.equal(await page.locator('.pricing-advanced-filters').count(), 0);
  assert.equal(await trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false');

  await trigger.click();
  const dialog = page.locator('.pricing-filter-modal');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(
    await dialog.locator('[data-filter-key="billing"][data-filter-value="per_request"]').getAttribute('aria-pressed'),
    'true',
  );
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));

  await page.setViewportSize({ width: 768, height: 1000 });
  await page.locator('.pricing-advanced-filters').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.pricing-filter-modal').count(), 0);
  assert.equal(await trigger.getAttribute('aria-haspopup'), null);
  assert.match(await trigger.textContent(), /筛选 \(1\) · 收起/);
  assert.equal(legacyPricingRequests, 1, 'legacy Pricing state/cache survives rerenders');
  assert.equal(frontDoorPricingRequests, 0, 'legacy rerenders stay off the front door');
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
  const input = page.locator('.docs-search-dialog input[type="search"]');
  await input.waitFor({ state: 'visible' });
  await input.fill(query);
  const result = page.locator(`[data-search-target="${target}"]`);
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
