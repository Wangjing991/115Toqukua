'use strict';

// Optional real-DOM checks. Set UI_TEST_PLAYWRIGHT to an installed Playwright module
// and UI_TEST_CHROMIUM to a Chromium executable when browsers are not installed.
// Fixture accounts and file lists exist only in the isolated test browser context.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let playwright;
let moduleError;
try { playwright = require(process.env.UI_TEST_PLAYWRIGHT || 'playwright'); } catch (error) { moduleError = error; }

test('desktop renderer preserves selection, respects credential types and sends exact copy paths', { skip: !playwright && !process.env.UI_TEST_PLAYWRIGHT }, async () => {
  if (!playwright) throw moduleError;
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.UI_TEST_CHROMIUM ? { executablePath: process.env.UI_TEST_CHROMIUM } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    await context.addInitScript(() => {
      const snapshot = {
        engine: { status: 'ready', version: 'test-fixture' },
        accounts: { quark: { connected: true, mount: '/夸克' }, pan115: { connected: true, mount: '/115' } },
        settings: { cacheDir: 'E:\\test-cache' }, paused: false, jobs: [],
      };
      let callback;
      window.__uiTest = {
        calls: [],
        push(patch) { Object.assign(snapshot, patch); callback(structuredClone(snapshot)); },
      };
      window.bridge = {
        async getState() { return structuredClone(snapshot); },
        async list(args) {
          window.__uiTest.calls.push({ method: 'list', args });
          if (args.path === '/夸克') return { path: args.path, entries: [{ name: '照片', is_dir: true, size: 0 }, { name: '<img onerror=alert(1)>.txt', is_dir: false, size: 7 }, { name: '笔记.txt', is_dir: false, size: 10 }] };
          return { path: args.path, entries: [] };
        },
        async login(args) { window.__uiTest.calls.push({ method: 'login', args }); return { message: '测试登录入口' }; },
        async saveCredentials(args) { window.__uiTest.calls.push({ method: 'saveCredentials', args }); },
        async chooseCache() {},
        async startTransfer(args) { window.__uiTest.calls.push({ method: 'startTransfer', args }); return { id: 'test-job' }; },
        async pauseQueue() { snapshot.paused = true; },
        async resumeQueue() { snapshot.paused = false; },
        async cancelJob(id) { window.__uiTest.calls.push({ method: 'cancelJob', id }); },
        async retryJob(id) { window.__uiTest.calls.push({ method: 'retryJob', id }); },
        async openFolder(args) { window.__uiTest.calls.push({ method: 'openFolder', args }); },
        onState(handler) { callback = handler; return () => { callback = null; }; },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.getByLabel('选择 笔记.txt', { exact: true }).check();
    await page.waitForFunction(() => document.getElementById('copy-to-115').disabled === false);
    assert.equal(await page.locator('#quark-file-area img').count(), 0, 'untrusted filename must remain text');
    assert.equal(await page.getByText('<img onerror=alert(1)>.txt', { exact: true }).count(), 1);

    await page.evaluate(() => window.__uiTest.push({ jobs: [{ id: 'other', sourcePath: '/115/a', targetPath: '/夸克/a', status: 'running', totalFiles: 3, doneFiles: 1, totalBytes: 30, completedBytes: 10, stage: 'uploading', stageProgress: 45 }] }));
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).isChecked(), true, 'state push must preserve selection');
    await page.getByRole('button', { name: '将夸克选中文件复制到 115', exact: true }).click();
    await page.getByRole('button', { name: '开始复制', exact: true }).click();
    await page.waitForFunction(() => window.__uiTest.calls.some(call => call.method === 'startTransfer'));
    const copy = await page.evaluate(() => window.__uiTest.calls.find(call => call.method === 'startTransfer').args);
    assert.deepEqual(copy, { side: 'quark', sourceDir: '/夸克', names: ['笔记.txt'], targetDir: '/115' });

    await page.locator('.account-button[data-side="pan115"]').click();
    await page.getByRole('button', { name: '使用手动凭证' }).click();
    assert.equal(await page.locator('#cookie-input').isVisible(), false, '115 Open must not request a Cookie');
    assert.equal(await page.locator('#access-token-input').getAttribute('type'), 'password');
    await page.locator('#access-token-input').fill('test-access-token');
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await page.getByText('请同时填写 115 Open Access Token 和 Refresh Token。', { exact: true }).waitFor();
    await page.locator('#refresh-token-input').fill('test-refresh-token');
    await page.getByRole('button', { name: '保存并连接', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('account-dialog').open);
    const credentials = await page.evaluate(() => window.__uiTest.calls.find(call => call.method === 'saveCredentials').args);
    assert.deepEqual(credentials, { side: 'pan115', accessToken: 'test-access-token', refreshToken: 'test-refresh-token' });
    assert.equal(await page.locator('#access-token-input').inputValue(), '', 'credential field must clear after save');

    await page.getByRole('button', { name: '照片', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('quark-breadcrumbs').textContent.includes('照片'));
    assert.equal(await page.getByText('这个文件夹还是空的', { exact: true }).count(), 2);
    await page.getByRole('button', { name: '夸克返回上一级', exact: true }).click();
    await page.getByLabel('选择 笔记.txt', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).isChecked(), false);

    await page.evaluate(() => window.__uiTest.push({ jobs: [{ id: 'failed', sourcePath: '/夸克/a', targetPath: '/115', status: 'failed', totalFiles: 1, doneFiles: 0, failedFiles: 1, totalBytes: 10, completedBytes: 0, errors: ['<script>不应执行</script>'] }] }));
    await page.getByRole('button', { name: '查看原因', exact: true }).click();
    assert.equal(await page.locator('#error-details').textContent(), '<script>不应执行</script>');
    assert.equal(await page.locator('#error-details script').count(), 0);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    assert.deepEqual(errors, []);
    if (process.env.UI_TEST_SCREENSHOT) await page.screenshot({ path: process.env.UI_TEST_SCREENSHOT, fullPage: true });
    await context.close();

    const standalone = await browser.newPage();
    await standalone.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await standalone.getByText('此页面需要在桌面应用中运行。请启动开发项目或打包后的 EXE 文件。', { exact: true }).waitFor();
    assert.equal(await standalone.locator('#copy-to-115').isDisabled(), true);
    assert.equal(await standalone.locator('#quark-account-status').textContent(), '尚未连接');
    assert.equal(await standalone.locator('#task-count').textContent(), '0');
    await standalone.close();
  } finally { await browser.close(); }
});
