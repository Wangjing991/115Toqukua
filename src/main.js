'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, powerSaveBlocker } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { Store } = require('./store');
const { Queue } = require('./queue');
const { Engine } = require('./engine');
const { MOUNTS, within, redact } = require('./paths');
const { parse115Callback } = require('./auth-tokens');
const { AccountLifecycle } = require('./account-lifecycle');
const { MaintenanceLifecycle } = require('./maintenance-lifecycle');

app.setName('OpenListTransfer');
const profilePath = process.env.OPENLIST_TRANSFER_TEST_DATA ? path.resolve(process.env.OPENLIST_TRANSFER_TEST_DATA) : path.join(app.getPath('appData'), 'OpenListTransfer');
fs.mkdirSync(profilePath, { recursive: true }); app.setPath('userData', profilePath);
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, engine, queue, store, accounts, startup, startupSettled = false, quitting = false, sleepBlocker;
  const appURL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const state = { engine: { status: 'starting', version: '4.2.6' }, accounts: { quark: { connected: false, mount: MOUNTS.quark }, pan115: { connected: false, mount: MOUNTS.pan115 } }, logs: [] };
  const authWindows = new Map();
  let accountUpdate = 0;
  const maintenance = new MaintenanceLifecycle({
    profileDir: profilePath,
    services: () => ({ engine, queue, store, accounts, starting: !startupSettled }),
    sessionFor: side => session.fromPartition('persist:openlist-login-' + side),
    closeLogin: side => { const auth = authWindows.get(side); if (auth && !auth.isDestroyed()) auth.destroy(); },
    confirm: async action => {
      const reset = action === 'reset-app';
      const result = await dialog.showMessageBox(window, { type: reset ? 'warning' : 'question',
        title: reset ? '完整重置' : '清理缓存', message: reset ? '确定清除本软件的本机数据并退出？' : '确定清理本软件生成的缓存？',
        detail: reset
          ? '将退出两侧账号，清除本软件的网页登录状态、全部任务记录、可识别的传输缓存、缓存设置、引擎配置和日志。完成后程序关闭，下次打开需要重新登录。云端文件保留；缓存目录中的其他文件保留。此操作无法撤销。'
          : '将暂停本机引擎并清理任务记录中的传输缓存和引擎临时文件，完成后恢复引擎。账号、任务记录和设置保留，目录中的其他文件保留。',
        buttons: ['取消', reset ? '清除并退出' : '清理缓存'], defaultId: 0, cancelId: 0 });
      return result.response === 1;
    },
    onChange: () => broadcast(),
  });
  const snapshot = () => ({ ...state, engine: { ...state.engine, status: !startupSettled && state.engine.status === 'ready' ? 'starting' : state.engine.status }, maintenance: maintenance.snapshot(), settings: { cacheDir: store?.data.cacheDir || '' }, paused: queue?.paused || false, jobs: queue?.summaries() || [] });
  function broadcast() {
    if (!quitting && window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('state', snapshot());
    const active = queue?.running;
    if (active && sleepBlocker === undefined) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!active && sleepBlocker !== undefined) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = undefined; }
  }
  function log(message) {
    const record = `${new Date().toISOString()} ${redact(message)}`;
    state.logs.push(record); state.logs = state.logs.slice(-60);
    if (store) {
      try { const p = path.join(app.getPath('userData'), 'logs'); fs.mkdirSync(p, { recursive: true }); fs.appendFileSync(path.join(p, 'events.log'), record + '\n', { mode: 0o600 }); }
      catch { state.logs.push('日志文件暂时无法写入，请检查应用数据目录的磁盘空间与权限。'); }
    }
    broadcast();
  }
  function ready() { maintenance.assertAvailable(); if (quitting || !startupSettled || state.engine.status !== 'ready' || !engine || !queue || !accounts) throw new Error('本地引擎尚未就绪，请查看启动状态'); }
  function handle(channel, fn) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame?.url !== appURL) throw new Error('请求来源无效');
      try { return await fn(...args); } catch (e) { throw new Error(redact(e)); }
    });
  }
  function validateSide(side) { if (!Object.hasOwn(MOUNTS, side)) throw new Error('网盘类型无效'); return side; }
  async function updateAccounts() {
    const revision = ++accountUpdate;
    const accounts = await engine.getAccounts();
    if (revision !== accountUpdate) return;
    for (const side of Object.keys(MOUNTS)) state.accounts[side] = { ...accounts[side], mount: MOUNTS[side] };
    broadcast();
  }
  function initializeQueueAndAccounts() {
    if (!queue) {
      queue = new Queue({ engine, store, cacheDir: store.data.cacheDir }); queue.on('change', broadcast);
      queue.on('fault', message => log('队列已暂停：' + message));
    }
    if (!accounts) accounts = new AccountLifecycle({ engine, queue,
      sessionFor: side => session.fromPartition('persist:openlist-login-' + side),
      closeLogin: side => { const auth = authWindows.get(side); if (auth && !auth.isDestroyed()) auth.destroy(); },
      confirmLogout: async side => {
        const result = await dialog.showMessageBox(window, { type: 'question', title: '退出当前账号',
          message: `确定退出${side === 'quark' ? '夸克' : '115'}账号？`,
          detail: '将移除本软件保存的该账号凭证和网页登录状态。云端文件及另一侧账号保留。已取消的旧任务将无法重试，请重新选择文件创建任务。此操作不会撤销网盘网站上的应用授权。',
          buttons: ['取消', '退出账号'], defaultId: 0, cancelId: 0 });
        return result.response === 1;
      },
    });
  }
  async function saveCredentials(input, revision) {
    ready(); const side = validateSide(input?.side);
    const credentials = { side };
    if (side === 'quark') {
      if (typeof input.cookie !== 'string' || !input.cookie.trim() || input.cookie.length > 64000) throw new Error('请填写有效的夸克 Cookie');
      credentials.cookie = input.cookie.trim().replace(/^cookie:\s*/i, '').replace(/[\r\n]+/g, '');
    } else {
      for (const key of ['accessToken', 'refreshToken']) {
        if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 32000) throw new Error('请同时填写 Access Token 和 Refresh Token');
        credentials[key] = input[key].trim();
      }
    }
    return accounts.save(side, async () => {
      await engine.saveCredentials(credentials);
      state.accounts[side].connected = false; state.accounts[side].message = '正在验证目录读取'; broadcast();
      // Explicitly probe reading: a saved storage record alone does not establish connectivity.
      try { await engine.list({ path: MOUNTS[side], refresh: true }); }
      catch (error) { state.accounts[side].connected = false; state.accounts[side].message = redact(error); broadcast(); throw error; }
      await updateAccounts();
      state.accounts[side].connected = true; state.accounts[side].message = '已连接';
      log(`${side === 'quark' ? '夸克' : '115'}连接成功`);
      return { connected: true };
    }, revision);
  }
  function allowedAuthURL(value, side) {
    try {
      const u = new URL(value); if (u.protocol !== 'https:') return false;
      const hosts = side === 'quark' ? ['quark.cn', 'uc.cn'] : ['api.oplist.org', '115.com'];
      return hosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
    } catch { return false; }
  }
  async function login({ side }) {
    ready(); validateSide(side);
    const revision = accounts.loginRevision(side);
    if (authWindows.has(side)) { authWindows.get(side).focus(); return { opened: true }; }
    const authSession = session.fromPartition('persist:openlist-login-' + side);
    authSession.setUserAgent(authSession.getUserAgent().replace(/(?:OpenListTransfer|Electron)\/[\w.]+\s*/g, ''));
    const loginWindow = new BrowserWindow({ width: 1100, height: 790, parent: window, title: side === 'quark' ? '登录夸克后将自动尝试连接' : '请选择 115 网盘并完成授权；无法自动导入时可手动填写令牌',
      autoHideMenuBar: true, webPreferences: { session: authSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    loginWindow.removeMenu(); authWindows.set(side, loginWindow);
    authSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const childWindows = new Set(); let checking = false, lastFingerprint = '', retryAfter = 0, timer, capturedTokens = null;
    function restrict(contents) {
      contents.on('will-navigate', (event, url) => { if (!allowedAuthURL(url, side)) event.preventDefault(); });
      contents.setWindowOpenHandler(({ url }) => allowedAuthURL(url, side)
        ? { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: authSession, nodeIntegration: false, contextIsolation: true, sandbox: true } } }
        : { action: 'deny' });
      contents.on('did-create-window', child => { childWindows.add(child); child.removeMenu(); restrict(child.webContents); child.on('closed', () => childWindows.delete(child)); });
      const navigated = (_event, url) => { if (side === 'pan115') capturedTokens = parse115Callback(url) || capturedTokens; probe(); };
      contents.on('did-navigate', navigated); contents.on('did-navigate-in-page', navigated);
    }
    restrict(loginWindow.webContents);
    const tokenScript = `(() => {
      const fields = Array.from(document.querySelectorAll('input,textarea')).map(e => {
        const label = e.id ? document.querySelector('label[for="'+CSS.escape(e.id)+'"]') : null;
        const nearby = e.closest('label')?.textContent || label?.textContent || e.parentElement?.previousElementSibling?.textContent || '';
        return { key: [e.id,e.name,e.placeholder,nearby].join(' ').toLowerCase(), value: e.value?.trim() || '' };
      });
      return { accessToken: fields.find(f => /access[ _-]?token|访问令牌/.test(f.key))?.value || '', refreshToken: fields.find(f => /refresh[ _-]?token|刷新令牌/.test(f.key))?.value || '' };
    })()`;
    async function probe() {
      if (checking || loginWindow.isDestroyed() || Date.now() < retryAfter) return; checking = true;
      try {
        let credentials;
        if (side === 'quark') {
          const cookies = (await authSession.cookies.get({})).filter(c => /(^|\.)quark\.cn$/.test(c.domain.replace(/^\./, '')));
          if (!cookies.some(c => c.name === '__pus') || !cookies.some(c => c.name === '__puus')) return;
          credentials = { side, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };
        } else {
          let tokens = capturedTokens;
          for (const candidate of [loginWindow, ...childWindows]) {
            if (tokens) break;
            if (candidate.isDestroyed()) continue;
            const url = candidate.webContents.getURL();
            if (!url || new URL(url).hostname !== 'api.oplist.org') continue;
            tokens = parse115Callback(url);
            if (!tokens) {
              const fields = await candidate.webContents.executeJavaScript(tokenScript, false);
              if (fields.accessToken && fields.refreshToken) tokens = fields;
            }
          }
          if (!tokens) return;
          if (!tokens.accessToken || !tokens.refreshToken) return;
          credentials = { side, ...tokens };
        }
        const fingerprint = createHash('sha256').update(JSON.stringify(credentials)).digest('hex');
        if (fingerprint === lastFingerprint) return;
        if (loginWindow.isDestroyed() || !accounts.isCurrent(side, revision)) return;
        await saveCredentials(credentials, revision);
        lastFingerprint = fingerprint;
        if (!loginWindow.isDestroyed()) loginWindow.close();
      } catch (e) {
        if (loginWindow.isDestroyed() || !accounts.isCurrent(side, revision)) return;
        retryAfter = Date.now() + 30000;
        state.accounts[side].message = '自动接入尚未成功，可完成网页登录后重试，或使用手动凭证入口'; broadcast();
      } finally { checking = false; }
    }
    timer = setInterval(probe, 3000);
    loginWindow.on('closed', () => { clearInterval(timer); authWindows.delete(side); for (const child of childWindows) if (!child.isDestroyed()) child.destroy(); });
    await loginWindow.loadURL(side === 'quark' ? 'https://pan.quark.cn' : 'https://api.oplist.org');
    return { opened: true };
  }
  handle('get-state', () => snapshot());
  handle('list', async input => { ready(); const side = validateSide(input?.side); return engine.list({ path: within(input.path, MOUNTS[side]), refresh: !!input.refresh }); });
  handle('login', login); handle('save-credentials', saveCredentials);
  handle('logout', async input => {
    ready(); const side = validateSide(input?.side);
    const revision = accounts.revisions[side];
    try {
      const result = await accounts.logout(side);
      if (result.disconnected) log(`${side === 'quark' ? '夸克' : '115'}账号已退出`);
      return result;
    } finally {
      // A rejected busy request or a dismissed dialog did not change credentials.
      // Do not let either start an older status request that races a real logout.
      if (!accounts.isCurrent(side, revision)) await updateAccounts();
    }
  });
  handle('start-transfer', async input => { ready(); accounts.assertAvailable(); return queue.add(input); });
  handle('pause-queue', () => { ready(); return queue.pause(); });
  handle('resume-queue', () => { ready(); accounts.assertAvailable(); return queue.resume(); });
  handle('retry-job', id => { ready(); accounts.assertAvailable(); return queue.retry(id); });
  handle('cancel-job', id => { ready(); return queue.cancel(id); });
  handle('choose-cache', async () => {
    ready(); accounts.assertAvailable(); if (queue.hasUnfinished()) throw new Error('请先完成或取消现有任务，再更换缓存目录');
    const result = await dialog.showOpenDialog(window, { title: '选择缓存所在文件夹', properties: ['openDirectory', 'createDirectory'], defaultPath: store.data.cacheDir });
    if (result.canceled) return { cacheDir: store.data.cacheDir };
    ready();
    return accounts.exclusive(async () => {
      if (queue.running || queue.hasUnfinished()) throw new Error('请先完成或取消现有任务，再更换缓存目录');
      const dir = path.join(result.filePaths[0], 'OpenListTransferCache');
      fs.mkdirSync(dir, { recursive: true }); await engine.setCacheDir(dir);
      store.data.cacheDir = dir; store.save(); queue.cacheDir = dir; broadcast(); return { cacheDir: dir };
    });
  });
  handle('clear-cache', async () => {
    if (quitting) throw new Error('程序正在退出，请重新打开后操作');
    const result = await maintenance.run('clear-cache');
    if (!result.cancelled && engine?.status === 'ready' && store) {
      // A failed initial engine launch may not have built the queue/accounts.
      // Keep all operations gated until those services and account discovery settle.
      startupSettled = false;
      state.engine = { status: 'starting', version: '4.2.6' }; broadcast();
      startup = (async () => {
        initializeQueueAndAccounts();
        await updateAccounts();
        if (!quitting) state.engine = { status: 'ready', version: '4.2.6' };
      })().catch(error => {
        state.engine = { status: 'error', version: '4.2.6', error: redact(error) };
        throw error;
      }).finally(() => { startupSettled = true; broadcast(); });
      await startup;
    }
    if (!result.cancelled) log(result.complete ? `缓存清理完成：${result.files} 个文件，${result.bytes} 字节` : '部分缓存未能清理，请检查目录权限或文件占用后重试');
    for (const issue of result.errors?.slice(0, 10) || []) log(`缓存清理未完成：${issue.path} (${issue.code}) ${issue.message}`);
    return result;
  });
  handle('reset-app', async () => {
    if (quitting) throw new Error('程序正在退出，请重新打开后操作');
    let result;
    try { result = await maintenance.run('reset-app'); }
    catch (error) {
      if (maintenance.resetStarted) { state.engine = { status: 'error', version: '4.2.6', error: redact(error) }; broadcast(); }
      throw error;
    }
    if (!result.reset) return result;
    ++accountUpdate;
    store = null; queue = null; accounts = null;
    state.logs = [];
    for (const side of Object.keys(MOUNTS)) state.accounts[side] = { connected: false, mount: MOUNTS[side] };
    broadcast();
    await dialog.showMessageBox(window, { type: 'info', title: '重置完成', message: '本机数据已重置，程序即将关闭。',
      detail: '下次双击 EXE 将恢复初始设置，请重新连接账号。' + (result.retained ? ` 已保留 ${result.retained} 项无法确认为程序缓存的内容。` : ''), buttons: ['确定'] });
    setTimeout(() => app.quit(), 100);
    return result;
  });
  handle('open-folder', async ({ kind }) => {
    const allowed = { data: app.getPath('userData'), logs: path.join(app.getPath('userData'), 'logs'), cache: store?.data.cacheDir };
    if (!allowed[kind]) throw new Error('文件夹类型无效'); fs.mkdirSync(allowed[kind], { recursive: true }); return shell.openPath(allowed[kind]);
  });
  app.on('second-instance', () => { if (!quitting && window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); } });
  async function start() {
    const mainWindow = window = new BrowserWindow({ width: 1370, height: 900, minWidth: 1024, minHeight: 720, backgroundColor: '#f4f6fa', show: false, autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: !process.argv.includes('--smoke-test') } });
    window.removeMenu(); window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== appURL) event.preventDefault(); });
    const stopped = () => quitting || mainWindow.isDestroyed();
    window.once('ready-to-show', () => { if (!stopped() && !process.argv.includes('--smoke-test')) mainWindow.show(); });
    window.once('closed', () => { if (window === mainWindow) window = null; });
    window.on('close', event => {
      if (quitting) return; event.preventDefault();
      if (maintenance.busy) return;
      if (queue?.running) {
        const result = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续运行', '保存任务并退出'], defaultId: 0, cancelId: 0, title: '传输尚未结束', message: '退出后传输将停止。任务记录会保留，单个未完成文件可能需要重新传输。' });
        if (result === 0) return;
      }
      app.quit();
    });
    await mainWindow.loadURL(appURL);
    if (stopped()) return;
    try {
      const dataDir = app.getPath('userData');
      store = new Store(path.join(dataDir, 'tasks.json'), { version: 1, cacheDir: path.join(app.getPath('userData'), 'cache'), jobs: [] });
      fs.mkdirSync(store.data.cacheDir, { recursive: true });
      const binaryPath = app.isPackaged ? path.join(process.resourcesPath, 'engine', 'openlist.exe') : path.join(__dirname, '..', 'vendor', 'openlist.exe');
      engine = new Engine({ binaryPath, dataDir: path.join(dataDir, 'engine'), cacheDir: store.data.cacheDir });
      engine.on('status', status => { state.engine = { ...state.engine, ...status, error: status.error ? redact(status.error) : undefined }; broadcast(); });
      await engine.start();
      if (stopped()) return;
      state.engine = { status: 'ready', version: '4.2.6' };
      initializeQueueAndAccounts();
      await updateAccounts();
      if (stopped()) return;
      log('本地引擎已就绪，服务仅监听本机');
    } catch (e) { state.engine = { status: 'error', version: '4.2.6', error: redact(e) }; log('启动失败：' + redact(e)); }
    if (stopped()) return;
    startupSettled = true;
    broadcast();
    // Packaging smoke tests use an isolated profile and never authenticate any cloud account.
    if (process.argv.includes('--smoke-test')) {
      const output = path.join(app.getPath('userData'), 'smoke-result.json');
      const renderer = await window.webContents.executeJavaScript(`(async () => {
        const data = await window.bridge.getState();
        for (let n = 0; n < 100 && !document.getElementById('engine-status')?.classList.contains('ready'); n++) await new Promise(resolve => setTimeout(resolve, 50));
        await new Promise(resolve => setTimeout(resolve, 200));
        return { title: document.title, bridgeReady: !!window.bridge, engineStatus: data.engine.status, renderedReady: document.getElementById('engine-status')?.classList.contains('ready'), quarkText: document.getElementById('quark-title')?.textContent, pan115Text: document.getElementById('pan115-title')?.textContent, errors: document.querySelectorAll('.notice.error').length };
      })()`);
      const picture = await window.webContents.capturePage();
      fs.writeFileSync(path.join(app.getPath('userData'), 'smoke-screen.png'), picture.toPNG());
      fs.writeFileSync(output, JSON.stringify({ engine: state.engine, hasWindow: !!window, accounts: state.accounts, renderer }, null, 2));
      setTimeout(() => app.quit(), 1500);
    }
  }
  app.whenReady().then(() => {
    if (!quitting) return startup = start().finally(() => { startupSettled = true; broadcast(); });
  }).catch(error => { if (!quitting) { dialog.showErrorBox('启动失败', redact(error)); app.quit(); } });
  app.on('before-quit', event => {
    if (maintenance.busy) { event.preventDefault(); return; }
    if (quitting) return; event.preventDefault(); quitting = true;
    // A late engine.start completion must not recreate work after shutdown stopped it.
    Promise.resolve().then(async () => { await startup?.catch(() => {}); await queue?.stop(); for (const w of authWindows.values()) if (!w.isDestroyed()) w.destroy(); await engine?.stop(); })
      .catch(() => {}).finally(() => { if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker); app.quit(); });
  });
  app.on('window-all-closed', () => { if (!quitting) app.quit(); });
}
