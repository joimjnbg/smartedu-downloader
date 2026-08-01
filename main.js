const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const lib = require('./lib');
const net = require('./net');
const catalog = require('./catalog');
const { DownloadQueue } = require('./downloader');

let mainWindow;
let accessToken = '';

// ─── Token persistence ──────────────────────────────────────────────────────

const tokenFile = path.join(app.getPath('userData'), 'token.json');

function loadToken() {
  try {
    if (fs.existsSync(tokenFile)) {
      const d = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      accessToken = d.access_token || '';
    }
  } catch {}
}

function saveToken(token) {
  accessToken = token || '';
  try {
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: accessToken }), { mode: 0o600 });
  } catch {}
}

// ─── HLS video download: DISABLED ──────────────────────────────────────────
//
// 平台视频使用 AES-128 加密 + 华为 WAF (Web Application Firewall) 双重保护。
// 密钥服务器 ndvideo-key.ykt.eduyun.cn 部署了 JS Challenge 防护机制，
// 需要真实浏览器执行 JavaScript 才能通过验证。Electron 的 net.fetch 无法
// 执行 JS，即使使用隐藏 BrowserWindow 加载页面触发 WAF，也会因 Electron
// 与标准浏览器的指纹差异导致 WAF 拒绝提供服务或返回伪造密钥。
//
// 先后尝试过以下方案均不可靠：
//   1. net.fetch 直接请求 → WAF 拦截 403
//   2. 隐藏 BrowserWindow 加载根页面触发 WAF JS → Cookie 无法跨进程共享
//   3. 主窗口 iframe + executeJavaScript → WAF 检测到非标准浏览器指纹
//   4. 独立隐藏窗口 + session.webRequest 注入认证头 → 仍被 WAF 识别拦截
//
// 结论：在不运行完整 Chromium 浏览器的情况下，无法可靠绕过华为 WAF 获取
// 解密密钥。因此 v1.3.0 起取消视频下载功能。如需下载视频，请在浏览器中
// 打开后手动保存，或使用浏览器扩展程序。

// ─── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 740,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { loadToken(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── Delegated helpers ──────────────────────────────────────────────────────
// Pure-logic functions are in lib.js (testable without Electron)

const getUrlParam = lib.getUrlParam;
const sanitize = lib.sanitize;
const detectType = lib.detectType;
const extractUrl = lib.extractUrl;
const makeFileNode = lib.makeFileNode;
const parseRelationResources = lib.parseRelationResources;

const fetchJson = (url) => net.fetchJson(url, { token: accessToken, retries: 3, timeoutMs: 20000 });

// ─── URL Handlers ──────────────────────────────────────────────────────────

async function handleBasicWork(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
  const title = data.title || '未命名';

  const cp = data.custom_properties || {};
  const format = cp.format || 'pdf';
  const size = cp.size || 0;
  let info = extractUrl(data.ti_items, format, size);

  if (!info && data.relations) {
    const tree = parseRelationResources(data.relations, null, {});
    if (tree.length) return { title: sanitize(title), tree };
  }

  if (!info) throw new Error('未找到可下载的资源');
  return { title, tree: [makeFileNode(sanitize(title), format, info.format, info.url, size)] };
}

async function handleTextbook(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  const { title, node } = await resolveTextbook(contentId);
  return { title, tree: [node] };
}

