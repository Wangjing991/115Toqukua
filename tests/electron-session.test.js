'use strict';

// Opt in with ELECTRON_TEST_BINARY=/absolute/path/to/electron.exe. A supplied
// binary must run successfully; missing or broken binaries never silently skip.
// Every cookie/profile below belongs to an isolated temporary test directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const prefix = 'openlist-electron-session-';

async function removeFixture(directory) {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'Only remove a direct fixture child of the system temp directory');
  assert.ok(path.basename(absolute).startsWith(prefix), 'Only remove the named Electron test fixture');
  await fs.rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function runElectron(binary, script, phase, directory, origin) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(binary, [script, phase, directory, origin], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    let timedOut = false;
    const collect = chunk => { output = (output + chunk.toString()).slice(-8000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') {
        // The PID comes directly from this spawned child; kill its subprocesses
        // too before the isolated profile can be removed.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else child.kill('SIGKILL');
    }, 40000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error(`Electron ${phase} ${timedOut ? 'timed out' : `exited ${code} (${signal || 'no signal'})`}:\n${output}`));
      else resolve();
    });
  });
}

test('real Electron logout clears one persistent login partition and stays cleared after restart', { skip: !process.env.ELECTRON_TEST_BINARY, timeout: 110000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.end('<!doctype html><html><head><title>Isolated login-session fixture</title></head><body>Local session test only</body></html>');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const script = path.join(directory, 'session-fixture.cjs');
    const lifecyclePath = path.resolve(__dirname, '../src/account-lifecycle.js');
    await fs.writeFile(script, `
'use strict';
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { clearLoginSession } = require(${JSON.stringify(lifecyclePath)});
const [phase, directory, origin] = process.argv.slice(2);
const resultPath = path.join(directory, phase + '.json');
app.setPath('userData', path.join(directory, 'profile'));
app.setPath('sessionData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const partitions = {};
const windows = new Set();
function forSide(side) {
  if (!partitions[side]) {
    partitions[side] = session.fromPartition('persist:login-' + side);
    partitions[side].webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(origin + '/') }));
  }
  return partitions[side];
}
async function open(side) {
  const win = new BrowserWindow({ show: false, webPreferences: { session: forSide(side), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  windows.add(win);
  win.once('closed', () => windows.delete(win));
  await win.loadURL(origin + '/');
  return win;
}
async function inspect(side) {
  const win = await open(side);
  const storage = await win.webContents.executeJavaScript('localStorage.getItem("login-fixture")');
  const cookies = (await forSide(side).cookies.get({ url: origin })).map(cookie => ({ name: cookie.name, value: cookie.value }));
  win.destroy();
  return { storage, cookies };
}
async function flush() {
  for (const loginSession of Object.values(partitions)) {
    loginSession.flushStorageData();
    await loginSession.cookies.flushStore();
  }
}
app.whenReady().then(async () => {
  if (phase === 'clear') {
    for (const side of ['quark', 'pan115']) {
      const win = await open(side);
      await win.webContents.executeJavaScript('localStorage.setItem("login-fixture", ' + JSON.stringify(side) + ')');
      await forSide(side).cookies.set({ url: origin, name: 'login-fixture', value: side, expirationDate: Date.now() / 1000 + 3600 });
      win.destroy();
    }
    await flush();
    assert.deepEqual(await inspect('quark'), { storage: 'quark', cookies: [{ name: 'login-fixture', value: 'quark' }] });
    assert.deepEqual(await inspect('pan115'), { storage: 'pan115', cookies: [{ name: 'login-fixture', value: 'pan115' }] });
    await clearLoginSession(forSide('quark'));
  } else assert.equal(phase, 'restart');
  const actual = { quark: await inspect('quark'), pan115: await inspect('pan115') };
  assert.deepEqual(actual.quark, { storage: null, cookies: [] });
  assert.deepEqual(actual.pan115, { storage: 'pan115', cookies: [{ name: 'login-fixture', value: 'pan115' }] });
  await flush();
  fs.writeFileSync(resultPath, JSON.stringify({ phase, success: true, actual }));
  for (const win of windows) win.destroy();
  app.quit();
}).catch(error => {
  fs.writeFileSync(resultPath, JSON.stringify({ phase, success: false, error: error.stack }));
  console.error(error.stack);
  app.exit(1);
});
`, 'utf8');
    for (const phase of ['clear', 'restart']) {
      await runElectron(path.resolve(process.env.ELECTRON_TEST_BINARY), script, phase, directory, origin);
      const report = JSON.parse(await fs.readFile(path.join(directory, `${phase}.json`), 'utf8'));
      assert.equal(report.success, true, report.error);
      assert.equal(report.phase, phase);
      assert.deepEqual(report.actual, {
        quark: { storage: null, cookies: [] },
        pan115: { storage: 'pan115', cookies: [{ name: 'login-fixture', value: 'pan115' }] },
      });
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await removeFixture(directory);
  }
});
