'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { Engine } = require('../src/engine');
const { Queue } = require('../src/queue');
const { Store } = require('../src/store');

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
  assert.doesNotMatch(JSON.stringify(accounts), /COOKIE-VALUE|ACCESS-VALUE|REFRESH-VALUE/);
  await engine.saveCredentials({ side: 'quark', cookie: 'NEW-COOKIE' });
  assert.equal(stored.length, 2);
  assert.equal(JSON.parse(stored[0].addition).cookie, 'NEW-COOKIE');
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
