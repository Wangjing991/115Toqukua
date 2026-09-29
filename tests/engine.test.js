'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Engine } = require('../src/engine');
const { Queue } = require('../src/queue');
const { Store } = require('../src/store');
const { AccountLifecycle } = require('../src/account-lifecycle');
const { MaintenanceLifecycle } = require('../src/maintenance-lifecycle');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail('Condition timed out');
    await sleep(30);
  }
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function removeFixture(directory, prefix) {
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase(), 'Only remove a direct fixture child of the system temp directory');
  assert.ok(path.basename(absolute).startsWith(prefix), 'Only remove the named fixture directory');
  await fsp.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function mockEngine(t, handler) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-engine-unit-'));
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.equal(req.headers.authorization, 'private-test-token');
      const result = await handler(req, Buffer.concat(chunks));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ code: 500, message: error.message, data: null }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const engine = new Engine({ binaryPath: path.join(directory, 'unused.exe'), dataDir: directory, cacheDir: directory });
  engine.baseUrl = `http://127.0.0.1:${server.address().port}`;
  engine._token = 'private-test-token';
  engine.status = 'ready';
  t.after(async () => {
    await engine.stop();
    await new Promise((resolve) => server.close(resolve));
    await removeFixture(directory, 'openlist-engine-unit-');
  });
  return { engine, directory };
}

const success = (data) => ({ code: 200, message: 'success', data });

test('copy submits explicit no-overwrite flags and returns the created task id', async (t) => {
  const { engine } = await mockEngine(t, (req, body) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/fs/copy');
    assert.deepEqual(JSON.parse(body), {
      src_dir: '/_cache/job', dst_dir: '/115/备份', names: ['报告 (1).pdf'],
      overwrite: false, skip_existing: false, merge: false,
    });
    return success({ tasks: [{ id: 'copy-1', state: 0 }] });
  });
  assert.equal(await engine.copyFile({ srcDir: '/_cache/job', dstDir: '/115/备份', name: '报告 (1).pdf' }), 'copy-1');
});

test('HTTP 200 with an API conflict is rejected; an empty task result is never success', async (t) => {
  let calls = 0;
  const { engine } = await mockEngine(t, () => ++calls === 1
    ? { code: 403, message: 'file [report.pdf] exists', data: null }
    : success({ message: 'Copy operations completed immediately' }));
  const args = { srcDir: '/_cache', dstDir: '/115', name: 'report.pdf' };
  await assert.rejects(engine.copyFile(args), { code: 'CONFLICT' });
  await assert.rejects(engine.copyFile(args), { code: 'TASK_NOT_CREATED' });
});

test('task state mapping distinguishes success, cancellation, failure, and retry waits', async (t) => {
  const states = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const { engine } = await mockEngine(t, (req) => {
    assert.equal(req.url, '/api/task/upload/info?tid=job%20%2B%3F');
    return success({ state: states.shift(), progress: 37.5, error: '' });
  });
  const expected = ['running', 'running', 'success', 'running', 'cancelled', 'running', 'running', 'failed', 'running', 'running'];
  for (const state of expected) {
    assert.deepEqual(await engine.getUploadTask('job +?'), { state, progress: 37.5, error: '' });
  }
});

test('task errors remove known credentials and signed URLs', async (t) => {
  const { engine } = await mockEngine(t, () => success({ state: 7, progress: 0, error: 'secret-value https://127.0.0.1/p/test?sign=private failed' }));
  engine._secrets.add('secret-value');
  const task = await engine.getCopyTask('bad');
  assert.equal(task.state, 'failed');
  assert.doesNotMatch(task.error, /secret-value|sign=|https?:/);
});

test('upload uses the remote final name and no-overwrite header; it returns a pending task', async (t) => {
  const bytes = Buffer.from('cloud content\0中文');
  const target = '/115/备份/报告?.txt';
  const { engine, directory } = await mockEngine(t, (req, body) => {
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/api/fs/put');
    assert.equal(decodeURIComponent(req.headers['file-path']), target);
    assert.equal(req.headers['as-task'], 'true');
    assert.equal(req.headers.overwrite, 'false');
    assert.equal(Number(req.headers['content-length']), bytes.length);
    assert.deepEqual(body, bytes);
    return success({ task: { id: 'upload-1', state: 0, progress: 0 } });
  });
  const localPath = path.join(directory, 'content.bin');
  await fsp.writeFile(localPath, bytes);
  assert.equal(await engine.uploadFile({ localPath, targetPath: target, size: bytes.length }), 'upload-1');
  await assert.rejects(engine.uploadFile({ localPath, targetPath: target, size: bytes.length + 1 }), { code: 'FILE_CHANGED' });
});

