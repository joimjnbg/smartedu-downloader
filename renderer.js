// ─── DOM refs ──────────────────────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const btnFetch = document.getElementById('btnFetch');
const btnDownload = document.getElementById('btnDownload');
const btnRetryFailed = document.getElementById('btnRetryFailed');
const retryHint = document.getElementById('retryHint');
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
const catalogUrlInput = document.getElementById('catalogUrlInput');
const btnLoadCatalog = document.getElementById('btnLoadCatalog');
const catalogStatusEl = document.getElementById('catalogStatus');
const catalogTreeWrap = document.getElementById('catalogTreeWrap');
const catalogTreeEl = document.getElementById('catalogTree');
const catalogCountEl = document.getElementById('catalogCount');
const btnCatalogAdd = document.getElementById('btnCatalogAdd');

let flatFiles = [];
let flatById = new Map();
let fileRows = new Map();
let accessToken = '';
let catalogSelected = new Map();

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
  btnRetryFailed.style.display = 'none';
  retryHint.style.display = 'none';
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

function friendlyError(err) {
  if (!err) return '未知错误';
  if (typeof err !== 'string') return '未知错误';
  if (/需要登录 Token/.test(err)) return '需要登录 Token，请点右上角🔑设置后重试';
  if (/^HTTP 401|^HTTP 403/.test(err)) return '无权限（HTTP ' + err.slice(5) + '），Token 无效或已过期';
  if (/^HTTP 404/.test(err)) return '资源不存在或已下架（HTTP 404）';
  if (/^HTTP 400/.test(err)) return '资源链接无效（HTTP 400），可能已失效';
  if (/TIMEOUT/.test(err)) return '下载超时，已自动重试仍失败';
  if (/ABORTED|aborted|abort/i.test(err)) return '下载中断（网络异常或被取消）';
  if (/文件不完整/.test(err)) return err;
  return err;
}

function updateRetryButton(results) {
  const failed = (results || []).filter((r) => !r.success && r.url);
  const hasTokenIssue = failed.some((r) => /401|403|Token/.test(r.error || ''));
  btnRetryFailed.style.display = failed.length ? '' : 'none';
  btnRetryFailed.textContent = `重试失败 ${failed.length} 个`;
  btnRetryFailed.dataset.count = String(failed.length);
  retryHint.style.display = hasTokenIssue ? '' : 'none';
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
        const errText = r.success ? '' : friendlyError(r.error);
        setFileRowState(r.relativePath, r.name, r.success ? '完成' : errText, r.success ? 'done' : 'err');
        if (!r.success && r.url) {
          const row = fileRows.get(r.relativePath);
          if (row) row.title = errText + '\n' + r.url;
        }
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
      updateRetryButton(res.results);
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
    const errText = data.success ? '' : friendlyError(data.error);
    setFileRowState(data.relativePath, data.fileName, data.success ? '完成' : errText, data.success ? 'done' : 'err');
    if (!data.success) {
      const row = fileRows.get(data.relativePath);
      if (row && data.error && /401|403|Token/.test(data.error)) {
        row.title = errText;
      }
    }
  } else if (data.type === 'batch-done') {
    if (data.results) {
      for (const r of data.results) {
        const errText = r.success ? '' : friendlyError(r.error);
        setFileRowState(r.relativePath, r.name, r.success ? '完成' : errText, r.success ? 'done' : 'err');
        if (!r.success && r.url) {
          const row = fileRows.get(r.relativePath);
          if (row) row.title = errText + '\n' + r.url;
        }
      }
      if (!data.canceled) updateRetryButton(data.results);
    }
  }
});

btnRetryFailed.addEventListener('click', async () => {
  const count = parseInt(btnRetryFailed.dataset.count || '0', 10);
  if (!count) return;
  btnRetryFailed.disabled = true;
  btnRetryFailed.textContent = '重试中...';
  progressWrap.style.display = 'block';
  progressFill.style.width = '0%';
  progressText.textContent = `正在重试 ${count} 个失败文件...`;
  progressFile.textContent = '';
  setStatus('正在重试失败文件...', 'info');
  try {
    const res = await window.api.retryFailed({ concurrency: concurrencySel.value });
    if (res.canceled) {
      progressWrap.style.display = 'none';
      setStatus('重试已取消', 'info');
    } else if (res.success) {
      const ok = res.results.filter(r => r.success).length;
      const fail = res.results.length - ok;
      setStatus(`重试完成！成功 ${ok} 个${fail ? `，仍失败 ${fail} 个` : ''}`, fail ? 'error' : 'success');
      progressFill.style.width = '100%';
      progressText.textContent = `重试完成 ${res.results.length} 个`;
    } else {
      setStatus('重试失败: ' + (res.error || '未知错误'), 'error');
    }
  } catch (e) {
    setStatus('重试出错: ' + e.message, 'error');
  } finally {
    btnRetryFailed.disabled = false;
  }
});

