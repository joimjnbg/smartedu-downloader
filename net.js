// ─── HTTP client layer (testable without Electron) ─────────────────────────
// Retry / timeout / auth-fallback for JSON API calls.

const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

function authHeaders(token) {
  const h = { 'User-Agent': 'Mozilla/5.0' };
  if (token) {
    h['Authorization'] = `Bearer ${token}`;
    h['X-ND-AUTH'] = `MAC id="${token}",nonce="0",mac="0"`;
  }
  return h;
}

function retryDelay(attempt) {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * base * 0.25);
}

function isRetryable(status) {
  return status === 429 || status >= 500;
}

function requestOnce(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    let settled = false;
    const client = url.startsWith('https') ? https : http;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('ABORTED'));
    };
    if (signal) {
      if (signal.aborted) return reject(new Error('ABORTED'));
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      req = client.get(url, { headers }, (res) => {
        if (settled) return;
        const status = res.statusCode || 0;

        let stream = res;
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

        const chunks = [];
        let size = 0;
        stream.on('data', (c) => { chunks.push(c); size += c.length; });
        stream.on('error', (err) => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        });
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({ status, body: Buffer.concat(chunks), size });
        });
      });
    } catch (err) {
      return reject(err);
    }

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.setTimeout(timeoutMs, () => {
      if (settled) return;
      req.destroy(new Error(`TIMEOUT after ${timeoutMs}ms`));
    });
  });
}

// fetchJson with retries + auth fallback.
// - network errors / timeouts / 5xx / 429 → retry with exponential backoff
// - 401/403 without token → immediately retry with token (if provided)
async function fetchJson(url, { token, retries = MAX_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  let usedAuth = false;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const headers = usedAuth ? authHeaders(token) : { 'User-Agent': 'Mozilla/5.0' };

    let res;
    try {
      res = await requestOnce(url, { headers, timeoutMs, signal });
    } catch (err) {
      if (err.message === 'ABORTED') throw err;
      if (attempt < retries) {
        await sleep(retryDelay(attempt));
        continue;
      }
      throw new Error(`网络请求失败: ${err.message}`);
    }

    if (res.status === 200) {
      try { return JSON.parse(res.body.toString('utf8')); }
      catch (e) { throw new Error('响应不是有效 JSON'); }
    }

    if ((res.status === 401 || res.status === 403) && token && !usedAuth) {
      usedAuth = true;
      continue;
    }

    if (isRetryable(res.status) && attempt < retries) {
      await sleep(retryDelay(attempt));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('请求失败');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { authHeaders, fetchJson, requestOnce, retryDelay, isRetryable };
