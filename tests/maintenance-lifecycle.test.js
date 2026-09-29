'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { MaintenanceLifecycle } = require('../src/maintenance-lifecycle');
const { AccountLifecycle } = require('../src/account-lifecycle');

function fixture() {
  const events = [], profileDir = path.resolve('tmp/maintenance-fixture');
  const store = { data: { cacheDir: path.join(profileDir, 'custom'), jobs: [{ id: 'history', cacheDir: path.join(profileDir, 'old') }] } };
  const queue = { running: false, unfinished: false, hasUnfinished() { return this.unfinished; }, retire() { events.push('retire'); } };
  const engine = { status: 'ready', async stop() { events.push('stop'); this.status = 'stopped'; }, async start() { events.push('start'); this.status = 'ready'; } };
  const accounts = new AccountLifecycle({ engine, queue });
  const sessions = Object.fromEntries(['quark', 'pan115'].map(side => [side, {
    async closeAllConnections() { events.push(side + ':close'); },
    async clearStorageData() { events.push(side + ':storage'); },
    async clearCache() { events.push(side + ':cache'); },
    async clearAuthCache() { events.push(side + ':auth'); },
    cookies: { async flushStore() { events.push(side + ':flush'); } },
  }]));
  const report = { files: 2, bytes: 100, retained: 1, complete: true };
  const services = { engine, queue, store, accounts, starting: false };
  const maintenance = new MaintenanceLifecycle({ profileDir, services: () => services,
    sessionFor: side => sessions[side], closeLogin: side => events.push(side + ':window'),
    confirm: async action => { events.push('confirm:' + action); return true; },
    clearCache: async (dirs, jobs) => { events.push('cache'); assert.equal(engine.status, 'stopped'); assert.equal(jobs, store.data.jobs); assert.deepEqual(dirs, [path.join(profileDir, 'cache'), store.data.cacheDir, store.data.jobs[0].cacheDir]); return report; },
    resetConfiguration: async dir => { events.push('configuration'); assert.equal(dir, profileDir); return { complete: true }; },
  });
  return { maintenance, services, events, sessions, queue, accounts, engine, store, report };
}

test('clear cache stops and restarts engine while preserving accounts, settings and history', async () => {
  const f = fixture(), before = structuredClone(f.store.data);
  assert.equal(await f.maintenance.run('clear-cache'), f.report);
  assert.deepEqual(f.events, ['confirm:clear-cache', 'stop', 'cache', 'start']);
  assert.deepEqual(f.store.data, before); assert.deepEqual(f.accounts.revisions, { quark: 0, pan115: 0 });
  assert.equal(f.maintenance.busy, false); assert.equal(f.accounts.busy, false);
});

test('cancelled confirmations do not change local state', async () => {
  for (const action of ['clear-cache', 'reset-app']) {
    const f = fixture(); f.maintenance.confirm = async () => false;
    assert.deepEqual(await f.maintenance.run(action), { cancelled: true });
    assert.deepEqual(f.events, []); assert.equal(f.maintenance.resetStarted, false);
  }
});

test('unfinished tasks, active workers, pending account writes and startup reject maintenance before confirmation', async () => {
  for (const blocker of ['unfinished', 'running', 'accounts', 'starting']) {
    for (const action of ['clear-cache', 'reset-app']) {
      const f = fixture();
      if (blocker === 'accounts') f.accounts.busy = true;
      else if (blocker === 'starting') f.services.starting = true;
      else f.queue[blocker] = true;
      await assert.rejects(f.maintenance.run(action)); assert.deepEqual(f.events, []);
    }
  }
});

test('confirmation holds both locks against repeated requests, task changes and login writes', async () => {
  const f = fixture(); let resolve;
  f.maintenance.confirm = () => new Promise(done => { resolve = done; });
  const first = f.maintenance.run('clear-cache');
  assert.equal(f.maintenance.busy, true); assert.equal(f.accounts.busy, true);
  await assert.rejects(f.maintenance.run('reset-app'), /正在/);
  assert.throws(() => f.maintenance.assertAvailable(), /正在/);
  await assert.rejects(f.accounts.save('quark', async () => {}), /正在/);
  f.queue.unfinished = true; resolve(true);
  await assert.rejects(first, /未完成任务/); assert.deepEqual(f.events, []);
  assert.equal(f.accounts.busy, false);
});

