import { fetchFollow, FetchError } from './safe-fetch.mjs';
import { normalizeHost } from './net-guard.mjs';
import { classifyRobotsResponse, robotsDecision, parseRobots } from './robots.mjs';
import { decodeBody, visibleText, detectNoindex, jsonLdTypes, pageMeta, looksLikeSitemap, looksLikeTextFile } from './analyze.mjs';

export const THRESHOLD_CHARS = 100; // 事前登記：可視テキスト100字未満を未通過とする

const reasonOf = (e) => (e instanceof FetchError ? e.kind : 'connection');
const unknown = (reason, extra = {}) => ({ status: 'unknown', reason, ...extra });

export async function runCheck(input, deps = {}) {
  const n = normalizeHost(input);
  if (!n.ok) return { error: 'invalid-input', reason: n.reason };
  const host = n.host;
  const opts = {
    resolver: deps.resolver, allowPrivate: deps.allowPrivate, _request: deps._request,
    budget: { left: deps.budget ?? 12 }, timeoutMs: deps.timeoutMs ?? 4000,
    deadlineAt: Date.now() + (deps.deadlineMs ?? 8500),
  };
  let origins = deps.origin ? [deps.origin] : [`https://${host}`, `http://${host}`];
  const get = async (path, extra = {}) => {
    let lastErr;
    for (let i = 0; i < origins.length; i++) {
      try {
        const r = await fetchFollow(origins[i] + path, { ...opts, ...extra });
        origins = [origins[i]];
        return r;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof FetchError) || e.kind !== 'connection' || i === origins.length - 1) throw e;
      }
    }
    throw lastErr;
  };

  const out = { domain: host, checkedAt: new Date().toISOString(), items: {}, reference: {}, notes: {} };
  const skipRest = (reason) => {
    for (const k of ['reach', 'noindex', 'body']) out.items[k] = unknown(reason);
    out.reference = { skipped: true, reason };
  };

  let robotsRes;
  try {
    robotsRes = await get('/robots.txt', { maxBytes: 524288, accept: 'text/plain,*/*;q=0.5' });
  } catch (e) {
    const r = reasonOf(e);
    out.items.robots = unknown(r);
    if (r === 'dns') out.notes.dnsFailed = true;
    skipRest(r === 'dns' ? 'dns' : 'robots-unavailable');
    return out;
  }

  const cls = classifyRobotsResponse(robotsRes.status, decodeBody(robotsRes.body, robotsRes.headers['content-type']));
  let parsed = { groups: [], sitemaps: [] };
  if (cls.kind === 'present') {
    parsed = cls.parsed;
    const d = robotsDecision(parsed, 'oai-searchbot', '/');
    out.items.robots = { status: d.allowed ? 'pass' : 'fail', state: 'present', rule: d.rule, group: d.group };
  } else if (cls.kind === 'absent') {
    out.items.robots = { status: 'pass', state: 'absent' };
  } else if (cls.kind === 'denied') {
    out.items.robots = unknown(`http-${cls.status}`);
  } else {
    out.items.robots = unknown('http-5xx', { httpStatus: cls.status });
    skipRest('robots-unavailable');
    return out;
  }

  const allowedForUs = (path) => robotsDecision(parsed, 'kaaselachecker', path).allowed;

  const homeTask = (async () => {
    if (!allowedForUs('/')) {
      out.notes.checkerBlocked = true;
      for (const k of ['reach', 'noindex', 'body']) out.items[k] = unknown('robots-disallow-checker');
      out.reference.page = { skipped: true, reason: 'robots-disallow-checker' };
      return;
    }
    let r;
    try { r = await get('/', { maxBytes: 1_500_000 }); } catch (e) {
      const reason = reasonOf(e);
      out.items.reach = unknown(reason);
      out.items.noindex = unknown('home-unavailable');
      out.items.body = unknown('home-unavailable');
      out.reference.page = { skipped: true, reason: 'home-unavailable' };
      return;
    }
    const finalHost = new URL(r.finalUrl).hostname;
    if (r.status === 200) out.items.reach = { status: 'pass', httpStatus: 200, redirects: r.redirects, finalHost };
    else if ([401, 403, 429].includes(r.status)) out.items.reach = unknown(`http-${r.status}`, { httpStatus: r.status });
    else out.items.reach = { status: 'fail', httpStatus: r.status, redirects: r.redirects, finalHost };
    if (r.status !== 200) {
      out.items.noindex = unknown('home-unavailable');
      out.items.body = unknown('home-unavailable');
      out.reference.page = { skipped: true, reason: 'home-unavailable' };
      return;
    }
    const ct = r.headers['content-type'] || '';
    const html = decodeBody(r.body, ct);
    const isHtml = /html/i.test(ct) || html.trimStart().startsWith('<');
    if (!isHtml) {
      out.items.noindex = unknown('not-html'); out.items.body = unknown('not-html');
      out.reference.page = { skipped: true, reason: 'not-html' };
      return;
    }
    const ni = detectNoindex(html, r.headers);
    out.items.noindex = { status: ni.noindex ? 'fail' : 'pass', via: ni.via };
    const vt = visibleText(html);
    out.items.body = { status: vt.chars >= THRESHOLD_CHARS ? 'pass' : 'fail', chars: vt.chars, hasHeading: vt.hasHeading, threshold: THRESHOLD_CHARS, truncated: r.truncated };
    const meta = pageMeta(html);
    out.reference.jsonld = jsonLdTypes(html);
    out.reference.lang = { htmlLang: meta.htmlLang, hreflang: meta.hreflang, otherLangs: meta.otherLangs };
    out.reference.titleDesc = { title: meta.titlePresent, description: meta.descriptionPresent };
  })();

  const sitemapTask = (async () => {
    const same = (u) => { try { const h = new URL(u).hostname; return h === host || h === 'www.' + host || 'www.' + h === host; } catch { return false; } };
    const candidates = [];
    const declared = parsed.sitemaps.find(same);
    if (declared) candidates.push({ url: declared, source: 'robots' });
    candidates.push({ path: '/sitemap.xml', source: 'default' });
    let anyAllowed = false;
    let failure = null;
    for (const c of candidates) {
      const path = c.path ?? (() => { const u = new URL(c.url); return u.pathname + u.search; })();
      if (!allowedForUs(path)) continue;
      anyAllowed = true;
      try {
        const r = await get(c.path ? c.path : new URL(c.url).pathname + new URL(c.url).search, { maxBytes: 262144, accept: 'application/xml,text/xml,*/*;q=0.5' });
        if (r.status === 200 && looksLikeSitemap(r.body, r.headers['content-type'])) { out.reference.sitemap = { status: 'found', source: c.source }; return; }
      } catch (e) { failure = reasonOf(e); }
    }
    out.reference.sitemap = !anyAllowed ? { status: 'skipped', reason: 'robots-disallow-checker' } : failure ? { status: 'unknown', reason: failure } : { status: 'none' };
  })();

  const llmsTask = (async () => {
    if (!allowedForUs('/llms.txt')) { out.reference.llms = { status: 'skipped', reason: 'robots-disallow-checker' }; return; }
    try {
      const r = await get('/llms.txt', { maxBytes: 65536, accept: 'text/plain,*/*;q=0.5' });
      out.reference.llms = { status: r.status === 200 && looksLikeTextFile(r.body, r.headers['content-type']) ? 'found' : 'none' };
    } catch (e) { out.reference.llms = { status: 'unknown', reason: reasonOf(e) }; }
  })();

  await Promise.all([homeTask, sitemapTask, llmsTask]);
  return out;
}
