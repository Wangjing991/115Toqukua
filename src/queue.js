'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { MOUNTS, name, within, join, availableName, localWithin, redact } = require('./paths');
const { download } = require('./download');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class Queue extends EventEmitter {
  constructor({ engine, store, cacheDir, downloader = download, pollMs = 1000 }) {
    super(); this.engine = engine; this.store = store; this.cacheDir = cacheDir; this.downloader = downloader; this.pollMs = pollMs;
    this.jobs = store.data.jobs || []; this.paused = this.jobs.some(j => !['completed', 'cancelled'].includes(j.status));
    this.running = false; this.current = null; this.lastEmit = 0; this.pendingCleanups = 0;
    for (const j of this.jobs) {
      if (['running', 'queued', 'scanning'].includes(j.status)) j.status = 'paused';
      for (const e of j.entries || []) {
        if (e.status === 'downloading') e.status = 'pending';
        if (e.status === 'submitting' && !e.taskId) { e.status = 'failed'; e.error = '上传提交时程序中断，结果待确认；重试会保留目标已有文件。'; }
      }
    }
    this.save();
  }
  save() { this.store.data.jobs = this.jobs; this.store.save(); }
  changed(persist = true) { if (persist) this.save(); this.emit('change'); }
  progress() { if (Date.now() - this.lastEmit > 250) { this.lastEmit = Date.now(); this.changed(false); } }
  summaries() { return this.jobs.map(j => {
    const entries = j.entries || [], done = entries.filter(e => e.status === 'completed'), failures = entries.filter(e => e.status === 'failed');
    return { id: j.id, sourcePath: j.sourceDir, targetPath: j.targetDir, status: j.status, totalFiles: entries.length,
      doneFiles: done.length, failedFiles: failures.length, totalBytes: entries.reduce((s, e) => s + e.size, 0), completedBytes: done.reduce((s, e) => s + e.size, 0),
      stage: j.stage, stageProgress: j.stageProgress || 0, message: [j.message, j.cacheWarning].filter(Boolean).join('；'), errors: [j.error, j.cacheWarning, ...failures.map(e => `${e.sourcePath}：${e.error}`)].filter(Boolean),
      totalDirectories: (j.directories || []).length, retryBlockedReason: j.retryBlockedReason || '' };
  }); }
  async add({ side, sourceDir, names, targetDir }) {
    if (!MOUNTS[side]) throw new Error('请选择来源网盘');
    sourceDir = within(sourceDir, MOUNTS[side]); targetDir = within(targetDir, MOUNTS[side === 'quark' ? 'pan115' : 'quark']);
    if (!Array.isArray(names) || !names.length || names.length > 100000) throw new Error('请先选择文件或文件夹');
    names = [...new Set(names.map(name))];
    const job = { id: randomUUID(), side, sourceDir, targetDir, names, status: 'scanning', stage: 'planning', entries: [], directories: [], planned: false, createdAt: new Date().toISOString(), cacheDir: this.cacheDir };
    this.jobs.push(job); this.changed();
    const planning = this.plan(job), generation = job.planGeneration;
    planning.then(() => { if (job.planGeneration === generation) this.kick(); }).catch(e => {
      if (job.planGeneration !== generation) return;
      job.status = job.cancelRequested ? 'cancelled' : 'failed'; job.error = redact(e); this.changed();
    });
    return { id: job.id };
  }
  async plan(job) {
    const generation = (job.planGeneration || 0) + 1; job.planGeneration = generation;
    const checkActive = () => { if (job.cancelRequested || job.planGeneration !== generation) throw Object.assign(new Error('目录扫描已取消'), { code: 'SCAN_CANCELLED' }); };
    const entries = [], directories = [];
    job.status = 'scanning'; job.stage = 'planning'; job.error = ''; job.entries = []; job.directories = [];
    const root = await this.engine.list({ path: job.sourceDir, refresh: true });
    checkActive();
    const selected = job.names.map(n => { const item = root.entries.find(e => e.name === n); if (!item) throw new Error(`源文件已不存在：${n}`); return item; });
    const pending = selected.map(item => ({ item, parent: job.sourceDir, destination: job.targetDir }));
    for (let i = 0; i < pending.length; i++) {
      checkActive();
      const { item, parent, destination } = pending[i]; name(item.name);
      const sourcePath = join(parent, item.name);
      if (item.is_dir) {
        const dir = join(destination, item.name); directories.push(dir);
        const result = await this.engine.list({ path: sourcePath, refresh: true });
        checkActive();
        for (const child of result.entries) pending.push({ item: child, parent: sourcePath, destination: dir });
      } else {
        const size = Number(item.size); if (!Number.isSafeInteger(size) || size < 0) throw new Error(`无法确定文件大小：${sourcePath}`);
        entries.push({ id: randomUUID(), name: item.name, sourcePath, targetDir: destination, size, status: 'pending', taskId: null });
      }
      job.message = `正在扫描：${entries.length} 个文件，${directories.length} 个文件夹`;
      if (i % 25 === 0) this.progress();
    }
    checkActive(); job.entries = entries; job.directories = directories;
    job.planned = true; job.status = this.paused ? 'paused' : 'queued'; job.message = '等待复制'; this.changed();
  }
  async ensureDirectory(dir) {
    const parent = path.posix.dirname(dir), base = path.posix.basename(dir);
    const result = await this.engine.list({ path: parent, refresh: true });
    const existing = result.entries.find(e => e.name === base);
    if (existing) { if (!existing.is_dir) throw new Error(`同名项是文件，无法建立文件夹：${dir}`); return; }
    if (result.entries.some(e => e.name.normalize('NFC').toLowerCase() === base.normalize('NFC').toLowerCase())) throw new Error(`目录名称仅大小写或字符形式不同，请先在目标盘整理后重试：${dir}`);
    await this.engine.mkdir(dir);
    const check = await this.engine.list({ path: parent, refresh: true });
    if (!check.entries.some(e => e.name === base && e.is_dir)) throw new Error(`未能确认文件夹已建立：${dir}`);
  }
  kick() {
    if (this.running || this.paused) return;
    this.running = true;
    this.runPromise = this.run().catch(error => {
      this.paused = true;
      if (this.current) { this.current.status = 'failed'; this.current.error = '任务记录或控制器发生错误：' + redact(error); }
      this.emit('fault', redact(error));
    }).finally(() => { this.running = false; this.current = null; this.changed(false); });
  }
  async run() {
    for (;;) {
      if (this.paused) return;
      const job = this.jobs.find(j => j.status === 'queued'); if (!job) return;
      this.current = job; job.status = 'running'; job.error = ''; this.changed();
      try {
        for (const dir of job.directories) { if (this.paused || job.cancelRequested) break; job.message = `检查目录：${dir}`; await this.ensureDirectory(dir); }
        for (const entry of job.entries) {
          if (this.paused || job.cancelRequested) break;
          if (['completed', 'failed', 'cancelled'].includes(entry.status)) continue;
          try { await this.process(job, entry); }
          catch (e) {
            if (this.paused || job.cancelRequested) { if (entry.status !== 'completed') entry.status = 'pending'; }
            else { entry.status = 'failed'; entry.error = redact(e); }
            this.changed();
          }
        }
        if (job.cancelRequested) { job.status = 'cancelled'; job.message = '已取消；已完成的目标文件予以保留'; await this.cleanJob(job); }
        else if (this.paused) { job.status = 'paused'; job.message = '已暂停，点击继续恢复未完成文件'; }
        else if (job.entries.some(e => e.status === 'failed')) { job.status = 'failed'; job.message = '部分文件未完成，可查看原因并重试'; }
        else {
          job.stage = 'verifying'; job.message = '核对本次复制的文件与目录'; this.changed();
          await this.verify(job);
          job.status = job.entries.some(e => e.status === 'failed') ? 'failed' : 'completed';
          job.message = job.status === 'completed' ? `已核对 ${job.entries.length} 个文件及 ${job.directories.length} 个文件夹的路径和字节大小` : '结果核对存在异常，请查看详情';
        }
      } catch (e) { job.status = 'failed'; job.error = redact(e); job.message = '任务未完成，请查看详情'; }
      this.current = null; this.changed();
    }
  }
  async process(job, entry) {
    const localFile = localWithin(job.cacheDir, job.id, entry.id, 'content.bin');
    await fs.promises.mkdir(path.dirname(localFile), { recursive: true });
    if (entry.taskId) {
      entry.status = 'uploading';
      try {
        await this.waitUpload(job, entry);
        if (job.cancelRequested) return;
        return await this.finishFile(job, entry, localFile);
      } catch (error) {
        if (error.code !== 'NOT_FOUND' && !/task.*not found|task.*not exist|任务.*不存在/i.test(error.message)) throw error;
        // The engine's volatile task table is gone after a restart. Verify the
        // exact recorded destination before deciding whether to resubmit.
        const actual = (await this.engine.list({ path: entry.targetDir, refresh: true })).entries.find(e => e.name === entry.finalName && !e.is_dir);
        entry.taskId = null;
        if (actual && Number(actual.size) === entry.size) return this.finishFile(job, entry, localFile);
        entry.status = 'pending'; this.changed();
      }
    }
    let cached = false;
    try { cached = (await fs.promises.stat(localFile)).size === entry.size; } catch {}
    const disk = await fs.promises.statfs(job.cacheDir);
    const free = Number(disk.bavail) * Number(disk.bsize), required = entry.size * (cached ? 1.1 : 2.1) + 256 * 1024 * 1024;
    if (free < required) throw new Error(`缓存盘空间不足，当前文件还需约 ${(required / 1024 ** 3).toFixed(1)} GB 可用空间`);
    if (!cached) {
      const file = await this.engine.getFile(entry.sourcePath);
      if (Number(file.size) !== entry.size) throw new Error('源文件大小已变化，请重新创建复制任务');
      if (!file.raw_url) throw new Error('引擎未返回原文件下载地址');
      if (this.paused || job.cancelRequested) return;
      entry.status = 'downloading'; job.stage = 'downloading'; job.stageProgress = 0; job.message = `读取原文件：${entry.name}`; this.changed();
      this.abort = new AbortController();
      try { await this.downloader({ url: new URL(file.raw_url, this.engine.baseUrl).href, file: localFile, expectedSize: entry.size, signal: this.abort.signal,
        onProgress: bytes => { job.stageProgress = entry.size ? bytes * 100 / entry.size : 100; this.progress(); } }); }
      finally { this.abort = null; }
      entry.status = 'cached'; this.changed();
    }
    if (this.paused || job.cancelRequested) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const target = await this.engine.list({ path: entry.targetDir, refresh: true });
      if (this.paused || job.cancelRequested) return;
      entry.finalName = availableName(entry.name, target.entries); entry.targetPath = join(entry.targetDir, entry.finalName);
      entry.status = 'submitting'; job.stage = 'uploading'; job.stageProgress = 0; job.message = `准备上传：${entry.finalName}`; this.changed();
      try { entry.taskId = await this.engine.uploadFile({ localPath: localFile, targetPath: entry.targetPath, size: entry.size }); this.changed(); break; }
      catch (e) { if (e.code === 'CONFLICT' && attempt < 7) continue; throw e; }
    }
    if (!entry.taskId) throw new Error('上传未返回任务编号，尚未确认完成');
    entry.status = 'uploading'; await this.waitUpload(job, entry);
    if (job.cancelRequested) return;
    await this.finishFile(job, entry, localFile);
  }
  async waitUpload(job, entry) {
    job.stage = 'uploading'; job.message = `正在上传：${entry.finalName || entry.name}`; this.changed();
    for (;;) {
      if (job.cancelRequested) {
        await this.engine.cancelUploadTask(entry.taskId);
        entry.taskId = null; entry.status = 'cached'; this.changed(); return;
      }
      const task = await this.engine.getUploadTask(entry.taskId);
      job.stageProgress = Number(task.progress) || 0; this.progress();
      if (task.state === 'success') return;
      if (['failed', 'cancelled'].includes(task.state)) { entry.taskId = null; throw new Error(task.error || '上传任务未成功，缓存已保留供重试'); }
      await sleep(this.pollMs);
    }
  }
  async finishFile(job, entry, localFile) {
    entry.status = 'verifying'; job.stage = 'verifying'; job.message = `核对：${entry.finalName}`; this.changed();
    const result = await this.engine.list({ path: entry.targetDir, refresh: true });
    const actual = result.entries.find(e => e.name === entry.finalName && !e.is_dir);
    if (!actual || Number(actual.size) !== entry.size) { entry.taskId = null; throw new Error('目标文件不存在或字节大小不一致，未标记为完成'); }
    entry.status = 'completed'; entry.error = ''; entry.finishedAt = new Date().toISOString(); this.changed();
    try { await fs.promises.rm(localFile, { force: true }); }
    catch { job.cacheWarning = '文件已复制并核对，但部分本机缓存暂时无法清理；请在任务结束后检查缓存目录。'; }
    await fs.promises.rmdir(path.dirname(localFile)).catch(() => {});
    await fs.promises.rmdir(path.dirname(path.dirname(localFile))).catch(() => {});
  }
  async verify(job) {
    for (const dir of job.directories) await this.engine.list({ path: dir, refresh: true });
    const directories = new Map();
    for (const e of job.entries) {
      if (e.status !== 'completed') continue;
      if (!directories.has(e.targetDir)) directories.set(e.targetDir, (await this.engine.list({ path: e.targetDir, refresh: true })).entries);
      const actual = directories.get(e.targetDir).find(f => f.name === e.finalName && !f.is_dir);
      if (!actual || Number(actual.size) !== e.size) { e.status = 'failed'; e.taskId = null; e.error = '完成后的再次核对发现目标缺失或大小变化'; }
    }
  }
  pause() { this.paused = true; if (this.current) this.current.message = '暂停已请求；正在处理的阶段结束后停止排队'; this.changed(); return { paused: true }; }
  async resume() {
    this.paused = false;
    for (const j of this.jobs) if (j.status === 'paused') {
      if (!j.planned) { try { await this.plan(j); } catch (e) { j.status = 'failed'; j.error = redact(e); } }
      else j.status = 'queued';
    }
    this.changed(); this.kick();
  }
  async retry(id) {
    const job = this.jobs.find(j => j.id === id); if (!job) throw new Error('任务不存在');
    if (this.pendingCleanups || this.current?.id === id) throw new Error('任务仍在处理或取消中，请稍后重试');
    if (job.retryBlockedReason) throw new Error(job.retryBlockedReason);
    if (!['failed', 'cancelled', 'paused'].includes(job.status)) throw new Error('当前任务尚不能重试');
    job.cancelRequested = false; job.error = '';
    if (!job.planned) await this.plan(job);
    for (const e of job.entries) if (['failed', 'cancelled'].includes(e.status)) { e.status = 'pending'; e.error = ''; }
    job.status = this.paused ? 'paused' : 'queued'; this.changed(); this.kick();
  }
  async cancel(id) {
    const job = this.jobs.find(j => j.id === id); if (!job || ['completed', 'cancelled'].includes(job.status)) return;
    job.cancelRequested = true;
    if (this.current?.id === id) { this.abort?.abort(); job.message = '正在取消当前文件'; }
    else {
      this.pendingCleanups++;
      try {
        job.status = 'cancelled'; await this.cleanJob(job);
        job.error = ''; job.message = '已取消；已完成的目标文件予以保留';
      }
      catch (error) {
        job.status = 'failed'; job.error = '取消未完成：' + redact(error);
        job.message = '未能确认上传已停止，请查看原因并再次取消';
        throw error;
      }
      finally { this.pendingCleanups--; this.changed(); }
    }
    this.changed();
  }
  async cleanJob(job) {
    for (const e of job.entries) {
      if (e.taskId && e.status !== 'completed') {
        try { await this.engine.cancelUploadTask(e.taskId); }
        catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
        e.taskId = null;
      }
      const file = localWithin(job.cacheDir, job.id, e.id, 'content.bin');
      await fs.promises.rm(file, { force: true }).catch(() => {});
      await fs.promises.rm(file + '.part', { force: true }).catch(() => {});
      await fs.promises.rmdir(path.dirname(file)).catch(() => {});
      if (e.status !== 'completed') e.status = 'cancelled';
    }
    await fs.promises.rmdir(localWithin(job.cacheDir, job.id)).catch(() => {});
  }
  invalidateCancelledTasks(side) {
    if (!MOUNTS[side]) throw new Error('网盘类型无效');
    if (this.running || this.hasUnfinished()) throw new Error('请先完成或取消现有任务');
    for (const job of this.jobs) if (job.status === 'cancelled') {
      job.retryBlockedReason = '该任务使用的账号已退出，不能重试旧任务；请重新选择文件创建任务。';
      job.error = job.retryBlockedReason;
    }
    this.changed();
  }
  hasUnfinished() { return this.pendingCleanups > 0 || this.jobs.some(j => !['completed', 'cancelled'].includes(j.status)); }
  async stop() {
    this.pause(); this.abort?.abort();
    let timeout;
    try { await Promise.race([this.runPromise || Promise.resolve(), new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]); }
    finally { clearTimeout(timeout); this.save(); }
  }
}
module.exports = { Queue };
