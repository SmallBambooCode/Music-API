'use strict';

const crypto = require('crypto');

function parseBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

let runtimeAllowlistDisabled = parseBool(process.env.ALLOWLIST_DISABLED_DEFAULT || 'false');
let runtimeAllowlistDisabledAt = runtimeAllowlistDisabled ? new Date().toISOString() : null;

function splitRules(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function cleanRule(rule) {
  let x = String(rule || '').trim();
  if (!x) return '';
  if (x === '*') return '*';
  try {
    if (/^https?:\/\//i.test(x)) {
      const u = new URL(x);
      return (u.host || u.hostname).toLowerCase();
    }
  } catch {}
  x = x.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:+$/, '');
  return x.toLowerCase();
}

function normalizeRules(value) {
  return [...new Set(splitRules(value).map(cleanRule).filter(Boolean))];
}

function getRuntimeAllowlistState() {
  return {
    disabled: runtimeAllowlistDisabled,
    disabledAt: runtimeAllowlistDisabledAt,
    runtimeOnly: true,
    note: 'Temporary switch is held in the same /api serverless function runtime memory. It may reset after redeploy, cold start, instance recycle, or region switch.',
  };
}

function setRuntimeAllowlistDisabled(disabled) {
  runtimeAllowlistDisabled = Boolean(disabled);
  runtimeAllowlistDisabledAt = runtimeAllowlistDisabled ? new Date().toISOString() : null;
  return getRuntimeAllowlistState();
}

async function getStoredAllowlist() {
  const rules = normalizeRules(process.env.ALLOWLIST || process.env.ALLOWED_ORIGINS || '');
  return { rules, source: 'env', writable: false, editable: false, runtimeSwitch: getRuntimeAllowlistState() };
}

function parseHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).host.toLowerCase();
    return new URL(`http://${raw}`).host.toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const x = Number(part);
    if (x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
}

function cidrMatch(ip, cidr) {
  const [base, bitsText] = String(cidr).split('/');
  const bits = Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function hostMatchesRule(hostOrIp, rule) {
  const value = parseHost(hostOrIp);
  const r = cleanRule(rule);
  if (!value || !r) return false;
  if (r === '*') return true;
  if (r.includes('/')) return cidrMatch(value, r);
  if (value === r) return true;
  if (r.startsWith('*.')) {
    const base = r.slice(2);
    return value === base || value.endsWith(`.${base}`);
  }
  return false;
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (
    forwarded ||
    String(req.headers['x-real-ip'] || '').trim() ||
    String(req.headers['cf-connecting-ip'] || '').trim() ||
    (req.socket && req.socket.remoteAddress) ||
    ''
  ).replace(/^::ffff:/, '');
}

function getRequestCandidates(req) {
  const candidates = [];
  const origin = req.headers.origin;
  const referer = req.headers.referer || req.headers.referrer;
  const ip = getClientIp(req);
  if (origin) candidates.push({ kind: 'origin', value: origin, host: parseHost(origin) });
  if (referer) candidates.push({ kind: 'referer', value: referer, host: parseHost(referer) });
  if (ip) candidates.push({ kind: 'ip', value: ip, host: ip });
  return candidates;
}

async function checkAllowlist(req) {
  const info = await getStoredAllowlist();
  const candidates = getRequestCandidates(req);

  if (runtimeAllowlistDisabled) {
    return {
      allowed: true,
      disabled: true,
      rules: info.rules,
      candidates,
      matched: { kind: 'runtime_switch', value: 'allowlist disabled by admin password' },
      source: 'admin_runtime_disabled',
      corsOrigin: '*',
      runtimeSwitch: getRuntimeAllowlistState(),
    };
  }

  const allowed = info.rules.some((rule) => candidates.some((candidate) => hostMatchesRule(candidate.host || candidate.value, rule)));
  const matched = allowed
    ? candidates.find((candidate) => info.rules.some((rule) => hostMatchesRule(candidate.host || candidate.value, rule)))
    : null;
  const corsOrigin = matched && matched.kind === 'origin' ? matched.value : 'null';
  return { allowed, disabled: false, rules: info.rules, candidates, matched, source: info.source, corsOrigin, runtimeSwitch: getRuntimeAllowlistState() };
}

function authHeaderPassword(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-admin-password'] || '').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function isAdminAuthed(req, body = {}) {
  const expected = String(process.env.ADMIN_PASSWORD || '');
  if (!expected) return false;
  const supplied = authHeaderPassword(req) || body.password || body.adminPassword || '';
  return safeEqual(supplied, expected);
}

module.exports = {
  normalizeRules,
  getStoredAllowlist,
  checkAllowlist,
  isAdminAuthed,
  getClientIp,
  getRequestCandidates,
  getRuntimeAllowlistState,
  setRuntimeAllowlistDisabled,
};