async function resolveTextbook(contentId) {
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${contentId}.json`);
  const title = data.title || '未命名';
  const cp = data.custom_properties || {};
  const format = cp.format || 'pdf';
  const size = cp.size || 0;
  const info = extractUrl(data.ti_items, format, size);
  if (!info) throw new Error('未找到可下载的资源');
  return { title, node: makeFileNode(sanitize(title), format, info.format, info.url, size) };
}

async function handleClassActivity(url) {
  const activityId = getUrlParam(url, 'activityId');
  if (!activityId) throw new Error('未找到 activityId');
  const data = await fetchJson(`https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${activityId}.json`);
  const title = data.title || '未命名';
  const relations = data.relations || {};
  const tlist = data.teacher_list || [];
  const teacherName = tlist.length ? tlist[0].name || '' : '';
  const prefix = teacherName ? `[${sanitize(teacherName)}]` : '';
  const tree = parseRelationResources(relations, null, {
    national_course_resource: '课程资源',
    lesson_plan_design: '教学设计',
    classroom_record: '课堂实录',
    teaching_assets: '教学资源',
  });
  return { title: prefix + sanitize(title), tree };
}

async function handleCourseware(url) {
  const resourceId = getUrlParam(url, 'resourceId');
  if (!resourceId) throw new Error('未找到 resourceId');
  const data = await fetchJson(`https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2/prepare_sub_type/resources/details/${resourceId}.json`);
  const title = data.title || '未命名';
  const cp = data.custom_properties || {};
  const format = cp.format || '';
  const size = cp.size || 0;

  let info = extractUrl(data.ti_items, format, size);

  if (!info && data.relations) {
    const tree = parseRelationResources(data.relations, null, {});
    if (tree.length) return { title: sanitize(title), tree };
  }

  if (!info) throw new Error('未找到可下载的资源');
  return { title, tree: [makeFileNode(sanitize(title), format, info.format, info.url, size)] };
}

async function handleOneTeacher(url) {
  const lessonId = getUrlParam(url, 'lessonId');
  if (!lessonId) throw new Error('未找到 lessonId');
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/prepare_lesson/resources/details/${lessonId}.json`);
  const title = data.title || '未命名';
  const relations = data.relations || {};
  const tlist = data.teacher_list || [];
  const teacherName = tlist.length ? tlist[0].name || '' : '';
  const prefix = teacherName ? `[${sanitize(teacherName)}]` : '';
  const tree = parseRelationResources(relations, null, {
    lesson_plan_design: '教学设计', classroom_record: '课堂实录', teaching_assets: '教学资源',
  });
  return { title: prefix + sanitize(title), tree };
}

async function handleExperiment(url) {
  const courseId = getUrlParam(url, 'courseId');
  if (!courseId) throw new Error('未找到 courseId');
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/experiment/resources/details/${courseId}.json`);
  const title = data.title || '未命名';
  const relations = data.relations || {};
  const tlist = data.teacher_list || [];
  const teacherName = tlist.length ? tlist[0].name || '' : '';
  const prefix = teacherName ? `[${sanitize(teacherName)}]` : '';
  const tree = parseRelationResources(relations, null, {
    lesson_1: '课程内容', experiment_video: '实验视频',
  });
  return { title: prefix + sanitize(title), tree };
}

async function handleQualityCourse(url) {
  const courseId = getUrlParam(url, 'courseId');
  if (!courseId) throw new Error('未找到 courseId');
  const apiUrl = url.includes('jpk.basic.smartedu.cn') || url.includes('yearQualityCourse')
    ? `https://s-file-1.ykt.cbern.com.cn/competitive/elite_lesson/resources/${courseId}.json`
    : `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/${courseId}.json`;
  const data = await fetchJson(apiUrl);
  const title = data.title || '未命名';
  const relations = data.relations || {};
  const tree = parseRelationResources(relations, null, { course_resource: '课程资源' });
  return { title: sanitize(title), tree };
}

