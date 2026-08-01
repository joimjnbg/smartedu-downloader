// ─── Download engine (testable without Electron) ───────────────────────────
// Parallel queue with:
//   - concurrency limit (worker pool)
//   - HTTP Range resume (partial files continue, not restart)
//   - exponential backoff retry on network errors / 5xx / 429 / timeouts
//   - token auth fallback on 401/403
//   - cancellation (AbortController per file)
//   - throttled progress callbacks (speed + bytes)

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const http = require('http');
const https = require('https');
const { authHeaders } = require('./net');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const PROGRESS_THROTTLE_MS = 100;

class AbortError extends Error {
  constructor() { super('ABORTED'); this.name = 'AbortError'; }
}

function retryDelay(attempt) {
  const base = 500 * Math.pow(2, attempt);
  return base + Math.floor(Math.random() * base * 0.25);
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Single HTTP request that streams one response into dest.
// resolve({ status, ok, restart, received, total, error })
async function streamOnce(url, dest, { headers, signal, timeoutMs, offset, onProgress }) {
  return new Promise((resolve) => {
    let req;
    let settled = false;
    const client = url.startsWith('https') ? https : http;
    let bytes = 0;

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (req) req.removeListener('timeout', onTimeout);
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onAbort = () => { req.destroy(new AbortError()); };
    const onTimeout = () => { req.destroy(new Error(`TIMEOUT after ${timeoutMs}ms`)); };

    try {
      req = client.get(url, { headers }, (res) => {
        const status = res.statusCode || 0;

        if (status === 416) { res.resume(); return finish({ status, ok: false }); }
        if (status !== 200 && status !== 206) { res.resume(); return finish({ status, ok: false }); }

        const append = status === 206;
        if (!append && offset > 0) { res.resume(); return finish({ status, ok: false, restart: true }); }

        const effectiveOffset = append ? offset : 0;
        const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
        const ws = fs.createWriteStream(dest, { flags: append ? 'a' : 'w' });

        res.on('data', (c) => {
          bytes += c.length;
          if (!ws.write(c)) res.pause();
          onProgress(effectiveOffset + bytes, effectiveOffset + (total || bytes));
        });
        ws.on('drain', () => res.resume());
        res.on('error', (err) => { ws.destroy(); finish({ status, ok: false, error: err }); });
        res.on('end', () => ws.end());
        ws.on('error', (err) => finish({ status, ok: false, error: err }));
        ws.on('finish', () => finish({ status, ok: true, received: bytes, total }));
      });
    } catch (err) {
      return finish({ status: 0, ok: false, error: err });
    }

    req.on('error', (err) => finish({ status: 0, ok: false, error: err }));
    req.setTimeout(timeoutMs, onTimeout);
    if (signal) {
      if (signal.aborted) { req.destroy(new AbortError()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// Download one file to dest with resume + retry + auth fallback.
// Returns { bytes, attempts, total, alreadyComplete }.
async function downloadOne(url, dest, opts = {}) {
  const { token, signal, timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = DEFAULT_MAX_RETRIES, onProgress = () => {}, retryDelayFn = retryDelay } = opts;
  let usedAuth = false;
  let attempts = 0;
  let finalTotal = null;

  const fail = (msg, extra = {}) => {
    const e = new Error(msg);
    Object.assign(e, { stage: 'download', url, status: 0, attempts, ...extra });
    throw e;
  };

  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
  } catch {}

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts++;
    const st = await fsp.stat(dest).catch(() => null);
    const offset = st ? st.size : 0;

    const headers = { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' };
    if (usedAuth) Object.assign(headers, authHeaders(token));
    if (offset > 0) headers['Range'] = `bytes=${offset}-`;

    const r = await streamOnce(url, dest, { headers, signal, timeoutMs, offset, onProgress });
    if (r.total != null) finalTotal = offset + r.total;

    if (r.ok) {
      const nowSize = (st ? st.size : 0) + r.received;
      if (r.total != null && r.received < r.total) {
        if (attempt < maxRetries) { await sleep(retryDelayFn(attempt)); continue; }
        fail(`文件不完整: 收到 ${r.received}/${r.total} 字节`, { status: r.status });
      }
      return { bytes: nowSize, attempts, total: finalTotal, alreadyComplete: false };
    }

    if (r.status === 416) {
      return { bytes: offset, attempts, total: offset, alreadyComplete: true };
    }
    if (r.restart) {
      await fsp.rm(dest, { force: true });
      if (attempt < maxRetries) continue;
      fail('服务器不支持 Range，重试后仍失败', { status: r.status });
    }
    if (r.error && r.error.name === 'AbortError') throw r.error;
    if (r.status === 401 || r.status === 403) {
      if (token && !usedAuth) { usedAuth = true; continue; }
      fail(token ? `HTTP ${r.status}` : '需要登录 Token（该资源受保护）', { status: r.status });
    }
    if ((r.error || isRetryableStatus(r.status)) && attempt < maxRetries) {
      await sleep(retryDelayFn(attempt));
      continue;
    }
    fail(r.error ? r.error.message : `HTTP ${r.status}`, { status: r.status });
  }
  fail('下载失败');
}

// ─── Parallel queue ─────────────────────────────────────────────────────────

class DownloadQueue {
  constructor(opts = {}) {
    this.concurrency = opts.concurrency || 4;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.retryDelayFn = opts.retryDelayFn || retryDelay;
    this.onProgress = opts.onProgress || (() => {});
    this.onFileDone = opts.onFileDone || (() => {});

    this.queue = [];
    this.active = new Map();
    this.canceled = false;
    this.stats = { total: 0, completed: 0, succeeded: 0, failed: 0, canceled: 0 };
    this._idle = 0;
    this._idleResolvers = [];
    this._speeds = new Map();
    this._seq = 0;
  }

  get activeCount() { return this.active.size; }

  enqueue(file) {
    if (this.canceled) return;
    file.__id = ++this._seq;
    this.queue.push(file);
    this.stats.total++;
    this._idle++;
    this._pump();
  }

  cancel() {
    this.canceled = true;
    for (const f of this.queue) {
      this._idle--;
      this.stats.canceled++;
    }
    this.queue = [];
    for (const c of this.active.values()) c.abort();
    if (this._idle === 0) {
      for (const r of this._idleResolvers.splice(0)) r();
    }
  }

  whenIdle() {
    if (this._idle === 0) return Promise.resolve();
    return new Promise((resolve) => this._idleResolvers.push(resolve));
  }

  _pump() {
    while (this.active.size < this.concurrency && this.queue.length > 0 && !this.canceled) {
      this._start(this.queue.shift());
    }
  }

  async _start(file) {
    const controller = new AbortController();
    this.active.set(file.__id, controller);
    const startedAt = Date.now();
    this._speeds.set(file.__id, { time: startedAt, bytes: 0 });

    try {
      const result = await downloadOne(file.url, file.dest, {
        token: file.token,
        signal: controller.signal,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
        retryDelayFn: this.retryDelayFn,
        onProgress: (downloaded, total) => {
          const s = this._speeds.get(file.__id) || { time: startedAt, bytes: 0 };
          const now = Date.now();
          const dt = (now - s.time) / 1000;
          const speed = dt > 0 ? (downloaded - s.bytes) / dt : 0;
          s.time = now;
          s.bytes = downloaded;
          this.onProgress(file, { downloaded, total, speed: Math.max(0, speed) });
        },
      });
      this.stats.succeeded++;
      this.onFileDone(file, { success: true, bytes: result.bytes, attempts: result.attempts, ms: Date.now() - startedAt, alreadyComplete: result.alreadyComplete });
    } catch (err) {
      if (this.canceled || err.name === 'AbortError') {
        this.stats.canceled++;
      } else {
        this.stats.failed++;
        this.onFileDone(file, { success: false, error: err.message, attempts: err.attempts || 0, ms: Date.now() - startedAt });
      }
    } finally {
      this._speeds.delete(file.__id);
      this.active.delete(file.__id);
      this.stats.completed++;
      this._idle--;
      if (this._idle === 0) {
        for (const r of this._idleResolvers.splice(0)) r();
      }
      this._pump();
    }
  }
}

module.exports = { downloadOne, streamOnce, DownloadQueue, AbortError, retryDelay, isRetryableStatus };
