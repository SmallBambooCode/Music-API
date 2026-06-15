'use strict';

function setCors(res, origin = '*') {
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin, Referer');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Password');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJson(req, res, status, payload, corsOrigin = '*') {
  setCors(res, corsOrigin);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', status >= 400 ? 'no-store' : 'public, max-age=30');
  if (req.method === 'HEAD') return res.end();
  return res.end(JSON.stringify(payload));
}

function sendText(req, res, status, text, contentType = 'text/plain; charset=utf-8', corsOrigin = '*') {
  setCors(res, corsOrigin);
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', status >= 400 ? 'no-store' : 'public, max-age=60');
  if (req.method === 'HEAD') return res.end();
  return res.end(text || '');
}

function redirect(res, location, status = 302, corsOrigin = '*') {
  setCors(res, corsOrigin);
  res.statusCode = status;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  return res.end();
}

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function getPath(req) {
  try {
    return new URL(req.url, getOrigin(req)).pathname;
  } catch {
    return '/api';
  }
}

function getQuery(req) {
  const url = new URL(req.url, getOrigin(req));
  const query = {};
  for (const [key, value] of url.searchParams.entries()) query[key] = value;
  return query;
}

function apiBaseUrl(req) {
  const origin = getOrigin(req);
  const path = getPath(req);
  if (path === '/' || path === '/test' || path === '/health' || path.startsWith('/admin')) return `${origin}/api`;
  return `${origin}${path}`;
}

function sendMaybeJsonp(req, res, status, payload, callback, corsOrigin = '*') {
  if (callback && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(callback)) {
    return sendText(req, res, status, `${callback}(${JSON.stringify(payload)});`, 'application/javascript; charset=utf-8', corsOrigin);
  }
  return sendJson(req, res, status, payload, corsOrigin);
}

function readBody(req, limitBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [key, value] of params.entries()) obj[key] = value;
    return obj;
  }
}

module.exports = {
  setCors,
  sendJson,
  sendText,
  redirect,
  getOrigin,
  getPath,
  getQuery,
  apiBaseUrl,
  sendMaybeJsonp,
  readBody,
  readJson,
};
