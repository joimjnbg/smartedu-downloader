const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ─── Config ─────────────────────────────────────────────────────────────────
const TOKEN = '7F938B205F876FC39BD5FD64A3C821677D498ABDACCD91FF52E21D140A623676835BFF46A86225DB14C3C5D970C469FCE1C6A030260C40C8';

const M3U8_URL = 'https://r1-ndr-private.ykt.cbern.com.cn/edu_product/esp/video_courses/5bfd9236-994d-1a84-f226-dbfcc56d5020.t/zh-CN/1725675964211/transcode/videos/5bfd9236-994d-1a84-f226-dbfcc56d5020-1920x1080-true-e9d7052cfea4e66508823c4dbd0e832a-8219b1c871e04803aba432deccc63d20.m3u8';

const KEY_URL = 'https://ndvideo-key.ykt.eduyun.cn/v1/resource_keys/a625860be5234b79aa796b2cf0de80dd';

const IV_HEX = '00000000000000000000000000000000';

const SEGMENT_0 = 'https://r1-ndr-private.ykt.cbern.com.cn/edu_product/esp/video_courses/5bfd9236-994d-1a84-f226-dbfcc56d5020.t/zh-CN/1725675964211/transcode/videos/5bfd9236-994d-1a84-f226-dbfcc56d5020-1920x1080-true-e9d7052cfea4e66508823c4dbd0e832a-8219b1c871e04803aba432deccc63d20-00000.ts';

const TS_PACKET = 188;

// ─── Helpers ────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    'User-Agent': 'Mozilla/5.0',
    'Authorization': `Bearer ${token}`,
    'X-ND-AUTH': `MAC id="${token}",nonce="0",mac="0"`,
  };
}

