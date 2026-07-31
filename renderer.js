// ─── DOM refs ──────────────────────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const btnFetch = document.getElementById('btnFetch');
const btnDownload = document.getElementById('btnDownload');
const btnCancel = document.getElementById('btnCancel');
const btnSelectAll = document.getElementById('btnSelectAll');
const btnDeselectAll = document.getElementById('btnDeselectAll');
const resultCard = document.getElementById('resultCard');
const resTitle = document.getElementById('resTitle');
const treeContainer = document.getElementById('treeContainer');
const statusEl = document.getElementById('status');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressFile = document.getElementById('progressFile');
const selectCount = document.getElementById('selectCount');
const downloadList = document.getElementById('downloadList');
const tokenBadge = document.getElementById('tokenBadge');
const tokenDialog = document.getElementById('tokenDialog');
const tokenInput = document.getElementById('tokenInput');
const btnTokenSave = document.getElementById('btnTokenSave');
const btnTokenCancel = document.getElementById('btnTokenCancel');
const concurrencySel = document.getElementById('concurrencySel');

let flatFiles = [];
let flatById = new Map();
let fileRows = new Map();
let accessToken = '';

// ─── Token Management ──────────────────────────────────────────────────────

async function initToken() {
  accessToken = await window.api.getToken() || '';
  updateTokenBadge();
}

function updateTokenBadge() {
  if (accessToken) {
    const short = accessToken.substring(0, 12) + '...';
    tokenBadge.textContent = '🔑 ' + short;
    tokenBadge.style.background = '#dcfce7';
    tokenBadge.style.color = '#16a34a';
  } else {
    tokenBadge.textContent = '🔑 未设置';
    tokenBadge.style.background = '#e5e7eb';
    tokenBadge.style.color = '#666';
  }
}

tokenBadge.addEventListener('click', () => {
  tokenInput.value = accessToken || '';
  tokenDialog.style.display = 'flex';
  tokenInput.focus();
});

btnTokenCancel.addEventListener('click', () => {
  tokenDialog.style.display = 'none';
});

btnTokenSave.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  await window.api.setToken(token);
  accessToken = token;
  updateTokenBadge();
  tokenDialog.style.display = 'none';
  setStatus(token ? 'Token 已保存' : 'Token 已清除', 'info');
});

tokenDialog.addEventListener('click', (e) => {
  if (e.target === tokenDialog) tokenDialog.style.display = 'none';
});

// ─── Status ────────────────────────────────────────────────────────────────

function setStatus(msg, type) { statusEl.textContent = msg; statusEl.className = 'status ' + type; }
function hideStatus() { statusEl.className = 'status'; statusEl.textContent = ''; }

function setLoading(v) {
  btnFetch.disabled = v;
  btnFetch.textContent = v ? '解析中...' : '解析';
}

// ─── Tree ──────────────────────────────────────────────────────────────────
// Folders keep a `_children` array of descendant file records (structure-based,
// no DOM queries per node).

let nodeIdCounter = 0;

function buildFileList(nodes, parentPath, parentKey) {
  const list = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      const fp = parentPath ? `${parentPath}/${node.name}` : node.name;
      node._children = [];
      list.push(...buildFileList(node.children || [], fp, node._children));
    } else {
      const id = ++nodeIdCounter;
      const rp = parentPath ? `${parentPath}/${node.name}` : node.name;
      const rec = { ...node, id, relativePath: rp, checked: true };
      if (parentKey) parentKey.push(rec);
      list.push(rec);
    }
  }
  return list;
}

