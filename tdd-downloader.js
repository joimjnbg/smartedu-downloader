/**
 * TDD suite for downloader.js â€” download engine tests.
 *
 * Uses a local HTTP fixture server (no Electron, no network).
 *
 * Usage: node tdd-downloader.js
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { downloadOne, DownloadQueue, AbortError } = require('./downloader');

// â”€â”€â”€ Test Runner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let passed = 0;
let failed = 0;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}

function assert(name, cond) {
  if (cond) { passed++; console.log(`  âœ” ${name}`); }
  else { failed++; console.log(`  âœ˜ ${name}  [${currentGroup}]`); }
}

async function expectReject(name, fn, match) {
  try {
    await fn();
    failed++;
    console.log(`  âœ˜ ${name} (no rejection)  [${currentGroup}]`);
  } catch (e) {
    const ok = match ? (typeof match === 'string' ? e.message.includes(match) : match.test(e.message)) : true;
    if (ok) { passed++; console.log(`  âœ” ${name}  (${e.message})`); }
    else { failed++; console.log(`  âœ˜ ${name} (message "${e.message}" !~ ${match})  [${currentGroup}]`); }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// â”€â”€â”€ Fixture server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BODY_OK = Buffer.from('hello world, this is a downloadable file content');
const BODY_1 = Buffer.from('file-one-content-' + 'x'.repeat(1024));
const BODY_2 = Buffer.from('file-two-content-' + 'y'.repeat(2048));

let flakyHits = 0;
let authSeen = [];
let rangeSeen = [];
let truncHits = 0;
let bad400Hits = 0;
let qActive = 0;
let maxQActive = 0;
let slowHits = 0;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // Only /slow participates in the concurrency counter.
  if (url === '/slow') {
    slowHits++;
    qActive++;
    maxQActive = Math.max(maxQActive, qActive);
    const body = Buffer.from(`slow-${slowHits}-` + 'z'.repeat(8192));
    res.writeHead(200, { 'Content-Length': body.length });
    res.write(body.subarray(0, 64));
    setTimeout(() => {
      res.end(body.subarray(64));
      qActive--;
    }, 150);
    return;
  }

  if (url === '/hang') {
    // never respond; just keep the connection open until client gives up
    setTimeout(() => { try { res.destroy(); } catch {} }, 3000);
    return;
  }

  if (url === '/ok') {
    res.writeHead(200, { 'Content-Length': BODY_OK.length, 'Content-Type': 'application/octet-stream' });
    res.end(BODY_OK);
    return;
  }

  if (url === '/flaky') {
    flakyHits++;
    if (flakyHits < 3) {
      res.writeHead(500, { 'Content-Length': 0 });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': BODY_1.length });
    res.end(BODY_1);
    return;
  }

  if (url === '/auth') {
    const hasAuth = !!req.headers['authorization'];
    authSeen.push(hasAuth);
    if (!hasAuth) {
      res.writeHead(401, { 'Content-Length': 0 });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': BODY_1.length });
    res.end(BODY_1);
    return;
  }

  if (url === '/range') {
    const r = req.headers['range'];
    rangeSeen.push(r || null);
    const len = BODY_1.length;
    if (!r) {
      // First contact: send half then drop connection (simulates interruption)
      res.writeHead(200, { 'Content-Length': len, 'Content-Type': 'application/octet-stream' });
      res.write(BODY_1.subarray(0, Math.floor(len / 2)));
      setTimeout(() => { try { res.destroy(); } catch {} }, 20);
      return;
    }
    const m = /^bytes=(\d+)-$/.exec(r);
    if (!m || parseInt(m[1], 10) >= len) {
      res.writeHead(416, { 'Content-Range': `bytes */${len}` });
      res.end();
      return;
    }
    const start = parseInt(m[1], 10);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${len - 1}/${len}`,
      'Content-Length': len - start,
    });
    res.end(BODY_1.subarray(start));
    return;
  }

  if (url === '/trunc') {
    truncHits++;
    // Declares more bytes than it sends: client must detect incompleteness
    res.writeHead(200, { 'Content-Length': BODY_2.length * 2 });
    res.end(BODY_2);
    return;
  }

  if (url === '/bad400') {
    bad400Hits++;
    if (bad400Hits === 1) {
      res.writeHead(400, { 'Content-Type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>InvalidArgument</Code><Message>Authorization header is invalid</Message></Error>');
      return;
    }
    res.writeHead(200, { 'Content-Length': BODY_2.length });
    res.end(BODY_2);
    return;
  }

  if (url === '/bad400persist') {
    res.writeHead(400, { 'Content-Type': 'application/xml' });
    res.end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access denied</Message></Error>');
    return;
  }

  if (url === '/slowabort') {
    // Same slow body, but does not touch the shared concurrency counter
    const body = Buffer.from('slowabort-' + 'z'.repeat(8192));
    res.writeHead(200, { 'Content-Length': body.length });
    res.write(body.subarray(0, 64));
    setTimeout(() => { try { res.end(body.subarray(64)); } catch {} }, 150);
    return;
  }

  res.writeHead(404);
  res.end();
});

