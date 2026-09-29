'use strict';
const path = require('node:path');
const { clearLoginSession } = require('./account-lifecycle');
const { clearManagedCache, resetLocalConfiguration } = require('./local-maintenance');

// Hold one lock from confirmation through engine shutdown and cleanup. Account
// writes use their existing lock too, so login callbacks cannot restore a reset.
class MaintenanceLifecycle {
  constructor({ profileDir, services, sessionFor, closeLogin, confirm, onChange = () => {},
    clearCache = clearManagedCache, resetConfiguration = resetLocalConfiguration }) {
    Object.assign(this, { profileDir, services, sessionFor, closeLogin, confirm, onChange, clearCache, resetConfiguration });
    this.busy = false; this.action = null; this.resetStarted = false;
  }
  snapshot() { return { busy: this.busy, action: this.action, resetStarted: this.resetStarted }; }
  assertAvailable() {
    if (this.busy) throw new Error('正在清理缓存或重置软件，请稍后再试');
    if (this.resetStarted) throw new Error('重置尚未完成，请在设置中再次执行完整重置，或关闭软件后重新打开');
  }
  assertNoTasks(queue) {
    if (queue && (queue.running || queue.hasUnfinished())) throw new Error('请先完成或取消所有未完成任务，并等待取消结束，再清理缓存或重置；暂停和失败任务也需要处理');
  }
  async run(action) {
    if (!['clear-cache', 'reset-app'].includes(action)) throw new Error('清理操作无效');
    if (this.busy) throw new Error('正在清理缓存或重置软件，请稍后再试');
    if (this.resetStarted && action !== 'reset-app') this.assertAvailable();
    const { engine, queue, store, accounts, starting } = this.services();
    if (starting) throw new Error('请等待本地引擎启动结束后再操作');
    this.assertNoTasks(queue); accounts?.assertAvailable();
    // A failed startup may have loaded history without constructing a queue.
    // Only an explicitly confirmed reset may discard that unfinished history.
    if (!queue && action === 'clear-cache' && store?.data.jobs?.some(job => !['completed', 'cancelled'].includes(job.status))) {
      throw new Error('任务记录中仍有未完成任务，不能单独清理缓存。请修复启动后完成或取消任务；如需放弃全部本机记录，可选择完整重置。');
    }
    this.busy = true; this.action = action; this.onChange();
    try {
      const work = async () => {
        if (!await this.confirm(action)) return { cancelled: true };
        this.assertNoTasks(queue);
        const jobs = store?.data.jobs || [];
        const cacheDirs = [path.join(this.profileDir, 'cache'), store?.data.cacheDir, ...jobs.map(job => job.cacheDir)].filter(Boolean);
        const reset = action === 'reset-app';
        const restart = !reset && !!engine;
        if (reset) {
          this.resetStarted = true;
          queue?.retire();
          for (const side of ['quark', 'pan115']) {
            if (accounts) accounts.revisions[side] += 1;
            this.closeLogin(side);
          }
        }
        await engine?.stop();
        try {
          const report = await this.clearCache(cacheDirs, jobs);
          if (!reset) return report;
          const sessions = await Promise.allSettled(['quark', 'pan115'].map(side => clearLoginSession(this.sessionFor(side))));
          // Preserve the manifest on failure so the next reset can still locate
          // old custom caches. No successful-reset result is returned partially.
          const problems = [];
          if (!report.complete) problems.push('部分缓存未能清理');
          if (sessions.some(result => result.status === 'rejected')) problems.push('部分网页登录状态未能清理');
          if (problems.length) throw new Error('重置未完全完成：' + problems.join('；') + '。请关闭占用文件的程序后再次执行完整重置。');
          const configuration = await this.resetConfiguration(this.profileDir);
          if (!configuration.complete) throw new Error('部分本机配置未能删除，重置未完全完成。请关闭占用文件的程序后再次执行完整重置。');
          return { reset: true, ...report };
        } finally {
          if (restart) await engine.start();
        }
      };
      return accounts ? await accounts.exclusive(work) : await work();
    } finally {
      this.busy = false; this.action = null; this.onChange();
    }
  }
}
module.exports = { MaintenanceLifecycle };
