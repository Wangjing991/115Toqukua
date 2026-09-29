'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CACHE_FILES = new Set(['content.bin', 'content.bin.part']);
// OpenList v4.2.6 pkg/utils/file.go: os.CreateTemp(conf.Conf.TempDir, "file-*").
// Go uses the decimal representation of a uint32 for the wildcard.
const ENGINE_TEMP_FILE = /^file-(?:0|[1-9][0-9]{0,9})$/;
const RESET_FILES = Object.freeze([
  'engine/config.json', 'engine/config.json.tmp',
  'engine/data.db', 'engine/data.db-wal', 'engine/data.db-shm', 'engine/data.db-journal',
  'logs/events.log',
  'tasks.json.writing', 'tasks.json',
]);

function report() { return { files: 0, bytes: 0, directories: 0, retained: 0, skipped: [], errors: [], complete: true }; }
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function identity(value) { return process.platform === 'win32' ? value.toLowerCase() : value; }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function recordError(result, target, error) {
  result.complete = false;
  result.errors.push({ path: target, code: error.code || 'IO_ERROR', message: error.message });
}
function retain(result, target, reason) { result.retained++; result.skipped.push({ path: target, reason }); }
function absoluteDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw problem('INVALID_PATH', '缓存或数据目录必须是绝对路径。');
  return path.resolve(value);
}
function childPath(root, ...parts) {
  const target = path.resolve(root, ...parts);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw problem('UNSAFE_PATH', '清理路径超出了指定目录。');
  return target;
}