test('partial cache failure is reported and engine still restarts', async () => {
  const f = fixture(); f.report.complete = false;
  assert.equal((await f.maintenance.run('clear-cache')).complete, false);
  assert.equal(f.engine.status, 'ready');
  f.maintenance.clearCache = async () => { throw new Error('file busy'); };
  await assert.rejects(f.maintenance.run('clear-cache'), /file busy/);
  assert.equal(f.engine.status, 'ready'); assert.equal(f.maintenance.busy, false);
});

test('reset invalidates login callbacks, retires queue and clears both sessions before configuration', async () => {
  const f = fixture();
  const result = await f.maintenance.run('reset-app');
  assert.equal(result.reset, true); assert.equal(f.engine.status, 'stopped');
  assert.deepEqual(f.accounts.revisions, { quark: 1, pan115: 1 });
  assert.deepEqual(f.events.slice(0, 6), ['confirm:reset-app', 'retire', 'quark:window', 'pan115:window', 'stop', 'cache']);
  for (const side of ['quark', 'pan115']) assert.ok(f.events.indexOf(side + ':flush') < f.events.indexOf('configuration'));
  assert.ok(!f.events.includes('start')); assert.equal(f.maintenance.resetStarted, true);
  assert.throws(() => f.maintenance.assertAvailable(), /重置/);
});

test('failed reset retains configuration and supports retry without reactivating old work', async () => {
  const f = fixture();
  f.sessions.quark.clearStorageData = async () => { throw new Error('locked'); };
  await assert.rejects(f.maintenance.run('reset-app'), /重置未完全完成/);
  assert.ok(!f.events.includes('configuration')); assert.ok(f.events.includes('pan115:flush'));
  assert.equal(f.engine.status, 'stopped'); assert.equal(f.maintenance.busy, false);
  await assert.rejects(f.maintenance.run('clear-cache'), /重置/);
  f.sessions.quark.clearStorageData = async () => {};
  assert.equal((await f.maintenance.run('reset-app')).reset, true);
});

test('cache and configuration failures never return successful reset', async () => {
  const f = fixture(); f.report.complete = false;
  await assert.rejects(f.maintenance.run('reset-app'), /缓存/);
  assert.ok(!f.events.includes('configuration'));
  f.report.complete = true; f.maintenance.resetConfiguration = async () => ({ complete: false });
  await assert.rejects(f.maintenance.run('reset-app'), /配置/);
});

test('reset can recover a failed startup with no Store, engine or queue', async () => {
  const f = fixture();
  for (const key of ['engine', 'queue', 'store', 'accounts']) delete f.services[key];
  f.maintenance.clearCache = async (dirs, jobs) => { assert.equal(dirs.length, 1); assert.deepEqual(jobs, []); return f.report; };
  assert.equal((await f.maintenance.run('reset-app')).reset, true);
  assert.ok(f.events.includes('configuration'));
});

test('cleanup retries a failed engine startup rather than stranding maintenance in stopped state', async () => {
  const f = fixture(); f.engine.status = 'error';
  await f.maintenance.run('clear-cache');
  assert.equal(f.engine.status, 'ready'); assert.ok(f.events.includes('start'));
});

test('persisted unfinished history after startup failure blocks cache clearing but may be explicitly reset', async () => {
  const f = fixture(); delete f.services.queue;
  f.engine.status = 'error'; f.store.data.jobs[0].status = 'paused';
  await assert.rejects(f.maintenance.run('clear-cache'), /记录中仍有未完成/);
  assert.deepEqual(f.events, []);
  f.maintenance.confirm = async () => false;
  assert.deepEqual(await f.maintenance.run('reset-app'), { cancelled: true });
  assert.deepEqual(f.events, []);
  f.maintenance.confirm = async () => true;
  assert.equal((await f.maintenance.run('reset-app')).reset, true);
});
