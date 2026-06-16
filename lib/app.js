'use strict';

const fs = require('node:fs');
const path = require('node:path');
const provider = require('./provider');
const meting = require('./meting');
const allowlist = require('./allowlist');
const httpClient = require('./enhanced-http-client');

const VERSION = '0.12.0';

function send(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST',
    'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Admin-Password',
    'Cache-Control': 'no-store',
    ...headers,
  });
  if (res.req && res.req.method === 'HEAD') return res.end();
  res.end(body);
}

function json(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

function text(res, status, body) {
  send(res, status, body, 'text/plain; charset=utf-8');
}

function redirect(res, url) {
  res.writeHead(302, { Location: url, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end();
}

function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function staticFile(name, res, type) {
  const file = path.join(__dirname, '..', 'public', name);
  send(res, 200, fs.readFileSync(file, 'utf8'), type || 'text/html; charset=utf-8');
}

async function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

async function passwordFromReq(req, url) {
  const queryPwd = allowlist.getPasswordFromReq(req, url);
  if (queryPwd) return queryPwd;

  if (req.method === 'POST') {
    const raw = await readBody(req);
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) {
      try { return JSON.parse(raw).password || ''; } catch { return ''; }
    }
    const params = new URLSearchParams(raw);
    return params.get('password') || '';
  }

  return '';
}

async function adminStatus(req, res, url) {
  const password = await passwordFromReq(req, url);
  const auth = allowlist.isAdminPassword(password);
  if (!auth.ok) {
    return json(res, auth.reason === 'ADMIN_PASSWORD_NOT_CONFIGURED' ? 500 : 401, {
      ok: false,
      auth: false,
      reason: auth.reason,
      message: auth.reason === 'ADMIN_PASSWORD_NOT_CONFIGURED'
        ? '服务端没有配置 ADMIN_PASSWORD。'
        : '管理员密码不正确。',
      allowlist: allowlist.getStatus(),
      client: allowlist.clientInfo(req),
    });
  }

  return json(res, 200, {
    ok: true,
    auth: true,
    message: '管理员密码正确。',
    allowlist: allowlist.getStatus(),
    client: allowlist.clientInfo(req),
    provider: provider.providerName(),
  });
}

async function adminToggle(req, res, url) {
  const password = await passwordFromReq(req, url);
  const auth = allowlist.isAdminPassword(password);
  if (!auth.ok) {
    return json(res, auth.reason === 'ADMIN_PASSWORD_NOT_CONFIGURED' ? 500 : 401, {
      ok: false,
      auth: false,
      reason: auth.reason,
      message: auth.reason === 'ADMIN_PASSWORD_NOT_CONFIGURED'
        ? '服务端没有配置 ADMIN_PASSWORD。'
        : '管理员密码不正确，白名单状态没有改变。',
    });
  }

  let disabled = url.searchParams.get('disabled');
  if (disabled === null && req.method === 'POST') {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    disabled = params.get('disabled');
  }

  const next = bool(disabled);
  return json(res, 200, {
    ok: true,
    auth: true,
    message: next ? '白名单已临时关闭。' : '白名单已重新开启。',
    allowlist: allowlist.setDisabled(next),
  });
}

function shouldBypassAllowlist(action, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') return true;
  if (action === 'health' || action === 'admin-status' || action === 'admin-toggle') return true;
  return false;
}

async function handleApi(req, res, reqUrl) {
  const action = reqUrl.searchParams.get('action');

  if (action === 'health') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      provider: await provider.health(),
      adapterPort: httpClient.getAdapterPort(),
      enhancedPort: httpClient.getEnhancedPort(),
      enhancedBase: httpClient.getBase(),
      allowlist: allowlist.getStatus(),
      hasAdapterCookie: Boolean(httpClient.buildCookie()),
      urlStrategy: process.env.URL_STRATEGY || 'enhanced-only',
      ncmLevel: process.env.NCM_LEVEL || 'standard',
      ncmLevels: process.env.NCM_LEVELS || 'standard,higher,exhigh,lossless,hires',
      portWarning: process.env.PORT
        ? '检测到 PORT 变量。v12 本地不使用 PORT；请用 API_ENHANCED_PORT / ADAPTER_PORT。'
        : undefined,
    });
  }

  if (action === 'admin-status') return adminStatus(req, res, reqUrl);
  if (action === 'admin-toggle') return adminToggle(req, res, reqUrl);

  const allowed = allowlist.isAllowed(req);
  if (!allowed.allowed) {
    return json(res, 403, {
      ok: false,
      error: 'forbidden_by_allowlist',
      message: '当前请求来源不在 ALLOWLIST 中。',
      allowlist: allowlist.getStatus(),
      client: allowed,
      hint: '本地调试可在 /admin 输入 ADMIN_PASSWORD 后临时关闭白名单，或把来源加入 ALLOWLIST。',
    });
  }

  if (action === 'probe' || action === 'doctor') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      provider: provider.providerName(),
      probe: await provider.probe(reqUrl.searchParams.get('id') || '174944'),
    });
  }

  const server = reqUrl.searchParams.get('server') || 'netease';
  const type = reqUrl.searchParams.get('type') || 'playlist';
  const id = reqUrl.searchParams.get('id') || '';
  const limit = Number(reqUrl.searchParams.get('limit') || process.env.PLAYLIST_LIMIT || 100);
  const offset = Number(reqUrl.searchParams.get('offset') || 0);

  if (server !== 'netease') return json(res, 400, { ok: false, error: 'unsupported_server', message: 'Only server=netease is supported.' });
  if (!id) return json(res, 400, { ok: false, error: 'missing_id', message: 'Query parameter id is required.' });

  try {
    if (type === 'url') {
      const result = await provider.songUrl(id);
      const wantsJson = bool(reqUrl.searchParams.get('json')) || bool(reqUrl.searchParams.get('debug'));
      if (!result.ok) {
        return json(res, 502, {
          ok: false,
          error: 'no_playable_url',
          message: result.message,
          provider: result.provider,
          upstream: result.upstream,
          attempts: bool(process.env.DEBUG_RESPONSE) || bool(reqUrl.searchParams.get('debug')) ? result.attempts : undefined,
        });
      }
      if (wantsJson) return json(res, 200, result);
      return redirect(res, result.url);
    }

    if (type === 'lrc' || type === 'lyric') return text(res, 200, await provider.lyric(id));

    if (type === 'pic') {
      const detail = await provider.songDetail(id);
      const first = meting.list(detail.songs, meting.originFromReq(req))[0];
      if (!first || !first.pic) return json(res, 404, { ok: false, error: 'no_pic' });
      return redirect(res, first.pic);
    }

    return json(res, 200, await meting.resolve(type, id, meting.originFromReq(req), { limit, offset }));
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: 'internal_error',
      message: err.message,
      stack: bool(process.env.DEBUG_RESPONSE) || bool(reqUrl.searchParams.get('debug')) ? err.stack : undefined,
    });
  }
}

async function handle(req, res) {
  res.req = req;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS,POST',
      'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization, X-Admin-Password',
    });
    return res.end();
  }

  const reqUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${httpClient.getAdapterPort()}`}`);
  const action = reqUrl.searchParams.get('action');

  if (reqUrl.pathname === '/' || reqUrl.pathname === '/test') return staticFile('test.html', res);
  if (reqUrl.pathname === '/admin' || reqUrl.pathname === '/admin/') return staticFile('admin.html', res);
  if (reqUrl.pathname === '/health') {
    reqUrl.searchParams.set('action', 'health');
    return handleApi(req, res, reqUrl);
  }
  if (reqUrl.pathname === '/api') return handleApi(req, res, reqUrl);

  return json(res, 404, { ok: false, error: 'not_found' });
}

module.exports = { handle };