async function handleThematicCourse(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  let foundTitle = '专题课程';

  try {
    const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
    foundTitle = data.title || foundTitle;
    const cp = data.custom_properties || {};
    const format = cp.format || '';
    const size = cp.size || 0;

    if (data.relations) {
      const tree = parseRelationResources(data.relations, null, {});
      if (tree.length) return { title: sanitize(foundTitle), tree };
    }

    const info = extractUrl(data.ti_items, format, size);
    if (info) return { title: sanitize(foundTitle), tree: [makeFileNode(sanitize(foundTitle), format, info.format, info.url, size)] };
  } catch {}

  try {
    const list = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/thematic_course/${contentId}/resources/list.json`);
    const children = [];
    for (const item of list) {
      const title = item.title || '未命名';
      const cp = item.custom_properties || {};
      const format = cp.format || 'pdf';
      const size = cp.size || 0;
      const info = extractUrl(item.ti_items, format, size);
      if (info) children.push(makeFileNode(sanitize(title), format, info.format, info.url, size));
    }
    if (children.length) return { title: sanitize(foundTitle), tree: children };
  } catch {}

  throw new Error('未找到可下载的资源');
}

async function handleVideo(url) {
  throw new Error(
    '暂不支持下载视频。\n\n' +
    '原因：平台视频使用 AES-128 加密，密钥服务器 ndvideo-key.ykt.eduyun.cn 部署了华为 WAF (Web Application Firewall) JS Challenge 防护。\n\n' +
    '该 WAF 需要真实浏览器环境执行 JavaScript 才能通过验证，Electron 环境无法可靠绕过。' +
    'v1.2.x 中尝试了隐藏 BrowserWindow + iframe 等多种方案，' +
    '但 WAF 始终能检测到非标准浏览器指纹并拒绝提供解密密钥。\n\n' +
    '如需下载视频，请在浏览器中打开后手动保存，或使用浏览器扩展程序。'
  );
}

// ─── IPC: Token ─────────────────────────────────────────────────────────────

ipcMain.handle('get-token', () => accessToken);
ipcMain.handle('set-token', (e, token) => { saveToken(token); return true; });

// ─── IPC: Misc ──────────────────────────────────────────────────────────────

ipcMain.handle('open-external', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) {
    const { shell } = require('electron');
    shell.openExternal(url);
    return true;
  }
  return false;
});

// ─── IPC: URL Router ────────────────────────────────────────────────────────

ipcMain.handle('fetch-resource', async (event, pageUrl) => {
  try {
    const type = detectType(pageUrl);
    let result;
    switch (type) {
      case 'basicWork':     result = await handleBasicWork(pageUrl); break;
      case 'textbook':      result = await handleTextbook(pageUrl); break;
      case 'classActivity': result = await handleClassActivity(pageUrl); break;
      case 'courseware':    result = await handleCourseware(pageUrl); break;
      case 'oneTeacher':    result = await handleOneTeacher(pageUrl); break;
      case 'experiment':    result = await handleExperiment(pageUrl); break;
      case 'qualityCourse': result = await handleQualityCourse(pageUrl); break;
      case 'thematicCourse': result = await handleThematicCourse(pageUrl); break;
      case 'video':         result = await handleVideo(pageUrl); break;
      default:              throw new Error('暂不支持此类型的链接');
    }
    return { success: true, title: result.title, tree: result.tree, type };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Batch Download ────────────────────────────────────────────────────

let activeQueue = null;
let lastBatch = null;

function dedupePaths(files) {
  const seen = new Map();
  return files.map((f) => {
    const base = f.relativePath;
    let rp = base;
    let n = 2;
    while (seen.has(rp)) rp = base.replace(/(\.\w+)?$/, `_${n++}$1`);
    seen.set(rp, true);
    return { ...f, relativePath: rp };
  });
}

function estimateTotalBytes(files) {
  return files.reduce((sum, f) => sum + (f.size || 0), 0);
}

function startQueue(batch, files, concurrency) {
  const queue = new DownloadQueue({
    concurrency: Math.min(Math.max(parseInt(concurrency, 10) || 4, 1), 8),
    onProgress: (file, { downloaded, total, speed }) => {
      batch.bytesTotal = Math.max(batch.bytesTotal, total || 0);
      if (mainWindow && !batch.canceled) {
        mainWindow.webContents.send('download-progress', {
          type: 'file',
          fileName: file.name,
          relativePath: file.relativePath,
          downloaded, total, speed,
          bytesTotal: batch.bytesTotal,
          bytesDone: batch.bytesDone + downloaded,
          completed: queue.stats.completed,
          totalFiles: queue.stats.total,
        });
      }
    },
    onFileDone: (file, result) => {
      batch.results.push({ name: file.name, relativePath: file.relativePath, url: file.url, ...result });
      batch.bytesDone += result.bytes || 0;
      if (mainWindow && !batch.canceled) {
        mainWindow.webContents.send('download-progress', {
          type: 'file-done',
          fileName: file.name,
          relativePath: file.relativePath,
          success: result.success,
          error: result.error,
          bytesDone: batch.bytesDone,
          bytesTotal: batch.bytesTotal,
          completed: queue.stats.completed,
          totalFiles: queue.stats.total,
        });
      }
    },
  });
  batch.queue = queue;

  for (const f of files) {
    queue.enqueue({
      url: f.url,
      dest: path.join(batch.destDir, f.relativePath),
      name: f.name,
      relativePath: f.relativePath,
      token: accessToken,
    });
  }
  return queue;
}

function sendBatchDone(batch, queue) {
  if (!mainWindow) return;
  const ok = batch.results.filter((r) => r.success).length;
  const fail = batch.results.filter((r) => !r.success).length;
  mainWindow.webContents.send('download-progress', {
    type: 'batch-done',
    canceled: batch.canceled || queue.canceled,
    results: batch.results,
    stats: { ok, fail, canceled: queue.stats.canceled },
    dir: batch.destDir,
  });
}

ipcMain.handle('download-files', async (event, { files, concurrency }) => {
  const saveDir = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载保存目录',
  });
  if (saveDir.canceled) return { success: false, canceled: true };

  const destDir = saveDir.filePaths[0];
  const deduped = dedupePaths(files);

  // Best-effort free-disk check (Node ≥ 18.15)
  try {
    const st = fs.statfsSync(destDir);
    const free = st.bavail * st.bsize;
    const need = estimateTotalBytes(deduped);
    if (need > 0 && free < need) {
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['继续下载', '取消'],
        defaultId: 1,
        title: '磁盘空间不足',
        message: `目标磁盘可用 ${(free / 1024 / 1024 / 1024).toFixed(1)} GB，本次下载预计需要 ${(need / 1024 / 1024 / 1024).toFixed(2)} GB。`,
      });
      if (choice.response === 1) return { success: false, canceled: true };
    }
  } catch {}

  const batch = {
    destDir,
    queue: null,
    results: [],
    canceled: false,
    bytesTotal: 0,
    bytesDone: 0,
  };

  activeQueue = batch;
  lastBatch = batch;
  const queue = startQueue(batch, deduped, concurrency);

  await queue.whenIdle();
  if (activeQueue === batch) activeQueue = null;
  sendBatchDone(batch, queue);
  return { success: true, results: batch.results, dir: destDir, canceled: batch.canceled || queue.canceled };
});

ipcMain.handle('retry-failed', async (event, { concurrency }) => {
  if (!lastBatch) return { success: false, error: '没有可重试的下载记录' };
  const failed = lastBatch.results.filter((r) => !r.success && r.url);
  if (!failed.length) return { success: false, error: '没有失败的文件' };
  if (activeQueue && activeQueue.queue) return { success: false, error: '已有下载正在进行' };

  const batch = {
    destDir: lastBatch.destDir,
    queue: null,
    results: [],
    canceled: false,
    bytesTotal: 0,
    bytesDone: 0,
  };
  activeQueue = batch;
  const files = failed.map((r) => ({
    url: r.url,
    name: r.name,
    relativePath: r.relativePath,
    format: '',
    size: 0,
  }));
  const queue = startQueue(batch, files, concurrency);
  await queue.whenIdle();
  if (activeQueue === batch) activeQueue = null;
  sendBatchDone(batch, queue);
  return { success: true, results: batch.results, dir: batch.destDir, canceled: batch.canceled || queue.canceled };
});

ipcMain.handle('cancel-download', () => {
  if (activeQueue && activeQueue.queue) {
    activeQueue.canceled = true;
    activeQueue.queue.cancel();
    return true;
  }
  return false;
});

// ─── IPC: Textbook Catalog ──────────────────────────────────────────────────
// 目录数据源（教材全量列表）：
//   data_version.json 返回若干分片 URL，每个分片约 1000 本教材的元数据。
//   首次加载后缓存到 userData/catalog-cache.json，之后秒开。

const catalogCacheFile = () => path.join(app.getPath('userData'), 'catalog-cache.json');

let catalogStore = null;

async function loadCatalogStore() {
  if (catalogStore) return catalogStore;
  let urls = null;
  try {
    const v = await fetchJson(catalog.CATALOG_VERSION_URL);
    urls = String((v && v.urls) || '').split(',').map((s) => s.trim()).filter(Boolean);
  } catch {}
  if (fs.existsSync(catalogCacheFile())) {
    try {
      const cached = JSON.parse(fs.readFileSync(catalogCacheFile(), 'utf8'));
      if (cached && Array.isArray(cached.books) && (!urls || (cached.urls || []).join() === urls.join())) {
        catalogStore = cached;
        return cached;
      }
    } catch {}
  }
  if (!urls || !urls.length) throw new Error('无法获取教材目录版本信息');
  const books = await catalog.fetchAllBooks(fetchJson, urls);
  catalogStore = { urls, books };
  try {
    fs.mkdirSync(path.dirname(catalogCacheFile()), { recursive: true });
    fs.writeFileSync(catalogCacheFile(), JSON.stringify(catalogStore));
  } catch {}
  return catalogStore;
}

ipcMain.handle('catalog:load', async () => {
  try {
    const store = await loadCatalogStore();
    return { success: true, total: store.books.length, cached: fs.existsSync(catalogCacheFile()) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('catalog:tree', (event, defaultTag) => {
  try {
    if (!catalogStore) throw new Error('请先加载目录');
    const parsed = catalog.parseCatalogUrl(defaultTag);
    const books = catalog.filterByTagIds(catalogStore.books, parsed ? parsed.tagIds : []);
    const tree = catalog.buildTree(books);
    return { success: true, tree, tagPath: parsed ? parsed.tagIds : [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('catalog:search', (event, query) => {
  try {
    if (!catalogStore) throw new Error('请先加载目录');
    const hits = catalog.searchBooks(catalogStore.books, query);
    const items = hits.slice(0, 300).map((b) => ({
      id: b.id,
      title: b.title,
      publisher: (b.provider_list && b.provider_list[0] && b.provider_list[0].name) || '',
      path: catalog.bookPath(b),
    }));
    return { success: true, total: hits.length, shown: items.length, items };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('catalog:books', async (event, list) => {
  try {
    const items = Array.isArray(list) ? list : [];
    if (!items.length) throw new Error('未选择教材');
    const total = items.length;
    const results = [];
    let done = 0;
    const workers = Array.from({ length: Math.min(8, total) }, async () => {
      while (items.length) {
        const item = items.shift();
        try {
          const { title, node } = await resolveTextbook(item.id);
          results.push({ ok: true, id: item.id, path: item.path, title, node });
        } catch (e) {
          results.push({ ok: false, id: item.id, path: item.path, error: e.message });
        }
        done++;
        if (mainWindow) mainWindow.webContents.send('catalog-progress', { done, total });
      }
    });
    await Promise.all(workers);

    const root = { type: 'folder', name: '教材', children: [] };
    for (const r of results) {
      if (!r.ok) continue;
      const parts = String(r.path || '').split('/').filter(Boolean);
      let cur = root;
      for (const p of parts) {
        let f = cur.children.find((c) => c.type === 'folder' && c.name === p);
        if (!f) { f = { type: 'folder', name: p, children: [] }; cur.children.push(f); }
        cur = f;
      }
      cur.children.push({ type: 'file', ...r.node });
    }
    const okCount = results.filter((r) => r.ok).length;
    return {
      success: true,
      title: `教材目录（成功 ${okCount}/${total}）`,
      tree: root.children,
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, path: r.path, error: r.error })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