test('account configuration uses exact driver names, string additions, and local proxy', async (t) => {
  const stored = [];
  const { engine } = await mockEngine(t, (req, body) => {
    if (req.url.startsWith('/api/admin/storage/list')) return success({ content: stored, total: stored.length });
    if (req.url === '/api/admin/storage/create') {
      const storage = JSON.parse(body);
      assert.equal(typeof storage.addition, 'string');
      assert.equal(storage.web_proxy, true);
      assert.equal(storage.enable_sign, true);
      stored.push({ ...storage, id: stored.length + 1, status: 'work' });
      return success({ id: stored.length });
    }
    if (req.url === '/api/admin/storage/update') {
      const storage = JSON.parse(body);
      const index = stored.findIndex((item) => item.id === storage.id);
      stored[index] = { ...storage, status: 'work' };
      return success(null);
    }
    throw new Error('Unexpected endpoint');
  });
  await engine.saveCredentials({ side: 'quark', cookie: 'COOKIE-VALUE' });
  await engine.saveCredentials({ side: 'pan115', accessToken: 'ACCESS-VALUE', refreshToken: 'REFRESH-VALUE' });
  const accounts = await engine.getAccounts();
  assert.equal(accounts.quark.mount, '/夸克');
  assert.equal(accounts.pan115.mount, '/115');
  assert.equal(accounts.quark.connected, true);
  assert.equal(stored[0].driver, 'Quark');
  assert.equal(stored[1].driver, '115 Open');
  assert.equal(JSON.parse(stored[0].addition).root_folder_id, '0');
  assert.equal(JSON.parse(stored[1].addition).refresh_token, 'REFRESH-VALUE');
  assert.equal(JSON.parse(stored[1].addition).page_size, 1150, '115 should use the largest supported page to minimize remote requests');
  assert.doesNotMatch(JSON.stringify(accounts), /COOKIE-VALUE|ACCESS-VALUE|REFRESH-VALUE/);
  await engine.saveCredentials({ side: 'quark', cookie: 'NEW-COOKIE' });
  assert.equal(stored.length, 2);
  assert.equal(JSON.parse(stored[0].addition).cookie, 'NEW-COOKIE');
});

test('startup migration updates an existing legacy 115 ID without changing credentials or other properties', async (t) => {
  let stored = [{
    id: 7, mount_path: '/115', driver: '115 Open', status: 'work', disabled: false,
    addition: JSON.stringify({ root_folder_id: '0', access_token: 'ACCESS-VALUE', refresh_token: 'REFRESH-VALUE', limit_rate: 1, page_size: 200 }),
  }];
  let updates = 0;
  const { engine } = await mockEngine(t, (req, body) => {
    if (req.url.startsWith('/api/admin/storage/list')) return success({ content: stored, total: stored.length });
    assert.equal(req.url, '/api/admin/storage/update');
    updates++;
    assert.equal(JSON.parse(body).id, 7);
    assert.equal(JSON.parse(body).disabled, false);
    stored = [{ ...JSON.parse(body), status: 'work' }];
    return success(null);
  });
  const accounts = await engine.getAccounts();
  assert.equal(updates, 0, 'Account discovery must only read existing state');
  assert.equal(JSON.parse(stored[0].addition).page_size, 200);
  await engine._upgrade115ListPage(await engine._listStorages());
  const addition = JSON.parse(stored[0].addition);
  assert.equal(accounts.pan115.connected, true);
  assert.equal(addition.page_size, 1150);
  assert.equal(addition.limit_rate, 1);
  assert.equal(addition.access_token, 'ACCESS-VALUE');
  assert.equal(addition.refresh_token, 'REFRESH-VALUE');
  await engine._upgrade115ListPage(await engine._listStorages());
  assert.equal(updates, 1, 'Already migrated storage should not reinitialize');
});

test('a delayed account status response cannot recreate credentials after logout', async (t) => {
  let stored = [{ id: 7, mount_path: '/115', driver: '115 Open', status: 'work',
    addition: JSON.stringify({ access_token: 'fixture-only-token', page_size: 200 }) }];
  let releaseSnapshot, snapshotStarted;
  const captured = new Promise(resolve => { snapshotStarted = resolve; });
  const delayed = new Promise(resolve => { releaseSnapshot = resolve; });
  let first = true;
  const writes = [];
  const { engine } = await mockEngine(t, async (req, body) => {
    if (req.url.startsWith('/api/admin/storage/list')) {
      const content = structuredClone(stored);
      if (first) { first = false; snapshotStarted(); await delayed; }
      return success({ content, total: content.length });
    }
    writes.push(req.url);
    if (req.url === '/api/admin/storage/delete?id=7') { stored = []; return success(null); }
    if (req.url === '/api/admin/storage/create') { stored.push({ ...JSON.parse(body), id: 8 }); return success({ id: 8 }); }
    throw new Error('Unexpected endpoint');
  });
  const pendingStatus = engine.getAccounts();
  await captured;
  try {
    await engine.removeAccount('pan115');
    assert.equal(stored.length, 0);
  } finally { releaseSnapshot(); }
  await pendingStatus;
  assert.deepEqual(stored, [], 'An older read must never recreate the removed account');
  assert.deepEqual(writes, ['/api/admin/storage/delete?id=7']);
});

