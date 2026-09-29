'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { Readable } = require('node:stream');

const VERSION = '4.2.6';
const DIRECTORY_LIST_TIMEOUT = 180000;
const PAN115_LIST_PAGE_SIZE = 1150;
const ACCOUNTS = Object.freeze({
  quark: { driver: 'Quark', mount: '/夸克' },
  pan115: { driver: '115 Open', mount: '/115' },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Holding both Process handles prevents PID reuse from changing the process
// being watched or terminated. Values are data in environment variables, never
// interpolated into PowerShell source or passed through a command shell.
const WATCHDOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
$engineProcess = $null
$ownerProcess = $null
try {
  $engineProcess = [System.Diagnostics.Process]::GetProcessById([int]$env:OPENLIST_WATCH_CHILD)
  $engineHandle = $engineProcess.Handle
  $expectedPath = [System.IO.Path]::GetFullPath($env:OPENLIST_WATCH_BINARY)
  $actualPath = [System.IO.Path]::GetFullPath($engineProcess.MainModule.FileName)
  if (-not [string]::Equals($expectedPath, $actualPath, [System.StringComparison]::OrdinalIgnoreCase)) { exit 31 }
  $engineCreated = $engineProcess.StartTime.ToUniversalTime()
  $launchTime = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:OPENLIST_WATCH_LAUNCH).UtcDateTime
  if ($engineCreated -lt $launchTime.AddSeconds(-3) -or $engineCreated -gt [DateTime]::UtcNow.AddSeconds(3)) { exit 32 }
  try {
    $ownerProcess = [System.Diagnostics.Process]::GetProcessById([int]$env:OPENLIST_WATCH_OWNER)
    $ownerHandle = $ownerProcess.Handle
    $expectedOwner = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:OPENLIST_WATCH_OWNER_START).UtcDateTime
    if ([Math]::Abs(($ownerProcess.StartTime.ToUniversalTime() - $expectedOwner).TotalSeconds) -gt 5) {
      $ownerProcess.Dispose()
      $ownerProcess = $null
    }
  } catch { $ownerProcess = $null }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  if ($null -ne $ownerProcess) { $ownerProcess.WaitForExit() }
  if (-not $engineProcess.HasExited) { $engineProcess.Kill(); $engineProcess.WaitForExit(5000) | Out-Null }
} catch { exit 33 }
finally {
  if ($null -ne $ownerProcess) { $ownerProcess.Dispose() }
  if ($null -ne $engineProcess) { $engineProcess.Dispose() }
}
`;

function failure(message, code = 'ENGINE_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function virtualPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
    throw failure('网盘路径无效。', 'INVALID_ARGUMENT');
  }
  return path.posix.normalize(value);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** Owns one private OpenList v4.2.6 process. Credentials never leave this adapter. */
class Engine extends EventEmitter {
  constructor({ binaryPath, dataDir, cacheDir }) {
    super();
    if (![binaryPath, dataDir, cacheDir].every((item) => typeof item === 'string' && item.trim())) {
      throw failure('请指定引擎、数据和缓存目录。', 'INVALID_ARGUMENT');
    }
    this.binaryPath = path.resolve(binaryPath);
    this.dataDir = path.resolve(dataDir);
    this.cacheDir = path.resolve(cacheDir);
    this.configPath = path.join(this.dataDir, 'config.json');
    this.version = VERSION;
    this.baseUrl = null;
    this.port = null;
    this.status = 'stopped';
    this._token = null;
    this._child = null;
    this._watchdog = null;
    this._childSpawnedAt = null;
    this._startPromise = null;
    this._stopRequested = false;
    this._secrets = new Set();
    this._uploads = new Map();
  }

  _safeMessage(message) {
    let text = String(message || '操作失败。');
    for (const secret of this._secrets) {
      if (secret) text = text.split(secret).join('[凭证已隐藏]');
    }
    return text
      .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]')
      .replace(/(?:access_token|refresh_token|cookie|authorization|password|sign)\s*[:=]\s*[^\s,}]+/gi, '[凭证已隐藏]')
      .slice(0, 600);
  }

  _setStatus(status, error) {
    this.status = status;
    this.emit('status', { status, version: VERSION, error: error ? this._safeMessage(error.message || error) : null });
  }

  async start() {
    if (this.status === 'ready') return { status: 'ready', version: VERSION, baseUrl: this.baseUrl };
    if (this._startPromise) return this._startPromise;
    this._stopRequested = false;
    this._startPromise = this._start();
    try {
      return await this._startPromise;
    } finally {
      this._startPromise = null;
    }
  }

  async _start() {
    this._setStatus('starting');
    try {
      await fsp.access(this.binaryPath, fs.constants.F_OK);
      this.binaryPath = await fsp.realpath(this.binaryPath);
      await fsp.mkdir(this.dataDir, { recursive: true });
      await fsp.mkdir(this.cacheDir, { recursive: true });
      const versionOutput = await this._runCli(['version']);
      if (!/\bv?4\.2\.6\b/.test(versionOutput)) {
        throw failure('引擎版本不匹配，需要 OpenList v4.2.6。', 'VERSION_MISMATCH');
      }
      this.port = await getFreePort();
      this.baseUrl = `http://127.0.0.1:${this.port}`;
      await this._writePrivateConfig();
      const firstPassword = crypto.randomBytes(32).toString('base64url');
      this._secrets.add(firstPassword);
      // admin token initializes a fresh database without starting any listener.
      // The token is read into memory, never persisted by the wrapper or logged.
      const cliOutput = await this._runCli(
        ['admin', 'token', '--data', this.dataDir, '--config', this.configPath],
        { OPENLIST_ADMIN_PASSWORD: firstPassword },
      );
      const match = cliOutput.match(/Admin token:\s*(\S+)/);
      if (!match) throw failure('无法取得本机引擎授权，请检查数据目录权限。', 'INITIALIZATION_FAILED');
      this._token = match[1];
      this._secrets.add(this._token);
      if (this._stopRequested) throw failure('启动已取消。', 'CANCELLED');
      this._launchServer();
      await this._startWatchdog();
      const deadline = Date.now() + 60000;
      let ready = false;
      while (Date.now() < deadline && !this._stopRequested) {
        if (!this._child || this._child.exitCode !== null) break;
        try {
          // Authenticated readiness also prevents using an unrelated process if
          // another application wins the small free-port allocation race.
          const me = await this._request('GET', '/me', undefined, { timeout: 2000 });
          if (me && me.role === 2) { ready = true; break; }
        } catch { /* The private server may still be initializing. */ }
        await delay(150);
      }
      if (!ready) throw failure('本机引擎未能启动，请检查端口、引擎文件和数据目录。', 'START_FAILED');
      await this._mountCache();
      // Migrate only while startup still excludes account/transfer operations.
      // A status lookup must never restore credentials deleted by logout.
      try { await this._upgrade115ListPage(await this._listStorages()); }
      catch { /* A compatibility migration failure must not block normal login. */ }
      this._setStatus('ready');
      return { status: 'ready', version: VERSION, baseUrl: this.baseUrl };
    } catch (error) {
      await this._terminateChild();
      this._token = null;
      this.baseUrl = null;
      const safeError = failure(this._safeMessage(error.message), error.code || 'START_FAILED');
      this._setStatus(this._stopRequested ? 'stopped' : 'error', safeError);
      throw safeError;
    }
  }

  async _writePrivateConfig() {
    let config = {};
    try { config = JSON.parse(await fsp.readFile(this.configPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw failure('引擎配置无法读取，请检查配置文件。', 'CONFIG_ERROR'); }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw failure('引擎配置格式无效。', 'CONFIG_ERROR');
    config.force = true;
    config.site_url = this.baseUrl;
    config.cdn = '';
    config.scheme = {
      ...config.scheme, address: '127.0.0.1', http_port: this.port,
      https_port: -1, force_https: false, unix_file: '', enable_h2c: false, enable_h3: false,
    };
    for (const protocol of ['s3', 'ftp', 'sftp', 'mcp']) config[protocol] = { ...config[protocol], enable: false };
    config.log = { ...config.log, enable: false };
    config.database = { type: 'sqlite3', db_file: path.join(this.dataDir, 'data.db'), table_prefix: 'x_' };
    config.temp_dir = path.join(this.cacheDir, '.openlist-temp');
    config.bleve_dir = path.join(this.dataDir, 'bleve');
    config.delayed_start = 0;
    config.tasks = {
      ...config.tasks,
      copy: { workers: 1, max_retry: 0, task_persistant: false },
      upload: { workers: 1, max_retry: 0, task_persistant: false },
      allow_retry_canceled: true,
    };
    // The Electron main process is the API client; no web origin needs access.
    config.cors = { allow_origins: [this.baseUrl], allow_methods: ['GET', 'POST', 'PUT'], allow_headers: ['Authorization', 'Content-Type'] };
    await fsp.mkdir(config.temp_dir, { recursive: true });
    const tempPath = `${this.configPath}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    await fsp.rename(tempPath, this.configPath);
  }

  _runCli(args, extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        cwd: this.dataDir, windowsHide: true, shell: false,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv },
      });
      let output = '';
      let ended = false;
      const finish = (error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(output);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(failure('引擎初始化超时。', 'INITIALIZATION_TIMEOUT'));
      }, 60000);
      child.stdout.on('data', (chunk) => {
        if (output.length < 1024 * 1024) output += chunk.toString();
      });
      child.stderr.resume();
      child.once('error', () => finish(failure('无法运行引擎文件。', 'BINARY_ERROR')));
      child.once('close', (code) => finish(code === 0 ? null : failure('引擎初始化失败。', 'INITIALIZATION_FAILED')));
    });
  }

  _launchServer() {
    this._childSpawnedAt = Date.now();
    const child = spawn(this.binaryPath, ['server', '--data', this.dataDir, '--config', this.configPath], {
      cwd: this.dataDir, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this._child = child;
    child.stdout.resume();
    child.stderr.resume();
    child.once('error', () => {
      if (this.status === 'ready') this._setStatus('error', '本机引擎无法运行。');
    });
    child.once('exit', () => {
      if (this._child === child) {
        this._child = null;
        void this._stopWatchdog();
      }
      if (!this._stopRequested && this.status === 'ready') this._setStatus('error', '本机引擎已意外退出，请重新启动应用。');
    });
  }

  async _startWatchdog() {
    if (process.platform !== 'win32') return;
    const engineChild = this._child;
    if (!engineChild || !engineChild.pid) throw failure('无法启动引擎进程看护。', 'WATCHDOG_ERROR');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const watchdog = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WATCHDOG_SCRIPT, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENLIST_WATCH_CHILD: String(engineChild.pid),
        OPENLIST_WATCH_OWNER: String(process.pid),
        OPENLIST_WATCH_BINARY: this.binaryPath,
        OPENLIST_WATCH_LAUNCH: String(this._childSpawnedAt),
        OPENLIST_WATCH_OWNER_START: String(Math.round(Date.now() - process.uptime() * 1000)),
      },
    });
    this._watchdog = watchdog;
    watchdog.stderr.resume();
    await new Promise((resolve, reject) => {
      let settled = false;
      let output = '';
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(failure('引擎进程看护启动超时。', 'WATCHDOG_ERROR')), 15000);
      watchdog.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-100);
        if (/\bREADY\b/.test(output)) finish();
      });
      watchdog.once('error', () => finish(failure('无法启动引擎进程看护。', 'WATCHDOG_ERROR')));
      watchdog.once('exit', () => {
        const unexpected = this._watchdog === watchdog;
        if (unexpected) this._watchdog = null;
        finish(failure('引擎进程看护未能建立。', 'WATCHDOG_ERROR'));
        if (unexpected && !this._stopRequested && this._child === engineChild) {
          if (this.status === 'ready') this._setStatus('error', '引擎进程看护已退出，请重新启动应用。');
          void this._terminateChild();
        }
      });
    });
  }

  async _stopWatchdog() {
    const watchdog = this._watchdog;
    if (!watchdog) return;
    // Clear ownership first so its expected exit cannot stop a future engine.
    this._watchdog = null;
    await this._stopProcess(watchdog);
  }

  async stop() {
    this._stopRequested = true;
    if (this._startPromise) await this._startPromise.catch(() => {});
    if (this.status !== 'stopped') this._setStatus('stopping');
    for (const request of this._uploads.values()) request.destroy(failure('上传已取消。', 'CANCELLED'));
    this._uploads.clear();
    await this._terminateChild();
    this._token = null;
    this.baseUrl = null;
    this._setStatus('stopped');
  }

  async _terminateChild() {
    await this._stopWatchdog();
    const child = this._child;
    if (!child) return;
    await this._stopProcess(child);
    if (this._child === child) this._child = null;
  }

  async _stopProcess(child) {
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) { resolve(); return; }
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3000);
      child.once('exit', finish);
      child.kill();
    });
  }

  async setCacheDir(directory) {
    if (typeof directory !== 'string' || !directory.trim()) throw failure('缓存目录无效。', 'INVALID_ARGUMENT');
    const next = path.resolve(directory);
    if (next === this.cacheDir) return this.cacheDir;
    if (this._startPromise) await this._startPromise;
    const wasReady = this.status === 'ready';
    if (wasReady) {
      for (const type of ['copy', 'upload']) {
        const tasks = await this._request('GET', `/task/${type}/undone`);
        if (tasks && tasks.length) throw failure('请等当前传输停止后再更换缓存目录。', 'BUSY');
      }
      if (this._uploads.size) throw failure('请等当前传输停止后再更换缓存目录。', 'BUSY');
    }
    await fsp.mkdir(next, { recursive: true });
    const previous = this.cacheDir;
    if (wasReady) await this.stop();
    this.cacheDir = next;
    if (wasReady) {
      try { await this.start(); }
      catch (error) { this.cacheDir = previous; throw error; }
    }
    return this.cacheDir;
  }

  _request(method, endpoint, body, { timeout = 30000, headers = {}, stream, size, uploadKey } = {}) {
    if (!this.baseUrl || !this._token) return Promise.reject(failure('本机引擎尚未就绪。', 'NOT_READY'));
    const requestUrl = new URL(`/api${endpoint}`, this.baseUrl);
    const requestBody = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, data) => {
        if (settled) return;
        settled = true;
        if (uploadKey) this._uploads.delete(uploadKey);
        if (stream) stream.destroy();
        error ? reject(error) : resolve(data);
      };
      const req = http.request(requestUrl, {
        method, headers: {
          Authorization: this._token,
          ...(requestBody ? { 'Content-Type': 'application/json', 'Content-Length': requestBody.length } : {}),
          ...(stream ? { 'Content-Type': 'application/octet-stream', 'Content-Length': size } : {}),
          ...headers,
        },
      }, (res) => {
        const chunks = [];
        let length = 0;
        res.on('data', (chunk) => {
          length += chunk.length;
          if (length > 16 * 1024 * 1024) req.destroy(failure('引擎响应过大。', 'INVALID_RESPONSE'));
          else chunks.push(chunk);
        });
        res.on('error', (error) => finish(failure(this._safeMessage(error.message), 'NETWORK_ERROR')));
        res.on('end', () => {
          let payload;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { finish(failure('引擎返回了无效响应。', 'INVALID_RESPONSE')); return; }
          if (res.statusCode !== 200 || payload.code !== 200) {
            const text = this._safeMessage(payload.message || '引擎操作失败。');
            const conflict = payload.code === 403 && /(?:file\s+.*exists|file exists|同名冲突)/i.test(text);
            const error = failure(text, conflict ? 'CONFLICT' : payload.code === 401 ? 'AUTH_ERROR' : payload.code === 404 ? 'NOT_FOUND' : 'API_ERROR');
            error.apiCode = payload.code;
            finish(error);
          } else finish(null, payload.data);
        });
      });
      req.setTimeout(timeout, () => req.destroy(failure('本机引擎请求超时。', 'TIMEOUT')));
      req.once('error', (error) => finish(failure(this._safeMessage(error.message), error.code === 'CANCELLED' ? 'CANCELLED' : error.code === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR')));
      if (uploadKey) this._uploads.set(uploadKey, req);
      if (stream) {
        stream.once('error', () => req.destroy(failure('无法读取本地缓存文件。', 'FILE_ERROR')));
        stream.pipe(req);
      } else req.end(requestBody);
    });
  }

  async _listStorages() {
    const storages = [];
    for (let page = 1; ; page += 1) {
      const data = await this._request('GET', `/admin/storage/list?page=${page}&per_page=100`);
      if (!data || !Array.isArray(data.content)) throw failure('存储列表响应无效。', 'INVALID_RESPONSE');
      for (const storage of data.content) {
        try {
          const addition = JSON.parse(storage.addition || '{}');
          for (const key of ['cookie', 'access_token', 'refresh_token']) {
            if (typeof addition[key] === 'string' && addition[key]) this._secrets.add(addition[key]);
          }
        } catch { /* A broken storage is reported through its status. */ }
      }
      storages.push(...data.content);
      if (storages.length >= data.total || !data.content.length) return storages;
    }
  }

  async _upsertStorage(storage) {
    const existing = (await this._listStorages()).find((item) => item.mount_path === storage.mount_path);
    if (existing && existing.driver !== storage.driver) throw failure('挂载路径被其它驱动占用。', 'MOUNT_CONFLICT');
    if (existing) {
      const { mount_details, ...saved } = existing;
      await this._request('POST', '/admin/storage/update', { ...saved, ...storage, id: existing.id });
      return existing.id;
    }
    const result = await this._request('POST', '/admin/storage/create', storage);
    return result && result.id;
  }

  async _mountCache() {
    await this._upsertStorage({
      mount_path: '/_cache', driver: 'Local', disabled: false, disable_index: true,
      enable_sign: true, web_proxy: true, cache_expiration: 0,
      addition: JSON.stringify({ root_folder_path: this.cacheDir, thumbnail: false, show_hidden: true, directory_size: false }),
    });
  }

  async _upgrade115ListPage(storages) {
    const matches = storages.filter((item) => item.mount_path === ACCOUNTS.pan115.mount);
    if (matches.length !== 1) return;
    const storage = matches[0];
    if (storage.driver !== ACCOUNTS.pan115.driver || !Number.isSafeInteger(storage.id) || storage.id <= 0) return;
    let addition;
    try { addition = JSON.parse(storage.addition || '{}'); }
    catch { return; }
    if (!addition || typeof addition !== 'object' || Array.isArray(addition) || Number(addition.page_size) >= PAN115_LIST_PAGE_SIZE) return;
    const { mount_details, ...saved } = storage;
    // Update only this existing ID. Never recreate a vanished account, even if
    // a caller supplies a stale snapshot. Preserve disabled and all other fields.
    await this._request('POST', '/admin/storage/update', {
      ...saved,
      addition: JSON.stringify({ ...addition, page_size: PAN115_LIST_PAGE_SIZE }),
    });
  }

  async getAccounts() {
    const storages = this.status === 'ready' ? await this._listStorages() : [];
    return Object.fromEntries(Object.entries(ACCOUNTS).map(([side, account]) => {
      const storage = storages.find((item) => item.mount_path === account.mount && item.driver === account.driver);
      const connected = !!storage && !storage.disabled && storage.status === 'work';
      return [side, {
        connected, mount: account.mount,
        message: connected ? '已连接' : storage ? this._safeMessage(storage.status || '账号未连接') : '尚未连接账号',
      }];
    }));
  }

  async saveCredentials({ side, cookie, accessToken, refreshToken }) {
    const account = ACCOUNTS[side];
    if (!account) throw failure('不支持的账号类型。', 'INVALID_ARGUMENT');
    const fields = side === 'quark' ? [cookie] : [accessToken, refreshToken];
    if (!fields.every((item) => typeof item === 'string' && item.trim())) throw failure('请填写完整的账号凭证。', 'INVALID_ARGUMENT');
    fields.forEach((item) => this._secrets.add(item.trim()));
    const addition = side === 'quark'
      ? { root_folder_id: '0', cookie: cookie.trim(), order_by: 'none', order_direction: 'asc', use_transcoding_address: false, only_list_video_file: false }
      : { root_folder_id: '0', access_token: accessToken.trim(), refresh_token: refreshToken.trim(), limit_rate: 1, page_size: PAN115_LIST_PAGE_SIZE, order_by: 'file_name', order_direction: 'asc' };
    await this._upsertStorage({
      mount_path: account.mount, driver: account.driver, addition: JSON.stringify(addition),
      disabled: false, disable_index: true, enable_sign: true, web_proxy: true,
      webdav_policy: 'native_proxy', cache_expiration: 1,
    });
    return this.getAccounts();
  }

  async removeAccount(side) {
    if (!Object.hasOwn(ACCOUNTS, side)) throw failure('不支持的账号类型。', 'INVALID_ARGUMENT');
    if (this.status !== 'ready') throw failure('本机引擎尚未就绪。', 'NOT_READY');
    const account = ACCOUNTS[side];
    const matches = (await this._listStorages()).filter((item) => item.mount_path === account.mount);
    if (matches.some((item) => item.driver !== account.driver)) {
      throw failure('账号挂载路径被其它驱动占用，未删除配置。', 'MOUNT_CONFLICT');
    }
    if (matches.length > 1) throw failure('账号挂载配置重复，未删除配置。', 'INVALID_RESPONSE');
    const storage = matches[0];
    if (storage) {
      if (!Number.isSafeInteger(storage.id) || storage.id <= 0) throw failure('账号配置编号无效，未删除配置。', 'INVALID_RESPONSE');
      // OpenList's admin storage deletion drops the local mount and credential
      // record. It never uses the filesystem remove endpoint or deletes files.
      await this._request('POST', `/admin/storage/delete?id=${storage.id}`);
      const remaining = await this._listStorages();
      if (remaining.some((item) => item.id === storage.id || item.mount_path === account.mount)) {
        throw failure('账号配置仍然存在，请重试退出账号。', 'ACCOUNT_NOT_REMOVED');
      }
    }
    return this.getAccounts();
  }

  async list({ path: requestedPath, refresh = false }) {
    const directory = virtualPath(requestedPath);
    const entries = [];
    for (let page = 1; ; page += 1) {
      const data = await this._request('POST', '/fs/list', { path: directory, password: '', refresh: !!refresh && page === 1, page, per_page: 500 }, { timeout: DIRECTORY_LIST_TIMEOUT });
      if (!data || (data.content !== null && !Array.isArray(data.content))) throw failure('文件列表响应无效。', 'INVALID_RESPONSE');
      const content = data.content || [];
      entries.push(...content.map((item) => ({ ...item, isDir: !!item.is_dir, path: path.posix.join(directory, item.name) })));
      if (entries.length >= data.total || !content.length) return { path: directory, entries };
    }
  }

  getFile(filePath) { return this._request('POST', '/fs/get', { path: virtualPath(filePath), password: '' }); }

  mkdir(directory) { return this._request('POST', '/fs/mkdir', { path: virtualPath(directory) }); }

  async copyFile({ srcDir, dstDir, name }) {
    if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\0') || name === '.' || name === '..') throw failure('文件名无效。', 'INVALID_ARGUMENT');
    const data = await this._request('POST', '/fs/copy', {
      src_dir: virtualPath(srcDir), dst_dir: virtualPath(dstDir), names: [name],
      overwrite: false, skip_existing: false, merge: false,
    });
    if (!data || !Array.isArray(data.tasks) || data.tasks.length !== 1 || !data.tasks[0].id) {
      throw failure('引擎没有创建复制任务，未将文件标记为完成。', 'TASK_NOT_CREATED');
    }
    return data.tasks[0].id;
  }

  async uploadFile({ localPath, targetPath, size }) {
    const destination = virtualPath(targetPath);
    const source = path.resolve(localPath);
    const stat = await fsp.stat(source);
    if (!stat.isFile() || (size !== undefined && size !== stat.size)) throw failure('缓存文件大小不匹配，请重新下载。', 'FILE_CHANGED');
    const uploadKey = crypto.randomUUID();
    const headers = { 'File-Path': encodeURIComponent(destination), 'As-Task': 'true', Overwrite: 'false' };
    let endpoint = '/fs/put';
    let stream;
    let contentLength = stat.size;
    if (stat.size === 0) {
      // v4.2.6 raw PUT leaves the empty task's reader attached to a closed HTTP
      // request. The official multipart endpoint owns an independent in-memory
      // empty reader, while still returning a real background upload task.
      const boundary = `openlist-${crypto.randomBytes(16).toString('hex')}`;
      const form = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="empty.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--${boundary}--\r\n`);
      endpoint = '/fs/form';
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      contentLength = form.length;
      stream = Readable.from(form);
    } else stream = fs.createReadStream(source);
    const data = await this._request('PUT', endpoint, undefined, {
      timeout: 120000, stream, size: contentLength, uploadKey, headers,
    });
    if (!data || !data.task || !data.task.id) throw failure('引擎没有创建上传任务，未将文件标记为完成。', 'TASK_NOT_CREATED');
    return data.task.id;
  }

  async _getTask(type, id) {
    const data = await this._request('POST', `/task/${type}/info?tid=${encodeURIComponent(id)}`);
    if (!data || !Number.isInteger(data.state) || data.state < 0 || data.state > 9) throw failure('传输任务状态无效。', 'INVALID_RESPONSE');
    return {
      state: data.state === 2 ? 'success' : data.state === 4 ? 'cancelled' : data.state === 7 ? 'failed' : 'running',
      progress: Number.isFinite(data.progress) ? Math.min(100, Math.max(0, data.progress)) : 0,
      error: data.error ? this._safeMessage(data.error) : '',
    };
  }

  getCopyTask(id) { return this._getTask('copy', id); }
  cancelCopyTask(id) { return this._request('POST', `/task/copy/cancel?tid=${encodeURIComponent(id)}`); }
  retryCopyTask(id) { return this._request('POST', `/task/copy/retry?tid=${encodeURIComponent(id)}`); }
  getUploadTask(id) { return this._getTask('upload', id); }
  cancelUploadTask(id) { return this._request('POST', `/task/upload/cancel?tid=${encodeURIComponent(id)}`); }
  retryUploadTask(id) { return this._request('POST', `/task/upload/retry?tid=${encodeURIComponent(id)}`); }
}

module.exports = { Engine, VERSION };
