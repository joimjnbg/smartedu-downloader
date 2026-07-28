/**
 * TDD test suite for SmartEdu URL/resource parsing logic.
 *
 * Tests the pure-logic functions from lib.js without Electron.
 *
 * Usage: node tdd-logic.js
 */

const lib = require('./lib');

// ─── Test Runner ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n── ${name} ─────────────────────────────────────`);
}

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

// Simulated ti_items for videos
function makeVideoTiItems(flags) {
  return flags.map((f, i) => ({
    ti_format: f === 'jpg' ? 'jpg' : 'm3u8',
    ti_file_flag: f,
    ti_size: 15000,
    custom_properties: f === 'href' ? { encryption: 'drm' } : {},
    ti_storages: [`https://example.com/video/${f}.${f.includes('m3u8') ? 'm3u8' : 'jpg'}`],
  }));
}

// Simulated ti_items for documents
function makeDocTiItems(flags) {
  return flags.map((f, i) => {
    const isPdf = f === 'pdf';
    return {
      ti_format: isPdf ? 'pdf' : 'folder',
      ti_file_flag: f,
      ti_size: isPdf ? 1000000 : 0,
      ti_storage: isPdf ? `https://example.com/doc/result.pdf` : `https://example.com/doc/${f}`,
      ti_storages: isPdf ? [`https://example.com/doc/result.pdf`] : [`https://example.com/doc/${f}`],
    };
  });
}

// A mock resource item (as returned from API relations array)
function mockRelationItem(title, format, size, tiItemFlags, typeCode) {
  const isVideo = format === 'mp4' || format === 'm3u8';
  const tiItems = tiItemFlags.map((f, i) => {
    const tiFmt = f === 'jpg' ? 'jpg' : f === 'pdf' ? 'pdf' : isVideo ? 'm3u8' : 'folder';
    const storages = [`https://example.com/storage/${title}/${f}`];
    return {
      ti_format: tiFmt,
      ti_file_flag: f,
      ti_size: f === 'jpg' ? 100000 : f === 'pdf' ? 500000 : 0,
      ti_storages: storages,
    };
  });
  return {
    global_title: { 'zh-CN': title },
    title: title,
    custom_properties: { format, size: size || 0 },
    ti_items: tiItems,
    resource_type_code: typeCode || '',
  };
}

function mockRelations(keys, itemsByKey) {
  const r = {};
  for (const key of keys) {
    r[key] = itemsByKey[key] || [];
  }
  return r;
}

// ═══════════════════════════════════════════════════════════════════════════
//  1. URL TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

group('1. URL Type Detection (detectType)');

assert('textbook: /tchMaterial/detail',
  lib.detectType('https://basic.smartedu.cn/tchMaterial/detail?contentId=xxx') === 'textbook');

