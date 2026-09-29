'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountLifecycle } = require('../src/account-lifecycle');

function fixture(overrides = {}) {
  const calls = [], states = Object.fromEntries(['quark', 'pan115'].map(side => [side, { credentials: true, cookies: true }]));
  const queue = { running: false, unfinished: false, hasUnfinished() { return this.unfinished; },
    invalidateCancelledTasks(side) { calls.push('invalidate:' + side); } };
  const lifecycle = new AccountLifecycle({
    queue,
    engine: { async removeAccount(side) { calls.push('remove:' + side); states[side].credentials = false; } },
    confirmLogout: async side => { calls.push('confirm:' + side); return true; },
    closeLogin: side => calls.push('close:' + side),
    sessionFor: side => ({
      async closeAllConnections() { calls.push('connections:' + side); },
      async clearStorageData() { calls.push('storage:' + side); states[side].cookies = false; },
      async clearCache() { calls.push('cache:' + side); },
      async clearAuthCache() { calls.push('auth:' + side); },
      cookies: { async flushStore() { calls.push('flush:' + side); } },
    }),
    ...overrides,
  });
  return { lifecycle, calls, states, queue };
}

test('logout clears only the selected account and its browser session, before allowing new login', async () => {
  const { lifecycle, calls, states } = fixture();
  const oldLogin = lifecycle.loginRevision('quark');
  assert.deepEqual(await lifecycle.logout('quark'), { disconnected: true });
  assert.deepEqual(states.quark, { credentials: false, cookies: false });
  assert.deepEqual(states.pan115, { credentials: true, cookies: true });
  assert.ok(calls.indexOf('invalidate:quark') < calls.indexOf('remove:quark'));
  assert.ok(calls.indexOf('close:quark') < calls.indexOf('storage:quark'));
  assert.ok(calls.includes('cache:quark') && calls.includes('auth:quark') && calls.includes('flush:quark'));
  assert.equal(lifecycle.isCurrent('quark', oldLogin), false);
  let writes = 0;
  await assert.rejects(lifecycle.save('quark', async () => { writes++; }, oldLogin), /已失效/);
  await lifecycle.save('quark', async () => { writes++; }, lifecycle.loginRevision('quark'));
  assert.equal(writes, 1, 'late results from the old window cannot restore removed credentials');
});

test('cancelling logout preserves credentials, browser session and task retry eligibility', async () => {
  const { lifecycle, calls, states } = fixture({ confirmLogout: async () => false });
  const revision = lifecycle.loginRevision('pan115');
  assert.deepEqual(await lifecycle.logout('pan115'), { cancelled: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(states.pan115, { credentials: true, cookies: true });
  assert.equal(lifecycle.loginRevision('pan115'), revision);
});

test('unfinished tasks and a settling cancelled transfer prevent logout before confirmation', async () => {
  const { lifecycle, calls, queue } = fixture();
  queue.unfinished = true;
  await assert.rejects(lifecycle.logout('quark'), /完成或取消/);
  queue.unfinished = false; queue.running = true;
  await assert.rejects(lifecycle.logout('pan115'), /完成或取消/);
  assert.deepEqual(calls, []);
});

test('account operations and transfers are locked while confirmation is pending', async () => {
  let finishConfirmation;
  const { lifecycle, calls } = fixture({ confirmLogout: () => new Promise(resolve => { finishConfirmation = resolve; }) });
  const logout = lifecycle.logout('quark');
  assert.throws(() => lifecycle.assertAvailable(), /正在更新账号/);
  assert.throws(() => lifecycle.loginRevision('pan115'), /正在更新账号/);
  await assert.rejects(lifecycle.logout('pan115'), /正在更新账号/);
  await assert.rejects(lifecycle.save('quark', () => { throw new Error('must not write'); }), /正在更新账号/);
  assert.deepEqual(calls, []);
  finishConfirmation(true); await logout;
  assert.doesNotThrow(() => lifecycle.assertAvailable());
});

test('an in-flight credential save completes before logout can be attempted', async () => {
  let finishSave;
  const { lifecycle, calls } = fixture();
  const save = lifecycle.save('quark', () => new Promise(resolve => { finishSave = resolve; }));
  await assert.rejects(lifecycle.logout('quark'), /正在更新账号/);
  assert.deepEqual(calls, []);
  finishSave(); await save;
  await lifecycle.logout('quark');
  assert.ok(calls.includes('remove:quark'));
});

test('partial logout never reports success, still clears the browser, and is retryable', async () => {
  const { lifecycle, calls } = fixture();
  lifecycle.engine.removeAccount = async () => { throw new Error('test backend failure'); };
  await assert.rejects(lifecycle.logout('pan115'), /退出未完全完成.*凭证移除失败/);
  assert.ok(calls.includes('storage:pan115'));
  assert.equal(lifecycle.busy, false);
  lifecycle.engine.removeAccount = async () => {};
  assert.deepEqual(await lifecycle.logout('pan115'), { disconnected: true });
});

test('browser cleanup failure is reported even when credentials were removed', async () => {
  const { lifecycle, calls, states } = fixture();
  const sessionFor = lifecycle.sessionFor;
  lifecycle.sessionFor = side => ({ ...sessionFor(side), async clearStorageData() { throw new Error('test disk failure'); } });
  await assert.rejects(lifecycle.logout('quark'), /退出未完全完成.*网页登录状态清理失败/);
  assert.equal(states.quark.credentials, false);
  assert.equal(states.pan115.credentials, true);
  assert.ok(calls.includes('auth:quark') && calls.includes('flush:quark'));
  assert.equal(lifecycle.busy, false);
});

test('failed task-history persistence stops logout before any credentials are removed', async () => {
  const { lifecycle, calls, queue } = fixture();
  queue.invalidateCancelledTasks = () => { throw new Error('test disk full'); };
  await assert.rejects(lifecycle.logout('quark'), /test disk full/);
  assert.deepEqual(calls, ['confirm:quark']);
  assert.equal(lifecycle.busy, false);
  await assert.rejects(lifecycle.logout('invalid'), /网盘类型无效/);
});
