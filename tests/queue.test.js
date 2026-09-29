'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Queue } = require('../src/queue');
const { Store } = require('../src/store');
const { availableName, within, localWithin, redact } = require('../src/paths');

class FakeEngine {
  constructor() {
    this.baseUrl = 'http://127.0.0.1:1'; this.dirs = new Map([['/夸克', []], ['/115', []]]); this.files = new Map(); this.tasks = new Map(); this.uploads = []; this.nextTask = 0;
  }
  addDir(dir) { if (!this.dirs.has(dir)) { this.dirs.set(dir, []); this.dirs.get(path.posix.dirname(dir))?.push({ name: path.posix.basename(dir), is_dir: true, size: 0 }); } }
  addFile(file, value) { const content = Buffer.from(value); this.files.set(file, content); const list = this.dirs.get(path.posix.dirname(file)); list.push({ name: path.posix.basename(file), is_dir: false, size: content.length }); }
  async list({ path: dir }) { if (!this.dirs.has(dir)) throw new Error('目录不存在：' + dir); return { path: dir, entries: structuredClone(this.dirs.get(dir)) }; }
  async mkdir(dir) { this.addDir(dir); }
  async getFile(file) { return { size: this.files.get(file).length, raw_url: 'http://127.0.0.1:1/' + encodeURIComponent(file) }; }
  async uploadFile({ localPath, targetPath }) {
    if (this.files.has(targetPath)) throw Object.assign(new Error('exists'), { code: 'CONFLICT' });
    const data = await fs.readFile(localPath), id = 'task-' + ++this.nextTask;
    this.uploads.push(targetPath); this.addFile(targetPath, data); this.tasks.set(id, { state: 'success', progress: 100 }); return id;
  }
  async getUploadTask(id) { if (!this.tasks.has(id)) throw Object.assign(new Error('task not found'), { code: 'NOT_FOUND' }); return this.tasks.get(id); }
  async cancelUploadTask(id) { this.tasks.set(id, { state: 'cancelled', progress: 0 }); }
}
async function fixture(t, jobs = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-queue-'));
  t.after(() => { assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(dir).startsWith('openlist-queue-')); return fs.rm(dir, { recursive: true, force: true }); });
  const engine = new FakeEngine();
  const store = new Store(path.join(dir, 'tasks.json'), { jobs });
  const downloads = [];
  const downloader = async ({ url, file, onProgress }) => { const remote = decodeURIComponent(new URL(url).pathname.slice(1)); const data = engine.files.get(remote); downloads.push(remote); await fs.writeFile(file, data); onProgress(data.length); };
  const queue = new Queue({ engine, store, cacheDir: dir, downloader, pollMs: 5 });
  return { dir, engine, queue, store, downloads };
}
async function waitFor(predicate, message = '等待任务完成') {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 5)); }
}

test('copies a recursive tree, merges existing folders, preserves conflicts and checks bytes', async t => {
  const { engine, queue, dir } = await fixture(t);
  engine.addDir('/夸克/照片'); engine.addDir('/夸克/照片/空目录'); engine.addDir('/夸克/照片/子目录');
  engine.addFile('/夸克/照片/a.txt', 'new bytes'); engine.addFile('/夸克/照片/子目录/zero', '');
  engine.addDir('/115/照片'); engine.addFile('/115/照片/a.txt', 'original');
  await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['照片'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.equal(engine.files.get('/115/照片/a.txt').toString(), 'original');
  assert.equal(engine.files.get('/115/照片/a (2).txt').toString(), 'new bytes');
  assert.equal(engine.files.get('/115/照片/子目录/zero').length, 0);
  assert.ok(engine.dirs.has('/115/照片/空目录'));
  assert.equal(queue.summaries()[0].doneFiles, 2);
  assert.ok(!((await fs.readdir(dir)).includes(queue.jobs[0].id)), 'completed temporary files are removed');
  assert.equal(engine.files.get('/夸克/照片/a.txt').toString(), 'new bytes', 'source remains intact');
});

test('plans and verifies a selected empty folder', async t => {
  const { engine, queue } = await fixture(t); engine.addDir('/夸克/空文件夹');
  await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['空文件夹'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.ok(engine.dirs.has('/115/空文件夹')); assert.equal(queue.summaries()[0].totalFiles, 0);
});

test('reverse transfers use the same non-destructive pipeline', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/115/test:1.txt', 'reverse');
  await queue.add({ side: 'pan115', sourceDir: '/115', names: ['test:1.txt'], targetDir: '/夸克' });
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.equal(engine.files.get('/夸克/test:1.txt').toString(), 'reverse');
});

test('a target size mismatch never reports success, and retry can transfer again', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/夸克/a', 'test');
  const original = engine.uploadFile.bind(engine); let corrupt = true;
  engine.uploadFile = async input => { const id = await original(input); if (corrupt) engine.dirs.get('/115').find(e => e.name === path.posix.basename(input.targetPath)).size = 99; return id; };
  await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'failed');
  assert.equal(queue.summaries()[0].doneFiles, 0); assert.equal(queue.jobs[0].entries[0].taskId, null);
  corrupt = false; await queue.retry(queue.jobs[0].id);
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.equal(engine.files.get('/115/a (2)').toString(), 'test');
});

