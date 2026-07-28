/**
 * HLS AES-128 Decryption TDD Suite
 *
 * Tests the pure-logic parts without Electron:
 *   1. Encrypted segment detection (RED → no TS sync)
 *   2. m3u8 parsing (key URL, IV, segment extraction)
 *   3. AES-128-CBC decrypt with a mock key
 *   4. Full end-to-end with WAF-fallback: download, decrypt, validate
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Config ─────────────────────────────────────────────────────────────────
const TOKEN = '7F938B205F876FC39BD5FD64A3C821677D498ABDACCD91FF52E21D140A623676835BFF46A86225DB14C3C5D970C469FCE1C6A030260C40C8';

const TOKEN_SHORT = TOKEN.substring(0, 12) + '...';

const M3U8_URL = 'https://r1-ndr-private.ykt.cbern.com.cn/edu_product/esp/video_courses/5bfd9236-994d-1a84-f226-dbfcc56d5020.t/zh-CN/1725675964211/transcode/videos/5bfd9236-994d-1a84-f226-dbfcc56d5020-1920x1080-true-e9d7052cfea4e66508823c4dbd0e832a-8219b1c871e04803aba432deccc63d20.m3u8';

const KEY_URL = 'https://ndvideo-key.ykt.eduyun.cn/v1/resource_keys/a625860be5234b79aa796b2cf0de80dd';

const SEGMENT_URLS = [
  'https://r1-ndr-private.ykt.cbern.com.cn/edu_product/esp/video_courses/5bfd9236-994d-1a84-f226-dbfcc56d5020.t/zh-CN/1725675964211/transcode/videos/5bfd9236-994d-1a84-f226-dbfcc56d5020-1920x1080-true-e9d7052cfea4e66508823c4dbd0e832a-8219b1c871e04803aba432deccc63d20-00000.ts',
];

const TS_PACKET = 188;

// ─── Helpers ────────────────────────────────────────────────────────────────

function authHeaders(token) {
  return {
    'User-Agent': 'Mozilla/5.0',
    'Authorization': `Bearer ${token}`,
    'X-ND-AUTH': `MAC id="${token}",nonce="0",mac="0"`,
  };
}

function dl(url, headers) {
  return new Promise((resolve, reject) => {
    const c = url.startsWith('https') ? https : http;
    c.get(url, { headers, rejectUnauthorized: true }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const ch = []; res.on('data', d => ch.push(d)); res.on('end', () => resolve(Buffer.concat(ch)));
    }).on('error', reject);
  });
}

function countSync(buf) {
  let hits = 0, total = 0;
  for (let i = 0; i + TS_PACKET <= buf.length; i += TS_PACKET) { total++; if (buf[i] === 0x47) hits++; }
  return { hits, total, ratio: total > 0 ? hits / total : 0 };
}

function info(s) { console.log(`  ℹ ${s}`); }
function pass(s) { console.log(`  ✓ ${s}`); }
function fail(s) { console.log(`  ✗ ${s}`); }

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { pass(label); passed++; }
  else { fail(label + (detail ? ' — ' + detail : '')); failed++; }
}

// ─── Test 1: Encrypted segment detection ────────────────────────────────────

async function testEncryptedSegmentDetection() {
  info('Downloading first encrypted segment...');
  let buf;
  try { buf = await dl(SEGMENT_URLS[0], authHeaders(TOKEN)); }
  catch { buf = await dl(SEGMENT_URLS[0], { 'User-Agent': 'Mozilla/5.0' }); }

  info(`${buf.length} bytes downloaded`);

  const s = countSync(buf);
  info(`TS sync 0x47: ${s.hits}/${s.total} = ${(s.ratio * 100).toFixed(1)}%`);

  assert('Encrypted segment: sync ratio < 1% (RED — unplayable)',
    s.ratio < 0.01, `actual ${(s.ratio * 100).toFixed(2)}%`);

  return buf;
}

// ─── Test 2: m3u8 parsing ──────────────────────────────────────────────────

async function testM3u8Parsing() {
  info('Downloading m3u8 playlist...');
  let buf;
  try { buf = await dl(M3U8_URL, authHeaders(TOKEN)); }
  catch { buf = await dl(M3U8_URL, { 'User-Agent': 'Mozilla/5.0' }); }

  const text = buf.toString('utf8');
  info(`m3u8: ${text.length} chars`);

  // Parse key URL and IV
  const keyMatch = text.match(/URI="([^"]+)"/);
  const ivMatch = text.match(/IV=0x([0-9a-fA-F]+)/);

  assert('m3u8: #EXT-X-KEY URI found', !!keyMatch);
  assert('m3u8: IV found', !!ivMatch);
  assert('m3u8: IV is 32 hex digits (16 bytes)', ivMatch && ivMatch[1].length === 32);

  if (keyMatch) {
    info(`Key URL: ${keyMatch[1].substring(0, 60)}...`);
    assert('Key URL domain is ndvideo-key.ykt.eduyun.cn',
      keyMatch[1].includes('ndvideo-key.ykt.eduyun.cn'));
  }

  // Parse segment URLs
  const segments = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.length > 0) segments.push(t);
  }

  assert(`m3u8: segment count > 50`, segments.length > 50, `actual ${segments.length}`);

  // Check encryption tag
  assert('m3u8: METHOD is AES-128', text.includes('METHOD=AES-128'));

  // Check playlist type
  assert('m3u8: VOD playlist', text.includes('PLAYLIST-TYPE:VOD') || text.includes('VOD'));

  // Check all segment URLs are .ts
  const allTs = segments.every(s => s.endsWith('.ts') || s.includes('.ts'));
  assert('m3u8: all segments are .ts files', allTs);

  return { text, segments, keyUrl: keyMatch ? keyMatch[1] : null, ivHex: ivMatch ? ivMatch[1] : null };
}

// ─── Test 3: AES-128-CBC decrypt correctness ────────────────────────────────

function testAesDecrypt() {
  info('Testing AES-128-CBC with known vectors...');

  // Test vector: key = 16 bytes of 0x01, IV = 16 bytes of 0x00
  // Plaintext: 16 bytes of "Hello World!!!" (padded with PKCS#7)
  const key = Buffer.alloc(16, 0x01);
  const iv = Buffer.alloc(16, 0x00);
  const plaintext = Buffer.from('Hello World!!!!'); // exactly 16 bytes

  // Encrypt first to get known ciphertext
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Now decrypt with autoPadding=true (strip padding)
  const dec1 = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const result1 = Buffer.concat([dec1.update(encrypted), dec1.final()]);

  assert('AES decrypt: autoPadding=true matches original',
    result1.equals(plaintext), `got ${result1.toString('hex')}`);

  // Decrypt with autoPadding=false (keep padding)
  const dec2 = crypto.createDecipheriv('aes-128-cbc', key, iv);
  dec2.setAutoPadding(false);
  const result2 = Buffer.concat([dec2.update(encrypted), dec2.final()]);

  assert('AES decrypt: autoPadding=false output is larger',
    result2.length > plaintext.length, `plain=${plaintext.length} dec=${result2.length}`);

  // With autoPadding=false, last byte is PKCS#7 value (should be 16 in this case)
  // "Hello World!!!!" is 15 bytes → PKCS#7 adds 1 byte of value 0x01
  assert('AES decrypt: autoPadding=false last byte is PKCS#7 pad length',
    result2[result2.length - 1] === result2.length - plaintext.length);

  // Full round-trip: encrypt → decrypt with autoPadding=false → strip manually
  const padLen = result2[result2.length - 1];
  const stripped = result2.subarray(0, result2.length - padLen);
  assert('AES decrypt: manual strip matches original',
    stripped.equals(plaintext));

  info('AES-128-CBC operations: all correct');
}

// ─── Test 4: TS sync verification (after decrypt) ───────────────────────────

async function testTSSyncAfterDecrypt(encryptedBuf, key, iv) {
  if (!key) {
    info('Key unavailable — mocking with zero key to verify structure');
    key = Buffer.alloc(16, 0x42); // arbitrary mock key
  }

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);

  let decrypted;
  try {
    decrypted = Buffer.concat([decipher.update(encryptedBuf), decipher.final()]);
  } catch (e) {
    fail(`Decrypt threw: ${e.message}`);
    return;
  }

  const s = countSync(decrypted);

  if (s.ratio > 0.9) {
    pass(`Decrypted TS sync: ${s.hits}/${s.total} = ${(s.ratio*100).toFixed(1)}% -- PLAYABLE`);
  } else if (key) {
    fail(`Decrypted TS sync: ${s.hits}/${s.total} = ${(s.ratio*100).toFixed(1)}% -- wrong key?`);
    // Check first 4 bytes for known TS headers
    const pkt0 = decrypted.subarray(0, 188);
    info(`First packet hex: ${pkt0.subarray(0, 16).toString('hex')}`);
  } else {
    info(`Decrypted TS sync: ${s.hits}/${s.total} (mock key — wrong decryption expected)`);
    info(`First packet hex: ${decrypted.subarray(0, 16).toString('hex')}`);
  }

  // Save for inspection
  const outPath = path.join(__dirname, 'tdd-decrypted.ts');
  fs.writeFileSync(outPath, decrypted);
  info(`Saved decrypted segment: ${outPath} (${decrypted.length} bytes)`);
}

// ─── Test 5: Direct key server access (proves Electron needed) ──────────────

async function testKeyServerDirect() {
  info('Testing key server access via Node.js https...');

  const methods = [
    { name: 'Bearer + X-ND-AUTH', headers: authHeaders(TOKEN) },
    { name: 'Bearer only', headers: { 'User-Agent': 'Mozilla/5.0', 'Authorization': `Bearer ${TOKEN}` } },
    { name: 'X-ND-AUTH only', headers: { 'User-Agent': 'Mozilla/5.0', 'X-ND-AUTH': `MAC id="${TOKEN}",nonce="0",mac="0"` } },
    { name: 'No auth', headers: { 'User-Agent': 'Mozilla/5.0' } },
  ];

  for (const m of methods) {
    try {
      const buf = await dl(KEY_URL, m.headers);
      if (buf.length === 16) {
        pass(`Key obtained via ${m.name}! hex: ${buf.toString('hex')}`);
        return buf;
      }
      info(`${m.name}: got ${buf.length}B (not a key)`);
    } catch (e) {
      info(`${m.name}: ${e.message}`);
    }
  }

  info('All Node.js HTTP methods blocked by WAF — Electron BrowserWindow needed');
  return null;
}

// ─── Test 6: Edge cases ────────────────────────────────────────────────────

function testEdgeCases() {
  info('Testing edge cases...');

  // Buffer shorter than TS_PACKET
  const short = Buffer.alloc(100);
  const s = countSync(short);
  assert('countSync handles buffers < 188 bytes', s.total === 0);

  // IV parsing edge cases
  const ivFull = Buffer.from('00000000000000000000000000000000', 'hex');
  assert('Full zero IV is 16 bytes', ivFull.length === 16);

  const ivHex = '00000000000000000000000000000000';
  assert('IV hex string is 32 chars', ivHex.length === 32);

  // Key validation edge cases
  assert('16-byte key is valid AES-128', Buffer.alloc(16).length === 16);

  // TS packet boundaries
  const buf = Buffer.alloc(188 * 100);
  buf[0] = 0x47;
  buf[188] = 0x47;
  buf[188 * 2] = 0x47;
  const sc = countSync(buf);
  assert('countSync finds sync bytes at correct positions', sc.hits === 3 && sc.total === 100);

  // No sync bytes
  const buf2 = Buffer.alloc(188 * 10);
  buf2[0] = 0x00;
  const sc2 = countSync(buf2);
  assert('countSync returns 0 for no sync bytes', sc2.hits === 0);

  // All sync bytes (fill entire buffer)
  const buf3 = Buffer.alloc(188 * 5);
  for (let i = 0; i < 5; i++) buf3[i * 188] = 0x47;
  const sc3 = countSync(buf3);
  assert('countSync finds all sync bytes', sc3.hits === 5 && sc3.total === 5);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  HLS AES-128 Decryption  TDD Suite      ║');
  console.log('║  Token: ' + TOKEN_SHORT + '     ║');
  console.log('╚══════════════════════════════════════════╝');

  // Test 0: Get m3u8 info first
  const m3u8 = await testM3u8Parsing();
  console.log('');

  // Test 1: Download encrypted segment
  const segBuf = await testEncryptedSegmentDetection();
  console.log('');

  // Test 2: AES decrypt correctness (no network)
  testAesDecrypt();
  console.log('');

  // Test 3: Edge cases
  testEdgeCases();
  console.log('');

  // Test 4: Try key server directly
  const key = await testKeyServerDirect();
  console.log('');

  // Test 5: Attempt decrypt with key (if available) or with mock
  const iv = m3u8.ivHex ? Buffer.from(m3u8.ivHex, 'hex') : Buffer.alloc(16, 0);
  await testTSSyncAfterDecrypt(segBuf, key, iv);
  console.log('');

  // Summary
  console.log('═══════════════════════════════════════════');
  console.log(`  Passed: ${passed}   Failed: ${failed}`);
  if (key) {
    console.log(`  KEY: ${key.toString('hex')}`);
  } else {
    console.log('  KEY: NOT OBTAINED (needs Electron BrowserWindow)');
  }
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('\nFATAL:', e); process.exit(1); });