test('listing returns every page and refreshes only the first request', async (t) => {
  let page = 0;
  const { engine } = await mockEngine(t, (req, body) => {
    const request = JSON.parse(body);
    assert.equal(request.page, ++page);
    assert.equal(request.refresh, page === 1);
    return success({ total: 2, content: [{ name: page === 1 ? 'folder' : 'file.txt', is_dir: page === 1, size: 1 }] });
  });
  const result = await engine.list({ path: '/夸克', refresh: true });
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].path, '/夸克/folder');
  assert.equal(result.entries[0].isDir, true);
});

test('interactive directory browsing returns one bounded page with continuation metadata', async (t) => {
  let calls = 0;
  const { engine } = await mockEngine(t, (req, body) => {
    calls += 1;
    assert.equal(req.url, '/api/fs/list');
    assert.deepEqual(JSON.parse(body), { path: '/115', password: '', refresh: true, page: 1, per_page: 200 });
    return success({ total: 3, content: [
      { name: '第一项', is_dir: true, size: 0 },
      { name: '第二项.txt', is_dir: false, size: 12 },
    ] });
  });
  const result = await engine.listPage({ path: '/115', refresh: true, page: 1, perPage: 200 });
  assert.equal(calls, 1, 'opening a directory must not read every remote page');
  assert.equal(result.entries.length, 2);
  assert.equal(result.total, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextPage, 2);
});

test('large cloud directories receive a dedicated three-minute listing budget', async () => {
  const engine = new Engine({ binaryPath: 'unused.exe', dataDir: '.', cacheDir: '.' });
  engine._request = async (_method, endpoint, _body, options) => {
    assert.equal(endpoint, '/fs/list');
    const timeout = options?.timeout ?? 30000;
    if (timeout < 180000) {
      const error = new Error('本机引擎请求超时。');
      error.code = 'TIMEOUT';
      throw error;
    }
    return { total: 1, content: [{ name: '大型目录', is_dir: true, size: 0 }] };
  };
  const result = await engine.list({ path: '/115', refresh: true });
  assert.equal(result.entries[0].name, '大型目录');
});

test('logout deletes only the selected exact account configuration and is idempotent', async (t) => {
  let storages = [
    { id: 1, mount_path: '/夸克', driver: 'Quark', status: 'work', addition: '{"cookie":"test-quark-cookie"}' },
    { id: 2, mount_path: '/115', driver: '115 Open', status: 'work', addition: '{"access_token":"test-115-token"}' },
    { id: 3, mount_path: '/_cache', driver: 'Local', status: 'work', addition: '{"root_folder_path":"test-cache"}' },
    { id: 4, mount_path: '/other-quark', driver: 'Quark', status: 'work', addition: '{"cookie":"test-other-cookie"}' },
  ];
  const others = structuredClone(storages.slice(1));
  const deleted = [];
  const { engine, directory } = await mockEngine(t, (req, body) => {
    if (req.url.startsWith('/api/admin/storage/list')) return success({ content: storages, total: storages.length });
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/admin/storage/delete?id=1');
    assert.equal(body.length, 0);
    deleted.push(1);
    storages = storages.filter((item) => item.id !== 1);
    return success(null);
  });
  const cachedFile = path.join(directory, 'retained-cache.bin');
  await fsp.writeFile(cachedFile, 'unfinished file cache');
  const accounts = await engine.removeAccount('quark');
  assert.equal(accounts.quark.connected, false);
  assert.equal(accounts.pan115.connected, true);
  assert.deepEqual(storages, others);
  assert.deepEqual(await engine.removeAccount('quark'), accounts);
  assert.deepEqual(deleted, [1]);
  assert.equal(await fsp.readFile(cachedFile, 'utf8'), 'unfinished file cache');
  assert.doesNotMatch(JSON.stringify(accounts), /test-quark-cookie|test-115-token|test-other-cookie/);
});

test('logout removes expired 115 configuration even when it is not connected', async (t) => {
  let storages = [{ id: 17, mount_path: '/115', driver: '115 Open', disabled: true, status: 'token expired' }];
  const { engine } = await mockEngine(t, (req) => {
    if (req.url.startsWith('/api/admin/storage/list')) return success({ content: storages, total: storages.length });
    assert.equal(req.url, '/api/admin/storage/delete?id=17');
    storages = [];
    return success(null);
  });
  assert.equal((await engine.getAccounts()).pan115.connected, false);
  assert.equal((await engine.removeAccount('pan115')).pan115.connected, false);
  assert.deepEqual(storages, []);
});

