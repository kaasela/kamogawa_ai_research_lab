import net from 'node:net';
import { domainToASCII } from 'node:url';

const V4_BLOCKS = [
  [0,0,0,0,8],[10,0,0,0,8],[100,64,0,0,10],[127,0,0,0,8],[169,254,0,0,16],[172,16,0,0,12],
  [192,0,0,0,24],[192,0,2,0,24],[192,88,99,0,24],[192,168,0,0,16],[198,18,0,0,15],
  [198,51,100,0,24],[203,0,113,0,24],[224,0,0,0,4],[240,0,0,0,4],
];

function parseIPv4(s) {
  const p = s.split('.');
  if (p.length !== 4) return null;
  const o = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return o.some((n) => !(n >= 0 && n <= 255)) ? null : o;
}

function v4Blocked(o) {
  const ip = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  return V4_BLOCKS.some(([a, b, c, d, bits]) => {
    const base = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

export function parseIPv6(input) {
  let s = String(input).split('%')[0].toLowerCase();
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':'));
  const head = parse(dbl[0]);
  const rest = dbl.length === 2 ? parse(dbl[1]) : [];
  let groups;
  if (dbl.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some((n) => Number.isNaN(n)) ? null : out;
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const o = parseIPv4(ip);
    return !o || v4Blocked(o);
  }
  if (net.isIPv6(ip)) {
    const g = parseIPv6(ip);
    if (!g) return true;
    const embedded = (hi, lo) => v4Blocked([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    const firstFiveZero = g.slice(0, 5).every((x) => x === 0);
    if (firstFiveZero && g[5] === 0xffff) return embedded(g[6], g[7]); // ::ffff:a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6], g[7]); // NAT64
    if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, ::/96
    if ((g[0] & 0xe000) !== 0x2000) return true; // global unicast is 2000::/3 only
    if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return true; // documentation, Teredo
    if (g[0] === 0x2002) return true; // 6to4
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

const BAD_TLDS = new Set(['local','localhost','internal','lan','home','corp','intranet','localdomain','test','invalid','arpa','onion']);

export function normalizeHost(input) {
  let s = String(input ?? '').trim();
  if (!s || s.length > 300) return { ok: false, reason: 'empty' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: 'invalid' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo' };
  if (u.port) return { ok: false, reason: 'port' };
  const raw = u.hostname.replace(/\.$/, '');
  if (!raw) return { ok: false, reason: 'invalid' };
  if (raw.startsWith('[') || net.isIP(raw)) return { ok: false, reason: 'ip' };
  const host = domainToASCII(raw).toLowerCase();
  if (!host || host.length > 253 || !host.includes('.')) return { ok: false, reason: 'invalid' };
  const labels = host.split('.');
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return { ok: false, reason: 'invalid' };
  const tld = labels[labels.length - 1];
  if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld) || BAD_TLDS.has(tld)) return { ok: false, reason: 'tld' };
  return { ok: true, host };
}
