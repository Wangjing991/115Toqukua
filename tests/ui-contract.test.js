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
        async saveCredentials(args) {
          window.__uiTest.calls.push({ method: 'saveCredentials', args });
          // The real main process broadcasts this temporary disconnected state
          // while validating replacement credentials, then reports success.
          snapshot.accounts[args.side].connected = false;
          callback(structuredClone(snapshot));
          await Promise.resolve();
          snapshot.accounts[args.side].connected = true;
          callback(structuredClone(snapshot));
        },
        async chooseCache() {},
        async startTransfer(args) { window.__uiTest.calls.push({ method: 'startTransfer', args }); return { id: 'test-job' }; },
        async pauseQueue() { snapshot.paused = true; },
        async resumeQueue() { snapshot.paused = false; },
        async cancelJob(id) {
          window.__uiTest.calls.push({ method: 'cancelJob', id });
          const attempts = window.__uiTest.calls.filter(call => call.method === 'cancelJob' && call.id === id).length;
          if (attempts === 1) throw new Error('未能确认停止上传，请再次取消任务。');
          snapshot.jobs.find(job => job.id === id).status = 'cancelled';
          callback(structuredClone(snapshot));
        },
        async retryJob(id) { window.__uiTest.calls.push({ method: 'retryJob', id }); },
        async openFolder(args) { window.__uiTest.calls.push({ method: 'openFolder', args }); },
        onState(handler) { callback = handler; return () => { callback = null; }; },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.waitForFunction(() => window.__uiTest.calls.filter(call => call.method === 'list').length >= 2);
    assert.deepEqual(await page.evaluate(() => window.__uiTest.calls.filter(call => call.method === 'list').slice(0, 2).map(call => call.args.refresh)), [false, false], 'initial account paint should reuse the directory cache');
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
    assert.equal(await page.locator('#refresh-token-input').inputValue(), '', 'refresh token must clear after validation reconnects the account');
    assert.equal(await page.locator('#toast').textContent(), '115网盘已连接。', 'temporary disconnect must not suppress successful authorization');
    assert.equal(await page.locator('#pan115-account-status').textContent(), '已连接');

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
    await page.locator('#task-list').getByRole('button', { name: '取消', exact: true }).click();
    await page.waitForFunction(() => window.__uiTest.calls.some(call => call.method === 'cancelJob' && call.id === 'failed'));
    await page.getByText('未能确认停止上传，请再次取消任务。', { exact: true }).waitFor();
    assert.equal(await page.locator('#task-list').getByRole('button', { name: '取消', exact: true }).isEnabled(), true, 'a failed cancellation can be attempted again');
    await page.locator('#task-list').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#task-list').getByText('已取消', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__uiTest.calls.filter(call => call.method === 'cancelJob' && call.id === 'failed').length), 2);
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

