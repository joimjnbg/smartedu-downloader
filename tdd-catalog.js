const assert = require('assert');
const {
  CATALOG_VERSION_URL,
  parseCatalogUrl,
  fetchAllBooks,
  filterByTagIds,
  buildTree,
  countBooks,
  collectBooks,
  bookPath,
  searchBooks,
} = require('./catalog');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

function book(id, title, tags) {
  return { id, title, resource_type_code: 'assets_document', tag_list: tags, provider_list: [{ name: '某出版社', id: 'p1' }] };
}
const T = (id, name, dim) => ({ tag_id: id, tag_name: name, tag_dimension_id: dim });

const STAGE_XIAO = T('s-x', '小学', 'zxxxd');
const STAGE_CHU = T('s-c', '初中', 'zxxxd');
const SUB_YUWEN = T('k-yw', '语文', 'zxxxk');
const SUB_SHUXUE = T('k-sx', '数学', 'zxxxk');
const VER_TONG = T('v-t', '统编版', 'zxxbb');
const VER_REN = T('v-r', '人教版', 'zxxbb');
const G1 = T('g-1', '一年级', 'zxxnj');
const G7 = T('g-7', '七年级', 'zxxnj');
const UP = T('c-u', '上册', 'zxxcc');

const books = [
  book('b1', '语文一年级上册', [STAGE_XIAO, SUB_YUWEN, VER_TONG, G1, UP]),
  book('b2', '语文一年级下册', [STAGE_XIAO, SUB_YUWEN, VER_TONG, G1]),
  book('b3', '数学一年级上册', [STAGE_XIAO, SUB_SHUXUE, VER_REN, G1, UP]),
  book('b4', '语文七年级上册', [STAGE_CHU, SUB_YUWEN, VER_TONG, G7, UP]),
  book('b5', '无学段标签书', [SUB_YUWEN, VER_TONG, G1]),
];

// ─── parseCatalogUrl ────────────────────────────────────────────────────────

ok('parseCatalogUrl: 标准目录链接', () => {
  const r = parseCatalogUrl('https://basic.smartedu.cn/tchMaterial?defaultTag=s-x%2Fk-yw%2Fv-t%2Fg-1');
  assert.deepStrictEqual(r, { tagIds: ['s-x', 'k-yw', 'v-t', 'g-1'] });
});

ok('parseCatalogUrl: 未编码斜杠', () => {
  const r = parseCatalogUrl('https://basic.smartedu.cn/tchMaterial?defaultTag=s-x/k-yw/v-t');
  assert.deepStrictEqual(r, { tagIds: ['s-x', 'k-yw', 'v-t'] });
});

ok('parseCatalogUrl: 无 defaultTag 返回 null', () => {
  assert.strictEqual(parseCatalogUrl('https://basic.smartedu.cn/tchMaterial/detail?contentId=abc'), null);
});

ok('parseCatalogUrl: 非平台链接返回 null', () => {
  assert.strictEqual(parseCatalogUrl('https://example.com/x'), null);
});

ok('parseCatalogUrl: 非法输入返回 null', () => {
  assert.strictEqual(parseCatalogUrl('not a url'), null);
  assert.strictEqual(parseCatalogUrl(''), null);
  assert.strictEqual(parseCatalogUrl(null), null);
});

// ─── fetchAllBooks ──────────────────────────────────────────────────────────

ok('fetchAllBooks: 合并全部分片', async () => {
  const urls = ['u1', 'u2'];
  const fetches = new Map([['u1', [books[0], books[1]]], ['u2', [books[2]]]]);
  const r = await fetchAllBooks((u) => Promise.resolve(fetches.get(u)), urls);
  assert.strictEqual(r.length, 3);
});

ok('fetchAllBooks: 进度回调', async () => {
  let done = 0;
  await fetchAllBooks(() => Promise.resolve([]), ['a', 'b', 'c'], (cur, total) => { done += cur === 1 ? 1 : 0; assert.strictEqual(total, 3); });
  assert.ok(done >= 1);
});

ok('fetchAllBooks: 空列表返回空数组', async () => {
  assert.deepStrictEqual(await fetchAllBooks(() => Promise.resolve([]), []), []);
});

// ─── filterByTagIds ─────────────────────────────────────────────────────────

ok('filterByTagIds: 全部匹配', () => {
  const r = filterByTagIds(books, ['s-x', 'k-yw', 'v-t', 'g-1']);
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map((b) => b.id).sort(), ['b1', 'b2']);
});

