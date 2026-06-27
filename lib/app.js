'use strict';

// 多平台 API 路由层 v0.16.0
// 支持: netease (融合 api-enhanced, 自带解灰) / kugou / kuwo / qq
// 端点:
//   /api?action=health                       — 健康检查 (本服务 + api-enhanced 模块探测)
//   /api?action=admin-status                 — 管理员查询
//   /api?action=admin-toggle                 — 临时关闭/开启白名单
//   /api?action=enhanced&path=/xxx           — 透传 api-enhanced 任意模块 (仅 netease)
//   /api?server={server}&type=search&id=kw  — 搜索歌曲 (返回 [{id,name,singer,time}])
//   /api?server={server}&type=url&id=xxx     — 播放 URL (302 跳转或 json=1 返回 JSON)
//   /api?server={server}&type=lrc&id=xxx     — 歌词文本
//   /api?server={server}&type=song_full&id=xxx — 完整单曲 (name+url+lyric+time, 一次返回, 加速插件)
//   /api?server={server}&type=song&id=xxx    — MetingJS 兼容格式
//   /api?server={server}&type=pic&id=xxx     — 封面图 (仅 netease)

const fs = require('node:fs');
const path = require('node:path');
const provider = require('./provider');
const meting = require('./meting');
const allowlist = require('./allowlist');
const nc = require('./netease-client');
const providers = require('./providers');

const VERSION = '0.17.0';

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

function sanitizeEnhancedPath(pathname) {
  let p = String(pathname || '').trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (p.includes('..') || p.includes('\\')) return { ok: false, reason: 'BAD_PATH' };
  if (/match|unblock/i.test(p)) return { ok: false, reason: 'UNSAFE_PATH_BLOCKED' };
  return { ok: true, path: p };
}