test('a transient upload API conflict chooses a new name without overwriting', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/夸克/a.txt', 'ours');
  const original = engine.uploadFile.bind(engine); let first = true;
  engine.uploadFile = async input => { if (first) { first = false; engine.addFile('/115/a.txt', 'external'); throw Object.assign(new Error('exists'), { code: 'CONFLICT' }); } return original(input); };
  await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a.txt'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.equal(engine.files.get('/115/a.txt').toString(), 'external'); assert.equal(engine.files.get('/115/a (2).txt').toString(), 'ours');
});

test('resume reconciles a lost engine task against its saved exact target', async t => {
  const { dir, engine, store, downloads } = await fixture(t);
  engine.addFile('/夸克/a', 'saved'); engine.addFile('/115/a (2)', 'saved');
  store.data.jobs = [{ id: 'job', sourceDir: '/夸克', targetDir: '/115', names: ['a'], side: 'quark', status: 'running', planned: true, directories: [], cacheDir: dir,
    entries: [{ id: 'file', sourcePath: '/夸克/a', targetDir: '/115', targetPath: '/115/a (2)', name: 'a', finalName: 'a (2)', size: 5, status: 'uploading', taskId: 'lost' }] }];
  const queue = new Queue({ engine, store, cacheDir: dir });
  assert.equal(queue.paused, true); await queue.resume();
  await waitFor(() => queue.jobs[0].status === 'completed');
  assert.equal(engine.uploads.length, 0); assert.equal(downloads.length, 0);
});

test('resume can re-upload when both old task and recorded destination are absent', async t => {
  const { dir, engine, store } = await fixture(t); engine.addFile('/夸克/a', 'saved');
  store.data.jobs = [{ id: 'job', sourceDir: '/夸克', targetDir: '/115', names: ['a'], side: 'quark', status: 'running', planned: true, directories: [], cacheDir: dir,
    entries: [{ id: 'file', sourcePath: '/夸克/a', targetDir: '/115', targetPath: '/115/a', name: 'a', finalName: 'a', size: 5, status: 'uploading', taskId: 'lost' }] }];
  const cache = path.join(dir, 'job', 'file'); await fs.mkdir(cache, { recursive: true }); await fs.writeFile(path.join(cache, 'content.bin'), 'saved');
  const queue = new Queue({ engine, store, cacheDir: dir }); await queue.resume();
  await waitFor(() => queue.jobs[0].status === 'completed'); assert.equal(engine.uploads.length, 1);
});

test('pause during local download prevents submission and reuses complete cache on resume', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/夸克/a', 'abc');
  const downloader = queue.downloader; queue.downloader = async args => { await downloader(args); queue.pause(); };
  await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'paused'); assert.equal(engine.uploads.length, 0);
  queue.downloader = async () => { throw new Error('complete cache should be reused'); };
  await queue.resume(); await waitFor(() => queue.jobs[0].status === 'completed');
});

test('invalid paths are rejected before any remote task starts', async t => {
  const { queue } = await fixture(t);
  await assert.rejects(queue.add({ side: 'quark', sourceDir: '/夸克/../_cache', names: ['a'], targetDir: '/115' }));
  await assert.rejects(queue.add({ side: 'quark', sourceDir: '/夸克', names: ['../a'], targetDir: '/115' }));
  await assert.rejects(queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/_cache' }));
  assert.equal(queue.jobs.length, 0);
});

test('cancel while waiting for source metadata does not start a download', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/夸克/a', 'test');
  let release, entered = false;
  const original = engine.getFile.bind(engine);
  engine.getFile = async p => { entered = true; await new Promise(resolve => { release = resolve; }); return original(p); };
  let downloads = 0; queue.downloader = async () => { downloads++; };
  const { id } = await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/115' });
  await waitFor(() => entered); await queue.cancel(id); release();
  await waitFor(() => queue.jobs[0].status === 'cancelled');
  assert.equal(downloads, 0); assert.equal(engine.uploads.length, 0);
});

test('cancel while target listing is pending does not submit an upload', async t => {
  const { engine, queue } = await fixture(t); engine.addFile('/夸克/a', 'test');
  let release, entered = false; const original = engine.list.bind(engine);
  engine.list = async input => { if (input.path === '/115') { entered = true; await new Promise(resolve => { release = resolve; }); } return original(input); };
  const { id } = await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/115' });
  await waitFor(() => entered); await queue.cancel(id); release();
  await waitFor(() => queue.jobs[0].status === 'cancelled'); assert.equal(engine.uploads.length, 0);
});