ok('filterByTagIds: 部分匹配（只按学段）', () => {
  const r = filterByTagIds(books, ['s-x']);
  assert.strictEqual(r.length, 3);
});

ok('filterByTagIds: 缺一个 tag 即排除', () => {
  const r = filterByTagIds(books, ['s-x', 'k-yw', 'v-t', 'g-1', 'zzz']);
  assert.strictEqual(r.length, 0);
});

ok('filterByTagIds: 空过滤返回全部', () => {
  assert.strictEqual(filterByTagIds(books, []).length, 5);
  assert.strictEqual(filterByTagIds(books, null).length, 5);
});

// ─── buildTree ──────────────────────────────────────────────────────────────

ok('buildTree: 层级与计数', () => {
  const tree = buildTree(books);
  assert.strictEqual(tree.count, 5);
  assert.strictEqual(tree.children.length, 3); // 小学 / 初中 / 未分类
  const xiaoxue = tree.children.find((c) => c.name === '小学');
  assert.strictEqual(xiaoxue.count, 3);
  assert.strictEqual(xiaoxue.children.length, 2); // 语文 / 数学
  const yuwen = xiaoxue.children.find((c) => c.name === '语文');
  assert.strictEqual(yuwen.children[0].name, '统编版');
  assert.strictEqual(yuwen.children[0].children[0].name, '一年级');
  assert.strictEqual(yuwen.children[0].children[0].count, 2);
  assert.strictEqual(yuwen.children[0].children[0].children[0].name, '上册');
  assert.strictEqual(yuwen.children[0].children[0].children[0].books.length, 1);
  assert.strictEqual(yuwen.children[0].children[0].children[0].books[0].title, '语文一年级上册');
});

ok('buildTree: 缺失维度自动跳过', () => {
  const tree = buildTree([books[4]]); // 无学段 tag
  assert.strictEqual(tree.count, 1);
  assert.strictEqual(tree.children.length, 1);
  assert.strictEqual(tree.children[0].name, '未分类');
  assert.strictEqual(countBooks(tree), 1);
});

ok('buildTree: 叶子书籍含出版社', () => {
  const tree = buildTree([books[0]]);
  const leaf = collectBooks(tree)[0];
  assert.strictEqual(leaf.publisher, '某出版社');
  assert.strictEqual(leaf.id, 'b1');
});

// ─── countBooks / collectBooks ──────────────────────────────────────────────

ok('countBooks: 与 collectBooks 一致', () => {
  const tree = buildTree(books);
  assert.strictEqual(countBooks(tree), collectBooks(tree).length);
  assert.strictEqual(countBooks(tree), 5);
});

// ─── searchBooks / bookPath ─────────────────────────────────────────────────

ok('bookPath: 按维度拼接分类路径', () => {
  assert.strictEqual(bookPath(books[0]), '小学/语文/统编版/一年级/上册');
  assert.strictEqual(bookPath(books[4]), '语文/统编版/一年级');
});

ok('searchBooks: 按书名匹配', () => {
  const r = searchBooks(books, '数学');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].id, 'b3');
});

ok('searchBooks: 按学科 tag 匹配', () => {
  const r = searchBooks(books, '语文');
  assert.strictEqual(r.length, 4); // b1 b2 b4 b5（b5 也有语文 tag）
});

ok('searchBooks: 多关键字空格分隔全部命中', () => {
  const r = searchBooks(books, '小学 一年级');
  assert.strictEqual(r.length, 3); // b1 b2 b3
});

ok('searchBooks: 按出版社匹配', () => {
  const r = searchBooks(books, '某出版社');
  assert.strictEqual(r.length, 5);
});

ok('searchBooks: 大小写不敏感（英文书名）', () => {
  const withEn = [book('e1', 'English Textbook', [STAGE_XIAO, T('k-en', 'English', 'zxxxk')])];
  const r = searchBooks(withEn, 'english');
  assert.strictEqual(r.length, 1);
});

ok('searchBooks: 相关性排序（书名命中优先）', () => {
  const r = searchBooks(books, '语文');
  assert.strictEqual(r[0].id, 'b1'); // 书名含"语文"排前面
});

ok('searchBooks: 空查询返回空', () => {
  assert.strictEqual(searchBooks(books, '').length, 0);
  assert.strictEqual(searchBooks(books, '   ').length, 0);
  assert.strictEqual(searchBooks(books, null).length, 0);
});

ok('searchBooks: 无匹配返回空', () => {
  assert.strictEqual(searchBooks(books, '不存在的书').length, 0);
});

console.log(`\ncatalog: ${passed} passed`);
