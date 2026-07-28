const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const lib = require('./lib');

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
    fs.writeFileSync(tokenFile, JSON.stringify({ access_token: accessToken }));
  } catch {}
}

function authHeaders() {
  const h = { 'User-Agent': 'Mozilla/5.0' };
  if (accessToken) {
    h['Authorization'] = `Bearer ${accessToken}`;
    h['X-ND-AUTH'] = `MAC id="${accessToken}",nonce="0",mac="0"`;
  }
  return h;
}

function fetchJson(url, withAuth) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const headers = withAuth ? authHeaders() : { 'User-Agent': 'Mozilla/5.0' };
    client.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function downloadWithAuth(url, dest, onProgress) {
  // Try without auth first, then with auth if needed
  function attempt(headers) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, { headers }, (res) => {
        if (res.statusCode === 200) {
          handleResponse(res, resolve, reject, dest, onProgress);
        } else {
          res.resume(); // drain unused response
          reject({ code: res.statusCode });
        }
      }).on('error', reject);
    });
  }

  return attempt({ 'User-Agent': 'Mozilla/5.0' }).catch((err) => {
    if (err && (err.code === 401 || err.code === 403) && accessToken) {
      return attempt(authHeaders());
    }
    throw new Error(`HTTP ${err && err.code ? err.code : 'error'}`);
  });
}

function handleResponse(res, resolve, reject, dest, onProgress) {
  if (res.statusCode !== 200) {
    return reject(new Error(`HTTP ${res.statusCode}`));
  }
  const total = parseInt(res.headers['content-length'] || '0');
  let downloaded = 0;
  const ws = fs.createWriteStream(dest);
  res.on('data', (c) => {
    downloaded += c.length;
    if (onProgress && total > 0) onProgress(downloaded, total);
  });
  res.pipe(ws);
  ws.on('finish', () => { ws.close(); resolve(); });
  ws.on('error', reject);
}

// ─── DRM key fetcher ────────────────────────────────────────────────────────
// Key server (ndvideo-key.ykt.eduyun.cn) is behind Huawei WAF that returns
// a JS challenge. We bypass it by having a real BrowserWindow execute the JS:
//   1. Load root URL in hidden iframe inside main window → WAF JS runs → cookies set
//   2. Then fetch the key URL from the same renderer (cookies attached)

async function fetchDrmKey(keyUrl, token) {
  // Quick path: try direct net.fetch first (works if WAF is absent or simple)
  try {
    const h = { 'User-Agent': 'Mozilla/5.0' };
    if (token) { h['Authorization'] = `Bearer ${token}`; h['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`; }
    const resp = await net.fetch(keyUrl, { method: 'GET', headers: h });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 16) return buf;
    }
  } catch {}

  // Main path: use the visible main window's renderer (real browser context)
  // The WAF JS challenge executes in the iframe, sets cookies in the shared
  // session, then a second fetch() goes through WAF and returns the key.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const KEY_ROOT = 'https://ndvideo-key.ykt.eduyun.cn';
    const script = `
      (async () => {
        // Step 1: load key-server root in hidden iframe → triggers WAF JS
        const f = document.createElement('iframe');
        f.style.display = 'none';
        f.src = '${KEY_ROOT}/';
        document.body.appendChild(f);
        await new Promise(r => { f.onload = r; setTimeout(r, 8000); });

        // Step 2: now fetch the real key URL (cookies from WAF are attached)
        try {
          const resp = await fetch('${keyUrl}', { credentials: 'include' });
          if (!resp.ok) return null;
          const buf = await resp.arrayBuffer();
          return Array.from(new Uint8Array(buf));
        } catch(e) { return null; }
      })();
    `;
    try {
      const result = await mainWindow.webContents.executeJavaScript(script);
      if (result && result.length === 16) return Buffer.from(result);
    } catch {}
  }

  // Last resort: hidden BrowserWindow fallback (for edge cases)
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => { if (!done) { done = true; try { w.close(); } catch {} resolve(null); } };
    const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const filter = { urls: ['https://ndvideo-key.ykt.eduyun.cn/*'] };
    w.webContents.session.webRequest.onBeforeSendHeaders(filter, (d, cb) => {
      d.requestHeaders['User-Agent'] = 'Mozilla/5.0';
      if (token) { d.requestHeaders['Authorization'] = `Bearer ${token}`; d.requestHeaders['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`; }
      cb({ requestHeaders: d.requestHeaders });
    });
    w.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        if (done) return;
        try {
          const r = await w.webContents.executeJavaScript(`fetch('${keyUrl}',{credentials:'include'}).then(r=>r.ok?r.arrayBuffer():null).then(b=>b?Array.from(new Uint8Array(b)):null)`);
          if (r && r.length === 16) { done = true; w.close(); resolve(Buffer.from(r)); return; }
        } catch {}
        cleanup();
      }, 3000);
    });
    w.webContents.on('did-fail-load', cleanup);
    w.loadURL('https://ndvideo-key.ykt.eduyun.cn/');
    setTimeout(cleanup, 20000);
  });
}