test('logout handles cancellation, errors, stale requests and account-bound retry actions in the real DOM', { skip: !playwright && !process.env.UI_TEST_PLAYWRIGHT }, async () => {
  if (!playwright) throw moduleError;
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.UI_TEST_CHROMIUM ? { executablePath: process.env.UI_TEST_CHROMIUM } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    await context.addInitScript(() => {
      const snapshot = {
        engine: { status: 'ready', version: 'logout-fixture' },
        accounts: { quark: { connected: true, mount: '/夸克' }, pan115: { connected: true, mount: '/115' } },
        settings: {}, paused: false, jobs: [],
      };
      let callback;
      window.__uiTest = {
        calls: [], logoutMode: 'cancel', deferList: false, newAccount: false,
        push(patch) { Object.assign(snapshot, patch); callback(structuredClone(snapshot)); },
        disconnect(side) { snapshot.accounts[side].connected = false; callback(structuredClone(snapshot)); },
        reconnect(side) { snapshot.accounts[side].connected = true; callback(structuredClone(snapshot)); },
      };
      const fixture = window.__uiTest;
      window.bridge = {
        async getState() { return structuredClone(snapshot); },
        async list(args) {
          fixture.calls.push({ method: 'list', args });
          if (args.side === 'quark' && fixture.deferList) {
            fixture.deferList = false;
            return new Promise(resolve => { fixture.finishList = () => resolve({ entries: [{ name: '旧账号迟到文件.txt', size: 5 }] }); });
          }
          if (args.side === 'pan115') return { entries: [{ name: '目标.txt', size: 3 }] };
          if (fixture.newAccount) return { entries: [{ name: '新账号文件.txt', size: 6 }] };
          if (args.path === '/夸克/照片') return { entries: [{ name: '深处.txt', size: 7 }] };
          return { entries: [{ name: '照片', is_dir: true, size: 0 }, { name: '笔记.txt', size: 10 }] };
        },
        async logout(args) {
          fixture.calls.push({ method: 'logout', args });
          if (fixture.logoutMode === 'cancel') return { cancelled: true };
          if (fixture.logoutMode === 'error') throw new Error('有任务正在传输，请先暂停队列并等待当前阶段结束。');
          if (fixture.logoutMode === 'pending') return new Promise(resolve => {
            fixture.finishLogout = () => { fixture.disconnect(args.side); resolve({ disconnected: true }); };
          });
          fixture.disconnect(args.side);
          return { disconnected: true };
        },
        async login() { return new Promise(resolve => { fixture.finishLogin = () => resolve({ message: '旧登录请求已返回' }); }); },
        async saveCredentials() {},
        onState(handler) { callback = handler; return () => { callback = null; }; },
      };
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.getByLabel('选择 笔记.txt', { exact: true }).check();
    await page.getByLabel('选择 目标.txt', { exact: true }).check();
    await page.locator('.account-button[data-side="quark"]').click();
    const logout = page.getByRole('button', { name: '退出当前账号', exact: true });
    await logout.click();
    await page.getByText('已取消退出，账号状态未改变。', { exact: true }).waitFor();
    assert.equal(await page.locator('#quark-account-status').textContent(), '已连接');
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).isChecked(), true, 'cancel must preserve source selection');
    assert.equal(await page.getByLabel('选择 目标.txt', { exact: true }).isChecked(), true, 'cancel must preserve other drive');

    await page.evaluate(() => { window.__uiTest.logoutMode = 'error'; });
    await logout.click();
    await page.locator('#login-message.error').getByText('有任务正在传输，请先暂停队列并等待当前阶段结束。', { exact: true }).waitFor();
    assert.equal(await logout.isEnabled(), true, 'backend failure permits another attempt');
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).isChecked(), true, 'failure must preserve source selection');
    await page.locator('#account-dialog [aria-label="关闭"]').click();

    await page.getByRole('button', { name: '照片', exact: true }).click();
    await page.getByLabel('选择 深处.txt', { exact: true }).check();
    await page.evaluate(() => { window.__uiTest.deferList = true; window.__uiTest.logoutMode = 'pending'; });
    await page.getByRole('button', { name: '刷新夸克文件列表', exact: true }).click();
    await page.waitForFunction(() => typeof window.__uiTest.finishList === 'function');
    await page.locator('.account-button[data-side="quark"]').click();
    await page.getByRole('button', { name: '使用手动凭证' }).click();
    await page.locator('#cookie-input').fill('fixture-unsaved-cookie');
    await page.getByRole('button', { name: '打开扫码 / 网页登录 ↗', exact: true }).click();
    await page.waitForFunction(() => typeof window.__uiTest.finishLogin === 'function');
    await logout.click();
    await page.waitForFunction(() => typeof window.__uiTest.finishLogout === 'function');
    assert.equal(await page.locator('#logout-button').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#browser-login-button').isDisabled(), true);
    assert.equal(await page.locator('#save-credentials-button').isDisabled(), true);
    await page.evaluate(() => {
      window.__uiTest.push({ paused: true });
      document.getElementById('logout-button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await page.locator('#logout-button').isDisabled(), true, 'state events must not re-enable a pending logout');
    assert.equal(await page.evaluate(() => window.__uiTest.calls.filter(call => call.method === 'logout').length), 3, 'duplicate logout must not invoke backend');
    await page.evaluate(() => window.__uiTest.finishLogout());
    await page.getByText('已退出当前账号，可重新登录。', { exact: true }).waitFor();
    assert.equal(await page.locator('#quark-account-status').textContent(), '尚未连接');
    assert.equal(await page.locator('#quark-selection').textContent(), '未选择文件');
    assert.equal(await page.locator('#quark-summary').textContent(), '0 个项目');
    assert.equal(await page.locator('#quark-breadcrumbs').textContent(), '全部文件');
    assert.equal(await page.locator('#cookie-input').inputValue(), '');
    assert.equal(await page.locator('#copy-to-115').isDisabled(), true);
    assert.equal(await page.locator('#copy-to-quark').isDisabled(), true);
    assert.equal(await page.locator('#pan115-account-status').textContent(), '已连接');
    assert.equal(await page.getByLabel('选择 目标.txt', { exact: true }).isChecked(), true, 'successful logout must preserve other drive and selection');
    await page.evaluate(() => window.__uiTest.finishLogin());
    await page.waitForFunction(() => !document.getElementById('browser-login-button').disabled);
    assert.equal(await page.locator('#login-message').textContent(), '已退出当前账号，可重新登录。', 'late login response must not replace logout result');

    await page.evaluate(() => { window.__uiTest.logoutMode = 'success'; });
    assert.equal(await logout.isEnabled(), true, 'disconnected accounts still support credential/session cleanup');
    await logout.click();
    await page.waitForFunction(() => window.__uiTest.calls.filter(call => call.method === 'logout').length === 4 && !document.getElementById('logout-button').disabled);
    await page.locator('#account-dialog [aria-label="关闭"]').click();
    await page.evaluate(() => { window.__uiTest.newAccount = true; window.__uiTest.reconnect('quark'); });
    await page.getByLabel('选择 新账号文件.txt', { exact: true }).waitFor();
    await page.evaluate(() => window.__uiTest.finishList());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByLabel('选择 新账号文件.txt', { exact: true }).isChecked(), false);
    assert.equal(await page.getByText('旧账号迟到文件.txt', { exact: true }).count(), 0, 'late list from old account must never replace the newly logged-in account');
    assert.equal(await page.locator('#quark-breadcrumbs').textContent(), '全部文件');
    assert.equal(await page.locator('#quark-selection').textContent(), '未选择文件');

    const reason = '账号已退出，此任务不可重试。请重新登录后新建任务。';
    await page.evaluate(reason => window.__uiTest.push({ jobs: [{ id: 'old-account-job', sourcePath: '/夸克/a', targetPath: '/115', status: 'cancelled', totalFiles: 1, doneFiles: 0, retryBlockedReason: reason }] }), reason);
    assert.equal(await page.getByRole('button', { name: '重试', exact: true }).count(), 0);
    await page.getByRole('button', { name: '查看原因', exact: true }).click();
    assert.equal(await page.locator('#error-details').textContent(), reason);
    await page.getByRole('button', { name: '知道了', exact: true }).click();
    await page.getByLabel('选择 新账号文件.txt', { exact: true }).check();
    await page.locator('.account-button[data-side="pan115"]').click();
    await page.getByRole('button', { name: '使用手动凭证' }).click();
    await page.locator('#access-token-input').fill('fixture-unsaved-access');
    await page.locator('#refresh-token-input').fill('fixture-unsaved-refresh');
    await logout.click();
    await page.getByText('已退出当前账号，可重新登录。', { exact: true }).waitFor();
    assert.equal(await page.locator('#pan115-account-status').textContent(), '尚未连接');
    assert.equal(await page.locator('#pan115-selection').textContent(), '未选择文件');
    assert.equal(await page.locator('#access-token-input').inputValue(), '');
    assert.equal(await page.locator('#refresh-token-input').inputValue(), '');
    assert.equal(await page.getByLabel('选择 新账号文件.txt', { exact: true }).isChecked(), true, '115 logout leaves Quark selection intact');
    assert.deepEqual(await page.evaluate(() => window.__uiTest.calls.filter(call => call.method === 'logout').map(call => call.args)), [
      { side: 'quark' }, { side: 'quark' }, { side: 'quark' }, { side: 'quark' }, { side: 'pan115' },
    ]);
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally { await browser.close(); }
});

test('maintenance preserves data when clearing cache, locks operations and confirms reset outcomes in the real DOM', { skip: !playwright && !process.env.UI_TEST_PLAYWRIGHT }, async () => {
  if (!playwright) throw moduleError;
  const browser = await playwright.chromium.launch({ headless: true, ...(process.env.UI_TEST_CHROMIUM ? { executablePath: process.env.UI_TEST_CHROMIUM } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    await context.addInitScript(() => {
      const snapshot = {
        engine: { status: 'ready', version: 'maintenance-fixture' },
        accounts: { quark: { connected: true, mount: '/夸克' }, pan115: { connected: true, mount: '/115' } },
        settings: { cacheDir: 'E:\\fixture-cache' }, paused: false,
        jobs: [{ id: 'finished', status: 'completed', sourcePath: '/夸克/笔记.txt', targetPath: '/115', totalFiles: 1, doneFiles: 1 }],
      };
      let callback;
      const fixture = window.__uiTest = {
        calls: [], clearMode: 'pending', resetMode: 'cancel',
        push(patch) { Object.assign(snapshot, patch); callback(structuredClone(snapshot)); },
      };
      window.bridge = {
        async getState() { return structuredClone(snapshot); },
        async list() { return { entries: [{ name: '笔记.txt', size: 10 }] }; },
        async clearCache() {
          fixture.calls.push('clearCache');
          if (fixture.clearMode === 'cancel') return { cancelled: true };
          if (fixture.clearMode === 'error') throw new Error('缓存文件正在使用，清理未完成。');
          if (fixture.clearMode === 'partial') return { files: 1, bytes: 512, retained: 2, complete: false };
          return new Promise(resolve => {
            fixture.push({ maintenance: { busy: true, action: 'clear-cache' } });
            fixture.finishClear = () => {
              fixture.push({ maintenance: { busy: false, action: null } });
              resolve({ files: 3, bytes: 2048, retained: 1, complete: true });
            };
          });
        },
        async resetApp() {
          fixture.calls.push('resetApp');
          if (fixture.resetMode === 'cancel') return { cancelled: true };
          if (fixture.resetMode === 'error') throw new Error('部分本地设置尚未清除，请重试。');
          return { reset: true };
        },
        async chooseCache() { fixture.calls.push('chooseCache'); },
        async login() { fixture.calls.push('login'); },
        async logout() { fixture.calls.push('logout'); },
        async startTransfer() { fixture.calls.push('startTransfer'); },
        async resumeQueue() { fixture.calls.push('resumeQueue'); },
        async pauseQueue() { fixture.calls.push('pauseQueue'); },
        async retryJob() { fixture.calls.push('retryJob'); },
        async cancelJob() { fixture.calls.push('cancelJob'); },
        onState(handler) { callback = handler; return () => { callback = null; }; },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../src/renderer/index.html')).href);
    await page.getByLabel('选择 笔记.txt', { exact: true }).first().check();
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const clear = page.locator('#clear-cache-button');
    const reset = page.locator('#reset-app-button');
    assert.equal(await clear.isEnabled(), true);
    assert.equal(await reset.isEnabled(), true);

    for (const status of ['paused', 'failed', 'running']) {
      await page.evaluate(status => window.__uiTest.push({ jobs: [{ id: 'unfinished', status }] }), status);
      assert.equal(await clear.isDisabled(), true, `${status} task blocks cleanup`);
      assert.equal(await reset.isDisabled(), true, `${status} task blocks reset`);
      assert.equal(await page.locator('#maintenance-task-hint').isVisible(), true);
      await page.evaluate(() => document.getElementById('reset-app-button').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    }
    assert.deepEqual(await page.evaluate(() => window.__uiTest.calls), []);
    await page.evaluate(() => window.__uiTest.push({ jobs: [{ id: 'finished', status: 'completed' }, { id: 'cancelled', status: 'cancelled' }] }));
    await clear.click();
    await page.waitForFunction(() => typeof window.__uiTest.finishClear === 'function');
    assert.equal(await clear.getAttribute('aria-busy'), 'true');
    assert.equal(await reset.isDisabled(), true);
    assert.equal(await page.locator('#choose-cache-button').isDisabled(), true);
    assert.equal(await page.locator('.account-button[data-side="quark"]').isDisabled(), true);
    assert.equal(await page.locator('#copy-to-115').isDisabled(), true);
    assert.equal(await page.locator('#browser-login-button').isDisabled(), true);
    assert.equal(await page.locator('#logout-button').isDisabled(), true);
    assert.equal(await page.locator('#task-list').getByRole('button', { name: '重试', exact: true }).isDisabled(), true);
    await page.evaluate(() => {
      window.__uiTest.push({ paused: true });
      for (const id of ['clear-cache-button', 'reset-app-button', 'choose-cache-button', 'browser-login-button', 'logout-button', 'queue-toggle', 'copy-to-115']) {
        document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
      document.querySelector('#task-list .task-actions button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.deepEqual(await page.evaluate(() => window.__uiTest.calls), ['clearCache'], 'busy state must block duplicate or competing IPC even on synthetic clicks');
    await page.evaluate(() => window.__uiTest.finishClear());
    await page.waitForFunction(() => document.getElementById('maintenance-status').textContent.startsWith('缓存清理完成'));
    assert.match(await page.locator('#maintenance-status').textContent(), /3 个文件，释放 2.0 KB/);
    assert.match(await page.locator('#maintenance-status').textContent(), /另有 1 项未删除/);
    assert.equal(await clear.isEnabled(), true);
    assert.equal(await page.locator('#quark-account-status').textContent(), '已连接');
    assert.equal(await page.locator('#pan115-account-status').textContent(), '已连接');
    assert.equal(await page.locator('#cache-dir').inputValue(), 'E:\\fixture-cache');
    assert.equal(await page.locator('#task-count').textContent(), '2');
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).first().isChecked(), true);
    assert.equal(await page.locator('#copy-to-115').isEnabled(), true);

    await page.evaluate(() => { window.__uiTest.clearMode = 'partial'; });
    await clear.click();
    await page.waitForFunction(() => document.getElementById('maintenance-status').textContent.startsWith('缓存尚未全部清理'));
    assert.match(await page.locator('#maintenance-status.error').textContent(), /1 个文件，释放 512 B.*另有 2 项未删除/);
    assert.equal(await clear.isEnabled(), true, 'partial cleanup permits retry');
    await page.evaluate(() => { window.__uiTest.clearMode = 'error'; });
    await clear.click();
    await page.getByText('缓存文件正在使用，清理未完成。', { exact: true }).waitFor();
    assert.equal(await clear.isEnabled(), true, 'failed cleanup permits retry');
    await page.evaluate(() => { window.__uiTest.clearMode = 'cancel'; });
    await clear.click();
    await page.getByText('已取消清理缓存。', { exact: true }).waitFor();
    assert.equal(await clear.isEnabled(), true);
    assert.equal(await page.getByLabel('选择 笔记.txt', { exact: true }).first().isChecked(), true);

    await reset.click();
    await page.getByText('已取消重置，本地数据未改变。', { exact: true }).waitFor();
    assert.equal(await reset.isEnabled(), true);
    assert.equal(await page.locator('#task-count').textContent(), '2');
    assert.equal(await page.locator('#quark-account-status').textContent(), '已连接');
    await page.evaluate(() => { window.__uiTest.resetMode = 'error'; });
    await reset.click();
    await page.getByText('部分本地设置尚未清除，请重试。', { exact: true }).waitFor();
    assert.equal(await reset.isEnabled(), true);
    await page.evaluate(() => window.__uiTest.push({ engine: { status: 'error', error: '测试本地服务启动失败' } }));
    assert.equal(await reset.isEnabled(), true, 'reset remains available after engine startup failure');
    await page.evaluate(() => window.__uiTest.push({ maintenance: { busy: false, action: null, resetStarted: true } }));
    assert.equal(await clear.isDisabled(), true, 'partially applied reset only permits completing reset');
    assert.equal(await reset.isEnabled(), true, 'partial reset failure can be retried');
    await page.evaluate(() => {
      window.__uiTest.push({ engine: { status: 'ready' } });
      document.getElementById('clear-cache-button').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    assert.equal(await page.locator('.account-button[data-side="quark"]').isDisabled(), true, 'late ready event cannot reopen accounts after partial reset');
    assert.equal(await page.locator('#copy-to-115').isDisabled(), true);
    assert.equal(await reset.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__uiTest.calls.filter(call => call === 'clearCache').length), 4, 'partial reset blocks synthetic cleanup clicks');
    if (process.env.UI_TEST_MAINTENANCE_SCREENSHOT) await page.screenshot({ path: process.env.UI_TEST_MAINTENANCE_SCREENSHOT });
    await page.evaluate(() => { window.__uiTest.resetMode = 'success'; });
    await reset.click();
    await page.getByText('重置完成，程序即将关闭。下次打开后请重新连接网盘。', { exact: true }).waitFor();
    await page.evaluate(() => window.__uiTest.push({ engine: { status: 'ready' }, maintenance: { busy: false, action: null }, jobs: [] }));
    assert.equal(await reset.isDisabled(), true, 'successful reset remains locked until process exits');
    assert.equal(await clear.isDisabled(), true);
    assert.equal(await page.locator('#copy-to-115').isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
