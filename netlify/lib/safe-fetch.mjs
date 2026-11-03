import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { isPrivateAddress, normalizeHost } from './net-guard.mjs';

export const UA = 'KaaselaChecker/1.0 (+https://kaasela.com/check/about/)';

export class FetchError extends Error {
  constructor(kind, detail) {
    super(detail ? `${kind}: ${detail}` : kind);
    this.kind = kind; // dns | blocked | timeout | connection | tls | redirect-limit | bad-url | budget
  }
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new FetchError('timeout', 'dns')), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function parseSafeUrl(url, opts) {
  let u;
  try { u = new URL(url); } catch { throw new FetchError('bad-url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('bad-url', 'scheme');
  if (u.username || u.password) throw new FetchError('bad-url', 'userinfo');
  if (u.port && !opts.allowPrivate) throw new FetchError('bad-url', 'port'); // only default ports 80/443 (tests alone may pass allowPrivate)
  if (!opts.allowPrivate) {
    const n = normalizeHost(u.hostname);
    if (!n.ok) throw new FetchError('bad-url', n.reason);
  }
  return u;
}

async function resolvePublic(host, opts) {
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  } else {
    const lookupAll = opts.resolver ?? ((h) => dns.lookup(h, { all: true, verbatim: true }));
    try {
      addrs = await withTimeout(Promise.resolve(lookupAll(host)), opts.dnsTimeoutMs ?? 3000);
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError('dns', e.code);
    }
  }
  if (!addrs || addrs.length === 0) throw new FetchError('dns', 'empty');
  if (!opts.allowPrivate && addrs.some((a) => isPrivateAddress(a.address))) throw new FetchError('blocked');
  return [...addrs].sort((a, b) => a.family - b.family); // IPv4 first
}

const CONN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']);

function classify(e) {
  if (e instanceof FetchError) return e;
  const c = e && e.code ? String(e.code) : '';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return new FetchError('dns', c);
  if (c.startsWith('ERR_TLS') || c.startsWith('ERR_SSL') || c.includes('CERT') || c.includes('SELF_SIGNED') || c === 'EPROTO' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return new FetchError('tls', c);
  if (c === 'ERR_SOCKET_TIMEOUT' || c === 'ETIMEDOUT') return new FetchError('timeout');
  return new FetchError('connection', c || undefined);
}

function requestOnce(u, addr, opts) {
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(wall); fn(v); } };
    const req = lib.request({
      host: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: 'GET',
      agent: false,
      servername: u.protocol === 'https:' ? u.hostname : undefined,
      timeout: timeoutMs,
      headers: {
        'User-Agent': UA,
        'Accept': opts.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'close',
      },
      lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address: addr.address, family: addr.family }]) : cb(null, addr.address, addr.family)),
    }, (res) => {
      const chunks = [];
      let size = 0;
      let truncated = false;
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const finish = () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated });
      stream.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) {
          chunks.push(c.subarray(0, c.length - (size - maxBytes)));
          truncated = true;
          res.destroy();
          finish();
          return;
        }
        chunks.push(c);
      });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', (e) => (truncated || chunks.length ? finish() : done(reject, classify(e))));
      res.on('error', (e) => (truncated || chunks.length ? finish() : done(reject, classify(e))));
    });
    const wall = setTimeout(() => { req.destroy(); done(reject, new FetchError('timeout')); }, timeoutMs);
    req.on('timeout', () => { req.destroy(); done(reject, new FetchError('timeout')); });
    req.on('error', (e) => done(reject, classify(e)));
    req.end();
  });
}

export async function fetchFollow(startUrl, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  let url = startUrl;
  const chain = [];
  for (let hop = 0; ; hop++) {
    if (opts.budget && --opts.budget.left < 0) throw new FetchError('budget');
    const left = opts.deadlineAt ? opts.deadlineAt - Date.now() : Infinity;
    if (left <= 0) throw new FetchError('timeout', 'deadline');
    const hopOpts = { ...opts, timeoutMs: Math.min(opts.timeoutMs ?? 5000, left) };
    const u = parseSafeUrl(url, hopOpts);
    const addrs = await resolvePublic(u.hostname, hopOpts);
    let r, lastErr;
    for (const addr of addrs.slice(0, 2)) {
      try { r = await (opts._request ?? requestOnce)(u, addr, hopOpts); lastErr = null; break; } catch (e) {
        lastErr = e;
        if (!(e instanceof FetchError) || e.kind !== 'connection') break;
      }
    }
    if (!r) throw lastErr;
    chain.push({ url: u.href, status: r.status });
    const loc = r.headers.location;
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      if (hop >= maxRedirects) throw new FetchError('redirect-limit');
      try { url = new URL(loc, u).href; } catch { throw new FetchError('bad-url', 'location'); }
      continue;
    }
    return { status: r.status, headers: r.headers, body: r.body, truncated: r.truncated, finalUrl: u.href, redirects: hop, chain };
  }
}