let tmpDir;
let baseUrl;

// â”€â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function run() {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdl-dl-'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dest = (name) => path.join(tmpDir, name);
  const RETRY0 = () => 0;

  group('1. Basic download');
  {
    const p = dest('ok.bin');
    const r = await downloadOne(`${baseUrl}/ok`, p, { retryDelayFn: RETRY0 });
    const data = await fsp.readFile(p);
    assert('downloads full content', data.equals(BODY_OK));
    assert('returns byte count', r.bytes === BODY_OK.length);
    assert('1 attempt on clean download', r.attempts === 1);
  }

  group('1b. Deep subdirectories are created automatically');
  {
    const p = dest('语文/七年级/聋校语文下册/聋校语文下册.pdf');
    const r = await downloadOne(`${baseUrl}/ok`, p, { retryDelayFn: RETRY0 });
    const data = await fsp.readFile(p);
    assert('file created inside new subdirs', data.equals(BODY_OK) && r.bytes === BODY_OK.length);
  }

  group('2. Retry on 5xx');
  {
    const r = await downloadOne(`${baseUrl}/flaky`, dest('flaky.bin'), { retryDelayFn: RETRY0, maxRetries: 3 });
    const data = await fsp.readFile(dest('flaky.bin'));
    assert('recovers after 500s', data.equals(BODY_1) && r.attempts === 3);
  }

  group('3. Token auth fallback on 401');
  {
    const p = dest('auth.bin');
    const r = await downloadOne(`${baseUrl}/auth`, p, { token: 'TESTTOKEN', retryDelayFn: RETRY0 });
    const data = await fsp.readFile(p);
    assert('recovers with token', data.equals(BODY_1) && r.attempts === 2);
    assert('first request unauthenticated, second authenticated', authSeen[0] === false && authSeen[1] === true);
  }

  group('3b. 401 without token gives friendly error with stage/status/url');
  {
    let err = null;
    try { await downloadOne(`${baseUrl}/auth`, dest('noauth.bin'), { retryDelayFn: RETRY0, maxRetries: 0 }); }
    catch (e) { err = e; }
    assert('throws with Token hint', !!err && /Token/.test(err.message));
    assert('error carries stage', !!err && err.stage === 'download');
    assert('error carries status 401', !!err && err.status === 401);
    assert('error carries url', !!err && err.url === `${baseUrl}/auth`);
  }

  group('4. Range resume after interrupted download');
  {
    const p = dest('range.bin');
    const r = await downloadOne(`${baseUrl}/range`, p, { retryDelayFn: RETRY0, maxRetries: 3 });
    const data = await fsp.readFile(p);
    assert('final file complete after resume', data.equals(BODY_1));
    assert('resume used Range header', rangeSeen.some((h) => /^bytes=\d+-$/.test(h || '')));
    assert('second attempt appends remainder', r.bytes === BODY_1.length);
  }

  group('5. Timeout fails after retries');
  {
    await expectReject(
      'hang request rejected',
      () => downloadOne(`${baseUrl}/hang`, dest('hang.bin'), { retryDelayFn: RETRY0, timeoutMs: 200, maxRetries: 1 }),
      'TIMEOUT'
    );
  }

  group('6. Truncated response detected as failure');
  {
    // HTTP æ— æ³•"å¹²å‡€åœ°"çŸ­æ”¶ bodyï¼ˆå£°æ˜Žé•¿åº¦ > å®žé™…å‘é€ â†’ è¿žæŽ¥ä¸­æ–­ï¼Œå®¢æˆ·ç«¯æŠ¥ abortedï¼‰ã€‚
    // å…³é”®è¡Œä¸ºæ–­è¨€ï¼šæˆªæ–­çš„ä¸‹è½½ç»ä¸èƒ½æŠ¥å‘ŠæˆåŠŸã€‚
    await expectReject(
      'short body rejected',
      () => downloadOne(`${baseUrl}/trunc`, dest('trunc.bin'), { retryDelayFn: RETRY0, timeoutMs: 500, maxRetries: 2 }),
      /aborted|æ–‡ä»¶ä¸å®Œæ•´|Range|ECONNRESET|TIMEOUT/
    );
  }

  group('7. Abort (cancel)');
  {
    const controller = new AbortController();
    const promise = downloadOne(`${baseUrl}/slowabort`, dest('cancel.bin'), {
      signal: controller.signal,
      retryDelayFn: RETRY0,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 30);
    await expectReject('aborted download throws AbortError', () => promise, 'ABORTED');
  }

  group('8. Queue concurrency limit');
  {
    maxQActive = 0;
    const queue = new DownloadQueue({ concurrency: 2, retryDelayFn: RETRY0, timeoutMs: 5000 });
    const done = [];
    queue.onFileDone = (file, result) => done.push(result);
    for (let i = 0; i < 5; i++) {
      queue.enqueue({ url: `${baseUrl}/slow`, dest: dest(`slow${i}.bin`), name: `slow${i}.bin` });
    }
    await queue.whenIdle();
    await sleep(50);
    assert('max concurrent requests â‰¤ 2', maxQActive <= 2);
    assert('all 5 files completed', done.filter((d) => d.success).length === 5);
    assert('queue stats correct', queue.stats.succeeded === 5 && queue.stats.failed === 0);
  }

  group('9. Queue cancel');
  {
    const queue = new DownloadQueue({ concurrency: 2, retryDelayFn: RETRY0, timeoutMs: 5000 });
    const done = [];
    queue.onFileDone = (file, result) => done.push(result);
    for (let i = 0; i < 10; i++) {
      queue.enqueue({ url: `${baseUrl}/slow`, dest: dest(`c${i}.bin`), name: `c${i}.bin` });
    }
    setTimeout(() => queue.cancel(), 50);
    await queue.whenIdle();
    assert('no files completed after cancel', queue.stats.succeeded === 0);
    assert('all remaining files accounted as canceled', queue.stats.canceled === 10);
    assert('whenIdle resolves after cancel', true);
  }

  group('10. Already-complete file (416)');
  {
    const p = dest('complete.bin');
    await fsp.writeFile(p, BODY_1);
    const r = await downloadOne(`${baseUrl}/range`, p, { retryDelayFn: RETRY0 });
    assert('existing complete file short-circuits', r.alreadyComplete === true && r.bytes === BODY_1.length);
  }

  group('11. Retry on HTTP 400 (OSS/CDN transient)');
  {
    const p = dest('bad400.bin');
    const r = await downloadOne(`${baseUrl}/bad400`, p, { retryDelayFn: RETRY0, maxRetries: 2 });
    const data = await fsp.readFile(p);
    assert('400 is retried, file downloads', r.bytes === BODY_2.length && data.equals(BODY_2));
    assert('attempt log records OSS error code', (r.attemptLog[0] && r.attemptLog[0].error || '').includes('InvalidArgument'));
  }

  group('11b. Persistent 400 fails with OSS code in message');
  {
    await expectReject(
      'error message includes OSS Code',
      () => downloadOne(`${baseUrl}/bad400persist`, dest('bad400p.bin'), { retryDelayFn: RETRY0, maxRetries: 1 }),
      /OSS AccessDenied/
    );
  }

  await new Promise((resolve) => server.close(resolve));
  await fsp.rm(tmpDir, { recursive: true, force: true });

  console.log('\nâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  console.log(`  Total: ${passed + failed}   Passed: ${passed}   Failed: ${failed}`);
  console.log('â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
