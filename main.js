const { app, BrowserWindow, ipcMain, dialog, net } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

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

// ─── DRM key fetcher (Huawei WAF bypass via hidden BrowserWindow) ──────────

async function fetchDrmKey(keyUrl, token) {
  // Try direct net.fetch first (works if no WAF or simple cookie WAF)
  try {
    const h = { 'User-Agent': 'Mozilla/5.0' };
    if (token) { h['Authorization'] = `Bearer ${token}`; h['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`; }
    const resp = await net.fetch(keyUrl, { method: 'GET', headers: h });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length === 16) return buf;
    }
  } catch {}

  // If that fails, use a hidden BrowserWindow to let the WAF JS challenge execute
  return new Promise((resolve) => {
    let resolved = false;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const cleanup = () => { if (!resolved) { resolved = true; try { win.close(); } catch {} resolve(null); } };

    // Inject auth headers for all requests to the key domain
    const filter = { urls: ['https://ndvideo-key.ykt.eduyun.cn/*'] };
    win.webContents.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      details.requestHeaders['User-Agent'] = 'Mozilla/5.0';
      if (token) {
        details.requestHeaders['Authorization'] = `Bearer ${token}`;
        details.requestHeaders['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`;
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    let loadCount = 0;
    win.webContents.on('did-finish-load', () => {
      loadCount++;
      // Wait for WAF JS to execute and page to settle, then fetch via renderer
      setTimeout(async () => {
        if (resolved) return;
        try {
          const result = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const r = await fetch('${keyUrl}', { credentials: 'include' });
                if (!r.ok) return null;
                const b = await r.arrayBuffer();
                return Array.from(new Uint8Array(b));
              } catch(e) { return null; }
            })();
          `);
          if (result && result.length === 16) {
            resolved = true;
            win.close();
            resolve(Buffer.from(result));
            return;
          }
        } catch (e) {}
        // After 3 load events + 3 attempts, give up
        if (loadCount >= 3) cleanup();
      }, 2000);
    });

    win.webContents.on('did-fail-load', cleanup);

    // Navigate to key server root to trigger WAF challenge
    win.loadURL('https://ndvideo-key.ykt.eduyun.cn/');

    setTimeout(cleanup, 25000);
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
}

app.whenReady().then(() => { loadToken(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── Helpers ────────────────────────────────────────────────────────────────

function getUrlParam(u, name) {
  try { return new URL(u).searchParams.get(name); } catch { return null; }
}

function sanitize(s) {
  return s.replace(/[/\\:*?"<>|]/g, '_').trim() || '未命名';
}

function fixCsPath(s) {
  for (const p of ['cs_path:${ref-path}', 'cs_path:${ref_path}']) {
    if (s.startsWith(p)) return s.replace(p, 'https://r1-ndr.ykt.cbern.com.cn');
  }
  if (s.startsWith('cs_path:')) return s.replace('cs_path:', 'https://r1-ndr.ykt.cbern.com.cn');
  return s;
}

function getStorageUrl(item) {
  if (item.ti_storages && item.ti_storages.length > 0) {
    return item.ti_storages[0];
  }
  if (item.ti_storage) return fixCsPath(item.ti_storage);
  return null;
}

function extractUrl(tiItems, preferredFormat, size) {
  if (!tiItems) return null;

  // Priority 1: source file matching preferredFormat
  for (const item of tiItems) {
    if (item.ti_is_source_file && item.ti_format === preferredFormat && (!size || item.ti_size == size)) {
      const url = getStorageUrl(item);
      if (url) return { url, format: preferredFormat };
    }
  }

  // Priority 2: m3u8 HLS streams (for mp4/m3u8 requests)
  if (preferredFormat === 'mp4' || preferredFormat === 'm3u8') {
    for (const flag of ['href-m3u8', 'href-720p-m3u8', 'href-480p-m3u8', 'href', 'href-360p-m3u8']) {
      for (const item of tiItems) {
        if (item.ti_file_flag === flag) {
          const url = getStorageUrl(item);
          if (url) {
            const enc = item.custom_properties && item.custom_properties.encryption;
            return { url, format: 'm3u8', encrypted: enc === 'drm' || enc === true };
          }
        }
      }
    }
  }

  // Priority 3: match by size for non-mp4
  if (preferredFormat !== 'mp4' && preferredFormat !== 'm3u8') {
    for (const item of tiItems) {
      if (item.ti_size == size && item.ti_storage) {
        return { url: fixCsPath(item.ti_storage), format: item.ti_format || preferredFormat };
      }
    }
  }

  // Priority 4: PDF fallback (server converts pptx/docx to PDF)
  if (preferredFormat !== 'mp4' && preferredFormat !== 'm3u8' && preferredFormat !== 'pdf') {
    for (const item of tiItems) {
      if (item.ti_format === 'pdf') {
        const url = getStorageUrl(item);
        if (url) return { url, format: 'pdf' };
      }
    }
  }

  return null;
}

function makeFileNode(name, format, actualFormat, url, size) {
  const useFmt = actualFormat || format;
  const ext = useFmt ? `.${useFmt}` : '';
  const finalName = name.endsWith(ext) ? name : `${name}${ext}`;
  // Tag PDF conversions so user knows
  let displayName = finalName;
  if (actualFormat && actualFormat !== format && format && actualFormat === 'pdf') {
    const base = finalName.replace(/\.pdf$/, '');
    displayName = `${base}[PDF转换].pdf`;
  }
  return { name: displayName, format: useFmt || '', originalFormat: format || '', url: url || '', size: size || 0 };
}

// ─── URL type detection ─────────────────────────────────────────────────────

function detectType(url) {
  if (url.includes('/tchMaterial/detail')) return 'textbook';
  if (url.includes('/syncClassroom/classActivity')) return 'classActivity';
  if (url.includes('/syncClassroom/prepare/detail?resourceId')) return 'courseware';
  if (url.includes('/syncClassroom/prepare/detail?lessonId')) return 'oneTeacher';
  if (url.includes('/syncClassroom/experimentLesson')) return 'experiment';
  if (url.includes('/syncClassroom/basicWork/detail')) return 'basicWork';
  if (url.includes('/qualityCourse')) return 'qualityCourse';
  if (url.includes('/schoolService/detail') && url.includes('thematic_course')) return 'thematicCourse';
  if (url.includes('/sedu/detail') || url.includes('/wisdom/detail')) return 'video';
  return 'unknown';
}

// ─── Resource from relations ────────────────────────────────────────────────

const TYPE_LABELS = {
  mp4: '视频', m3u8: '视频', ts: '视频', avi: '视频', flv: '视频', mov: '视频',
  pdf: '文稿', ppt: '课件', pptx: '课件', doc: '文档', docx: '文档',
  xls: '表格', xlsx: '表格', zip: '压缩包', rar: '压缩包',
};

function parseRelationResources(relations, relationKeys, labelMap) {
  const tree = [];
  for (const key of relationKeys) {
    const items = relations[key];
    if (!items || !items.length) continue;
    const folderName = labelMap[key] || key;
    const children = [];
    const seen = new Set();
    for (const item of items) {
      const gt = item.global_title || {};
      const cn = gt['zh-CN'] || '';
      const st = item.title || '';
      const cp = item.custom_properties || {};
      const format = cp.format || '';
      const size = cp.size || 0;
      const info = extractUrl(item.ti_items, format, size);
      if (!info) continue;
      const actualFormat = info.format;
      const typeLabel = TYPE_LABELS[actualFormat] || actualFormat.toUpperCase();
      const typeSuffix = cn ? `[${typeLabel}]` : '';
      let baseName = cn ? (st && st !== cn ? `${cn} - ${st}` : cn) : (st || '未命名');
      let name = `${sanitize(baseName)}${typeSuffix}`;
      if (seen.has(name)) name = `${sanitize(baseName)}${typeSuffix}_2`;
      seen.add(name);
      children.push(makeFileNode(name, format, actualFormat, info.url, size));
    }
    if (children.length) tree.push({ name: folderName, type: 'folder', children });
  }
  return tree;
}

// ─── URL Handlers ──────────────────────────────────────────────────────────

async function handleBasicWork(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
  const title = data.title || '未命名';
  const cp = data.custom_properties || {};
  const format = cp.format || 'pdf';
  const size = cp.size || 0;
  const info = extractUrl(data.ti_items, format, size);
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
  const tree = parseRelationResources(relations, ['national_course_resource'], {
    national_course_resource: '课程资源'
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
  const info = extractUrl(data.ti_items, format, size);
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
  const tree = parseRelationResources(relations,
    ['lesson_plan_design', 'classroom_record', 'teaching_assets'],
    { lesson_plan_design: '教学设计', classroom_record: '课堂实录', teaching_assets: '教学资源' }
  );
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
  const tree = parseRelationResources(relations,
    ['lesson_1', 'experiment_video'],
    { lesson_1: '课程内容', experiment_video: '实验视频' }
  );
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
  const tree = parseRelationResources(relations, ['course_resource'], { course_resource: '课程资源' });
  return { title: sanitize(title), tree };
}

async function handleThematicCourse(url) {
  const contentId = getUrlParam(url, 'contentId');
  if (!contentId) throw new Error('未找到 contentId');
  try {
    const data = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/resources/details/${contentId}.json`);
    const title = data.title || '未命名';
    const cp = data.custom_properties || {};
    const format = cp.format || '';
    const size = cp.size || 0;
    const info = extractUrl(data.ti_items, format, size);
    if (info) return { title, tree: [makeFileNode(sanitize(title), format, info.format, info.url, size)] };
  } catch {}
  const list = await fetchJson(`https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/special_edu/thematic_course/${contentId}/resources/list.json`);
  const children = [];
  for (const item of list) {
    if (item.resource_type_code !== 'assets_document') continue;
    const title = item.title || '未命名';
    const cp = item.custom_properties || {};
    const format = cp.format || 'pdf';
    const size = cp.size || 0;
    const info = extractUrl(item.ti_items, format, size);
    if (info) children.push(makeFileNode(sanitize(title), format, info.format, info.url, size));
  }
  if (!children.length) throw new Error('未找到可下载的文档资源');
  return { title: '专题课程', tree: children };
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
  const info = extractUrl(data.ti_items, format, size);
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
