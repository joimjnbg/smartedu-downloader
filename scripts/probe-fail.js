const catalog = require('../catalog');
const net = require('../net');
const lib = require('../lib');
const { downloadOne } = require('../downloader');
const path = require('path');
const os = require('os');

(async () => {
  const fetchJson = (url) => net.fetchJson(url, { retries: 3, timeoutMs: 30000 });
  const v = await fetchJson(catalog.CATALOG_VERSION_URL);
  const urls = String(v.urls || '').split(',').map(s => s.trim()).filter(Boolean);
  const books = await catalog.fetchAllBooks(fetchJson, urls);

  const ids = ['9acd7f94-2f1c-4ba5-b3e5-dc248d1f1d4c', '4360e8a1-7e94-34ab-eeaa-57819834b24b'];
  for (const id of ids) {
    const b = books.find(x => x.id === id);
    console.log('==', b.title);
    try {
      const d = await fetchJson('https://s-file-1.ykt.cbern.com.cn/zxx/ndrv2/resources/tch_material/details/' + id + '.json');
      const cp = d.custom_properties || {};
      const info = lib.extractUrl(d.ti_items, cp.format || 'pdf', cp.size || 0);
      if (!info) { console.log('  extractUrl FAILED'); continue; }
      console.log('  url:', info.url.slice(0, 120));
      try {
        const p = path.join(os.tmpdir(), 'probe-' + id + '.pdf');
        const r = await downloadOne(info.url, p, { maxRetries: 1, retryDelayFn: () => 0, timeoutMs: 25000 });
        console.log('  download OK bytes:', r.bytes);
        require('fs').rmSync(p, { force: true });
      } catch (e) {
        console.log('  download FAIL:', e.message);
      }
    } catch (e) {
      console.log('  DETAIL FAIL:', e.message);
    }
  }
})();
