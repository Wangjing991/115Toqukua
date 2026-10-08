'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

// Execute the application's actual event handlers. The Electron doubles throw the
// same exception as a native window after destruction, without touching user data.
function fixture(options = {}) {
  const mainPath = path.resolve(__dirname, '../src/main.js');
  const localRequire = createRequire(mainPath);
  const windows = [], calls = [], errors = [], dialogs = [], timers = [], handlers = new Map();
  let releaseReady;
  const ready = new Promise(resolve => { releaseReady = resolve; });
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    setName() {}, setPath() {},
    getPath: () => path.resolve(__dirname, '../tmp/lifecycle-fixture'),
    requestSingleInstanceLock: () => true,
    whenReady: () => ready,
    quit: () => calls.push('quit'),
    exit: code => calls.push(`exit:${code}`),
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.minimized = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler() {},
        send: () => this.nativeCall('send'),
      });
      windows.push(this);
    }
    nativeCall(name) {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      calls.push(name);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { this.nativeCall('isMinimized'); return this.minimized; }
    restore() { this.nativeCall('restore'); this.minimized = false; }
    focus() { this.nativeCall('focus'); }
    show() { this.nativeCall('show'); }
    removeMenu() { this.nativeCall('removeMenu'); }
    async loadURL() { this.nativeCall('loadURL'); await options.load; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  class FakeEngine extends EventEmitter {
    constructor() { super(); this.status = 'stopped'; this.configured = false; calls.push('engine.create'); }
    setStatus(status) { this.status = status; this.emit('status', { status }); }
    async start() {
      calls.push('engine.start'); this.setStatus('starting'); await options.start;
      const error = typeof options.startError === 'function' ? options.startError(calls.filter(call => call === 'engine.start').length) : options.startError;
      if (error) { this.setStatus('error'); throw error; }
      this.setStatus('ready'); calls.push('engine.started');
    }
    async stop() { calls.push('engine.stop'); this.setStatus('stopped'); }
    async saveCredentials() { calls.push('engine.saveCredentials'); this.configured = true; }
    async list() { calls.push('engine.list'); if (options.listError) throw options.listError; return { entries: [] }; }
    async getAccounts() { await options.getAccounts; return { quark: { connected: false }, pan115: { connected: this.configured } }; }
  }
  class FakeQueue extends EventEmitter {
    constructor({ store }) { super(); this.store = store; this.running = false; calls.push('queue.create'); }
    summaries() { return this.store.data.jobs; }
    hasUnfinished() { return this.store.data.jobs.some(job => !['completed', 'cancelled'].includes(job.status)); }
    pause() { return { paused: true }; }
    retire() { this.retired = true; calls.push('queue.retire'); }
    async stop() { calls.push('queue.stop'); if (!this.retired) this.store.save(); }
  }
  const { MaintenanceLifecycle } = localRequire('./maintenance-lifecycle');
  class FakeDataMaintenance extends MaintenanceLifecycle {
    constructor(dependencies) {
      super({ ...dependencies,
        clearCache: async () => { calls.push('cache.clear'); return { files: 1, bytes: 8, retained: 0, complete: true }; },
        resetConfiguration: async () => { calls.push('configuration.reset'); return { complete: options.resetComplete !== false }; },
      });
    }
  }
  const electron = {
    app, BrowserWindow: FakeWindow, ipcMain: { handle(name, handler) { handlers.set(name, handler); } }, shell: {},
    session: { fromPartition: side => ({
      async closeAllConnections() { calls.push('session.close:' + side); },
      async clearStorageData() { calls.push('session.clear:' + side); },
      async clearCache() {}, async clearAuthCache() {}, cookies: { async flushStore() {} },
    }) },
    dialog: {
      showErrorBox: (_title, message) => errors.push(message),
      async showMessageBox(_window, settings) { dialogs.push(settings); return options.confirm ? options.confirm(settings) : { response: 1 }; },
    },
    powerSaveBlocker: { start: () => 1, stop() {} },
  };
  const substitutes = {
    electron,
    'node:fs': { mkdirSync() {}, appendFileSync() {} },
    './store': { Store: class {
      constructor(_file, data) { this.data = { ...data, jobs: options.jobs || [] }; }
      save() { calls.push('store.save'); }
    } },
    './engine': { Engine: FakeEngine }, './queue': { Queue: FakeQueue },
    './maintenance-lifecycle': { MaintenanceLifecycle: FakeDataMaintenance },
  };
  vm.runInNewContext(fs.readFileSync(mainPath, 'utf8'), {
    require: name => Object.hasOwn(substitutes, name) ? substitutes[name] : localRequire(name),
    __dirname: path.dirname(mainPath),
    process: { env: {}, argv: [], resourcesPath: '' },
    URL, console, setTimeout: callback => { timers.push(callback); }, clearTimeout, setInterval, clearInterval,
  }, { filename: mainPath });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { app, windows, calls, errors, dialogs, timers,
    invoke: (channel, ...args) => handlers.get(channel)({ sender: windows[0].webContents, senderFrame: { url: pathToFileURL(path.join(path.dirname(mainPath), 'renderer/index.html')).href } }, ...args),
    async ready() { releaseReady(); await flush(); }, flush };
}

test('a second launch before ready waits for the first window', async () => {
  const f = fixture();
  assert.doesNotThrow(() => f.app.emit('second-instance'));
  assert.equal(f.windows.length, 0);
  await f.ready();
  assert.equal(f.windows.length, 1);
  assert.deepEqual(f.errors, []);
});

test('repeated launches restore and focus the one live main window', async () => {
  const f = fixture(); await f.ready();
  f.windows[0].minimized = true;
  for (let i = 0; i < 3; i++) assert.doesNotThrow(() => f.app.emit('second-instance'));
  assert.equal(f.windows.length, 1);
  assert.equal(f.calls.filter(call => call === 'restore').length, 1);
  assert.equal(f.calls.filter(call => call === 'focus').length, 3);
});

test('the explicit close command starts shutdown and finishes with a process exit', async () => {
  const f = fixture(); await f.ready();
  await f.invoke('quit-app');
  assert.equal(f.calls.includes('quit'), true);
  f.app.emit('before-quit', { preventDefault() {} });
  await f.flush();
  assert.equal(f.calls.includes('engine.stop'), true);
  assert.equal(f.calls.includes('exit:0'), true);
});

test('115 login succeeds after storage validation even when its large root directory cannot be enumerated', async () => {
  const f = fixture({ listError: new Error('large root listing exceeded the directory timeout') });
  await f.ready();
  const result = await f.invoke('save-credentials', { side: 'pan115', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' });
  assert.equal(result.connected, true);
  assert.equal(f.calls.includes('engine.saveCredentials'), true);
  assert.equal(f.calls.includes('engine.list'), false, 'login must not enumerate every item in the root directory');
  assert.equal((await f.invoke('get-state')).accounts.pan115.connected, true);
});

test('launch after the main window is destroyed does not call destroyed native methods', async () => {
  const f = fixture(); await f.ready();
  f.windows[0].destroy();
  assert.doesNotThrow(() => f.app.emit('second-instance'), 'relaunch must not throw Object has been destroyed');
});

test('launch during shutdown does not call methods on the destroyed window', async () => {
  const f = fixture(); await f.ready();
  f.app.emit('before-quit', { preventDefault() {} });
  f.windows[0].destroy();
  assert.doesNotThrow(() => f.app.emit('second-instance'), 'shutdown relaunch must not throw Object has been destroyed');
  await f.flush();
});

test('a delayed ready-to-show callback cannot show a destroyed window', async () => {
  const f = fixture(); await f.ready();
  f.windows[0].destroy();
  assert.doesNotThrow(() => f.windows[0].emit('ready-to-show'), 'late ready callback must not throw Object has been destroyed');
});

test('quitting before app readiness does not create a window or engine afterward', async () => {
  const f = fixture();
  f.app.emit('before-quit', { preventDefault() {} });
  await f.ready();
  assert.equal(f.windows.length, 0);
  assert.equal(f.calls.includes('engine.create'), false);
});

test('quitting while the page loads does not start a new engine afterward', async () => {
  let finishLoad;
  const f = fixture({ load: new Promise(resolve => { finishLoad = resolve; }) });
  await f.ready();
  f.app.emit('before-quit', { preventDefault() {} });
  f.windows[0].destroy();
  finishLoad(); await f.flush();
  assert.equal(f.calls.includes('engine.create'), false);
  assert.deepEqual(f.errors, []);
});

test('quitting during engine startup waits for startup then stops it without creating a queue', async () => {
  let finishStart;
  const f = fixture({ start: new Promise(resolve => { finishStart = resolve; }) });
  await f.ready();
  assert.equal(f.calls.includes('engine.start'), true);
  f.app.emit('before-quit', { preventDefault() {} });
  f.windows[0].destroy(); await f.flush();
  assert.equal(f.calls.includes('engine.stop'), false, 'stop must not race an in-flight engine.start');
  finishStart(); await f.flush();
  assert.equal(f.calls.filter(call => call === 'engine.stop').length, 1);
  assert.equal(f.calls.includes('queue.create'), false);
  assert.ok(f.calls.indexOf('engine.stop') > f.calls.indexOf('engine.started'));
  assert.deepEqual(f.errors, []);
});

test('native maintenance cancellation reaches neither engine shutdown nor local deletion', async () => {
  const f = fixture({ confirm: () => ({ response: 0 }) }); await f.ready();
  assert.equal((await f.invoke('clear-cache')).cancelled, true);
  assert.equal((await f.invoke('reset-app')).cancelled, true);
  assert.equal(f.dialogs.length, 2);
  for (const operation of ['engine.stop', 'cache.clear', 'configuration.reset', 'queue.retire']) assert.equal(f.calls.includes(operation), false);
});

test('main reset IPC holds the quit lock and drops retired services before shutdown', async () => {
  let confirm;
  const f = fixture({ jobs: [{ id: 'old-history', status: 'completed' }],
    confirm: settings => settings.title === '重置完成' ? { response: 0 } : new Promise(resolve => { confirm = resolve; }),
  }); await f.ready();
  const reset = f.invoke('reset-app'); await f.flush();
  let prevented = false;
  f.app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  await assert.rejects(f.invoke('start-transfer', {}), /正在清理缓存或重置/);
  confirm({ response: 1 });
  assert.equal((await reset).reset, true);
  assert.equal(f.calls.includes('queue.retire'), true);
  assert.equal(f.calls.filter(call => call.startsWith('session.clear:')).length, 2);
  const state = await f.invoke('get-state');
  assert.equal(state.jobs.length, 0);
  assert.equal(state.accounts.quark.connected, false);
  assert.equal(state.accounts.pan115.connected, false);
  assert.equal(f.timers.length, 1, 'a successful reset schedules app shutdown');
  f.timers[0]();
  f.app.emit('before-quit', { preventDefault() {} }); await f.flush();
  assert.equal(f.calls.includes('queue.stop'), false, 'the old queue cannot rewrite the cleared task file');
  assert.equal(f.calls.includes('store.save'), false);
});

test('startup failure preserves unfinished caches unless the user explicitly confirms full reset', async () => {
  const f = fixture({ startError: new Error('fixture engine unavailable'), jobs: [{ id: 'unfinished', status: 'paused' }] });
  await f.ready();
  assert.equal((await f.invoke('get-state')).engine.status, 'error');
  await assert.rejects(f.invoke('clear-cache'), /完成或取消/);
  assert.equal(f.calls.includes('cache.clear'), false);
  assert.equal((await f.invoke('reset-app')).reset, true, 'without a worker, full reset explicitly abandons persisted tasks');
  assert.equal(f.dialogs[0].title, '完整重置');
  assert.match(f.dialogs[0].detail, /全部任务记录/);
});

test('cache cleanup after an engine startup failure leaves recovery controls usable', async () => {
  const f = fixture({ startError: new Error('fixture engine unavailable') }); await f.ready();
  await assert.rejects(f.invoke('clear-cache'), /fixture engine unavailable/);
  const state = await f.invoke('get-state');
  assert.ok(['ready', 'error'].includes(state.engine.status), `maintenance UI cannot recover from ${state.engine.status}`);
});

test('partial reset keeps the reset control usable for retry and prevents transfers', async () => {
  const f = fixture({ resetComplete: false }); await f.ready();
  await assert.rejects(f.invoke('reset-app'), /重置未完全完成/);
  const state = await f.invoke('get-state');
  assert.equal(state.maintenance.resetStarted, true);
  assert.ok(['ready', 'error'].includes(state.engine.status), `maintenance UI cannot retry from ${state.engine.status}`);
  await assert.rejects(f.invoke('start-transfer', {}), /重置尚未完成/);
});

test('maintenance waits until initial account discovery has settled even after engine readiness', async () => {
  let finishDiscovery;
  const f = fixture({ getAccounts: new Promise(resolve => { finishDiscovery = resolve; }), confirm: () => ({ response: 0 }) });
  await f.ready();
  try {
    assert.equal((await f.invoke('get-state')).engine.status, 'starting', 'renderer must wait to load account directories until IPC is usable');
    await assert.rejects(f.invoke('clear-cache'), /等待.*启动/);
    await assert.rejects(f.invoke('reset-app'), /等待.*启动/);
    assert.equal(f.dialogs.length, 0);
  } finally { finishDiscovery(); await f.flush(); }
  assert.equal((await f.invoke('clear-cache')).cancelled, true);
});

test('a successful engine retry cannot advertise a usable service without its queue', async () => {
  const f = fixture({ startError: attempt => attempt === 1 ? new Error('transient startup error') : null });
  await f.ready();
  assert.equal((await f.invoke('get-state')).engine.status, 'error');
  await f.invoke('clear-cache');
  const state = await f.invoke('get-state');
  if (state.engine.status === 'ready') assert.equal((await f.invoke('pause-queue')).paused, true);
  else {
    assert.equal(state.engine.status, 'error');
    assert.match(state.engine.error, /重新打开|重启/);
  }
});

test('recovery discovery blocks new operations and is awaited before quitting', async () => {
  let finishDiscovery;
  const f = fixture({ startError: attempt => attempt === 1 ? new Error('transient startup error') : null,
    getAccounts: new Promise(resolve => { finishDiscovery = resolve; }),
  }); await f.ready();
  const cleanup = f.invoke('clear-cache'); await f.flush();
  assert.equal((await f.invoke('get-state')).engine.status, 'starting');
  await assert.rejects(f.invoke('pause-queue'), /本地引擎尚未就绪/);
  await assert.rejects(f.invoke('reset-app'), /等待.*启动/);
  f.app.emit('before-quit', { preventDefault() {} }); await f.flush();
  assert.equal(f.calls.filter(call => call === 'engine.stop').length, 1, 'shutdown waits for recovery discovery');
  finishDiscovery(); await cleanup; await f.flush();
  assert.equal(f.calls.filter(call => call === 'engine.stop').length, 2);
  assert.equal((await f.invoke('get-state')).engine.status, 'stopped');
});
