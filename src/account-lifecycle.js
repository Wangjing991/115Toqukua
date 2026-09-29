'use strict';
const { MOUNTS } = require('./paths');

// Browser sessions are partitioned per drive. Clear all storage in just that
// partition after destroying its login windows, so old cookies cannot log back in.
async function clearLoginSession(loginSession) {
  await loginSession.closeAllConnections();
  const results = await Promise.allSettled([
    loginSession.clearStorageData(), loginSession.clearCache(), loginSession.clearAuthCache(),
  ]);
  await loginSession.cookies.flushStore();
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw new Error('网页登录状态未能全部清理，请再次退出账号');
}

class AccountLifecycle {
  constructor({ engine, queue, sessionFor, closeLogin, confirmLogout }) {
    Object.assign(this, { engine, queue, sessionFor, closeLogin, confirmLogout });
    this.busy = false;
    this.revisions = { quark: 0, pan115: 0 };
  }
  validateSide(side) { if (!Object.hasOwn(MOUNTS, side)) throw new Error('网盘类型无效'); }
  assertAvailable() { if (this.busy) throw new Error('正在更新账号，请稍后再试'); }
  loginRevision(side) { this.validateSide(side); this.assertAvailable(); return this.revisions[side]; }
  isCurrent(side, revision) { return this.revisions[side] === revision; }
  async exclusive(action) {
    this.assertAvailable(); this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async save(side, action, revision = this.revisions[side]) {
    this.validateSide(side); this.assertAvailable();
    if (!this.isCurrent(side, revision)) throw new Error('此登录窗口已失效，请重新登录');
    return this.exclusive(action);
  }
  assertNoTasks() {
    if (this.queue.running || this.queue.hasUnfinished()) throw new Error('请先完成或取消所有未完成任务，再退出账号；暂停或失败的任务也需要处理');
  }
  async logout(side) {
    this.validateSide(side); this.assertAvailable(); this.assertNoTasks();
    // Acquire before awaiting the native dialog. IPC transfer/retry/save handlers
    // check this lock, so a new job cannot slip between confirmation and removal.
    this.busy = true;
    try {
      if (!await this.confirmLogout(side)) return { cancelled: true };
      this.assertNoTasks();
      // Persist this before removing credentials. Cancelled history must never be
      // retried with a different account, including after a process restart.
      this.queue.invalidateCancelledTasks(side);
      this.revisions[side] += 1;
      this.closeLogin(side);
      const results = await Promise.allSettled([
        this.engine.removeAccount(side), clearLoginSession(this.sessionFor(side)),
      ]);
      const failures = results.flatMap((result, i) => result.status === 'rejected'
        ? [i === 0 ? '网盘连接凭证移除失败' : '网页登录状态清理失败'] : []);
      if (failures.length) throw new Error(`退出未完全完成：${failures.join('；')}。请再次点击退出当前账号。`);
      return { disconnected: true };
    } finally { this.busy = false; }
  }
}
module.exports = { AccountLifecycle, clearLoginSession };