function enhancedQueryParams(reqUrl) {
  const params = {};
  for (const [key, value] of reqUrl.searchParams.entries()) {
    if (['action', 'path', 'password'].includes(key)) continue;
    if (/unblock/i.test(key)) continue;
    params[key] = value;
  }
  return params;
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
    supportedServers: providers.SUPPORTED,
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
    const qqProvider = providers.get('qq');
    return json(res, 200, {
      ok: true,
      version: VERSION,
      provider: await provider.health(),
      supportedServers: providers.SUPPORTED,
      playlistSearchServers: providers.PLAYLIST_SEARCH_SUPPORTED,
      adapterPort: nc.getAdapterPort(),
      allowlist: allowlist.getStatus(),
      hasCookie: Boolean(nc.buildCookie()),
      unblock: nc.unblockEnabled(),
      qqUnblock: qqProvider ? qqProvider.unblockEnabled() : false,
      urlStrategy: process.env.URL_STRATEGY || 'enhanced-only',
      ncmLevel: process.env.NCM_LEVEL || 'standard',
      ncmLevels: process.env.NCM_LEVELS || 'standard,exhigh,lossless,hires',
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

  // 网易云 enhanced 模式 (仅 netease 支持)
  if (action === 'enhanced') {
    const checked = sanitizeEnhancedPath(reqUrl.searchParams.get('path') || '');
    if (!checked.ok) {
      return json(res, 400, {
        ok: false,
        error: checked.reason,
        message: checked.reason === 'UNSAFE_PATH_BLOCKED'
          ? '该底层路由未在测试台开放。'
          : '底层路由 path 不合法。',
      });
    }

    const result = await provider.enhancedRaw(checked.path, enhancedQueryParams(reqUrl));
    return json(res, result.ok ? 200 : (result.status || 502), {
      ok: result.ok,
      provider: provider.providerName(),
      path: checked.path,
      requestUrl: result.url,
      status: result.status,
      body: result.body,
    });
  }

  // 多平台业务路由
  const server = reqUrl.searchParams.get('server') || 'netease';
  const type = reqUrl.searchParams.get('type') || 'playlist';
  const id = reqUrl.searchParams.get('id') || '';
  const limit = Number(reqUrl.searchParams.get('limit') || process.env.PLAYLIST_LIMIT || 100);
  const offset = Number(reqUrl.searchParams.get('offset') || 0);
  // 用户鉴权信息 (酷狗/酷我 VIP 歌曲)
  const userId = reqUrl.searchParams.get('userid') || reqUrl.searchParams.get('userId') || '';
  const token = reqUrl.searchParams.get('token') || '';

  if (!providers.isSupported(server)) {
    return json(res, 400, {
      ok: false,
      error: 'unsupported_server',
      message: `不支持的平台: ${server}`,
      supported: providers.SUPPORTED,
    });
  }
  if (!id && type !== 'search' && type !== 'playlist_search') {
    return json(res, 400, { ok: false, error: 'missing_id', message: 'Query parameter id is required.' });
  }

  const api = providers.get(server);

  // B站音频代理: 检测 B站域名 URL, 包装为代理 URL (客户端无法发送 Referer 头)
  const proxyBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${nc.getAdapterPort()}`}`;
  function wrapBiliUrl(url) {
    if (!url) return url;
    const isBili = BILI_PROXY_DOMAINS.some(d => {
      try { return new URL(url).hostname.endsWith(d); } catch { return false; }
    });
    return isBili ? `${proxyBase}/proxy?url=${encodeURIComponent(url)}` : url;
  }

  try {
    // 多平台通用: 搜索
    if (type === 'search') {
      const songs = await api.search(id, limit);
      return json(res, 200, { ok: true, server, songs });
    }

    // 多平台通用: 完整单曲 (一次返回 name+url+lyric+time, 加速插件调用)
    if (type === 'song_full') {
      const detail = await api.songFull(id, userId, token);
      // B站音频 URL 需要通过代理 (客户端无法发送 Referer 头)
      if (detail.url) detail.url = wrapBiliUrl(detail.url);
      return json(res, detail.ok ? 200 : 502, { ok: detail.ok, server, song: detail });
    }

    // 多平台通用: 播放 URL
    if (type === 'url') {
      const result = await api.songUrl(id, userId, token);
      const wantsJson = bool(reqUrl.searchParams.get('json')) || bool(reqUrl.searchParams.get('debug'));
      if (!result.ok) {
        return json(res, 502, {
          ok: false,
          error: 'no_playable_url',
          message: server === 'netease' ? '网易云未返回可播放 URL' : '可能是 VIP 歌曲, 请切换其他源或登录',
          server,
        });
      }
      // B站音频 URL 需要通过代理
      const finalUrl = wrapBiliUrl(result.url);
      if (wantsJson) return json(res, 200, { ok: true, url: finalUrl, server });
      return redirect(res, finalUrl);
    }

    // 多平台通用: 歌词
    if (type === 'lrc' || type === 'lyric') {
      const lrc = await api.lyric(id, userId, token);
      // 酷我的 lyric 返回 {lyric, time} 对象
      const lyricText = lrc && typeof lrc === 'object' ? lrc.lyric : lrc;
      return send(res, 200, lyricText || '', 'text/plain; charset=utf-8');
    }

    // 多平台通用: 搜索歌单 (需要 provider 实现 searchPlaylist)
    if (type === 'playlist_search') {
      if (typeof api.searchPlaylist !== 'function') {
        return json(res, 400, {
          ok: false,
          error: 'playlist_search_not_supported',
          message: `平台 ${server} 不支持歌单搜索`,
          supported: providers.PLAYLIST_SEARCH_SUPPORTED,
        });
      }
      const playlists = await api.searchPlaylist(id, limit);
      return json(res, 200, { ok: true, server, playlists });
    }

    // 多平台通用: 歌单详情 (需要 provider 实现 playlistDetail)
    if (type === 'playlist_detail') {
      if (typeof api.playlistDetail !== 'function') {
        return json(res, 400, {
          ok: false,
          error: 'playlist_detail_not_supported',
          message: `平台 ${server} 不支持歌单详情`,
        });
      }
      const result = await api.playlistDetail(id, limit, offset);
      return json(res, 200, { ok: true, server, ...result });
    }

    // 网易云独有: MetingJS 兼容格式 (song/playlist/album/artist)
    if (server === 'netease' && ['song', 'playlist', 'album', 'artist'].includes(type)) {
      return json(res, 200, await meting.resolve(type, id, meting.originFromReq(req), { limit, offset }));
    }

    // 网易云独有: 封面
    if (server === 'netease' && type === 'pic') {
      const detail = await provider.songDetail(id);
      const first = meting.list(detail.songs, meting.originFromReq(req))[0];
      if (!first || !first.pic) return json(res, 404, { ok: false, error: 'no_pic' });
      return redirect(res, first.pic);
    }

    return json(res, 400, {
      ok: false,
      error: 'unsupported_type',
      message: `平台 ${server} 不支持 type=${type}`,
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: 'internal_error',
      message: err.message,
      stack: bool(process.env.DEBUG_RESPONSE) || bool(reqUrl.searchParams.get('debug')) ? err.stack : undefined,
    });
  }
}

// B站音频代理: 客户端无法发送 Referer 头, 通过服务端代理添加
// 仅允许代理 B站域名的音频, 防止被滥用为开放代理
const BILI_PROXY_DOMAINS = [
  '.bilivideo.com',
  '.bilivideo.com',
  '.akamaized.net', // B站 CDN
  '.mcdn.bilivideo.cn',
  '.cn-mcc.bilivideo.com',
];

async function handleProxy(req, res, reqUrl) {
  const targetUrl = reqUrl.searchParams.get('url');
  if (!targetUrl) {
    return json(res, 400, { ok: false, error: 'missing_url', message: 'Query parameter url is required.' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return json(res, 400, { ok: false, error: 'bad_url', message: 'Invalid URL.' });
  }

  // 安全: 只代理 B站域名的音频
  const isBili = BILI_PROXY_DOMAINS.some(d => parsed.hostname.endsWith(d));
  if (!isBili) {
    return json(res, 403, { ok: false, error: 'domain_not_allowed', message: 'Only bilibili audio domains are proxied.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const proxyResp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Range': req.headers.range || 'bytes=0-',
      },
      signal: controller.signal,
    });

    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    };
    // 透传 Content-Type / Content-Length / Content-Range / Accept-Ranges
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = proxyResp.headers.get(h);
      if (v) headers[h] = v;
    }

    res.writeHead(proxyResp.status, headers);
    if (req.method === 'HEAD') return res.end();

    // 流式转发响应体
    const reader = proxyResp.body;
    if (reader && typeof reader.pipe === 'function') {
      reader.pipe(res);
    } else {
      // fallback: 手动读取
      const buf = Buffer.from(await proxyResp.arrayBuffer());
      res.end(buf);
    }
  } catch (err) {
    if (!res.headersSent) {
      json(res, 502, { ok: false, error: 'proxy_failed', message: err.message });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
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

  const reqUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${nc.getAdapterPort()}`}`);
  const action = reqUrl.searchParams.get('action');

  if (reqUrl.pathname === '/' || reqUrl.pathname === '/test') return staticFile('test.html', res);
  if (reqUrl.pathname === '/admin' || reqUrl.pathname === '/admin/') return staticFile('admin.html', res);
  if (reqUrl.pathname === '/bind') return staticFile('bind.html', res);
  if (reqUrl.pathname === '/health') {
    reqUrl.searchParams.set('action', 'health');
    return handleApi(req, res, reqUrl);
  }
  if (reqUrl.pathname === '/api') return handleApi(req, res, reqUrl);
  if (reqUrl.pathname === '/proxy') return handleProxy(req, res, reqUrl);

  return json(res, 404, { ok: false, error: 'not_found' });
}

module.exports = { handle, VERSION };