// Do not follow a junction/symlink even when it appears above the chosen root.
// Recheck before every unlink/rmdir. Callers must first stop all local writers;
// these checks are not an atomic defense against another process racing renames.
async function checkedDirectory(directory) {
  const absolute = absoluteDirectory(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const components = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = -1; index < components.length; index++) {
    if (index >= 0) current = path.join(current, components[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw problem('UNSAFE_PATH', '路径含符号链接、联接或非目录项，已保留。');
  }
  const stat = await fs.lstat(absolute);
  const actual = await fs.realpath(absolute);
  const actualStat = await fs.lstat(actual);
  // Windows may expand a legitimate 8.3 name such as WANGJI~1 here. Compare
  // filesystem identity rather than rejecting that alternate spelling.
  if (stat.isSymbolicLink() || !actualStat.isDirectory() || !sameFile(stat, actualStat)) throw problem('UNSAFE_PATH', '目录的实际位置已发生变化，已保留。');
  return stat;
}
async function checkedFile(target) {
  if (!await checkedDirectory(path.dirname(target))) return null;
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) throw problem('UNSAFE_PATH', '待清理项不是普通文件，已保留。');
  return stat;
}
async function removeFile(target, expected, result) {
  try {
    const current = await checkedFile(target);
    if (!current) return;
    if (!sameFile(current, expected)) throw problem('FILE_CHANGED', '待清理文件已发生变化，已保留。');
    await fs.unlink(target);
    result.files++; result.bytes += current.size;
  } catch (error) { recordError(result, target, error); }
}
async function removeEmptyDirectory(target, expected, result) {
  try {
    const current = await checkedDirectory(target);
    if (!current) return;
    if (!sameFile(current, expected)) throw problem('FILE_CHANGED', '待清理目录已发生变化，已保留。');
    // Never recursive: an unrelated file created during cleaning stays intact.
    await fs.rmdir(target); result.directories++;
  } catch (error) {
    if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') retain(result, target, '目录内仍有文件，已保留。');
    else recordError(result, target, error);
  }
}

async function cleanJob(root, job, result) {
  const directory = childPath(root, job.id);
  const jobStat = await checkedDirectory(directory);
  if (!jobStat) return;
  const entries = new Set((job.entries || []).map(entry => entry?.id).filter(id => UUID.test(id)));
  const files = [], directories = [];
  // Preflight the entire job tree. If anything is unrecognized, preserve that
  // whole job directory instead of treating user content as disposable cache.
  for (const entryName of await fs.readdir(directory)) {
    const entryDir = childPath(directory, entryName);
    if (!UUID.test(entryName) || !entries.has(entryName)) { retain(result, directory, '任务目录含未记录的内容，已保留。'); return; }
    const entryStat = await checkedDirectory(entryDir);
    if (!entryStat) continue;
    for (const filename of await fs.readdir(entryDir)) {
      if (!CACHE_FILES.has(filename)) { retain(result, directory, '任务目录含非传输缓存文件，已保留。'); return; }
      const file = childPath(entryDir, filename);
      const stat = await checkedFile(file);
      if (stat) files.push({ file, stat });
    }
    directories.push({ directory: entryDir, stat: entryStat });
  }
  for (const { file, stat } of files) await removeFile(file, stat, result);
  for (const item of directories) await removeEmptyDirectory(item.directory, item.stat, result);
  await removeEmptyDirectory(directory, jobStat, result);
}

async function cleanEngineTemp(root, result) {
  const directory = childPath(root, '.openlist-temp');
  if (!await checkedDirectory(directory)) return;
  for (const filename of await fs.readdir(directory)) {
    const file = childPath(directory, filename);
    if (!ENGINE_TEMP_FILE.test(filename) || Number(filename.slice(5)) > 0xffffffff) { retain(result, file, '不是已知的引擎临时文件，已保留。'); continue; }
    try {
      const stat = await checkedFile(file);
      if (stat) await removeFile(file, stat, result);
    } catch (error) { recordError(result, file, error); }
  }
  // Preserve the engine directory itself, as well as every selected cache root.
}

/**
 * Remove only recorded job caches and known engine temporary files.
 * Callers must stop the queue AND engine first; this function has no cloud API.
 * Supply the current cache, default cache and any historical cache roots.
 * Jobs also contribute their own recorded roots. Unknown trees are retained.
 * `retained` counts skipped items/subtrees, not a recursive count of user files.
 * I/O/unsafe-path failures return complete:false, including partial deletions.
 */
async function clearManagedCache(cacheDirs, jobs = []) {
  const result = report();
  if (!Array.isArray(cacheDirs) || !Array.isArray(jobs)) throw problem('INVALID_ARGUMENT', '缓存目录和任务记录必须为数组。');
  const roots = new Map();
  for (const value of [...cacheDirs, ...jobs.map(job => job?.cacheDir)]) {
    if (value === undefined || value === null) continue;
    try { const root = absoluteDirectory(value); roots.set(identity(root), root); }
    catch (error) { recordError(result, String(value), error); }
  }
  for (const root of roots.values()) {
    try {
      if (!await checkedDirectory(root)) continue;
      const rootJobs = new Map(jobs.filter(job => UUID.test(job?.id) && typeof job.cacheDir === 'string' && path.isAbsolute(job.cacheDir)
        && identity(path.resolve(job.cacheDir)) === identity(root)).map(job => [job.id, job]));
      for (const name of await fs.readdir(root)) {
        if (name === '.openlist-temp') {
          try { await cleanEngineTemp(root, result); } catch (error) { recordError(result, childPath(root, name), error); }
        } else if (rootJobs.has(name)) {
          try { await cleanJob(root, rootJobs.get(name), result); } catch (error) { recordError(result, childPath(root, name), error); }
        } else retain(result, childPath(root, name), '不是任务记录中的传输缓存，已保留。');
      }
    } catch (error) { recordError(result, root, error); }
  }
  return result;
}

/** Remove only wrapper/engine state files. The caller clears browser sessions. */
async function resetLocalConfiguration(profileDir) {
  const result = report();
  let profile;
  try { profile = absoluteDirectory(profileDir); if (!await checkedDirectory(profile)) return result; }
  catch (error) { recordError(result, String(profileDir), error); return result; }
  const files = [];
  for (const relative of RESET_FILES) {
    const file = childPath(profile, relative);
    try { const stat = await checkedFile(file); if (stat) files.push({ file, stat }); }
    catch (error) { recordError(result, file, error); }
  }
  // A symlink anywhere in the reset allowlist is rejected before deleting state.
  if (!result.complete) return result;
  for (const { file, stat } of files) {
    // Keep the cache-location manifest for a retry after any earlier failure.
    if (!result.complete && ['tasks.json', 'tasks.json.writing'].includes(path.basename(file))) continue;
    await removeFile(file, stat, result);
  }
  return result;
}

module.exports = { clearManagedCache, resetLocalConfiguration };
