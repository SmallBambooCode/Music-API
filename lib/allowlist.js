'use strict';

let runtimeDisabled = null;
let runtimeChangedAt = null;

function nowIso() {
  return new Date().toISOString();
}

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function getRules() {
  return splitCsv(process.env.ALLOWLIST || '');
}

function defaultDisabled() {
  return envBool('ALLOWLIST_DISABLED_DEFAULT', false);
}

function isDisabled() {
  return runtimeDisabled === null ? defaultDisabled() : runtimeDisabled;
}

function setDisabled(disabled) {
  runtimeDisabled = Boolean(disabled);
  runtimeChangedAt = nowIso();
  return getStatus();
}

function getStatus() {
  const rules = getRules();
  return {
    enabled: !isDisabled(),
    temporarilyDisabled: isDisabled(),
    disabledSource: runtimeDisabled === null ? 'env:ALLOWLIST_DISABLED_DEFAULT' : 'runtime-memory',
    changedAt: runtimeChangedAt,
    rules,
    ruleCount: rules.length,
    allowLocal: envBool('ALLOW_LOCAL', true),
    hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
  };
}

function isAdminPassword(password) {
  const expected = String(process.env.ADMIN_PASSWORD || '');
  if (!expected) return { ok: false, reason: 'ADMIN_PASSWORD_NOT_CONFIGURED' };
  if (String(password || '') !== expected) return { ok: false, reason: 'BAD_PASSWORD' };
  return { ok: true };
}

function getPasswordFromReq(req, url) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-admin-password'];
  if (header) return String(header);
  return url.searchParams.get('password') || '';
}

function clientInfo(req) {
  const origin = String(req.headers.origin || '');
  const referer = String(req.headers.referer || '');
  const host = String(req.headers.host || '');
  const xff = String(req.headers['x-forwarded-for'] || '');
  const real = String(req.headers['x-real-ip'] || '');
  const cf = String(req.headers['cf-connecting-ip'] || '');
  const ip = (xff.split(',')[0] || real || cf || req.socket?.remoteAddress || '').trim();

  return {
    origin,
    referer,
    host,
    ip,
    originHost: safeHost(origin),
    refererHost: safeHost(referer),
  };
}

function safeHost(value) {
  if (!value) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
}

function isLocalHost(host) {
  return ['localhost', '127.0.0.1', '::1'].includes(normalizeHost(host));
}

function isLocalIp(ip) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(ip || '').trim());
}

function hostMatches(host, rule) {
  const h = normalizeHost(host);
  const r = normalizeHost(rule);
  if (!h || !r) return false;
  if (r === '*') return true;
  if (r.startsWith('*.')) {
    const base = r.slice(2);
    return h === base || h.endsWith('.' + base);
  }
  return h === r;
}

function ipToInt(ip) {
  const parts = String(ip || '').trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) + x;
  }
  return n >>> 0;
}

function cidrMatches(ip, rule) {
  if (!rule.includes('/')) return false;
  const [base, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipN = ipToInt(ip);
  const baseN = ipToInt(base);
  if (ipN === null || baseN === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

function exactIpMatches(ip, rule) {
  return String(ip || '').trim() === String(rule || '').trim();
}

function isAllowed(req) {
  if (isDisabled()) {
    return { allowed: true, reason: 'ALLOWLIST_TEMPORARILY_DISABLED', ...clientInfo(req) };
  }

  const rules = getRules();
  if (rules.length === 0) {
    return { allowed: true, reason: 'ALLOWLIST_EMPTY', ...clientInfo(req) };
  }

  const info = clientInfo(req);

  if (envBool('ALLOW_LOCAL', true)) {
    if (isLocalHost(info.host) || isLocalHost(info.originHost) || isLocalHost(info.refererHost) || isLocalIp(info.ip)) {
      return { allowed: true, reason: 'LOCAL_ALLOWED', ...info };
    }
  }

  for (const rule of rules) {
    if (hostMatches(info.originHost, rule)) return { allowed: true, reason: `ORIGIN_MATCH:${rule}`, ...info };
    if (hostMatches(info.refererHost, rule)) return { allowed: true, reason: `REFERER_MATCH:${rule}`, ...info };
    if (hostMatches(info.host, rule)) return { allowed: true, reason: `HOST_MATCH:${rule}`, ...info };
    if (cidrMatches(info.ip, rule)) return { allowed: true, reason: `CIDR_MATCH:${rule}`, ...info };
    if (exactIpMatches(info.ip, rule)) return { allowed: true, reason: `IP_MATCH:${rule}`, ...info };
  }

  return { allowed: false, reason: 'NO_ALLOWLIST_RULE_MATCHED', ...info };
}

module.exports = {
  getRules,
  getStatus,
  setDisabled,
  isAdminPassword,
  getPasswordFromReq,
  clientInfo,
  isAllowed,
};