function renderTree(nodes, container, depth) {
  for (const node of nodes) {
    const wrapper = document.createElement('div');
    wrapper.className = 'tree-node';

    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = (depth * 22) + 'px';

    if (node.type === 'folder') {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle expanded';
      toggle.textContent = '▶';
      row.appendChild(toggle);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tree-check';
      row.appendChild(cb);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = '📁';
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = node.name;
      row.appendChild(name);

      wrapper.appendChild(row);

      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'tree-children';
      wrapper.appendChild(childrenDiv);
      renderTree(node.children || [], childrenDiv, depth + 1);

      const setFolderChecked = (checked) => {
        for (const child of node._children || []) child.checked = checked;
        const inputs = childrenDiv.querySelectorAll('.tree-check');
        for (const c of inputs) { c.checked = checked; c.indeterminate = false; }
        updateSelectCount();
      };

      const updateFolderState = () => {
        const children = node._children || [];
        const checkedCount = children.reduce((n, c) => n + (c.checked ? 1 : 0), 0);
        if (checkedCount === 0) { cb.checked = false; cb.indeterminate = false; }
        else if (checkedCount === children.length) { cb.checked = true; cb.indeterminate = false; }
        else { cb.checked = false; cb.indeterminate = true; }
      };

      cb.addEventListener('change', () => setFolderChecked(cb.checked));
      childrenDiv.addEventListener('change', updateFolderState);

      let expanded = true;
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT') return;
        expanded = !expanded;
        childrenDiv.style.display = expanded ? '' : 'none';
        toggle.classList.toggle('expanded', expanded);
      });

    } else {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle hidden';
      toggle.textContent = '▶';
      row.appendChild(toggle);

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'tree-check';
      cb.checked = true;
      row.appendChild(cb);

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      const fmt = (node.format || '').toLowerCase();
      if (['mp4', 'avi', 'mov', 'flv', 'm3u8', 'ts'].includes(fmt)) icon.textContent = '🎬';
      else if (['pdf'].includes(fmt)) icon.textContent = '📄';
      else if (['ppt', 'pptx'].includes(fmt)) icon.textContent = '📊';
      else if (['doc', 'docx'].includes(fmt)) icon.textContent = '📝';
      else if (['xls', 'xlsx'].includes(fmt)) icon.textContent = '📋';
      else icon.textContent = '📎';
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = node.name;
      row.appendChild(name);

      if (node.format) {
        const fmt = document.createElement('span');
        fmt.className = 'tree-fmt';
        fmt.textContent = node.format.toUpperCase();
        row.appendChild(fmt);
      }
      if (node.size) {
        const sz = document.createElement('span');
        sz.className = 'tree-size';
        sz.textContent = formatSize(node.size);
        row.appendChild(sz);
      }

      wrapper.appendChild(row);

      cb.addEventListener('change', () => {
        const f = flatById.get(node.id);
        if (f) f.checked = cb.checked;
        updateSelectCount();
        wrapper.closest('.tree-children')?.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }

    container.appendChild(wrapper);
  }
}