test('logout rejects a different driver at the account mount and invalid account names', async (t) => {
  let requests = 0;
  const { engine } = await mockEngine(t, (req) => {
    requests += 1;
    assert.ok(req.url.startsWith('/api/admin/storage/list'));
    return success({ content: [{ id: 4, mount_path: '/夸克', driver: 'Local' }], total: 1 });
  });
  await assert.rejects(engine.removeAccount('quark'), { code: 'MOUNT_CONFLICT' });
  for (const side of ['unknown', '__proto__', null, undefined]) {
    await assert.rejects(engine.removeAccount(side), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(requests, 1);
  engine.status = 'starting';
  await assert.rejects(engine.removeAccount('pan115'), { code: 'NOT_READY' });
  assert.equal(requests, 1);
});

test('logout does not report success for API errors or a configuration that remains', async (t) => {
  const storage = { id: 8, mount_path: '/115', driver: '115 Open', status: 'work' };
  let deleteAttempts = 0;
  const { engine } = await mockEngine(t, (req) => {
    if (req.url.startsWith('/api/admin/storage/list')) return success({ content: [storage], total: 1 });
    assert.equal(req.url, '/api/admin/storage/delete?id=8');
    deleteAttempts += 1;
    return deleteAttempts === 1 ? { code: 500, message: 'failed delete storage in database' } : success(null);
  });
  await assert.rejects(engine.removeAccount('pan115'), { code: 'API_ERROR' });
  assert.equal((await engine.getAccounts()).pan115.connected, true);
  await assert.rejects(engine.removeAccount('pan115'), { code: 'ACCOUNT_NOT_REMOVED' });
  assert.equal(deleteAttempts, 2);
});

test('logout refuses ambiguous or invalid storage identifiers without deleting anything', async (t) => {
  let storages = [{ id: '8&other=9', mount_path: '/115', driver: '115 Open' }];
  const { engine } = await mockEngine(t, (req) => {
    assert.ok(req.url.startsWith('/api/admin/storage/list'));
    return success({ content: storages, total: storages.length });
  });
  await assert.rejects(engine.removeAccount('pan115'), { code: 'INVALID_RESPONSE' });
  storages = [
    { id: 8, mount_path: '/115', driver: '115 Open' },
    { id: 9, mount_path: '/115', driver: '115 Open' },
  ];
  await assert.rejects(engine.removeAccount('pan115'), { code: 'INVALID_RESPONSE' });
});

test('task cancellation and retry send tid as a query parameter', async (t) => {
  const seen = [];
  const { engine } = await mockEngine(t, (req) => {
    seen.push(`${req.method} ${req.url}`);
    return success(null);
  });
  await engine.cancelCopyTask('copy-id');
  await engine.retryCopyTask('copy-id');
  await engine.cancelUploadTask('upload-id');
  await engine.retryUploadTask('upload-id');
  assert.deepEqual(seen, [
    'POST /api/task/copy/cancel?tid=copy-id', 'POST /api/task/copy/retry?tid=copy-id',
    'POST /api/task/upload/cancel?tid=upload-id', 'POST /api/task/upload/retry?tid=upload-id',
  ]);
});

test('private configuration disables external listeners, logs, and implicit task retries', async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-config-test-'));
  t.after(() => removeFixture(directory, 'openlist-config-test-'));
  const engine = new Engine({ binaryPath: path.join(directory, 'unused.exe'), dataDir: directory, cacheDir: path.join(directory, 'cache') });
  engine.port = 49152;
  engine.baseUrl = 'http://127.0.0.1:49152';
  await engine._writePrivateConfig();
  const config = JSON.parse(await fsp.readFile(engine.configPath));
  assert.equal(config.force, true);
  assert.equal(config.scheme.address, '127.0.0.1');
  assert.equal(config.scheme.https_port, -1);
  for (const service of ['s3', 'ftp', 'sftp', 'mcp']) assert.equal(config[service].enable, false);
  assert.equal(config.log.enable, false);
  assert.equal(config.tasks.copy.max_retry, 0);
  assert.equal(config.tasks.upload.task_persistant, false);
  assert.equal(config.temp_dir, path.join(directory, 'cache', '.openlist-temp'));
});

test('Windows watchdog closes its exact child when the owning Node process is killed', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-watchdog-'));
  const helperSource = `
    const { Engine } = require(process.env.TEST_ENGINE_MODULE);
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    (async () => {
      const engine = new Engine({ binaryPath: fs.realpathSync.native(process.execPath), dataDir: process.env.TEST_ENGINE_DIR, cacheDir: process.env.TEST_ENGINE_DIR });
      engine._childSpawnedAt = Date.now();
      // Even if the watchdog fails, this isolated child has a bounded lifetime.
      engine._child = spawn(engine.binaryPath, ['-e', 'setTimeout(() => {}, 30000)'], { windowsHide: true, shell: false, stdio: 'ignore' });
      try {
        const watchdogReady = engine._startWatchdog();
        engine._watchdog.once('exit', (code) => process.stderr.write('watchdog exit code: ' + code));
        await watchdogReady;
        process.send({ ready: true, childPid: engine._child.pid, watchdogPid: engine._watchdog.pid });
      } catch (error) { await engine._terminateChild(); process.send({ error: error.message }); process.exit(1); }
      setInterval(() => {}, 1000);
    })();
  `;
  const helper = spawn(process.execPath, ['-e', helperSource], {
    windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, TEST_ENGINE_MODULE: require.resolve('../src/engine'), TEST_ENGINE_DIR: directory },
  });
  let helperError = '';
  helper.stderr.on('data', (chunk) => { helperError += chunk.toString(); });
  t.after(async () => {
    if (helper.exitCode === null && helper.signalCode === null) helper.kill();
    await removeFixture(directory, 'openlist-watchdog-');
  });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Watchdog helper readiness timed out')), 20000);
    helper.once('error', (error) => { clearTimeout(timer); reject(error); });
    helper.once('message', (message) => { clearTimeout(timer); resolve(message); });
    helper.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Watchdog helper exited before ready (${code}): ${helperError}`)); });
  });
  assert.equal(result.ready, true, [result.error, helperError].filter(Boolean).join(' '));
  assert.ok(processExists(result.childPid));
  const helperExited = new Promise((resolve) => helper.once('exit', resolve));
  helper.kill('SIGKILL');
  await helperExited;
  await waitUntil(() => !processExists(result.childPid), 5000);
  await waitUntil(() => !processExists(result.watchdogPid), 5000);
});

const integrationBinary = process.env.OPENLIST_TEST_BINARY;
test('real v4.2.6 migrates legacy 115 only before startup readiness and tolerates migration failure', {
  skip: !integrationBinary || !fs.existsSync(integrationBinary), timeout: 120000,
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-migration-integration-'));
  const engine = new Engine({ binaryPath: integrationBinary, dataDir: path.join(directory, 'engine'), cacheDir: path.join(directory, 'cache') });
  t.after(async () => { await engine.stop(); await removeFixture(directory, 'openlist-migration-integration-'); });
  const migrate = engine._upgrade115ListPage.bind(engine);
  let attempts = 0, failMigration = false;
  engine._upgrade115ListPage = async storages => {
    assert.equal(engine.status, 'starting', 'Credential migration must finish before operations become available');
    attempts++;
    if (failMigration) throw new Error('fixture migration unavailable');
    return migrate(storages);
  };
  await engine.start();
  // First persist without driver.Init; a subsequent disabled update returns
  // before driver initialization in OpenList, keeping all credentials offline.
  await assert.rejects(engine._request('POST', '/admin/storage/create', {
    mount_path: '/115', driver: '115 Open', disabled: true, addition: '{',
  }), { code: 'API_ERROR' });
  const old = (await engine._listStorages()).find(item => item.mount_path === '/115');
  const addition = { root_folder_id: '0', access_token: 'fixture-only-access', refresh_token: 'fixture-only-refresh', limit_rate: 1, page_size: 200 };
  const { mount_details, ...saved } = old;
  await engine._request('POST', '/admin/storage/update', { ...saved, addition: JSON.stringify(addition) });
  await engine.stop(); await engine.start();
  assert.equal(engine.status, 'ready'); assert.equal(attempts, 2);
  const upgraded = (await engine._listStorages()).find(item => item.mount_path === '/115');
  assert.equal(upgraded.id, old.id); assert.equal(upgraded.disabled, true);
  assert.deepEqual(JSON.parse(upgraded.addition), { ...addition, page_size: 1150 });
  await engine.getAccounts(); await engine.getAccounts();
  assert.equal(attempts, 2, 'Status refreshes must not migrate or reinitialize drivers');
  await engine.stop(); failMigration = true; await engine.start();
  assert.equal(attempts, 3); assert.equal(engine.status, 'ready', 'Migration failure must not prevent account management');
  assert.equal((await engine.getAccounts()).pan115.connected, false);
});

test('real v4.2.6 cache cleanup preserves login records and history, then full reset reopens with fresh defaults', {
  skip: !integrationBinary || !fs.existsSync(integrationBinary), timeout: 180000,
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-maintenance-integration-'));
  const profileDir = path.join(directory, 'profile');
  const cacheDir = path.join(directory, 'custom-cache');
  const defaultCacheDir = path.join(profileDir, 'cache');
  const storePath = path.join(profileDir, 'tasks.json');
  const engine = new Engine({ binaryPath: integrationBinary, dataDir: path.join(profileDir, 'engine'), cacheDir });
  let freshEngine, queue;
  t.after(async () => {
    await queue?.stop();
    await engine.stop();
    await freshEngine?.stop();
    await removeFixture(directory, 'openlist-maintenance-integration-');
  });
  const store = new Store(storePath, { version: 1, cacheDir, jobs: [] });
  const jobId = randomUUID(), entryId = randomUUID();
  store.data.jobs.push({ id: jobId, cacheDir, status: 'completed', side: 'quark',
    sourceDir: '/夸克', targetDir: '/115', names: ['fixture.txt'], planned: true, directories: [],
    entries: [{ id: entryId, name: 'fixture.txt', size: 4, status: 'completed', sourcePath: '/夸克/fixture.txt', targetDir: '/115', finalName: 'fixture.txt' }] });
  queue = new Queue({ engine, store, cacheDir });
  await fsp.mkdir(engine.dataDir, { recursive: true });
  await fsp.writeFile(engine.configPath, JSON.stringify({ min_free_memory: -1 }));
  await engine.start();
  for (const [mount, driver, addition] of [
    ['/夸克', 'Quark', '{"cookie":"test-only-never-used"'],
    ['/115', '115 Open', '{"access_token":"test-only-never-used"'],
  ]) {
    // Malformed addition is persisted before parsing in v4.2.6 and prevents
    // driver.Init from making a network request; disabled prevents restart init.
    await assert.rejects(engine._request('POST', '/admin/storage/create', {
      mount_path: mount, driver, disabled: true, addition,
    }), { code: 'API_ERROR' });
  }
  // Match an already-opened profile: apply startup-only compatibility migration
  // before taking the preservation baseline for this separate cleanup test.
  await engine.stop(); await engine.start();
  const beforeMounts = (await engine._listStorages()).filter(item => item.mount_path !== '/_cache');
  assert.equal(beforeMounts.length, 2);
  const beforeHistory = JSON.parse(await fsp.readFile(storePath, 'utf8'));
  const knownCache = path.join(cacheDir, jobId, entryId, 'content.bin');
  await fsp.mkdir(path.dirname(knownCache), { recursive: true });
  await fsp.writeFile(knownCache, '1234');
  await fsp.mkdir(path.join(defaultCacheDir, '.openlist-temp'), { recursive: true });
  const tempCache = path.join(defaultCacheDir, '.openlist-temp', 'file-12345');
  await fsp.writeFile(tempCache, '123');
  const personal = path.join(cacheDir, 'keep-personal.txt');
  await fsp.writeFile(personal, 'unrelated user content');
  const calls = { quark: [], pan115: [] };
  const sessions = Object.fromEntries(Object.keys(calls).map(side => [side, {
    closeAllConnections: async () => calls[side].push('connections'),
    clearStorageData: async () => calls[side].push('storage'),
    clearCache: async () => calls[side].push('cache'),
    clearAuthCache: async () => calls[side].push('auth'),
    cookies: { flushStore: async () => calls[side].push('flush') },
  }]));
  const closed = [];
  const sessionFor = side => sessions[side], closeLogin = side => closed.push(side);
  const accounts = new AccountLifecycle({ engine, queue, sessionFor, closeLogin, confirmLogout: async () => true });
  const maintenance = new MaintenanceLifecycle({ profileDir,
    services: () => ({ engine, queue, store, accounts, starting: false }),
    sessionFor, closeLogin, confirm: async () => true,
  });

  const cleared = await maintenance.run('clear-cache');
  assert.equal(cleared.complete, true); assert.equal(cleared.files, 2); assert.equal(cleared.bytes, 7);
  assert.equal(engine.status, 'ready');
  assert.equal(fs.existsSync(knownCache), false); assert.equal(fs.existsSync(tempCache), false);
  assert.equal(await fsp.readFile(personal, 'utf8'), 'unrelated user content');
  assert.deepEqual((await engine._listStorages()).filter(item => item.mount_path !== '/_cache'), beforeMounts);
  assert.deepEqual(JSON.parse(await fsp.readFile(storePath, 'utf8')), beforeHistory);
  assert.equal(JSON.parse(await fsp.readFile(engine.configPath, 'utf8')).min_free_memory, -1);
  assert.deepEqual(calls, { quark: [], pan115: [] }); assert.deepEqual(closed, []);

  const reset = await maintenance.run('reset-app');
  assert.equal(reset.reset, true); assert.equal(reset.complete, true); assert.equal(engine.status, 'stopped');
  assert.equal(fs.existsSync(storePath), false);
  assert.equal(fs.existsSync(path.join(engine.dataDir, 'data.db')), false);
  assert.equal(fs.existsSync(engine.configPath), false);
  for (const side of ['quark', 'pan115']) assert.deepEqual(calls[side], ['connections', 'storage', 'cache', 'auth', 'flush']);
  assert.deepEqual(closed, ['quark', 'pan115']);
  await queue.stop();
  assert.equal(fs.existsSync(storePath), false, 'Retired queue must not restore deleted history on exit');
  const freshStore = new Store(storePath, { version: 1, cacheDir: defaultCacheDir, jobs: [] });
  assert.equal(freshStore.data.cacheDir, defaultCacheDir); assert.deepEqual(freshStore.data.jobs, []);
  freshEngine = new Engine({ binaryPath: integrationBinary, dataDir: engine.dataDir, cacheDir: freshStore.data.cacheDir });
  await freshEngine.start();
  const freshAccounts = await freshEngine.getAccounts();
  assert.equal(freshAccounts.quark.connected, false); assert.equal(freshAccounts.pan115.connected, false);
  assert.deepEqual((await freshEngine._listStorages()).map(item => item.mount_path), ['/_cache']);
  assert.equal(await fsp.readFile(personal, 'utf8'), 'unrelated user content');
  assert.ok(fs.existsSync(cacheDir), 'Selected custom cache root must be preserved');
});

test('real v4.2.6 logout persists after restart and preserves other mounts and cached files', {
  skip: !integrationBinary || !fs.existsSync(integrationBinary), timeout: 120000,
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-logout-integration-'));
  const cacheDir = path.join(directory, 'cache');
  const otherDir = path.join(directory, 'other');
  const engine = new Engine({ binaryPath: integrationBinary, dataDir: path.join(directory, 'data'), cacheDir });
  t.after(async () => {
    await engine.stop();
    await removeFixture(directory, 'openlist-logout-integration-');
  });
  await fsp.mkdir(otherDir);
  await fsp.writeFile(path.join(otherDir, 'keep.txt'), 'other storage file');
  await engine.start();
  await fsp.writeFile(path.join(cacheDir, 'unfinished.bin'), 'retained cache');
  await engine._upsertStorage({
    mount_path: '/other-local', driver: 'Local', disabled: false,
    addition: JSON.stringify({ root_folder_path: otherDir, show_hidden: true }),
  });
  for (const [mount, driver] of [['/夸克', 'Quark'], ['/115', '115 Open']]) {
    // v4.2.6 persists the storage before parsing addition. Malformed JSON
    // prevents driver.Init (and therefore all cloud requests) from running.
    // Disabled also prevents either fixture from loading on an engine restart.
    await assert.rejects(engine._request('POST', '/admin/storage/create', {
      mount_path: mount, driver, disabled: true, addition: '{',
    }), { code: 'API_ERROR' });
  }
  const before = await engine._listStorages();
  assert.ok(before.some((item) => item.mount_path === '/夸克' && item.driver === 'Quark'));
  assert.ok(before.some((item) => item.mount_path === '/115' && item.driver === '115 Open'));
  const protectedMounts = before.filter((item) => ['/_cache', '/other-local'].includes(item.mount_path));
  await engine.removeAccount('quark');
  const afterQuark = await engine._listStorages();
  assert.equal(afterQuark.some((item) => item.mount_path === '/夸克'), false);
  assert.ok(afterQuark.some((item) => item.mount_path === '/115'));
  assert.deepEqual(afterQuark.filter((item) => ['/_cache', '/other-local'].includes(item.mount_path)), protectedMounts);
  await engine.removeAccount('pan115');
  await engine.stop();
  await engine.start();
  const afterRestart = await engine._listStorages();
  assert.deepEqual(afterRestart.map((item) => item.mount_path).sort(), ['/_cache', '/other-local']);
  assert.equal((await engine.getAccounts()).quark.connected, false);
  assert.equal((await engine.getAccounts()).pan115.connected, false);
  await engine.removeAccount('quark');
  await engine.removeAccount('pan115');
  assert.equal(await fsp.readFile(path.join(cacheDir, 'unfinished.bin'), 'utf8'), 'retained cache');
  assert.equal(await fsp.readFile(path.join(otherDir, 'keep.txt'), 'utf8'), 'other storage file');
  assert.equal((await engine.list({ path: '/other-local', refresh: true })).entries[0].name, 'keep.txt');
});

test('real v4.2.6 starts privately, copies and uploads local bytes, rejects conflicts, and restarts', {
  skip: !integrationBinary || !fs.existsSync(integrationBinary), timeout: 180000,
}, async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'openlist-integration-'));
  const cacheDir = path.join(directory, 'cache');
  const destinationDir = path.join(directory, 'destination');
  await fsp.mkdir(cacheDir, { recursive: true });
  await fsp.mkdir(destinationDir);
  const engine = new Engine({ binaryPath: integrationBinary, dataDir: path.join(directory, 'data'), cacheDir });
  let queue;
  // Force actual disk-backed caching so cleanup is exercised even for small files.
  await fsp.mkdir(engine.dataDir, { recursive: true });
  await fsp.writeFile(engine.configPath, JSON.stringify({ min_free_memory: -1 }));
  const statuses = [];
  engine.on('status', (status) => statuses.push(status));
  t.after(async () => {
    if (queue) await queue.stop();
    await engine.stop();
    await removeFixture(directory, 'openlist-integration-');
  });
  await engine.start();
  assert.equal(engine.status, 'ready');
  await engine._upsertStorage({
    mount_path: '/local-destination', driver: 'Local', disabled: false, enable_sign: true,
    addition: JSON.stringify({ root_folder_path: destinationDir, thumbnail: false, show_hidden: true }),
  });
  const sourceBytes = Buffer.from('round-trip 中文 ' + 'x'.repeat(65536));
  const localPath = path.join(cacheDir, 'source.txt');
  await fsp.writeFile(localPath, sourceBytes);
  const entries = await engine.list({ path: '/_cache', refresh: true });
  assert.ok(entries.entries.some((entry) => entry.name === 'source.txt'));
  const file = await engine.getFile('/_cache/source.txt');
  assert.ok(file.raw_url.startsWith(engine.baseUrl + '/p/'));
  const downloaded = await fetch(file.raw_url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), sourceBytes);
  async function waitForTask(type, id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const status = type === 'copy' ? await engine.getCopyTask(id) : await engine.getUploadTask(id);
      if (status.state !== 'running') { assert.equal(status.state, 'success', status.error); return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('Local task timed out');
  }
  const copyId = await engine.copyFile({ srcDir: '/_cache', dstDir: '/local-destination', name: 'source.txt' });
  await waitForTask('copy', copyId);
  assert.deepEqual(await fsp.readFile(path.join(destinationDir, 'source.txt')), sourceBytes);
  await assert.rejects(engine.copyFile({ srcDir: '/_cache', dstDir: '/local-destination', name: 'source.txt' }), { code: 'CONFLICT' });
  const uploadId = await engine.uploadFile({ localPath, targetPath: '/local-destination/重命名.txt', size: sourceBytes.length });
  await waitForTask('upload', uploadId);
  assert.deepEqual(await fsp.readFile(path.join(destinationDir, '重命名.txt')), sourceBytes);
  await assert.rejects(engine.uploadFile({ localPath, targetPath: '/local-destination/重命名.txt' }), { code: 'CONFLICT' });
  const emptyPath = path.join(cacheDir, 'empty.bin');
  await fsp.writeFile(emptyPath, Buffer.alloc(0));
  const emptyId = await engine.uploadFile({ localPath: emptyPath, targetPath: '/local-destination/空文件.txt', size: 0 });
  await waitForTask('upload', emptyId);
  assert.equal((await fsp.stat(path.join(destinationDir, '空文件.txt'))).size, 0);
  await assert.rejects(engine.getUploadTask('missing-task-for-test'), { code: 'NOT_FOUND' });
  // Successful tasks must release their secondary OpenList cache copies.
  const tempFiles = await fsp.readdir(path.join(cacheDir, '.openlist-temp'), { recursive: true });
  assert.equal(tempFiles.length, 0, `Unexpected retained engine cache: ${tempFiles.join(', ')}`);
  await engine.stop();
  await engine.start();
  assert.equal((await engine.list({ path: '/local-destination', refresh: true })).entries.length, 3);
  assert.doesNotMatch(JSON.stringify(statuses), /Admin token|password|sign=/i);

  // These mounts emulate both sides with isolated local folders. This exercises
  // the real queue/proxy/PUT/task pipeline without contacting cloud accounts.
  const quarkDir = path.join(directory, 'fake-quark');
  const pan115Dir = path.join(directory, 'fake-115');
  await fsp.mkdir(path.join(quarkDir, '相册', '空文件夹'), { recursive: true });
  await fsp.mkdir(path.join(pan115Dir, '相册'), { recursive: true });
  for (const [mount, root] of [['/夸克', quarkDir], ['/115', pan115Dir]]) {
    await engine._upsertStorage({ mount_path: mount, driver: 'Local', disabled: false, enable_sign: true, web_proxy: true,
      addition: JSON.stringify({ root_folder_path: root, thumbnail: false, show_hidden: true }) });
  }
  await fsp.writeFile(path.join(quarkDir, '相册', '报告.txt'), sourceBytes);
  await fsp.writeFile(path.join(quarkDir, '相册', '空文件.txt'), Buffer.alloc(0));
  await fsp.writeFile(path.join(pan115Dir, '相册', '报告.txt'), 'existing destination');
  const store = new Store(path.join(directory, 'tasks.json'), { jobs: [] });
  queue = new Queue({ engine, store, cacheDir, pollMs: 20 });
  const forward = await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['相册'], targetDir: '/115' });
  await waitUntil(() => ['completed', 'failed'].includes(queue.jobs.find((job) => job.id === forward.id).status));
  const forwardJob = queue.jobs.find((job) => job.id === forward.id);
  assert.equal(forwardJob.status, 'completed', JSON.stringify(queue.summaries()));
  assert.equal(await fsp.readFile(path.join(pan115Dir, '相册', '报告.txt'), 'utf8'), 'existing destination');
  assert.deepEqual(await fsp.readFile(path.join(pan115Dir, '相册', '报告 (2).txt')), sourceBytes);
  assert.deepEqual(await fsp.readFile(path.join(quarkDir, '相册', '报告.txt')), sourceBytes);
  assert.equal((await fsp.stat(path.join(pan115Dir, '相册', '空文件.txt'))).size, 0);
  assert.ok((await fsp.stat(path.join(pan115Dir, '相册', '空文件夹'))).isDirectory());
  assert.equal(fs.existsSync(path.join(cacheDir, forward.id)), false);
  const reverse = await queue.add({ side: 'pan115', sourceDir: '/115/相册', names: ['报告.txt'], targetDir: '/夸克/相册' });
  await waitUntil(() => ['completed', 'failed'].includes(queue.jobs.find((job) => job.id === reverse.id).status));
  assert.equal(queue.jobs.find((job) => job.id === reverse.id).status, 'completed', JSON.stringify(queue.summaries()));
  assert.equal(await fsp.readFile(path.join(quarkDir, '相册', '报告 (2).txt'), 'utf8'), 'existing destination');
  assert.deepEqual(await fsp.readFile(path.join(quarkDir, '相册', '报告.txt')), sourceBytes);
  assert.equal(fs.existsSync(path.join(cacheDir, reverse.id)), false);
  assert.equal((await fsp.readdir(path.join(cacheDir, '.openlist-temp'), { recursive: true })).length, 0);
  const stoppedPids = [engine._child.pid, engine._watchdog?.pid].filter(Boolean);
  await queue.stop();
  await engine.stop();
  for (const pid of stoppedPids) assert.equal(processExists(pid), false, 'Owned engine and watchdog processes must exit on stop');
});
