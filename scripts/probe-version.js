const https = require('https');
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://basic.smartedu.cn/' }, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
(async () => {
  const r = await get('https://s-file-1.ykt.cbern.com.cn/zxx/ndrs/resources/tch_material/part_100.json');
  console.log('part_100 status:', r.status, 'bytes:', r.body.length);
  if (r.status === 200) {
    const arr = JSON.parse(r.body.toString('utf8'));
    console.log('count:', arr.length);
    const b = arr[0];
    console.log('keys:', Object.keys(b).join(','));
    console.log('id:', b.id);
    console.log('title:', b.title);
    console.log('resource_type_code:', b.resource_type_code);
    console.log('tag_list sample:', JSON.stringify((b.tag_list || []).slice(0, 6), null, 1).slice(0, 900));
    console.log('provider_list:', JSON.stringify(b.provider_list));
  }
})();