test('cancel and immediate retry during scanning cannot mix two directory plans', async t => {
  const { engine, queue } = await fixture(t); queue.pause();
  engine.addDir('/夸克/目录'); engine.addFile('/夸克/目录/a', 'abc');
  const releases = []; const original = engine.list.bind(engine);
  engine.list = async input => { if (input.path === '/夸克/目录') await new Promise(resolve => releases.push(resolve)); return original(input); };
  const { id } = await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['目录'], targetDir: '/115' });
  await waitFor(() => releases.length === 1); await queue.cancel(id);
  const retry = queue.retry(id); await waitFor(() => releases.length === 2);
  releases[0](); releases[1](); await retry;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.jobs[0].status, 'paused'); assert.equal(queue.jobs[0].entries.length, 1);
  await queue.resume(); await waitFor(() => queue.jobs[0].status === 'completed'); assert.equal(engine.uploads.length, 1);
});

test('names, cache containment and error redaction protect boundary cases', () => {
  assert.equal(availableName('a.tar.gz', ['a.tar.gz', 'a.tar (2).gz']), 'a.tar (3).gz');
  assert.equal(availableName('A.txt', ['a.txt']), 'A (2).txt');
  assert.throws(() => within('/115extra', '/115'));
  assert.throws(() => localWithin('C:\\cache', '..', 'escape'));
  assert.ok(!redact('error https://host/p?sign=secret Cookie: private').includes('secret'));
  assert.ok(!redact('Cookie: private').includes('private'));
});

test('corrupt persistent records are preserved and never silently overwritten', async t => {
  const { dir } = await fixture(t); const file = path.join(dir, 'broken.json'); await fs.writeFile(file, 'not json');
  assert.throws(() => new Store(file, { jobs: [] }), /无法读取/); assert.equal(await fs.readFile(file, 'utf8'), 'not json');
});

test('logging out preserves history but prevents cancelled tasks from retrying under a new account', async t => {
  const { engine, queue, store, dir } = await fixture(t);
  engine.addFile('/夸克/a', 'old account');
  queue.pause();
  const { id } = await queue.add({ side: 'quark', sourceDir: '/夸克', names: ['a'], targetDir: '/115' });
  await waitFor(() => queue.jobs[0].status === 'paused');
  assert.throws(() => queue.invalidateCancelledTasks('quark'), /完成或取消/);
  await queue.cancel(id);
  queue.jobs.push({ id: 'completed-history', status: 'completed', entries: [], directories: [] });
  queue.invalidateCancelledTasks('pan115');
  assert.equal(queue.jobs.length, 2);
  assert.equal(queue.jobs[1].retryBlockedReason, undefined);
  assert.match(queue.summaries()[0].retryBlockedReason, /账号已退出/);
  await assert.rejects(queue.retry(id), /不能重试旧任务/);
  const restored = new Queue({ engine, store: new Store(store.file, { jobs: [] }), cacheDir: dir });
  await assert.rejects(restored.retry(id), /不能重试旧任务/);
  assert.equal(engine.uploads.length, 0);
  assert.equal(engine.files.get('/夸克/a').toString(), 'old account');
});

test('cancelled status still blocks logout while a recovered upload is being stopped', async t => {
  const { engine, queue, dir } = await fixture(t);
  queue.jobs.push({ id: 'recovering', status: 'paused', sourceDir: '/夸克', targetDir: '/115', cacheDir: dir,
    entries: [{ id: 'file', taskId: 'old-upload', status: 'uploading', size: 5 }], directories: [] });
  let finishCancel;
  engine.cancelUploadTask = () => new Promise(resolve => { finishCancel = resolve; });
  const cancelling = queue.cancel('recovering');
  assert.equal(queue.jobs[0].status, 'cancelled');
  assert.equal(queue.running, false);
  assert.equal(queue.hasUnfinished(), true, 'cancellation cleanup must be included in the account guard');
  await assert.rejects(queue.retry('recovering'), /处理或取消中/);
  assert.throws(() => queue.invalidateCancelledTasks('quark'), /完成或取消/);
  finishCancel(); await cancelling;
  assert.equal(queue.hasUnfinished(), false);
  assert.doesNotThrow(() => queue.invalidateCancelledTasks('quark'));
});

test('failed upload cancellation retains the task and blocks logout until cancellation succeeds', async t => {
  const { engine, queue, dir } = await fixture(t);
  queue.jobs.push({ id: 'recovering', status: 'paused', sourceDir: '/夸克', targetDir: '/115', cacheDir: dir,
    entries: [{ id: 'file', taskId: 'old-upload', status: 'uploading', size: 5 }], directories: [] });
  engine.cancelUploadTask = async () => { throw new Error('cancellation unavailable'); };
  await assert.rejects(queue.cancel('recovering'), /cancellation unavailable/);
  assert.equal(queue.jobs[0].status, 'failed');
  assert.equal(queue.jobs[0].entries[0].taskId, 'old-upload');
  assert.equal(queue.hasUnfinished(), true);
  assert.throws(() => queue.invalidateCancelledTasks('pan115'), /完成或取消/);
  engine.cancelUploadTask = async () => {};
  await queue.cancel('recovering');
  assert.equal(queue.jobs[0].entries[0].taskId, null);
  assert.equal(queue.hasUnfinished(), false);
});