// ─── Download History helpers ──────────────────────────────────────────────

function sanitize(s) { return s.replace(/[/\\:*?"<>|]/g, '_').trim() || '文件'; }

// ─── Catalog (教材目录) ────────────────────────────────────────────────────

function setCatalogStatus(msg, type) {
  catalogStatusEl.textContent = msg;
  catalogStatusEl.className = 'status ' + type;
}

function updateCatalogCount() {
  catalogCountEl.textContent = `已选 ${catalogSelected.size} 本教材`;
}

function catalogPathOf(parents, name) {
  return [...parents, name].join('/');
}

function renderCatalogNode(node, container, parents, force) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (parents.length * 18) + 'px';

  if (node.children && node.children.length) {
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
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
    name.textContent = `${node.name}（${node.count}）`;
    row.appendChild(name);

    wrapper.appendChild(row);
    const childrenDiv = document.createElement('div');
    childrenDiv.className = 'tree-children';
    childrenDiv.style.display = 'none';
    wrapper.appendChild(childrenDiv);

    const updateFolderCheckbox = () => {
      let total = 0, sel = 0;
      const walk = (n) => {
        if (n.books && n.books.length) {
          total += n.books.length;
          sel += n.books.filter((b) => catalogSelected.has(b.id)).length;
        }
        for (const c of n.children) walk(c);
      };
      walk(node);
      if (sel === 0) { cb.checked = false; cb.indeterminate = false; }
      else if (sel === total) { cb.checked = true; cb.indeterminate = false; }
      else { cb.checked = false; cb.indeterminate = true; }
    };

    const setFolderChecked = (checked) => {
      const walk = (n, cur) => {
        if (n.books && n.books.length) {
          for (const b of n.books) {
            if (checked) catalogSelected.set(b.id, { id: b.id, title: b.title, path: catalogPathOf(cur, b.title) });
            else catalogSelected.delete(b.id);
            if (b._cb) b._cb.checked = checked;
          }
        }
        for (const c of n.children) walk(c, [...cur, n.name]);
      };
      walk(node, []);
      updateFolderCheckbox();
      updateCatalogCount();
    };

    cb.addEventListener('mousedown', () => {
      cb.dataset.wasInd = cb.indeterminate ? '1' : '0';
    });
    cb.addEventListener('change', () => {
      if (cb.dataset.wasInd === '1') {
        cb.checked = false;
        setFolderChecked(false);
      } else {
        setFolderChecked(cb.checked);
      }
      wrapper.closest('.tree-children')?.dispatchEvent(new Event('change', { bubbles: true }));
    });
    childrenDiv.addEventListener('change', updateFolderCheckbox);

    let rendered = force;
    if (force) {
      for (const child of node.children) renderCatalogNode(child, childrenDiv, [...parents, node.name], true);
      childrenDiv.style.display = '';
    }

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const open = childrenDiv.style.display !== 'none';
      if (!open) {
        if (!rendered) {
          for (const child of node.children) renderCatalogNode(child, childrenDiv, [...parents, node.name], false);
          rendered = true;
        }
        childrenDiv.style.display = '';
      } else {
        childrenDiv.style.display = 'none';
      }
      toggle.classList.toggle('expanded', !open);
    });
  } else {
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle hidden';
    toggle.textContent = '▶';
    row.appendChild(toggle);

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'tree-check';
    row.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = node.title;
    row.appendChild(name);

    if (node.publisher) {
      const pub = document.createElement('span');
      pub.className = 'tree-fmt';
      pub.textContent = node.publisher;
      row.appendChild(pub);
    }

    wrapper.appendChild(row);

    node._cb = cb;
    cb.addEventListener('change', () => {
      const path = catalogPathOf(parents, node.title);
      if (cb.checked) catalogSelected.set(node.id, { id: node.id, title: node.title, path });
      else catalogSelected.delete(node.id);
      updateCatalogCount();
      wrapper.closest('.tree-children')?.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  container.appendChild(wrapper);
}

function renderCatalogTree(tree) {
  catalogTreeEl.innerHTML = '';
  catalogSelected.clear();
  updateCatalogCount();
  if (!tree || !tree.children || !tree.children.length) {
    catalogTreeEl.innerHTML = '<div class="dl-empty">该目录下没有找到教材</div>';
    return;
  }
  for (const node of tree.children) renderCatalogNode(node, catalogTreeEl, [], false);
}

btnLoadCatalog.addEventListener('click', async () => {
  const url = catalogUrlInput.value.trim();
  if (!url) return setCatalogStatus('请输入教材目录链接', 'error');
  setCatalogStatus('正在加载教材目录（首次约需 10~40 秒，之后走本地缓存）...', 'info');
  btnLoadCatalog.disabled = true;
  catalogTreeWrap.style.display = 'none';
  try {
    const res = await window.api.loadCatalog();
    if (!res.success) return setCatalogStatus('目录加载失败: ' + res.error, 'error');
    const treeRes = await window.api.getCatalogTree(url);
    if (!treeRes.success) return setCatalogStatus('目录解析失败: ' + treeRes.error, 'error');
    renderCatalogTree(treeRes.tree);
    catalogTreeWrap.style.display = 'block';
    const scope = treeRes.tagPath && treeRes.tagPath.length
      ? `，当前分类范围 ${treeRes.tagPath.length} 层`
      : '，显示全部教材';
    setCatalogStatus(`目录加载成功：共 ${res.total} 本教材${scope}`, 'success');
  } catch (e) {
    setCatalogStatus('请求失败: ' + e.message, 'error');
  } finally {
    btnLoadCatalog.disabled = false;
  }
});

btnCatalogAdd.addEventListener('click', async () => {
  const selected = [...catalogSelected.values()];
  if (!selected.length) return setCatalogStatus('请先勾选要下载的教材', 'error');
  const dist = new Map();
  for (const s of selected) {
    const top = String(s.path).split('/').filter(Boolean)[0] || '其他';
    dist.set(top, (dist.get(top) || 0) + 1);
  }
  const breakdown = [...dist.entries()].map(([k, v]) => `  ${k}：${v} 本`).join('\n');
  const ok = window.confirm(`即将解析 ${selected.length} 本教材并加入下载列表：\n\n${breakdown}\n\n确认继续？`);
  if (!ok) return;
  btnCatalogAdd.disabled = true;
  btnCatalogAdd.textContent = '解析中...';
  setCatalogStatus(`正在解析 ${selected.length} 本教材（每本需联网获取下载地址）...`, 'info');
  try {
    const res = await window.api.resolveCatalogBooks(selected);
    if (!res.success) return setCatalogStatus('解析失败: ' + res.error, 'error');

    nodeIdCounter = 0;
    flatFiles = buildFileList(res.tree || [], '', null);
    flatById = new Map(flatFiles.map(f => [f.id, f]));
    resTitle.textContent = '📚 ' + res.title;
    treeContainer.innerHTML = '';
    renderTree(res.tree || [], treeContainer, 0);
    updateSelectCount();
    resultCard.style.display = 'block';
    progressWrap.style.display = 'none';

    setCatalogStatus(`已解析 ${flatFiles.length} 个文件${res.failed && res.failed.length ? `，${res.failed.length} 本失败` : ''}，请在下方结果区选择并下载`, 'success');
    if (res.failed && res.failed.length) {
      setStatus(`解析失败 ${res.failed.length} 本：${res.failed.map(f => f.path).join('、')}`, 'error');
    }
    resultCard.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setCatalogStatus('解析出错: ' + e.message, 'error');
  } finally {
    btnCatalogAdd.disabled = false;
    btnCatalogAdd.textContent = '将选中教材加入下载列表';
  }
});

window.api.onCatalogProgress((d) => {
  if (btnCatalogAdd.disabled) {
    setCatalogStatus(`正在解析教材 ${Math.min(d.done + 1, d.total)}/${d.total}...`, 'info');
  }
});

// ─── Init ──────────────────────────────────────────────────────────────────

initToken();
