'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { clearManagedCache, resetLocalConfiguration } = require('../src/local-maintenance');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openlist-maintenance-test-'));
  t.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('openlist-maintenance-test-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return root;
}
async function write(root, relative, data = 'cache') {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return file;
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function job(cacheDir) { return { id: randomUUID(), cacheDir, entries: [{ id: randomUUID() }] }; }
function cacheFile(record, filename = 'content.bin') { return path.join(record.id, record.entries[0].id, filename); }

test('cleans recorded transfer files and engine temp files, preserving unrelated files and cache roots', async t => {
  const root = await fixture(t), record = job(root);
  await write(root, cacheFile(record), '1234');
  await write(root, cacheFile(record, 'content.bin.part'), '12');
  await write(root, '.openlist-temp/file-4294967295', 'abc');
  const personal = await write(root, 'vacation/photo.jpg', 'private photo');
  const unknownTemp = await write(root, '.openlist-temp/my-notes.txt', 'notes');
  const output = await clearManagedCache([root], [record]);
  assert.equal(output.complete, true);
  assert.equal(output.files, 3); assert.equal(output.bytes, 9); assert.equal(output.directories, 2);
  assert.equal(output.retained, 2);
  assert.equal(await exists(path.join(root, record.id)), false);
  assert.equal(await fs.readFile(personal, 'utf8'), 'private photo');
  assert.equal(await fs.readFile(unknownTemp, 'utf8'), 'notes');
  assert.equal(await exists(root), true);
  assert.equal(await exists(path.join(root, '.openlist-temp')), true);
});

test('cleans all recorded historical roots once and leaves the caller job records intact', async t => {
  const parent = await fixture(t), a = path.join(parent, 'old-cache'), b = path.join(parent, 'new-cache');
  const jobs = [job(a), job(b)];
  for (const record of jobs) await write(record.cacheDir, cacheFile(record), '123');
  const saved = structuredClone(jobs);
  const output = await clearManagedCache([b, b, path.join(parent, 'absent')], jobs);
  assert.equal(output.complete, true); assert.equal(output.files, 2); assert.equal(output.bytes, 6);
  assert.deepEqual(jobs, saved);
});

test('unknown UUID trees and mixed job trees are retained in their entirety', async t => {
  const root = await fixture(t), known = job(root), unknown = job(root);
  const knownCache = await write(root, cacheFile(known));
  const ownFile = await write(root, path.join(known.id, known.entries[0].id, 'document.txt'));
  const unknownCache = await write(root, cacheFile(unknown));
  const output = await clearManagedCache([root], [known]);
  assert.equal(output.complete, true); assert.equal(output.files, 0); assert.equal(output.retained, 2);
  for (const file of [knownCache, ownFile, unknownCache]) assert.equal(await exists(file), true);
});

test('a junction at the cache root is rejected without touching its target', async t => {
  const parent = await fixture(t), target = path.join(parent, 'real'), link = path.join(parent, 'link');
  const record = job(link);
  const file = await write(target, cacheFile(record));
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const output = await clearManagedCache([link], [record]);
  assert.equal(output.complete, false); assert.equal(output.files, 0);
  assert.equal(output.errors[0].code, 'UNSAFE_PATH'); assert.equal(await exists(file), true);
});

test('a junction above the cache root is rejected without following it', async t => {
  const parent = await fixture(t), target = path.join(parent, 'real'), link = path.join(parent, 'parent-link');
  const record = job(path.join(link, 'cache'));
  const file = await write(path.join(target, 'cache'), cacheFile(record));
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const output = await clearManagedCache([record.cacheDir], [record]);
  assert.equal(output.complete, false); assert.equal(output.files, 0); assert.equal(await exists(file), true);
});

test('a junction inside a known job directory is rejected before any files in that job are deleted', async t => {
  const parent = await fixture(t), root = path.join(parent, 'cache'), target = path.join(parent, 'personal');
  const record = job(root); record.entries.push({ id: randomUUID() });
  const cached = await write(root, cacheFile(record));
  const personal = await write(target, 'content.bin', 'do not delete');
  await fs.symlink(target, path.join(root, record.id, record.entries[1].id), process.platform === 'win32' ? 'junction' : 'dir');
  const output = await clearManagedCache([root], [record]);
  assert.equal(output.complete, false); assert.equal(output.files, 0);
  assert.equal(await exists(cached), true); assert.equal(await fs.readFile(personal, 'utf8'), 'do not delete');
});

test('an engine temp filename that is a directory is retained and reported', async t => {
  const root = await fixture(t);
  const personal = await write(root, '.openlist-temp/file-42/content.bin');
  const output = await clearManagedCache([root], []);
  assert.equal(output.complete, false); assert.equal(output.files, 0); assert.equal(await exists(personal), true);
});

test('partial deletion failures return accurate bytes, files and errors', async t => {
  const root = await fixture(t), record = job(root);
  const blocked = await write(root, cacheFile(record), 'blocked');
  const removable = await write(root, cacheFile(record, 'content.bin.part'), '123');
  const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => {
    if (file === blocked) throw Object.assign(new Error('fixture file is locked'), { code: 'EBUSY' });
    return unlink(file);
  });
  const output = await clearManagedCache([root], [record]);
  assert.equal(output.complete, false); assert.equal(output.files, 1); assert.equal(output.bytes, 3);
  assert.ok(output.errors.some(error => error.path === blocked && error.code === 'EBUSY'));
  assert.equal(await exists(blocked), true); assert.equal(await exists(removable), false);
});

