const https = require('https');

const TAGS = 'e7bbb2de-0590-11ed-9c79-92fc3b3249d5/6a74973a-0772-11ed-ac74-092ab92074e6/44bee8bc-54e6-11ed-9c34-850ba61fa9f4/e7bbd296-0590-11ed-9c79-92fc3b3249d5';
const LAST_TAG = 'e7bbd296-0590-11ed-9c79-92fc3b3249d5';

function probe(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://basic.smartedu.cn/' }, timeout: 8000 }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 600) res.destroy(); });
      res.on('end', () => resolve({ url, status: res.statusCode, bytes: n, head: '' }));
    }).on('error', (e) => resolve({ url, status: 'ERR ' + e.message, bytes: 0 }));
  });
}

const bases = [
  'https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2',
  'https://s-file-1.ykt.cbern.com.cn/zxx/ndrs',
  'https://s-file-2.ykt.cbern.com.cn/zxx/ndrv2',
];
const paths = [
  `/resources/tch_material/list.json?tagId=${LAST_TAG}`,
  `/resources/tch_material/list.json?tagId=${TAGS}`,
  `/tch_material/list.json?tagId=${LAST_TAG}`,
  `/tag/tree.json`,
  `/tags.json`,
  `/resources/tch_material/tags/${LAST_TAG}.json`,
  `/resources?tagId=${LAST_TAG}&pageSize=5`,
  `/resources/list.json?tagId=${LAST_TAG}`,
  `/tch_material/books.json?tagId=${LAST_TAG}`,
  `/resources/tch_material/books.json?tagId=${LAST_TAG}`,
];

(async () => {
  const results = [];
  for (const b of bases) {
    for (const p of paths) {
      results.push(probe(b + p));
    }
  }
  const all = await Promise.all(results);
  for (const r of all.filter((x) => x.status !== 'ERR ' && x.status !== undefined)) {
    console.log(`${r.status} ${r.bytes}B  ${r.url}`);
  }
})();