// ─── HLS (m3u8) downloader ──────────────────────────────────────────────────

function downloadBuf(url, headers) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers, rejectUnauthorized: true }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function resolveUrl(base, rel) {
  if (rel.startsWith('http')) return rel;
  const u = new URL(base);
  if (rel.startsWith('/')) return u.origin + rel;
  return base.substring(0, base.lastIndexOf('/') + 1) + rel;
}

async function downloadHls(m3u8Url, destPath, onProgress, token) {
  function headers(withAuth) {
    const h = { 'User-Agent': 'Mozilla/5.0' };
    if (withAuth && token) {
      h['Authorization'] = `Bearer ${token}`;
      h['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`;
    }
    return h;
  }

  // Download m3u8 playlist
  let m3u8Data;
  let usedAuth = true;
  try { m3u8Data = await downloadBuf(m3u8Url, headers(true)); }
  catch { usedAuth = false; m3u8Data = await downloadBuf(m3u8Url, headers(false)); }
  const playlist = m3u8Data.toString('utf8');

  // Check for encryption
  const keyMatch = playlist.match(/URI="([^"]+)"/);
  const ivMatch = playlist.match(/IV=0x([0-9a-fA-F]+)/);
  const keyUrl = keyMatch ? keyMatch[1] : null;
  const iv = ivMatch ? Buffer.from(ivMatch[1], 'hex') : null;

  // Fetch AES-128 key — key server (ndvideo-key.ykt.eduyun.cn) is behind Huawei WAF
  // which returns a JS challenge. `net.fetch` can't execute JS, so we use a hidden
  // BrowserWindow: the WAF JS runs, sets cookies, then we fetch the key via renderer fetch().
  let keyBuf = null;
  if (keyUrl) {
    keyBuf = await fetchDrmKey(keyUrl, token);
  }

  // For encrypted streams where key is unavailable, download segments
  // and concatenate into .ts file (data preserved, can be decrypted with ffmpeg)
  if (keyUrl && !keyBuf) {
    const rawSegments = [];
    for (const line of playlist.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.length > 0) {
        rawSegments.push(resolveUrl(m3u8Url, t));
      }
    }
    if (rawSegments.length === 0) throw new Error('m3u8中未找到视频分段');
    const total = rawSegments.length;
    const allSegments = [];
    for (let i = 0; i < total; i++) {
      let buf;
      try { buf = await downloadBuf(rawSegments[i], headers(usedAuth)); }
      catch { buf = await downloadBuf(rawSegments[i], headers(false)); }
      allSegments.push(buf);
      if (onProgress) onProgress(i + 1, total);
    }
    const merged = Buffer.concat(allSegments);
    fs.writeFileSync(destPath, merged);
    return;
  }

  // Parse segment URLs
  const rawSegments = [];
  for (const line of playlist.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.length > 0) {
      rawSegments.push(resolveUrl(m3u8Url, t));
    }
  }
  if (rawSegments.length === 0) throw new Error('m3u8中未找到视频分段');

  // Download and optionally decrypt all segments
  const total = rawSegments.length;
  const allSegments = [];
  for (let i = 0; i < total; i++) {
    let buf;
    try { buf = await downloadBuf(rawSegments[i], headers(usedAuth)); }
    catch { buf = await downloadBuf(rawSegments[i], headers(false)); }
    if (keyBuf && iv) {
      try {
        const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
        decipher.setAutoPadding(false);
        buf = Buffer.concat([decipher.update(buf), decipher.final()]);
      } catch {}
    }
    allSegments.push(buf);
    if (onProgress) onProgress(i + 1, total);
  }

  // Save as .ts (H.264/AAC in MPEG-TS container — plays in VLC/PotPlayer/ffplay)
  const merged = Buffer.concat(allSegments);
  fs.writeFileSync(destPath, merged);
}

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

  // Set up CORS bypass + auth headers for the key-server domain so the
  // renderer's fetch() can reach it (renderer origin is file://, which is
  // cross-origin).
  const keyFilter = { urls: ['https://ndvideo-key.ykt.eduyun.cn/*'] };
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(keyFilter, (details, callback) => {
    details.requestHeaders['User-Agent'] = 'Mozilla/5.0';
    if (accessToken) {
      details.requestHeaders['Authorization'] = `Bearer ${accessToken}`;
      details.requestHeaders['X-ND-AUTH'] = `MAC id="${accessToken}",nonce="0",mac="0"`;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  mainWindow.webContents.session.webRequest.onHeadersReceived(keyFilter, (details, callback) => {
    details.responseHeaders['Access-Control-Allow-Origin'] = ['null'];
    details.responseHeaders['Access-Control-Allow-Credentials'] = ['true'];
    callback({ responseHeaders: details.responseHeaders });
  });
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

// ─── URL Handlers ──────────────────────────────────────────────────────────

async function handleBasicWork(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
  const title = data.title || '未命名';

  // Try top-level ti_items first
  const cp = data.custom_properties || {};
  const format = cp.format || 'pdf';
  const size = cp.size || 0;
  let info = extractUrl(data.ti_items, format, size);

  // Fallback: try relations (auto-discover all keys)
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
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/${contentId}.json`);
  const title = data.title || '未命名';
  const cp = data.custom_properties || {};
  const format = cp.format || 'pdf';
  const size = cp.size || 0;
  const info = extractUrl(data.ti_items, format, size);
  if (!info) throw new Error('未找到可下载的资源');
  return { title, tree: [makeFileNode(sanitize(title), format, info.format, info.url, size)] };
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
  // Auto-discover all relation keys (not just national_course_resource)
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

  // Try top-level ti_items first
  let info = extractUrl(data.ti_items, format, size);

  // Fallback: try relations
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
  // Auto-discover all relation keys
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
  // Auto-discover all relation keys
  const tree = parseRelationResources(relations, null, {
    lesson_1: '课程内容', experiment_video: '实验视频',
  });
  return { title: prefix + sanitize(title), tree };
}

async function handleQualityCourse(url) {
  let courseId = getUrlParam(url, 'courseId');
  if (!courseId) throw new Error('未找到 courseId');
  const apiUrl = url.includes('jpk.basic.smartedu.cn') || url.includes('yearQualityCourse')
    ? `https://s-file-1.ykt.cbern.com.cn/competitive/elite_lesson/resources/${courseId}.json`
    : `https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/${courseId}.json`;
  const data = await fetchJson(apiUrl);
  const title = data.title || '未命名';
  const relations = data.relations || {};
  // Auto-discover all relation keys
  const tree = parseRelationResources(relations, null, { course_resource: '课程资源' });
  return { title: sanitize(title), tree };
}

async function handleThematicCourse(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  let foundTitle = '专题课程';

  // First try: fetch as single resource
  try {
    const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
    foundTitle = data.title || foundTitle;
    const cp = data.custom_properties || {};
    const format = cp.format || '';
    const size = cp.size || 0;

    // Try relations first (for multi-resource)
    if (data.relations) {
      const tree = parseRelationResources(data.relations, null, {});
      if (tree.length) return { title: sanitize(foundTitle), tree };
    }

    // Fallback to top-level ti_items
    const info = extractUrl(data.ti_items, format, size);
    if (info) return { title: sanitize(foundTitle), tree: [makeFileNode(sanitize(foundTitle), format, info.format, info.url, size)] };
  } catch {}

  // Second try: list endpoint (for thematic courses with multiple resources)
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
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  const isWisdom = url.includes('/wisdom/');
  const base = isWisdom
    ? 'https://s-file-1.ykt.cbern.com.cn/ldjy/ndrs/special_edu/resources/details'
    : 'https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details';
  const data = await fetchJson(`${base}/${contentId}.json`);
  const title = data.title || '未命名';
  const cp = data.custom_properties || {};
  const format = cp.format || 'mp4';
  const size = cp.size || 0;

  // Try top-level ti_items first
  let info = extractUrl(data.ti_items, format, size);

  // Fallback: try relations (for multi-video resources)
  if (!info && data.relations) {
    const tree = parseRelationResources(data.relations, null, {});
    if (tree.length) return { title: sanitize(title), tree };
  }

  if (!info) throw new Error('未找到可下载的视频');
  return { title, tree: [makeFileNode(sanitize(title), format, info.format, info.url, size)] };
}

// ─── IPC: Token ─────────────────────────────────────────────────────────────

ipcMain.handle('get-token', () => accessToken);
ipcMain.handle('set-token', (e, token) => { saveToken(token); return true; });

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

ipcMain.handle('download-files', async (event, { files }) => {
  const saveDir = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载保存目录',
  });
  if (saveDir.canceled) return { success: false, canceled: true };

  const destDir = saveDir.filePaths[0];
  const results = [];
  let completed = 0;

  for (const file of files) {
    const isM3u8 = file.format === 'm3u8';
    // HLS downloads: keep .m3u8 (browser-playable when encrypted),
    // will be renamed to .mp4 only if decryption succeeds
    const filePath = path.join(destDir, file.relativePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      if (isM3u8) {
        const basePath = filePath.replace(/\.m3u8$/i, '');
        const hlsDest = basePath + '.ts';
        await downloadHls(file.url, hlsDest, (downloaded, total) => {
          if (mainWindow && total > 0) {
            mainWindow.webContents.send('download-progress', {
              fileName: file.name,
              percent: Math.round((downloaded / total) * 100),
              downloaded, total,
              completed, totalFiles: files.length,
            });
          }
        }, accessToken);
        // downloadHls saves as .ts (always — decrypted or encrypted)
        results.push({ name: path.basename(hlsDest), success: true, path: hlsDest });
      } else {
        await new Promise((resolve, reject) => {
          downloadWithAuth(file.url, filePath, (downloaded, total) => {
            if (mainWindow && total > 0) {
              mainWindow.webContents.send('download-progress', {
                fileName: file.name,
                percent: Math.round((downloaded / total) * 100),
                downloaded, total,
                completed, totalFiles: files.length,
              });
            }
          }).then(resolve).catch(reject);
        });
        results.push({ name: path.basename(filePath), success: true, path: filePath });
      }
    } catch (e) {
      results.push({ name: file.name, success: false, error: e.message });
    }
    completed++;
  }
  if (mainWindow) {
    mainWindow.webContents.send('download-progress', { done: true, completed, totalFiles: files.length });
  }
  return { success: true, results, dir: destDir };
});