test('reset removes exact local state only, leaving personal files and session storage to its caller', async t => {
  const root = await fixture(t);
  const names = ['tasks.json', 'tasks.json.writing', 'engine/config.json', 'engine/config.json.tmp',
    'engine/data.db', 'engine/data.db-wal', 'engine/data.db-shm', 'engine/data.db-journal', 'logs/events.log'];
  for (const name of names) await write(root, name, '123');
  const preserved = ['my-file.txt', 'settings.json', 'engine/backup.db', 'engine/bleve/custom.txt', 'tasks.json.backup', 'logs/my-log.txt', 'Partitions/login/Cookies'];
  for (const name of preserved) await write(root, name);
  const output = await resetLocalConfiguration(root);
  assert.equal(output.complete, true); assert.equal(output.files, names.length); assert.equal(output.bytes, names.length * 3);
  for (const name of names) assert.equal(await exists(path.join(root, name)), false, name);
  for (const name of preserved) assert.equal(await exists(path.join(root, name)), true, name);
});

test('reset preflights symlinked engine paths before deleting any application state', async t => {
  const parent = await fixture(t), root = path.join(parent, 'profile'), outside = path.join(parent, 'external');
  const tasks = await write(root, 'tasks.json');
  const data = await write(outside, 'data.db', 'external');
  await fs.symlink(outside, path.join(root, 'engine'), process.platform === 'win32' ? 'junction' : 'dir');
  const output = await resetLocalConfiguration(root);
  assert.equal(output.complete, false); assert.equal(output.files, 0);
  assert.equal(await exists(tasks), true); assert.equal(await fs.readFile(data, 'utf8'), 'external');
});

test('reset deletion failures are reported as incomplete rather than successful', async t => {
  const root = await fixture(t), data = await write(root, 'engine/data.db', 'db'), tasks = await write(root, 'tasks.json', 'task');
  const unlink = fs.unlink;
  t.mock.method(fs, 'unlink', async file => {
    if (file === data) throw Object.assign(new Error('fixture database is locked'), { code: 'EBUSY' });
    return unlink(file);
  });
  const output = await resetLocalConfiguration(root);
  assert.equal(output.complete, false); assert.equal(output.files, 0); assert.equal(output.bytes, 0);
  assert.equal(await exists(tasks), true); assert.equal(await exists(data), true);
  assert.equal(output.errors[0].code, 'EBUSY');
});
