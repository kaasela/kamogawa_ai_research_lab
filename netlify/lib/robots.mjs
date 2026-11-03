// robots.txt per RFC 9309 (group selection, longest-match, allow wins ties)
export function parseRobots(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of lines) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (cur) cur.rules.push({ allow: field === 'allow', pattern: value });
    } else if (field === 'sitemap') {
      if (value) sitemaps.push(value);
    }
  }
  return { groups, sitemaps };
}

function toRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + re + (anchored ? '$' : ''));
}

export function robotsDecision(parsed, token, path) {
  const t = String(token).toLowerCase();
  let groups = parsed.groups.filter((g) => g.agents.includes(t));
  let group = 'specific';
  if (groups.length === 0) { groups = parsed.groups.filter((g) => g.agents.includes('*')); group = groups.length ? 'wildcard' : 'none'; }
  const rules = groups.flatMap((g) => g.rules).filter((r) => r.pattern !== '');
  let best = null;
  for (const r of rules) {
    if (!toRegex(r.pattern).test(path)) continue;
    const len = r.pattern.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow, pattern: r.pattern };
  }
  return best ? { allowed: best.allow, rule: best.pattern, group } : { allowed: true, rule: null, group };
}

// HTTP status -> how the crawler must treat robots.txt (RFC 9309 §2.3.1)
export function classifyRobotsResponse(status, bodyText) {
  if (status >= 200 && status < 300) return { kind: 'present', parsed: parseRobots(bodyText) };
  if (status === 401 || status === 403 || status === 429) return { kind: 'denied', status };
  if (status >= 400 && status < 500) return { kind: 'absent' };
  return { kind: 'unavailable', status };
}
