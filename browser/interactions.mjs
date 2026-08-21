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

test('phone Pricing uses a bounded modal with locked group, Reset, Confirm, and focus return', { timeout: 25_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
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
  const perRequest = dialog.locator('[data-filter-key="billing"][data-filter-value="per_request"]');
  await perRequest.click();
  assert.equal(await perRequest.getAttribute('aria-pressed'), 'true');
  await dialog.getByRole('button', { name: '重置', exact: true }).click();
  assert.equal(await allBilling.getAttribute('aria-pressed'), 'true');
  assert.equal(await perRequest.getAttribute('aria-pressed'), 'false');

  await perRequest.click();
  await dialog.getByRole('button', { name: '确定', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));
  assert.match(await trigger.textContent(), /筛选 \(1\)/);
  assert.equal(await page.locator('.pricing-advanced-filters').count(), 0);

  await trigger.click();
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-pricing-filter-trigger'));
  await context.close();
});

test('desktop Pricing keeps the canonical inline filter interaction', { timeout: 20_000 }, async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await newPage(context);
  await page.goto(`${baseUrl}/pricing`, { waitUntil: 'domcontentloaded' });
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