function updateSelectCount() {
  selectCount.textContent = `已选 ${flatFiles.length ? flatFiles.filter(f => f.checked).length : 0} / ${flatFiles.length}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, s = bytes;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return s.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function formatSpeed(bps) {
  if (!bps || bps <= 0) return '';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0, s = bps;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return s.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

// ─── Parse ─────────────────────────────────────────────────────────────────

btnFetch.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return setStatus('请输入链接', 'error');
  hideStatus();
  setLoading(true);
  resultCard.style.display = 'none';
  progressWrap.style.display = 'none';

  try {
    const res = await window.api.fetchResource(url);
    if (!res.success) return setStatus('解析失败: ' + res.error, 'error');

    resTitle.textContent = '📚 ' + res.title;
    const data = res.tree || [];

    nodeIdCounter = 0;
    flatFiles = buildFileList(data, '', null);
    flatById = new Map(flatFiles.map(f => [f.id, f]));

    treeContainer.innerHTML = '';
    renderTree(data, treeContainer, 0);
    updateSelectCount();

    resultCard.style.display = 'block';
    setStatus(`解析成功！找到 ${flatFiles.length} 个可下载文件`, 'success');
  } catch (e) {
    setStatus('请求失败: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
});

// ─── Select / Deselect ─────────────────────────────────────────────────────

btnSelectAll.addEventListener('click', () => {
  for (const f of flatFiles) f.checked = true;
  const cbs = treeContainer.querySelectorAll('.tree-check');
  for (const cb of cbs) { cb.checked = true; cb.indeterminate = false; }
  updateSelectCount();
});

btnDeselectAll.addEventListener('click', () => {
  for (const f of flatFiles) f.checked = false;
  const cbs = treeContainer.querySelectorAll('.tree-check');
  for (const cb of cbs) { cb.checked = false; cb.indeterminate = false; }
  updateSelectCount();
});

// ─── Download ──────────────────────────────────────────────────────────────

function clearDownloadList() {
  fileRows.clear();
  downloadList.innerHTML = '<div class="dl-empty">暂无下载记录</div>';
}

function getFileRow(relativePath, name) {
  let row = fileRows.get(relativePath);
  if (!row) {
    const empty = downloadList.querySelector('.dl-empty');
    if (empty) empty.remove();
    row = document.createElement('div');
    row.className = 'dl-item';
    row.innerHTML = '<span class="dl-name"></span><span class="dl-status dl">等待中</span>';
    downloadList.prepend(row);
    fileRows.set(relativePath, row);
  }
  row.querySelector('.dl-name').textContent = sanitize(name || '文件');
  return row;
}

function setFileRowState(relativePath, name, statusText, statusClass) {
  const row = getFileRow(relativePath, name);
  const s = row.querySelector('.dl-status');
  s.className = 'dl-status ' + (statusClass || 'dl');
  s.textContent = statusText;
}

function updateOverall(d) {
  if (d.bytesTotal > 0) {
    progressFill.style.width = Math.min(100, (d.bytesDone / d.bytesTotal) * 100) + '%';
  } else if (d.totalFiles) {
    const within = d.downloaded && d.total ? d.downloaded / d.total : 0;
    progressFill.style.width = Math.min(100, ((d.completed + within) / d.totalFiles) * 100) + '%';
  }
  const speedText = d.speed ? ' · ' + formatSpeed(d.speed) : '';
  if (d.totalFiles) {
    progressText.textContent = `正在下载 (${Math.min(d.completed + 1, d.totalFiles)}/${d.totalFiles})${speedText}`;
  }
  if (d.fileName) progressFile.textContent = d.fileName;
}

btnDownload.addEventListener('click', async () => {
  const selected = flatFiles.filter(f => f.checked);
  if (!selected.length) return setStatus('请先选择要下载的文件', 'error');
  hideStatus();

  btnDownload.disabled = true;
  btnFetch.disabled = true;
  btnCancel.disabled = false;
  btnCancel.style.display = '';
  progressWrap.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = '准备下载...';
  progressFile.textContent = '';
  clearDownloadList();

  try {
    const res = await window.api.downloadFiles({
      files: selected.map(f => ({ url: f.url, name: f.name, relativePath: f.relativePath, format: f.format, size: f.size })),
      concurrency: concurrencySel.value,
    });

    if (res.results) {
      for (const r of res.results) {
        setFileRowState(r.relativePath, r.name, r.success ? '完成' : (r.error || '失败'), r.success ? 'done' : 'err');
      }
    }

    if (res.canceled) {
      progressWrap.style.display = 'none';
      setStatus('下载已取消', 'info');
    } else if (res.success) {
      const ok = res.results.filter(r => r.success).length;
      const fail = res.results.length - ok;
      setStatus(`下载完成！成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`, fail ? 'error' : 'success');
      progressFill.style.width = '100%';
      progressText.textContent = `已完成 ${ok + fail} 个文件`;
    }
  } catch (e) {
    setStatus('下载出错: ' + e.message, 'error');
  } finally {
    btnDownload.disabled = false;
    btnFetch.disabled = false;
    btnCancel.style.display = 'none';
  }
});

btnCancel.addEventListener('click', () => {
  btnCancel.disabled = true;
  progressText.textContent = '正在取消...';
  window.api.cancelDownload();
});

window.api.onProgress((data) => {
  if (data.type === 'file') {
    updateOverall(data);
    const s = data.speed ? formatSpeed(data.speed) : '';
    setFileRowState(data.relativePath, data.fileName, s || '下载中', 'dl');
  } else if (data.type === 'file-done') {
    updateOverall(data);
    setFileRowState(data.relativePath, data.fileName, data.success ? '完成' : (data.error || '失败'), data.success ? 'done' : 'err');
  } else if (data.type === 'batch-done') {
    if (data.results) {
      for (const r of data.results) {
        setFileRowState(r.relativePath, r.name, r.success ? '完成' : (r.error || '失败'), r.success ? 'done' : 'err');
      }
    }
  }
});

// ─── Download History helpers ──────────────────────────────────────────────

function sanitize(s) { return s.replace(/[/\\:*?"<>|]/g, '_').trim() || '文件'; }

// ─── Init ──────────────────────────────────────────────────────────────────

initToken();
