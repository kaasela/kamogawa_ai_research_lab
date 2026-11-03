const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

export function decodeBody(buf, contentType = '') {
  let label = (/charset\s*=\s*["']?([\w-]+)/i.exec(contentType) || [])[1];
  if (!label) {
    const head = buf.subarray(0, 4096).toString('latin1');
    label = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

function stripNonContent(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

export function visibleText(html) {
  const stripped = stripNonContent(html);
  const hasHeading = /<h[1-3][\s>]/i.test(stripped);
  const text = decodeEntities(stripped.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  const chars = [...text.replace(/\s+/g, '')].length;
  return { chars, hasHeading, sample: text.slice(0, 80) };
}

const DIRECTIVES = new Set(['noindex','nofollow','none','noarchive','nosnippet','notranslate','noimageindex','unavailable_after','max-snippet','max-image-preview','max-video-preview','indexifembedded','all','index','follow']);
const CRAWLERS = new Set(['robots', 'googlebot', 'bingbot', 'oai-searchbot']);

export function detectNoindex(html, headers = {}) {
  const via = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = (attr(tag, 'name') || '').toLowerCase();
    if (!CRAWLERS.has(name)) continue;
    const tokens = (attr(tag, 'content') || '').toLowerCase().split(/[,\s]+/);
    if (tokens.includes('noindex') || tokens.includes('none')) { via.push('meta'); break; }
  }
  const h = headers['x-robots-tag'];
  for (const v of Array.isArray(h) ? h : h ? [h] : []) {
    for (const part of String(v).split(/,(?=\s*[a-z0-9_-]+\s*:)/i)) {
      let rules = part.trim().toLowerCase();
      const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(rules);
      if (m && !DIRECTIVES.has(m[1])) { if (!CRAWLERS.has(m[1])) continue; rules = m[2]; }
      if (rules.split(/[,\s]+/).some((t) => t === 'noindex' || t === 'none')) { via.push('header'); break; }
    }
  }
  return { noindex: via.length > 0, via: [...new Set(via)] };
}

export function jsonLdTypes(html) {
  const types = new Set();
  let invalid = 0;
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const t = o['@type'];
    for (const x of Array.isArray(t) ? t : t ? [t] : []) if (typeof x === 'string') types.add(x);
    if (o['@graph']) walk(o['@graph']);
  };
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) { try { walk(JSON.parse(m[1])); } catch { invalid++; } }
  return { types: [...types].slice(0, 6), present: types.size > 0, invalid };
}

export function pageMeta(html) {
  const title = decodeEntities(((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '')).replace(/\s+/g, ' ').trim();
  let description = '';
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if ((attr(tag, 'name') || '').toLowerCase() === 'description') { description = (attr(tag, 'content') || '').trim(); break; }
  }
  const htmlLang = ((/<html\b[^>]*\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(html) || [])[1] || '').toLowerCase();
  const hreflangs = new Set();
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (/alternate/i.test(attr(tag, 'rel') || '') && attr(tag, 'hreflang')) hreflangs.add(attr(tag, 'hreflang').toLowerCase());
  }
  const primary = (s) => s.split('-')[0];
  const otherLangs = [...hreflangs].some((l) => l !== 'x-default' && htmlLang && primary(l) !== primary(htmlLang));
  return { titlePresent: title.length > 0, descriptionPresent: description.length > 0, htmlLang, hreflang: hreflangs.size > 0, otherLangs };
}

export function looksLikeSitemap(buf, contentType = '') {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return true; // .xml.gz served as-is
  return /<(urlset|sitemapindex)\b/i.test(buf.subarray(0, 4096).toString('utf8'));
}

export function looksLikeTextFile(buf, contentType = '') {
  const head = buf.subarray(0, 512).toString('utf8').trimStart().toLowerCase();
  if (!head) return false;
  return !(head.startsWith('<') || /text\/html/i.test(contentType));
}