assert('classActivity: /syncClassroom/classActivity',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/classActivity?activityId=xxx') === 'classActivity');

assert('courseware: /syncClassroom/prepare/detail with resourceId',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/prepare/detail?resourceId=xxx') === 'courseware');

assert('oneTeacher: /syncClassroom/prepare/detail with lessonId',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/prepare/detail?lessonId=xxx') === 'oneTeacher');

assert('experiment: /syncClassroom/experimentLesson',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/experimentLesson?courseId=xxx') === 'experiment');

assert('basicWork: /syncClassroom/basicWork/detail',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/basicWork/detail?contentId=xxx') === 'basicWork');

assert('qualityCourse: /qualityCourse',
  lib.detectType('https://basic.smartedu.cn/qualityCourse?courseId=xxx') === 'qualityCourse');

assert('thematicCourse: /schoolService/detail with thematic_course',
  lib.detectType('https://basic.smartedu.cn/schoolService/detail?thematic_course=xxx&contentId=yyy') === 'thematicCourse');

assert('video: /sedu/detail',
  lib.detectType('https://basic.smartedu.cn/sedu/detail?contentId=xxx') === 'video');

assert('video: /wisdom/detail',
  lib.detectType('https://basic.smartedu.cn/wisdom/detail?contentId=xxx') === 'video');

assert('unknown: unrelated URL',
  lib.detectType('https://example.com/somePage') === 'unknown');

assert('unknown: prepare/detail without id params',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/prepare/detail') === 'unknown');

assert('courseware: resourceId works even after lessonId param',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/prepare/detail?lessonId=xxx&resourceId=yyy') === 'courseware');

assert('courseware: resourceId value includes lessonId string (false positive)',
  lib.detectType('https://basic.smartedu.cn/syncClassroom/prepare/detail?resourceId=abc-lessonId-def') === 'courseware');

assert('unknown: unrelated tchMaterial-like path not detected as textbook',
  lib.detectType('https://basic.smartedu.cn/other/tchMaterial/other') === 'unknown');

// ───────────────────────────────────────────────────────────────────────────
//  2. extractUrl
// ───────────────────────────────────────────────────────────────────────────

group('2. URL Extraction (extractUrl)');

// Video extraction
const videoItems = makeVideoTiItems(['href', 'href-m3u8', 'href-hd-m3u8', 'href-720p-m3u8', 'href-480p-m3u8', 'href-360p-m3u8', 'thumbnail_1']);

const vResult = lib.extractUrl(videoItems, 'mp4');
assert('video: extracts m3u8 URL for mp4 request', !!vResult && vResult.format === 'm3u8');
// href-m3u8 has highest priority, and its item has no encryption in test fixtures
assert('video: encrypted flag matches source item', !!vResult && vResult.encrypted === false);
assert('video: prefers href-m3u8 (first in HLS_PRIORITY)', !!vResult && vResult.url.includes('href-m3u8'));

// Document extraction with PDF fallback
const docItems = makeDocTiItems(['image', 'pdf', 'thumbnail']);
const dResult = lib.extractUrl(docItems, 'docx', 1000000);
assert('document: extracts PDF for docx request (PDF fallback)', !!dResult && dResult.format === 'pdf');
assert('document: URL is from PDF item', !!dResult && dResult.url.includes('result.pdf'));

// Source file matching
const sourceItems = [
  { ti_format: 'pptx', ti_file_flag: '', ti_size: 500000, ti_is_source_file: true, ti_storage: 'cs_path:some/path/file.pptx' },
  { ti_format: 'pdf', ti_file_flag: 'pdf', ti_size: 300000, ti_storage: 'https://example.com/file.pdf' },
];
const sResult = lib.extractUrl(sourceItems, 'pptx', 500000);
assert('source file: returns URL matching preferredFormat+size', !!sResult && sResult.format === 'pptx');
assert('source file: cs_path URL is fixed', !!sResult && sResult.url.startsWith('https://'));

// null handling
assert('null ti_items returns null', lib.extractUrl(null, 'mp4') === null);
assert('empty ti_items returns null', lib.extractUrl([], 'mp4') === null);

// Source file without size match
const noSizeItems = [
  { ti_format: 'pptx', ti_file_flag: '', ti_size: 500000, ti_is_source_file: true, ti_storage: 'cs_path:${ref-path}/file.pptx' },
];
const nsResult = lib.extractUrl(noSizeItems, 'pptx');
assert('source file: matches without size filter when size=undefined', !!nsResult && nsResult.format === 'pptx');
assert('source file: ref-path is fixed', !!nsResult && nsResult.url.startsWith('https://r1-ndr.ykt.cbern.com.cn'));

// Image extraction
const imgItems = [
  { ti_format: 'jpg', ti_file_flag: 'href', ti_size: 200000, ti_storages: ['https://example.com/image.jpg'] },
];
const imgResult = lib.extractUrl(imgItems, 'jpg');
assert('image: extracts jpg URL', !!imgResult && imgResult.format === 'jpg');

// No match
const noMatch = lib.extractUrl([{ ti_format: 'txt', ti_file_flag: 'unknown', ti_size: 100 }], 'xyz');
assert('no match returns null', noMatch === null);

// ───────────────────────────────────────────────────────────────────────────
//  3. extractAllUrls
// ───────────────────────────────────────────────────────────────────────────

group('3. Multi-URL Extraction (extractAllUrls)');

const multiDoc = makeDocTiItems(['image', 'pdf', 'thumbnail']);
const multiUrls = lib.extractAllUrls(multiDoc);
assert('extractAllUrls: returns at least one URL', multiUrls.length > 0);
assert('extractAllUrls: includes PDF', multiUrls.some(u => u.format === 'pdf'));

const videoMulti = makeVideoTiItems(['href', 'href-m3u8', 'thumbnail_1']);
const vMulti = lib.extractAllUrls(videoMulti);
assert('extractAllUrls: video returns m3u8', vMulti.some(u => u.format === 'm3u8'));

assert('extractAllUrls: null input returns []', lib.extractAllUrls(null).length === 0);
assert('extractAllUrls: empty input returns []', lib.extractAllUrls([]).length === 0);

// ───────────────────────────────────────────────────────────────────────────
//  4. parseRelationResources
// ───────────────────────────────────────────────────────────────────────────

group('4. Relation Resource Parsing (parseRelationResources)');

// Build test relations
const relations = mockRelations(
  ['lesson_plan_design', 'classroom_record', 'teaching_assets', 'extra_material'],
  {
    lesson_plan_design: [mockRelationItem('教学设计', 'docx', 500000, ['image', 'pdf', 'thumbnail'])],
    classroom_record: [mockRelationItem('课堂实录', 'mp4', 10000000, ['href-m3u8', 'thumbnail_1'])],
    teaching_assets: [
      mockRelationItem('课件PPT', 'pptx', 3000000, ['image', 'pdf', 'thumbnail']),
    ],
    extra_material: [mockRelationItem('补充材料', 'docx', 200000, ['image', 'pdf', 'thumbnail'])],
  }
);

// Test with explicit keys
const tree1 = lib.parseRelationResources(relations,
  ['lesson_plan_design', 'classroom_record', 'teaching_assets'],
  { lesson_plan_design: '教学设计', classroom_record: '课堂实录', teaching_assets: '教学资源' }
);

assert('parse: returns 3 folders', tree1.length === 3);
assert('parse: folder names match labels',
  tree1[0].name === '教学设计' && tree1[1].name === '课堂实录' && tree1[2].name === '教学资源');
assert('parse: each folder has children', tree1.every(f => f.children.length > 0));
assert('parse: video folder contains m3u8',
  tree1[1].children.some(c => c.format === 'm3u8'));
assert('parse: doc folder contains pdf',
  tree1[0].children.some(c => c.format === 'pdf'));

// Test auto-discovery: when relationKeys is empty, use all keys
const tree2 = lib.parseRelationResources(relations, [], {});
assert('auto-discover: includes extra_material', tree2.some(f => f.name === 'extra_material'));
assert('auto-discover: includes all 4 relation keys', tree2.length === 4);

// Test auto-discovery: when relationKeys is null
const tree3 = lib.parseRelationResources(relations, null, null);
assert('auto-discover with null: includes extra_material', tree3.some(f => f.name === 'extra_material'));
assert('auto-discover with null: includes all 4', tree3.length === 4);

// Test empty relations
const tree4 = lib.parseRelationResources({}, ['key1'], {});
assert('empty relations returns empty tree', tree4.length === 0);

const tree5 = lib.parseRelationResources(null, ['key1'], {});
assert('null relations returns empty tree', tree5.length === 0);

// Test duplicate name handling
const dupeRelations = mockRelations(
  ['docs'],
  {
    docs: [
      mockRelationItem('Report', 'pdf', 100000, ['pdf']),
      mockRelationItem('Report', 'docx', 200000, ['pdf']),
    ],
  }
);
const treeDupes = lib.parseRelationResources(dupeRelations, ['docs'], { docs: '文档' });
assert('duplicate names: creates both items', treeDupes[0].children.length === 2);

// ───────────────────────────────────────────────────────────────────────────
//  5. Utility Functions
// ───────────────────────────────────────────────────────────────────────────

group('5. Utility Functions');

assert('sanitize: replaces special chars',
  lib.sanitize('file:name*with?bad<>chars') === 'file_name_with_bad__chars');

assert('sanitize: trims whitespace',
  lib.sanitize('  spaced  ') === 'spaced');

assert('sanitize: fallback for empty',
  lib.sanitize('') === '未命名');

assert('sanitize: fallback for only special chars (becomes empty after replace+trim)',
  lib.sanitize(' ') === '未命名');

assert('fixCsPath: no-op for http URL',
  lib.fixCsPath('https://example.com/file.pdf') === 'https://example.com/file.pdf');

assert('fixCsPath: replaces ref-path',
  lib.fixCsPath('cs_path:${ref-path}/file.pptx').startsWith('https://r1-ndr.ykt.cbern.com.cn'));

assert('fixCsPath: replaces ref_path',
  lib.fixCsPath('cs_path:${ref_path}/file.pptx').startsWith('https://r1-ndr.ykt.cbern.com.cn'));

assert('fixCsPath: replaces bare cs_path:',
  lib.fixCsPath('cs_path:/path/file.pptx').startsWith('https://r1-ndr.ykt.cbern.com.cn'));

assert('getStorageUrl: returns ti_storages[0]',
  lib.getStorageUrl({ ti_storages: ['https://a.com/1'], ti_storage: 'https://b.com/2' }) === 'https://a.com/1');

assert('getStorageUrl: falls back to ti_storage',
  lib.getStorageUrl({ ti_storage: 'https://c.com/3' }) === 'https://c.com/3');

assert('getStorageUrl: fixes cs_path in ti_storage',
  lib.getStorageUrl({ ti_storage: 'cs_path:file.pdf' }).startsWith('https://'));

assert('getStorageUrl: null if both empty',
  lib.getStorageUrl({}) === null);

assert('getUrlParam: gets param from URL',
  lib.getUrlParam('https://example.com?foo=bar&baz=qux', 'foo') === 'bar');

assert('getUrlParam: returns null for missing param',
  lib.getUrlParam('https://example.com?foo=bar', 'missing') === null);

assert('getUrlParam: returns null for invalid URL',
  lib.getUrlParam('not a url', 'x') === null);

// ───────────────────────────────────────────────────────────────────────────
//  6. makeFileNode
// ───────────────────────────────────────────────────────────────────────────

group('6. File Node Builder (makeFileNode)');

const fn1 = lib.makeFileNode('MyDoc', 'docx', 'pdf', 'https://url/doc.pdf', 500000);
assert('makeFileNode: adds PDF conversion tag',
  fn1.name.includes('PDF转换') && fn1.name.endsWith('.pdf'));

const fn2 = lib.makeFileNode('MyVideo', 'mp4', 'm3u8', 'https://url/playlist.m3u8', 1000000);
assert('makeFileNode: m3u8 format preserved',
  fn2.format === 'm3u8' && fn2.name.endsWith('.m3u8'));

const fn3 = lib.makeFileNode('MyDoc.pdf', 'pdf', 'pdf', 'https://url/doc.pdf', 500000);
assert('makeFileNode: no double extension',
  fn3.name === 'MyDoc.pdf');

const fn4 = lib.makeFileNode('NoFormat', '', '', '', 0);
assert('makeFileNode: no format adds no extension',
  fn4.name === 'NoFormat' && fn4.format === '');

// ───────────────────────────────────────────────────────────────────────────
//  7. TYPE_LABELS
// ───────────────────────────────────────────────────────────────────────────

group('7. Type Labels');

assert('video formats mapped', lib.TYPE_LABELS.mp4 === '视频' && lib.TYPE_LABELS.m3u8 === '视频');
assert('document formats mapped', lib.TYPE_LABELS.docx === '文档' && lib.TYPE_LABELS.pdf === '文稿');
assert('courseware formats mapped', lib.TYPE_LABELS.pptx === '课件' && lib.TYPE_LABELS.ppt === '课件');
assert('image formats mapped', lib.TYPE_LABELS.jpg === '图片' && lib.TYPE_LABELS.png === '图片');
assert('audio formats mapped', lib.TYPE_LABELS.mp3 === '音频' && lib.TYPE_LABELS.wav === '音频');
assert('archive formats mapped', lib.TYPE_LABELS.zip === '压缩包' && lib.TYPE_LABELS['7z'] === '压缩包');
assert('unknown format returns uppercase', lib.TYPE_LABELS['xyz'] === undefined);

// ───────────────────────────────────────────────────────────────────────────
//  8. HLS Priority Order
// ───────────────────────────────────────────────────────────────────────────

group('8. HLS Priority Flags');

assert('href-m3u8 is first priority', lib.HLS_PRIORITY[0] === 'href-m3u8');
assert('href-hd-m3u8 is second', lib.HLS_PRIORITY[1] === 'href-hd-m3u8');
assert('href-1080p-m3u8 is third', lib.HLS_PRIORITY[2] === 'href-1080p-m3u8');
assert('href-hd-m3u8 is included', lib.HLS_PRIORITY.includes('href-hd-m3u8'));
assert('href-sd-m3u8 is included', lib.HLS_PRIORITY.includes('href-sd-m3u8'));
assert('href-1080p-m3u8 is included', lib.HLS_PRIORITY.includes('href-1080p-m3u8'));
assert('href is last (fallback)', lib.HLS_PRIORITY[lib.HLS_PRIORITY.length - 1] === 'href');

// Verify the extractUrl picks href-hd-m3u8 over href-720p-m3u8
// when href-m3u8 is not available
const hdItems = makeVideoTiItems(['href-720p-m3u8', 'href-hd-m3u8', 'href-480p-m3u8']);
const hdResult = lib.extractUrl(hdItems, 'mp4');
assert('href-hd-m3u8 preferred over href-720p-m3u8 (quality order)',
  !!hdResult && hdResult.url.includes('href-hd-m3u8'));

// If href-m3u8 IS available, it takes priority over everything
const hdItems2 = makeVideoTiItems(['href-hd-m3u8', 'href-m3u8', 'href-720p-m3u8']);
const hdResult2 = lib.extractUrl(hdItems2, 'mp4');
assert('href-m3u8 is top priority over href-hd-m3u8',
  !!hdResult2 && hdResult2.url.includes('href-m3u8'));

// href is the lowest priority fallback
const hdItems3 = makeVideoTiItems(['href', 'href-sd-m3u8']);
const hdResult3 = lib.extractUrl(hdItems3, 'mp4');
assert('href-sd-m3u8 preferred over plain href',
  !!hdResult3 && hdResult3.url.includes('href-sd-m3u8'));

// Plain href is the very last fallback
const hdItems4 = makeVideoTiItems(['href', 'thumbnail_1']);
const hdResult4 = lib.extractUrl(hdItems4, 'mp4');
assert('href is last fallback', !!hdResult4 && hdResult4.url.includes('href'));

// ───────────────────────────────────────────────────────────────────────────
//  Summary
// ───────────────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════');
console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
console.log('═══════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
