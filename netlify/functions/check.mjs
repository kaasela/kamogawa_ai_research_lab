import { createHash, randomBytes } from 'node:crypto';
import { runCheck } from '../lib/checker.mjs';

// 回数制限：IPアドレスは、この関数インスタンスのメモリ上で、ソルト付きハッシュとしてのみ一時的に扱う。保存しない。
const SALT = randomBytes(16).toString('hex');
const WINDOW_MS = 60 * 60 * 1000;
const LIMIT = 20;
const hits = new Map();

function limited(ip) {
  const now = Date.now();
  for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
  if (hits.size > 5000) hits.clear();
  const key = createHash('sha256').update(SALT + ip).digest('hex');
  const e = hits.get(key) ?? { start: now, n: 0 };
  e.n++;
  hits.set(key, e);
  return e.n > LIMIT;
}

const ALLOWED_ORIGINS = new Set(['https://kaasela.com', 'https://www.kaasela.com']);

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', ...extra },
  });
}

// ドメインや結果は console に出さない・保存しない。
export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405, { allow: 'POST' });
  const origin = req.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json({ error: 'origin' }, 403);
  if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'content-type' }, 415);
  let body;
  try {
    const text = await req.text();
    if (text.length > 2000) return json({ error: 'too-large' }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: 'bad-json' }, 400); }
  const domain = body && typeof body.domain === 'string' ? body.domain : '';
  const ip = context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  if (limited(ip)) return json({ error: 'rate-limit' }, 429, { 'retry-after': '3600' });
  const result = await runCheck(domain, globalThis.__KC_TEST_DEPS__ ?? {});
  return result.error ? json(result, 400) : json(result, 200);
};

export const config = { path: '/api/check' };
