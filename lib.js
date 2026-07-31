// ─── Pure-logic helpers for SmartEdu URL/resource parsing ─────────────────
// Extracted so they can be tested without Electron.

// ─── URL helpers ──────────────────────────────────────────────────────────

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

// ─── URL type detection ───────────────────────────────────────────────────

function detectType(url) {
  let path = '', params = {};
  try {
    const u = new URL(url);
    path = u.pathname;
    for (const [k, v] of u.searchParams) params[k] = v;
  } catch {
    // fallback: use raw string
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

  // Use pathname + query params for precise matching
  if (path.endsWith('/tchMaterial/detail') || path.includes('/tchMaterial/detail')) return 'textbook';
  if (path.includes('/syncClassroom/classActivity')) return 'classActivity';
  if (path.includes('/syncClassroom/experimentLesson')) return 'experiment';
  if (path.includes('/syncClassroom/basicWork/detail')) return 'basicWork';
  if (path.includes('/qualityCourse')) return 'qualityCourse';
  if (path.includes('/sedu/detail') || path.includes('/wisdom/detail')) return 'video';

  // /syncClassroom/prepare/detail: determine by which param is present
  if (path.includes('/syncClassroom/prepare/detail')) {
    if (params['resourceId']) return 'courseware';
    if (params['lessonId']) return 'oneTeacher';
    // Has neither — still unknown
    return 'unknown';
  }

  if (path.includes('/schoolService/detail') && params['thematic_course']) return 'thematicCourse';

  return 'unknown';
}

// ─── Extract URL from ti_items ────────────────────────────────────────────

const TYPE_LABELS = {
  mp4: '视频', m3u8: '视频', ts: '视频', avi: '视频', flv: '视频', mov: '视频',
  pdf: '文稿', ppt: '课件', pptx: '课件', doc: '文档', docx: '文档',
  xls: '表格', xlsx: '表格', zip: '压缩包', rar: '压缩包', '7z': '压缩包',
  jpg: '图片', jpeg: '图片', png: '图片', gif: '图片', svg: '图片', webp: '图片',
  mp3: '音频', wav: '音频', aac: '音频', flac: '音频', ogg: '音频',
};

function extractUrl(tiItems, preferredFormat, size) {
  if (!tiItems) return null;

  // Priority 1: source file matching preferredFormat
  for (const item of tiItems) {
    if (item.ti_is_source_file && item.ti_format === preferredFormat && (!size || item.ti_size == size)) {
      const url = getStorageUrl(item);
      if (url) return { url, format: preferredFormat };
    }
  }

  // Priority 2: m3u8 HLS streams — 已禁用（见 main.js 顶部说明）
  // 平台视频使用 AES-128 加密 + 华为 WAF 防护，无法可靠解密

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

  // Priority 5: any non-thumbnail ti_items (broad match)
  for (const item of tiItems) {
    if (item.ti_file_flag === 'href' || !item.ti_file_flag) {
      const url = getStorageUrl(item);
      if (url) {
        const fmt = item.ti_format || preferredFormat;
        // Skip m3u8/mp4 video formats — video download is disabled
        if (fmt === 'm3u8' || fmt === 'mp4' || fmt === 'ts') continue;
        return { url, format: fmt };
      }
    }
  }

  return null;
}

// ─── Extract ALL downloadable items from ti_items (for relation parsing) ──

function extractAllUrls(tiItems) {
  const results = [];
  if (!tiItems) return results;

  // Find the primary file URL (same logic as extractUrl)
  let tiFormat = null;
  let tiSize = null;
  for (const item of tiItems) {
    if (item.ti_format) tiFormat = item.ti_format;
    if (item.ti_size) tiSize = item.ti_size;
  }

  // Skip if original format is video (disabled)
  const isVideo = tiFormat && ['mp4', 'm3u8', 'ts', 'avi', 'flv', 'mov'].includes(tiFormat);

  // Try PDF
  if (!isVideo) {
    const pdf = extractUrl(tiItems, 'pdf');
    if (pdf) results.push(pdf);
  }

  // Try original format (skip video formats)
  if (tiFormat && tiFormat !== 'pdf' && !isVideo) {
    const orig = extractUrl(tiItems, tiFormat, tiSize);
    if (orig && !results.some(r => r.url === orig.url)) {
      results.unshift(orig);
    }
  }

  // If nothing found, try common formats (video formats excluded)
  if (results.length === 0) {
    for (const fmt of ['pptx', 'docx', 'xlsx', 'zip']) {
      const r = extractUrl(tiItems, fmt);
      if (r && !results.some(x => x.url === r.url)) results.push(r);
    }
  }

  return results;
}

// ─── Build resource tree from relations ───────────────────────────────────

function makeFileNode(name, format, actualFormat, url, size) {
  const useFmt = actualFormat || format;
  const ext = useFmt ? `.${useFmt}` : '';
  const finalName = name.endsWith(ext) ? name : `${name}${ext}`;
  let displayName = finalName;
  if (actualFormat && actualFormat !== format && format && actualFormat === 'pdf') {
    const base = finalName.replace(/\.pdf$/, '');
    displayName = `${base}[PDF转换].pdf`;
  }
  return { name: displayName, format: useFmt || '', originalFormat: format || '', url: url || '', size: size || 0 };
}

function parseRelationResources(relations, relationKeys, labelMap) {
  const tree = [];
  if (!relations) return tree;
  // If no keys specified, auto-discover all from the response
  const keys = relationKeys && relationKeys.length > 0
    ? relationKeys
    : Object.keys(relations);

  for (const key of keys) {
    const items = relations[key];
    if (!items || !items.length) continue;
    const folderName = labelMap && labelMap[key] ? labelMap[key] : key;
    const children = [];
    const seen = new Set();
    for (const item of items) {
      const gt = item.global_title || {};
      const cn = gt['zh-CN'] || '';
      const st = item.title || '';
      const cp = item.custom_properties || {};
      const format = cp.format || '';
      const size = cp.size || 0;

      // Try extractAllUrls first for multiple items
      const allUrls = extractAllUrls(item.ti_items);
      if (allUrls.length === 0) continue;

      for (const info of allUrls) {
        const actualFormat = info.format;
        const typeLabel = TYPE_LABELS[actualFormat] || actualFormat.toUpperCase();
        const typeSuffix = cn ? `[${typeLabel}]` : '';
        let baseName = cn ? (st && st !== cn ? `${cn} - ${st}` : cn) : (st || '未命名');
        let name = `${sanitize(baseName)}${typeSuffix}`;
        if (allUrls.length > 1) {
          const fmtExt = actualFormat || 'file';
          name = `${sanitize(baseName)}_${fmtExt}${typeSuffix}`;
        }
        let finalName = name;
        if (seen.has(finalName)) finalName = `${sanitize(baseName)}${typeSuffix}_2`;
        seen.add(finalName);
        children.push(makeFileNode(finalName, format, actualFormat, info.url, size));
      }
    }
    if (children.length) tree.push({ name: folderName, type: 'folder', children });
  }
  return tree;
}

// ─── Exports (CommonJS) ───────────────────────────────────────────────────

module.exports = {
  getUrlParam,
  sanitize,
  fixCsPath,
  getStorageUrl,
  detectType,
  extractUrl,
  extractAllUrls,
  makeFileNode,
  parseRelationResources,
  TYPE_LABELS,
};
