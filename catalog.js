const CATALOG_VERSION_URL = 'https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/version/data_version.json';

const DIMENSION_ORDER = ['zxxxd', 'zxxxk', 'zxxbb', 'zxxnj', 'zxxcc'];

function parseCatalogUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('smartedu.cn') || !/tchMaterial|textbook/i.test(u.pathname)) return null;
    const tag = u.searchParams.get('defaultTag');
    if (!tag) return null;
    const tagIds = tag.split('/').map((s) => s.trim()).filter(Boolean);
    if (!tagIds.length) return null;
    return { tagIds };
  } catch {
    return null;
  }
}

async function fetchAllBooks(fetchFn, urls, onProgress) {
  if (!Array.isArray(urls) || !urls.length) return [];
  const results = await Promise.all(
    urls.map(async (u, i) => {
      const data = await fetchFn(u);
      if (onProgress) onProgress(i + 1, urls.length);
      return Array.isArray(data) ? data : [];
    })
  );
  return results.flat();
}

function tagIdSet(book) {
  const set = new Set();
  for (const t of book.tag_list || []) {
    if (t && t.tag_id) set.add(t.tag_id);
  }
  return set;
}

function filterByTagIds(books, tagIds) {
  const ids = (tagIds || []).filter(Boolean);
  if (!ids.length) return books;
  return books.filter((b) => {
    const s = tagIdSet(b);
    return ids.every((id) => s.has(id));
  });
}

function pickTag(book, dimensionId) {
  for (const t of book.tag_list || []) {
    if (t && t.tag_dimension_id === dimensionId) return { name: t.tag_name || '', tagId: t.tag_id || '' };
  }
  return null;
}

function bookSummary(book) {
  const p = (book.provider_list && book.provider_list[0]) || {};
  return {
    id: book.id,
    title: book.title || '',
    publisher: p.name || '',
    resourceType: book.resource_type_code || 'assets_document',
  };
}

function buildTree(books) {
  const root = { name: '全部教材', count: books.length, children: [], books: [] };
  const insert = (node, book, depth) => {
    if (depth >= DIMENSION_ORDER.length) {
      node.books.push(bookSummary(book));
      return;
    }
    const tag = pickTag(book, DIMENSION_ORDER[depth]);
    if (!tag || !tag.name) {
      if (node === root) {
        let un = root.children.find((c) => c.tagId === '__none__');
        if (!un) {
          un = { name: '未分类', tagId: '__none__', count: 0, children: [], books: [] };
          root.children.push(un);
        }
        un.count += 1;
        insert(un, book, depth + 1);
      } else {
        insert(node, book, depth + 1);
      }
      return;
    }
    let child = node.children.find((c) => c.tagId === tag.tagId);
    if (!child) {
      child = { name: tag.name, tagId: tag.tagId, count: 0, children: [], books: [] };
      node.children.push(child);
    }
    child.count += 1;
    insert(child, book, depth + 1);
  };
  for (const b of books) insert(root, b, 0);
  return root;
}

function countBooks(node) {
  let n = node.books.length;
  for (const c of node.children) n += countBooks(c);
  return n;
}

function collectBooks(node) {
  const out = [];
  const walk = (nd) => {
    if (nd.books.length) out.push(...nd.books);
    for (const c of nd.children) walk(c);
  };
  walk(node);
  return out;
}

module.exports = {
  CATALOG_VERSION_URL,
  DIMENSION_ORDER,
  parseCatalogUrl,
  fetchAllBooks,
  filterByTagIds,
  buildTree,
  countBooks,
  collectBooks,
  pickTag,
  bookSummary,
};
