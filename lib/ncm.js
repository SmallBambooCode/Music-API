'use strict';

// Do not enable api-enhanced's general unblock behaviour in this adapter.
// The adapter only asks for URLs that the configured account/session may normally receive.
process.env.ENABLE_GENERAL_UNBLOCK = 'false';

const cache = require('./cache');

const LEVELS = new Set([
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'dolby',
  'jymaster',
]);

function normalizeCookie(cookie) {
  let value = String(cookie || '').trim();
  if (!value) return '';
  if (!/(^|;\s*)os=/.test(value)) value += '; os=pc';
  return value;
}

function getCookie() {
  return normalizeCookie(process.env.NCM_COOKIE || '');
}

function getLevel(queryLevel) {
  const level = String(queryLevel || process.env.NCM_LEVEL || 'standard').trim();
  return LEVELS.has(level) ? level : 'standard';
}

function routeToFn(route) {
  return String(route || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\//g, '_');
}

function queryString(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  return sp.toString();
}

async function callByHttp(route, params) {
  const base = String(process.env.NCM_API_BASE || '').replace(/\/+$/, '');
  if (!base) throw new Error('NCM_API_BASE is empty');
  const qs = queryString(params);
  const url = `${base}/${String(route).replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'meting-enhanced-vercel/0.1',
      ...(params.cookie ? { Cookie: params.cookie } : {}),
    },
    redirect: 'manual',
  });

  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Keep non-JSON bodies for proxy/debug endpoints.
  }
  return { status: response.status, body, headers: response.headers };
}

async function callByPackage(route, params) {
  // CommonJS package exported by api-enhanced. Loaded lazily to reduce cold-start cost
  // for health/test routes.
  const ncm = require('@neteasecloudmusicapienhanced/api');
  const fnName = routeToFn(route);
  const fn = ncm[fnName];
  if (typeof fn !== 'function') {
    throw new Error(`api-enhanced function not found: ${fnName}`);
  }
  const result = await fn(params);
  return {
    status: result && result.status ? result.status : 200,
    body: result && Object.prototype.hasOwnProperty.call(result, 'body') ? result.body : result,
    cookie: result && result.cookie,
  };
}

async function call(route, params = {}, options = {}) {
  const safeParams = {
    ...params,
    cookie: params.cookie !== undefined ? params.cookie : getCookie(),
    noCookie: true,
  };

  // Explicitly do not pass unblock=true through, even if a caller supplies it.
  delete safeParams.unblock;

  const ttl = Number(options.ttl || 0);
  const key = `${process.env.NCM_API_BASE ? 'http' : 'pkg'}:${route}:${JSON.stringify(safeParams)}`;

  return cache.wrap(key, ttl, async () => {
    if (process.env.NCM_API_BASE) return callByHttp(route, safeParams);
    return callByPackage(route, safeParams);
  });
}

async function callFirst(routes, params = {}, options = {}) {
  let lastError;
  for (const route of routes) {
    try {
      return await call(route, params, options);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No route candidates provided');
}

module.exports = {
  call,
  callFirst,
  getCookie,
  getLevel,
  normalizeCookie,
};
