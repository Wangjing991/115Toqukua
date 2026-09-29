'use strict';

(() => {
  const api = window.bridge;
  const sides = ['quark', 'pan115'];
  const labels = { quark: '夸克', pan115: '115' };
  const statusLabels = { scanning: '扫描中', queued: '等待中', running: '传输中', paused: '已暂停', completed: '已完成', failed: '有失败项', cancelled: '已取消' };
  const stageLabels = { downloading: '下载到本机', uploading: '上传到网盘', verifying: '核对文件', planning: '扫描目录' };
  const terminalStates = new Set(['completed', 'failed', 'cancelled']);
  const model = {
    snapshot: { engine: { status: 'starting' }, accounts: {}, settings: {}, paused: false, jobs: [] },
    panes: Object.fromEntries(sides.map(side => [side, { path: '', entries: [], selected: new Set(), loaded: false, loading: false, error: '', request: 0 }])),
    accountSide: 'quark',
    pendingCopy: null,
    jobsSignature: '',
    toastTimer: null,
    unsubscribe: null,
  };
  const byId = id => document.getElementById(id);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  };
  const number = value => Math.max(0, Number(value) || 0);
  const account = side => model.snapshot.accounts?.[side] || {};
  const ready = () => Boolean(api && model.snapshot.engine?.status === 'ready');
  const rootPath = side => account(side).mount || (side === 'quark' ? '/夸克' : '/115');
  const trimPath = path => String(path || '/').replace(/\/+$/, '') || '/';
  const joinPath = (base, name) => `${trimPath(base) === '/' ? '' : trimPath(base)}/${name}`;
  const errorMessage = error => error?.message || String(error || '操作未完成，请稍后重试。');

  function bytes(value) {
    const size = number(value);
    if (size < 1024) return `${size.toLocaleString('zh-CN')} B`;
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let unit = -1;
    let amount = size;
    do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
    return `${amount.toFixed(amount >= 100 ? 0 : 1)} ${units[unit]}`;
  }

  function modifiedLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function toast(message, isError = false) {
    clearTimeout(model.toastTimer);
    const el = byId('toast');
    el.textContent = message;
    el.className = isError ? 'toast error' : 'toast';
    el.hidden = false;
    model.toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6500 : 4000);
  }

  async function call(method, ...args) {
    if (!api || typeof api[method] !== 'function') throw new Error('桌面服务尚未连接，请从应用程序启动。');
    return api[method](...args);
  }

  async function withButton(button, action) {
    button.disabled = true;
    try { return await action(); }
    catch (error) { toast(errorMessage(error), true); return undefined; }
    finally { if (button.isConnected) button.disabled = false; }
  }

  function paintEngine() {
    const engine = model.snapshot.engine || {};
    const status = byId('engine-status');
    const banner = byId('startup-banner');
    const isReady = engine.status === 'ready';
    const isError = engine.status === 'error';
    status.className = `engine-status ${isReady ? 'ready' : isError ? 'error' : ''}`;
    status.lastElementChild.textContent = isReady ? '本地服务运行中' : isError ? '本地服务启动失败' : '正在启动本地服务';
    banner.hidden = isReady;
    banner.className = isError ? 'notice error' : 'notice';
    banner.querySelector('.spinner').hidden = isError;
    byId('startup-title').textContent = isError ? '暂时无法启动传输服务' : '正在准备传输环境';
    byId('startup-description').textContent = engine.error || '首次启动可能需要一点时间，准备好后即可连接网盘。';
    byId('startup-logs').hidden = !isError;
    byId('version-label').textContent = engine.version ? `OpenList ${engine.version}` : 'OpenList 本地服务';
    byId('cache-dir').value = model.snapshot.settings?.cacheDir || '';
    byId('choose-cache-button').disabled = !api;
    document.querySelectorAll('[data-action="account"]').forEach(button => { button.disabled = !ready(); });
  }

  function paintAccount(side) {
    const info = account(side);
    const status = byId(`${side}-account-status`);
    status.textContent = info.connected ? '已连接' : '尚未连接';
    status.className = info.connected ? 'account-status connected' : 'account-status';
    status.title = info.message || '';
    const button = document.querySelector(`.account-button[data-side="${side}"]`);
    button.textContent = info.connected ? '管理账号' : '连接账号';
    button.disabled = !ready();
  }

  function paintPath(side) {
    const pane = model.panes[side];
    const mount = trimPath(rootPath(side));
    const path = pane.path || mount;
    const crumbs = byId(`${side}-breadcrumbs`);
    const elements = document.createDocumentFragment();
    const root = node('button', 'breadcrumb', '全部文件');
    root.type = 'button';
    root.title = mount;
    root.disabled = !ready() || !account(side).connected;
    root.addEventListener('click', () => loadDirectory(side, mount));
    elements.append(root);
    let current = mount;
    const relative = path === mount ? '' : path.slice(mount === '/' ? 1 : mount.length + 1);
    for (const segment of relative.split('/').filter(Boolean)) {
      elements.append(node('span', 'breadcrumb-separator', '/'));
      current = joinPath(current, segment);
      const location = current;
      const crumb = node('button', 'breadcrumb', segment);
      crumb.type = 'button';
      crumb.title = location;
      crumb.disabled = !ready() || !account(side).connected;
      crumb.addEventListener('click', () => loadDirectory(side, location));
      elements.append(crumb);
    }
    crumbs.replaceChildren(elements);
    crumbs.scrollLeft = crumbs.scrollWidth;
    const canBrowse = ready() && account(side).connected && !pane.loading;
    document.querySelector(`[data-action="up"][data-side="${side}"]`).disabled = !canBrowse || path === mount;
    document.querySelector(`[data-action="refresh"][data-side="${side}"]`).disabled = !canBrowse;
  }

  function emptyState(side, { title, description, actionLabel, action, loading = false }) {
    const container = node('div', 'empty-state');
    const icon = node('div', loading ? 'spinner' : 'empty-cloud', loading ? '' : '☁');
    icon.setAttribute('aria-hidden', 'true');
    container.append(icon, node('h4', '', title), node('p', '', description));
    if (actionLabel) {
      const button = node('button', `button primary ${side === 'pan115' ? 'blue' : ''}`, actionLabel);
      button.type = 'button';
      button.disabled = !ready();
      button.addEventListener('click', action);
      container.append(button);
    }
    return container;
  }

  function paintPane(side) {
    const pane = model.panes[side];
    const area = byId(`${side}-file-area`);
    area.setAttribute('aria-busy', String(pane.loading));
    paintPath(side);
    if (!account(side).connected) {
      area.replaceChildren(emptyState(side, { title: `连接你的${labels[side]}网盘`, description: account(side).message || '登录后，即可浏览和选择文件', actionLabel: `连接${labels[side]}`, action: () => openAccount(side) }));
    } else if (pane.loading) {
      area.replaceChildren(emptyState(side, { title: '正在读取文件', description: '正在获取当前目录，请稍候', loading: true }));
    } else if (pane.error) {
      area.replaceChildren(emptyState(side, { title: '无法读取当前目录', description: pane.error, actionLabel: '重新加载', action: () => loadDirectory(side, pane.path, true) }));
    } else if (!pane.entries.length) {
      area.replaceChildren(emptyState(side, { title: '这个文件夹还是空的', description: '可以将另一侧选中的文件复制到这里' }));
    } else {
      const fragment = document.createDocumentFragment();
      for (const entry of pane.entries) {
        const row = node('div', `file-row${pane.selected.has(entry.name) ? ' selected' : ''}`);
        row.tabIndex = 0;
        row.setAttribute('role', 'group');
        row.setAttribute('aria-label', `${entry.is_dir ? '文件夹' : '文件'} ${entry.name}`);
        const checkbox = node('input');
        checkbox.type = 'checkbox';
        checkbox.checked = pane.selected.has(entry.name);
        checkbox.setAttribute('aria-label', `选择 ${entry.name}`);
        checkbox.addEventListener('click', event => event.stopPropagation());
        checkbox.addEventListener('change', () => selectEntry(side, entry.name, checkbox.checked));
        const extension = entry.name.includes('.') ? entry.name.split('.').pop().slice(0, 3).toUpperCase() : '';
        const icon = node('span', `file-icon${entry.is_dir ? ' folder' : ''}`, entry.is_dir ? '' : extension);
        icon.setAttribute('aria-hidden', 'true');
        const info = node('div', 'file-info');
        const name = node(entry.is_dir ? 'button' : 'span', entry.is_dir ? 'file-name file-open' : 'file-name', entry.name);
        name.title = entry.is_dir ? `打开文件夹：${entry.name}` : entry.name;
        if (entry.is_dir) {
          name.type = 'button';
          name.addEventListener('click', event => { event.stopPropagation(); loadDirectory(side, joinPath(pane.path, entry.name)); });
        }
        info.append(name);
        const modified = modifiedLabel(entry.modified);
        if (modified) info.append(node('span', 'file-modified', modified));
        row.append(checkbox, icon, info, node('span', 'file-size', entry.is_dir ? '—' : bytes(entry.size)));
        row.addEventListener('click', () => selectEntry(side, entry.name, !pane.selected.has(entry.name)));
        row.addEventListener('dblclick', event => { if (entry.is_dir) { event.preventDefault(); loadDirectory(side, joinPath(pane.path, entry.name)); } });
        row.addEventListener('keydown', event => {
          if (event.target !== row) return;
          if (event.key === 'Enter' && entry.is_dir) { event.preventDefault(); loadDirectory(side, joinPath(pane.path, entry.name)); }
          else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); selectEntry(side, entry.name, !pane.selected.has(entry.name)); }
        });
        fragment.append(row);
      }
      area.replaceChildren(fragment);
    }
    byId(`${side}-summary`).textContent = pane.loading ? '正在读取…' : `${pane.entries.length.toLocaleString('zh-CN')} 个项目`;
    updateSelection(side);
  }

  function selectEntry(side, name, selected) {
    const pane = model.panes[side];
    if (selected) pane.selected.add(name); else pane.selected.delete(name);
    updateSelection(side);
  }

  function updateSelection(side) {
    const pane = model.panes[side];
    const rows = byId(`${side}-file-area`).querySelectorAll('.file-row');
    rows.forEach((row, index) => {
      const selected = pane.selected.has(pane.entries[index]?.name);
      row.classList.toggle('selected', selected);
      row.querySelector('input').checked = selected;
    });
    const selectAll = byId(`${side}-select-all`);
    selectAll.disabled = !ready() || !account(side).connected || pane.loading || Boolean(pane.error) || !pane.entries.length;
    selectAll.checked = Boolean(pane.entries.length && pane.selected.size === pane.entries.length);
    selectAll.indeterminate = pane.selected.size > 0 && pane.selected.size < pane.entries.length;
    byId(`${side}-selection`).textContent = pane.selected.size ? `已选择 ${pane.selected.size.toLocaleString('zh-CN')} 项` : '未选择文件';
    updateCopyButtons();
  }

  function updateCopyButtons() {
    const connected = ready() && sides.every(side => account(side).connected && model.panes[side].loaded && !model.panes[side].loading && !model.panes[side].error);
    byId('copy-to-115').disabled = !connected || !model.panes.quark.selected.size;
    byId('copy-to-quark').disabled = !connected || !model.panes.pan115.selected.size;
  }

  async function loadDirectory(side, path = rootPath(side), refresh = false) {
    if (!ready() || !account(side).connected) return;
    const pane = model.panes[side];
    const mount = trimPath(rootPath(side));
    const nextPath = trimPath(path || mount);
    if (nextPath !== mount && !nextPath.startsWith(`${mount}/`)) return;
    const changed = nextPath !== pane.path;
    const request = ++pane.request;
    pane.path = nextPath;
    pane.loading = true;
    pane.error = '';
    if (changed) { pane.selected.clear(); pane.entries = []; }
    paintPane(side);
    try {
      const result = await call('list', { side, path: nextPath, refresh });
      if (request !== pane.request) return;
      pane.entries = (Array.isArray(result?.entries) ? result.entries : [])
        .filter(entry => typeof entry.name === 'string' && entry.name !== '.' && entry.name !== '..' && !entry.name.includes('/'))
        .slice().sort((a, b) => Number(Boolean(b.is_dir)) - Number(Boolean(a.is_dir)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
      const available = new Set(pane.entries.map(entry => entry.name));
      pane.selected = new Set([...pane.selected].filter(name => available.has(name)));
      pane.loaded = true;
      pane.error = '';
    } catch (error) {
      if (request !== pane.request) return;
      pane.error = errorMessage(error);
      pane.loaded = false;
    } finally {
      if (request === pane.request) { pane.loading = false; paintPane(side); }
    }
  }

  function paintJobs() {
    const jobs = model.snapshot.jobs || [];
    const signature = JSON.stringify([model.snapshot.engine?.status, model.snapshot.paused, jobs]);
    if (signature === model.jobsSignature) return;
    model.jobsSignature = signature;
    byId('task-count').textContent = String(jobs.length);
    const active = jobs.filter(job => !terminalStates.has(job.status));
    const queue = byId('queue-toggle');
    queue.textContent = model.snapshot.paused ? '继续队列' : '暂停队列';
    queue.disabled = !ready() || (!active.length && !model.snapshot.paused);
    byId('queue-description').textContent = model.snapshot.paused ? '已请求暂停，当前阶段结束后停止' : '完成的文件会自动清理本机缓存';
    const list = byId('task-list');
    if (!jobs.length) {
      const empty = node('div', 'tasks-empty');
      const icon = node('span', '', '⇄');
      icon.setAttribute('aria-hidden', 'true');
      const text = node('div');
      text.append(node('strong', '', '还没有传输任务'), node('p', '', '在上方选择文件，再点击中间的方向按钮开始复制。'));
      empty.append(icon, text);
      list.replaceChildren(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const job of jobs.slice().reverse()) {
      const item = node('article', `task-item ${job.status || ''}`);
      const direction = node('div', 'task-direction', '⇄');
      direction.setAttribute('aria-hidden', 'true');
      const content = node('div', 'task-content');
      const titleRow = node('div', 'task-title-row');
      const source = String(job.sourcePath || '所选文件');
      const target = String(job.targetPath || '目标目录');
      const title = node('span', 'task-title', `${source.split('/').filter(Boolean).pop() || source} → ${target}`);
      title.title = `${source} → ${target}`;
      titleRow.append(title, node('span', `task-state ${job.status || ''}`, statusLabels[job.status] || '等待中'));
      const path = node('div', 'task-path', `${source} → ${target}`);
      path.title = `${source} → ${target}`;
      const totalBytes = number(job.totalBytes);
      const doneBytes = number(job.completedBytes);
      const totalFiles = number(job.totalFiles);
      const doneFiles = number(job.doneFiles);
      const percentage = job.status === 'completed' ? 100 : Math.min(100, totalBytes > 0 ? doneBytes / totalBytes * 100 : totalFiles > 0 ? doneFiles / totalFiles * 100 : 0);
      const track = node('div', 'progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', '整批文件完成进度');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(percentage)));
      const progress = node('div', 'progress-value');
      // The numeric custom property is written via CSSOM; all external text uses textContent.
      progress.style.width = `${percentage}%`;
      track.append(progress);
      const meta = node('div', 'task-meta');
      const failed = number(job.failedFiles);
      const summary = `${doneFiles.toLocaleString('zh-CN')} / ${totalFiles.toLocaleString('zh-CN')} 个文件${failed ? ` · ${failed} 个失败` : ''} · ${bytes(doneBytes)} / ${bytes(totalBytes)}`;
      let stage = job.status === 'completed' ? '目录、数量和大小已核对' : job.message || stageLabels[job.stage] || '';
      if (job.status === 'running' && Number.isFinite(Number(job.stageProgress))) {
        const stagePercent = Math.round(Math.max(0, Math.min(100, Number(job.stageProgress))));
        stage = `${stageLabels[job.stage] || '处理中'} ${stagePercent}%${job.message ? ` · ${job.message}` : ''}`;
      }
      const stageNode = node('span', '', stage);
      stageNode.title = stage;
      meta.append(node('span', '', summary), stageNode);
      content.append(titleRow, path, track, meta);
      const actions = node('div', 'task-actions');
      if (job.status === 'failed' || job.status === 'cancelled' || failed > 0) actions.append(jobButton('重试', () => runJobAction('retryJob', job.id)));
      if (job.status === 'failed' || failed > 0 || job.errors?.length) actions.append(jobButton('查看原因', () => showJobDetails(job.id)));
      if (!terminalStates.has(job.status)) actions.append(jobButton('取消', () => runJobAction('cancelJob', job.id), 'danger'));
      item.append(direction, content, actions);
      fragment.append(item);
    }
    list.replaceChildren(fragment);
  }

  function jobButton(label, action, extraClass = '') {
    const button = node('button', `button small ${extraClass}`, label);
    button.type = 'button';
    button.disabled = !ready() && label !== '查看原因';
    button.addEventListener('click', () => withButton(button, action));
    return button;
  }

  async function runJobAction(method, id) {
    await call(method, id);
    if (method === 'retryJob') toast('已提交重试，已完成的文件会保留。');
    else toast('已请求取消该任务。');
    await refreshState();
  }

  function showJobDetails(id) {
    const job = (model.snapshot.jobs || []).find(item => item.id === id);
    if (!job) return;
    byId('error-dialog-title').textContent = statusLabels[job.status] || '任务详情';
    const errors = Array.isArray(job.errors) ? job.errors.map(error => typeof error === 'string' ? error : error?.message || JSON.stringify(error)) : [];
    const details = [...new Set([job.message, ...errors].filter(Boolean))];
    byId('error-details').textContent = details.length ? details.join('\n\n') : '当前未记录详细错误。请打开日志目录查看传输日志。';
    byId('error-dialog').showModal();
  }

  function acceptState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const previous = model.snapshot;
    const previousJobs = new Map((previous.jobs || []).map(job => [job.id, job.status]));
    model.snapshot = snapshot;
    paintEngine();
    for (const side of sides) {
      paintAccount(side);
      const pane = model.panes[side];
      const info = account(side);
      const prior = previous.accounts?.[side] || {};
      if (!info.connected && prior.connected) {
        ++pane.request;
        Object.assign(pane, { entries: [], selected: new Set(), loaded: false, loading: false, error: '', path: rootPath(side) });
        paintPane(side);
      } else if (info.connected && ready() && (!prior.connected || previous.engine?.status !== 'ready' || prior.mount !== info.mount)) {
        loadDirectory(side, prior.mount === info.mount && pane.path ? pane.path : rootPath(side), true);
      } else if (!info.connected) {
        paintPane(side);
      } else {
        paintPath(side);
        updateSelection(side);
      }
    }
    paintJobs();
    updateCopyButtons();
    const newlyCompleted = (snapshot.jobs || []).filter(job => job.status === 'completed' && previousJobs.has(job.id) && previousJobs.get(job.id) !== 'completed');
    for (const side of sides) {
      const pane = model.panes[side];
      if (newlyCompleted.some(job => String(job.targetPath || '').startsWith(`${rootPath(side)}/`) || job.targetPath === rootPath(side)) && !pane.loading) {
        loadDirectory(side, pane.path, true);
      }
    }
  }

  async function refreshState() {
    const state = await call('getState');
    acceptState(state);
  }

  function clearCredentials() {
    ['cookie-input', 'access-token-input', 'refresh-token-input'].forEach(id => { byId(id).value = ''; });
  }

  function openAccount(side) {
    model.accountSide = side;
    clearCredentials();
    byId('account-dialog-title').textContent = `连接${labels[side]}网盘`;
    byId('manual-credentials').hidden = true;
    byId('manual-toggle').setAttribute('aria-expanded', 'false');
    byId('token-fields').hidden = side !== 'pan115';
    byId('cookie-input').closest('.field').hidden = side === 'pan115';
    byId('credential-hint').textContent = side === 'pan115' ? '使用 115 Open 的授权令牌，Refresh Token 用于更新登录状态。' : '保存后将验证连接，凭证不会显示在任务记录中。';
    const status = byId('login-message');
    status.classList.remove('error');
    status.textContent = account(side).connected ? '当前账号已连接。重新授权或保存凭证将更新该网盘的连接。' : '';
    byId('browser-login-button').disabled = !ready();
    byId('save-credentials-button').disabled = !ready();
    byId('account-dialog').showModal();
  }

  async function browserLogin() {
    const button = byId('browser-login-button');
    const status = byId('login-message');
    const side = model.accountSide;
    status.classList.remove('error');
    status.textContent = '正在打开登录页面，请按页面提示完成授权…';
    button.disabled = true;
    try {
      const result = await call('login', { side });
      if (model.accountSide === side) status.textContent = result?.message || '已打开登录入口。完成后将自动更新连接状态；也可使用下方手动凭证。';
      await refreshState();
      if (model.accountSide === side && account(side).connected) { status.textContent = '连接成功，可以关闭此窗口并浏览文件。'; }
    } catch (error) {
      if (model.accountSide === side) { status.classList.add('error'); status.textContent = errorMessage(error); }
    } finally { button.disabled = !ready(); }
  }

  async function saveCredentials(event) {
    event.preventDefault();
    const side = model.accountSide;
    const cookie = byId('cookie-input').value.trim();
    const accessToken = byId('access-token-input').value.trim();
    const refreshToken = byId('refresh-token-input').value.trim();
    const status = byId('login-message');
    status.classList.remove('error');
    if ((side === 'quark' && !cookie) || (side === 'pan115' && (!accessToken || !refreshToken))) {
      status.classList.add('error');
      status.textContent = side === 'quark' ? '请先粘贴夸克 Cookie。' : '请同时填写 115 Open Access Token 和 Refresh Token。';
      return;
    }
    const button = byId('save-credentials-button');
    button.disabled = true;
    status.textContent = '正在保存并检查连接…';
    try {
      await call('saveCredentials', side === 'quark' ? { side, cookie } : { side, accessToken, refreshToken });
      clearCredentials();
      await refreshState();
      if (model.accountSide === side) {
        if (account(side).connected) { byId('account-dialog').close(); toast(`${labels[side]}网盘已连接。`); }
        else status.textContent = '凭证已保存，正在等待连接结果。';
      }
    } catch (error) {
      if (model.accountSide === side) { status.classList.add('error'); status.textContent = errorMessage(error); }
    } finally { button.disabled = !ready(); }
  }

  function prepareCopy(side) {
    const destination = side === 'quark' ? 'pan115' : 'quark';
    const pane = model.panes[side];
    if (!pane.selected.size || !ready() || !account(destination).connected) return;
    model.pendingCopy = { side, sourceDir: pane.path, names: [...pane.selected], targetDir: model.panes[destination].path };
    byId('copy-dialog-title').textContent = `${labels[side]} → ${labels[destination]}`;
    byId('copy-selection-description').textContent = `将复制 ${pane.selected.size} 个选中项目，包含文件夹中的全部子目录和文件。`;
    byId('copy-source').textContent = pane.path;
    byId('copy-destination').textContent = model.panes[destination].path;
    byId('copy-error').textContent = '';
    byId('copy-dialog').showModal();
  }

  async function confirmCopy() {
    if (!model.pendingCopy) return;
    const request = model.pendingCopy;
    const button = byId('confirm-copy-button');
    button.disabled = true;
    byId('copy-error').textContent = '';
    try {
      await call('startTransfer', request);
      const pane = model.panes[request.side];
      if (pane.path === request.sourceDir) { request.names.forEach(name => pane.selected.delete(name)); updateSelection(request.side); }
      model.pendingCopy = null;
      byId('copy-dialog').close();
      toast('已加入传输任务，将先扫描目录并检查缓存空间。');
      await refreshState();
    } catch (error) { byId('copy-error').textContent = errorMessage(error); }
    finally { button.disabled = false; }
  }

  function bindEvents() {
    document.querySelectorAll('[data-action="account"]').forEach(button => button.addEventListener('click', () => openAccount(button.dataset.side)));
    document.querySelectorAll('[data-action="up"]').forEach(button => button.addEventListener('click', () => {
      const side = button.dataset.side;
      const path = model.panes[side].path;
      loadDirectory(side, path.slice(0, path.lastIndexOf('/')) || rootPath(side));
    }));
    document.querySelectorAll('[data-action="refresh"]').forEach(button => button.addEventListener('click', () => loadDirectory(button.dataset.side, model.panes[button.dataset.side].path, true)));
    for (const side of sides) {
      byId(`${side}-select-all`).addEventListener('change', event => {
        const pane = model.panes[side];
        pane.selected = event.target.checked ? new Set(pane.entries.map(entry => entry.name)) : new Set();
        updateSelection(side);
      });
    }
    document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => byId(button.dataset.close).close()));
    byId('account-dialog').addEventListener('close', clearCredentials);
    byId('copy-dialog').addEventListener('close', () => { model.pendingCopy = null; });
    byId('manual-toggle').addEventListener('click', () => {
      const panel = byId('manual-credentials');
      panel.hidden = !panel.hidden;
      byId('manual-toggle').setAttribute('aria-expanded', String(!panel.hidden));
      if (!panel.hidden) byId(model.accountSide === 'quark' ? 'cookie-input' : 'access-token-input').focus();
    });
    byId('browser-login-button').addEventListener('click', browserLogin);
    byId('credentials-form').addEventListener('submit', saveCredentials);
    byId('copy-to-115').addEventListener('click', () => prepareCopy('quark'));
    byId('copy-to-quark').addEventListener('click', () => prepareCopy('pan115'));
    byId('confirm-copy-button').addEventListener('click', confirmCopy);
    byId('settings-button').addEventListener('click', () => byId('settings-dialog').showModal());
    byId('choose-cache-button').addEventListener('click', () => withButton(byId('choose-cache-button'), async () => {
      await call('chooseCache');
      await refreshState();
    }));
    const openFolder = kind => call('openFolder', { kind }).catch(error => toast(errorMessage(error), true));
    document.querySelectorAll('[data-open-folder]').forEach(button => button.addEventListener('click', () => openFolder(button.dataset.openFolder)));
    byId('logs-button').addEventListener('click', () => openFolder('logs'));
    byId('startup-logs').addEventListener('click', () => openFolder('logs'));
    byId('queue-toggle').addEventListener('click', async () => {
      byId('queue-toggle').disabled = true;
      try {
        await call(model.snapshot.paused ? 'resumeQueue' : 'pauseQueue');
        await refreshState();
      } catch (error) { toast(errorMessage(error), true); }
      finally { model.jobsSignature = ''; paintJobs(); }
    });
    window.addEventListener('beforeunload', () => { if (typeof model.unsubscribe === 'function') model.unsubscribe(); });
  }

  async function initialize() {
    bindEvents();
    for (const side of sides) { model.panes[side].path = rootPath(side); paintPane(side); }
    if (!api) {
      acceptState({ ...model.snapshot, engine: { status: 'error', error: '此页面需要在桌面应用中运行。请启动开发项目或打包后的 EXE 文件。' } });
      return;
    }
    try {
      if (typeof api.onState === 'function') model.unsubscribe = api.onState(acceptState);
      await refreshState();
    } catch (error) {
      acceptState({ ...model.snapshot, engine: { status: 'error', error: errorMessage(error) } });
    }
  }

  initialize();
})();