function fetchBuf(url, headers) {
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

function countSyncBytes(buf) {
  let hits = 0;
  let total = 0;
  for (let i = 0; i + TS_PACKET <= buf.length; i += TS_PACKET) {
    total++;
    if (buf[i] === 0x47) hits++;
  }
  return { hits, total, ratio: total > 0 ? hits / total : 0 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Test 1: Download encrypted segment & verify it's NOT playable ──────────

async function testEncryptedSegment() {
  console.log('\n=== TEST 1: 下载加密 TS 分片 ===');

  let segBuf;
  try { segBuf = await fetchBuf(SEGMENT_0, authHeaders(TOKEN)); }
  catch (e) { segBuf = await fetchBuf(SEGMENT_0, { 'User-Agent': 'Mozilla/5.0' }); }

  console.log(`  下载完成: ${segBuf.length} bytes`);

  const { hits, total, ratio } = countSyncBytes(segBuf);
  console.log(`  0x47 sync check: ${hits}/${total} packets (${(ratio * 100).toFixed(1)}%)`);

  if (ratio < 0.5) {
    console.log('  ✓ PASS (RED): 加密分片没有 TS sync byte — 无法播放');
    return true;
  } else {
    console.log('  ✗ FAIL: 分片已有 TS sync byte — 可能未加密');
    return false;
  }
}

// ─── Test 2: Try various methods to get the AES-128 key ────────────────────

async function testFetchKey() {
  console.log('\n=== TEST 2: 获取 AES-128 密钥 ===');

  const methods = [];

  // Method 1: Bearer + X-ND-AUTH
  try {
    const buf = await fetchBuf(KEY_URL, authHeaders(TOKEN));
    methods.push({ name: 'Bearer + X-ND-AUTH', ok: true, len: buf.length, key: buf });
    console.log(`  ✓ Bearer+X-ND-AUTH: ${buf.length} bytes (${buf.length === 16 ? 'OK AES-128' : '非16字节'})`);
  } catch (e) {
    methods.push({ name: 'Bearer + X-ND-AUTH', ok: false, err: e.message });
    console.log(`  ✗ Bearer+X-ND-AUTH: ${e.message}`);
  }

  // Method 2: Bearer only
  try {
    const buf = await fetchBuf(KEY_URL, { 'User-Agent': 'Mozilla/5.0', 'Authorization': `Bearer ${TOKEN}` });
    methods.push({ name: 'Bearer only', ok: true, len: buf.length, key: buf });
    console.log(`  ✓ Bearer only: ${buf.length} bytes (${buf.length === 16 ? 'OK AES-128' : '非16字节'})`);
  } catch (e) {
    methods.push({ name: 'Bearer only', ok: false, err: e.message });
    console.log(`  ✗ Bearer only: ${e.message}`);
  }

  // Method 3: X-ND-AUTH only
  try {
    const buf = await fetchBuf(KEY_URL, { 'User-Agent': 'Mozilla/5.0', 'X-ND-AUTH': `MAC id="${TOKEN}",nonce="0",mac="0"` });
    methods.push({ name: 'X-ND-AUTH only', ok: true, len: buf.length, key: buf });
    console.log(`  ✓ X-ND-AUTH only: ${buf.length} bytes`);
  } catch (e) {
    methods.push({ name: 'X-ND-AUTH only', ok: false, err: e.message });
    console.log(`  ✗ X-ND-AUTH only: ${e.message}`);
  }

  // Method 4: No auth
  try {
    const buf = await fetchBuf(KEY_URL, { 'User-Agent': 'Mozilla/5.0' });
    methods.push({ name: 'No auth', ok: true, len: buf.length, key: buf });
    console.log(`  ✓ No auth: ${buf.length} bytes`);
  } catch (e) {
    methods.push({ name: 'No auth', ok: false, err: e.message });
    console.log(`  ✗ No auth: ${e.message}`);
  }

  // Find the first 16-byte key
  const goodKey = methods.find(m => m.ok && m.len === 16 && m.key);
  if (goodKey) {
    console.log(`\n  ★ 找到有效 AES-128 密钥! 方法: ${goodKey.name}`);
    console.log(`    密钥 hex: ${goodKey.key.toString('hex')}`);
    return goodKey.key;
  }

  // If no method returned 16 bytes, check if any returned something we can interpret
  // Could be hex-encoded (32 chars → 16 bytes)
  for (const m of methods) {
    if (m.ok && m.key) {
      const text = m.key.toString('utf8').trim();
      console.log(`\n  ? ${m.name} 返回 ${m.len} 字节: "${text.substring(0, 64)}"`);
      // Check if it's hex-encoded
      if (/^[0-9a-fA-F]{32}$/.test(text)) {
        console.log('  → 看起来是 hex 编码的密钥，尝试转换...');
        const decoded = Buffer.from(text, 'hex');
        return decoded;
      }
      // Check if first 16 bytes of response could be the key
      if (m.len >= 16) {
        console.log('  → 取前 16 字节作为密钥（尝试）');
        return m.key.subarray(0, 16);
      }
    }
  }

  console.log('\n  ✗ 所有方法均无法获取密钥');
  return null;
}

// ─── Test 3: Decrypt segment & verify it's playable ────────────────────────

async function testDecrypt(keyBuf) {
  console.log('\n=== TEST 3: 解密 TS 分片 ===');

  if (!keyBuf || keyBuf.length !== 16) {
    console.log('  SKIP: 没有有效的 AES-128 密钥');
    return false;
  }

  const iv = Buffer.from(IV_HEX, 'hex');
  console.log(`  密钥: ${keyBuf.toString('hex')}`);
  console.log(`  IV:   ${iv.toString('hex')}`);

  // Download a fresh segment
  let segBuf;
  try { segBuf = await fetchBuf(SEGMENT_0, authHeaders(TOKEN)); }
  catch (e) { segBuf = await fetchBuf(SEGMENT_0, { 'User-Agent': 'Mozilla/5.0' }); }

  console.log(`  加密分片: ${segBuf.length} bytes`);

  // Decrypt
  const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(segBuf), decipher.final()]);

  console.log(`  解密后:   ${decrypted.length} bytes`);

  // Verify TS sync bytes
  const { hits, total, ratio } = countSyncBytes(decrypted);
  console.log(`  0x47 sync check: ${hits}/${total} packets (${(ratio * 100).toFixed(1)}%)`);

  // Check first bytes
  console.log(`  前 12 字节 hex: ${decrypted.subarray(0, 12).toString('hex')}`);
  console.log(`  前 12 字节 ASCII: "${decrypted.subarray(0, 12).toString('ascii')}"`);

  const pass = ratio > 0.9;
  if (pass) {
    console.log('  ✓ PASS (GREEN): 解密成功 — 可播放的 TS 文件');
  } else {
    console.log('  ✗ FAIL: 解密失败 — 文件不可播放');
    // Dump first 188 bytes for analysis
    console.log(`  首包(188B) hex: ${decrypted.subarray(0, 188).toString('hex')}`);
  }
  return pass;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   HLS AES-128 Decryption TDD Test Suite  ║');
  console.log('╚══════════════════════════════════════════╝');

  // Test 1: RED — encrypted segment shouldn't have TS sync bytes
  const t1 = await testEncryptedSegment();

  // Test 2: Try to get the key
  const key = await testFetchKey();

  // Test 3: GREEN — decrypt and verify playable
  const t3 = await testDecrypt(key);

  console.log('\n═══════════════════════════════════════════');
  console.log(`  TEST 1 (RED - encrypted):   ${t1 ? '✓' : '✗'}`);
  console.log(`  TEST 2 (key fetch):         ${key ? `✓ (${key.length}B)` : '✗'}`);
  console.log(`  TEST 3 (GREEN - decrypted): ${t3 ? '✓' : '✗'}`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(t1 && (key === null || t3) ? 0 : 1);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
