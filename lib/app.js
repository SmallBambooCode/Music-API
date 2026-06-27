'use strict';

// 多平台 API 路由层 v0.20.0
// 支持: netease / kugou / kuwo / qq
// 已彻底移除所有解灰 (B站/kuwo/migu/kugou/pyncmd/bodian 等源全部废弃)
// VIP 歌曲改为 QQ/网易云账号扫码登录后获取
//
// 端点:
//   /api?action=health                       — 健康检查
//   /api?action=admin-status                 — 管理员查询
//   /api?action=admin-toggle                 — 临时关闭/开启白名单
//   /api?action=enhanced&path=/xxx           — 透传 api-enhanced 任意模块 (仅 netease)
//   /api?server={server}&type=search&id=kw  — 搜索歌曲
//   /api?server={server}&type=url&id=xxx     — 播放 URL
//   /api?server={server}&type=lrc&id=xxx     — 歌词文本
//   /api?server={server}&type=song_full&id=xxx — 完整单曲 (支持 cookie/userid+token 鉴权)
//   /api?server={server}&type=song&id=xxx    — MetingJS 兼容格式 (仅 netease)
//   /api?server={server}&type=pic&id=xxx     — 封面图 (仅 netease)
//
// 扫码登录端点:
//   /api?server=qq&action=qr_create          — 启动 QQ 扫码登录, 返回 { token, qrUrl }
//   /api?server=qq&action=qr_check&token=xxx — 轮询 QQ 登录状态, 返回 { status, uin?, pSkey?, nickname? }
//   /api?server=netease&action=qr_create     — 启动网易云扫码登录, 返回 { token, qrUrl }
//   /api?server=netease&action=qr_check&token=xxx — 轮询网易云登录状态, 返回 { status, cookie?, nickname? }
//
// 二维码图片:
//   /qr/qq?token=xxx       — 返回 QQ 二维码 PNG 图片
//   /qr/netease?token=xxx — 返回网易云二维码 PNG 图片 (base64 → PNG)

const fs = require('node:fs');
const path = require('node:path');
const provider = require('./provider');
const meting = require('./meting');
const allowlist = require('./allowlist');
const nc = require('./netease-client');
const providers = require('./providers');

const VERSION = '0.21.0';

// ==================== 扫码登录绑定码机制 ====================
// 玩家在网页扫码成功后, 服务端生成 6 位绑定码
// 玩家回游戏输入绑定码, 客户端调用 qr_bind 端点验证, 获取账号信息
// TTL: 5 分钟
const QR_BIND_CODES = new Map(); // 6位码 -> { platform, userId, token, cookie, nickname, expireAt }
const QR_BIND_TTL_MS = 5 * 60 * 1000;

function genBindCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function storeBindCode(platform, info) {
  // 同一平台重复绑定时, 清除旧码
  for (const [k, v] of QR_BIND_CODES) {
    if (v.platform === platform) QR_BIND_CODES.delete(k);
  }
  const code = genBindCode();
  QR_BIND_CODES.set(code, { platform, ...info, expireAt: Date.now() + QR_BIND_TTL_MS });
  // 定期清理
  setTimeout(() => QR_BIND_CODES.delete(code), QR_BIND_TTL_MS).unref?.();
  return code;
}

function consumeBindCode(code) {
  const data = QR_BIND_CODES.get(code);
  if (!data) return null;
  if (Date.now() > data.expireAt) {
    QR_BIND_CODES.delete(code);
    return null;
  }
  QR_BIND_CODES.delete(code);
  return data;
}

// 根据平台和扫码登录结果, 构建统一的账号信息 (用于绑定码存储)
function buildLoginInfo(platform, result) {
  if (platform === 'qq') {
    const uin = result.uin || '';
    const pSkey = result.pSkey || '';
    return {
      userId: uin,
      token: pSkey,
      cookie: `uin=o0${uin}; p_skey=${pSkey}`,
      nickname: result.nickname || `QQ用户${uin}`,
    };
  }
  if (platform === 'kugou') {
    const userId = result.userId || result.userid || '';
    const token = result.token || '';
    return {
      userId,
      token,
      cookie: result.cookie || `KugooID=${userId}; KugooToken=${token}`,
      nickname: result.nickname || `酷狗用户${userId}`,
    };
  }
  if (platform === 'kuwo') {
    const userId = result.userId || '';
    const token = result.token || '';
    return {
      userId,
      token,
      cookie: result.cookie || `kw_user_id=${userId}; kw_token=${token}`,
      nickname: result.nickname || `酷我用户${userId}`,
    };
  }
  return { userId: '', token: '', cookie: '', nickname: '' };
}

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
  if (pathname === '/qr/qq' || pathname === '/qr/netease' || pathname === '/qr/kugou' || pathname === '/qr/kuwo') return true;
  if (action === 'health' || action === 'admin-status' || action === 'admin-toggle' || action === 'qr_bind') return true;
  return false;
}

// 二维码图片端点 (返回 PNG/base64, 不需要白名单但需要有效 token)
async function handleQrImage(req, res, reqUrl, platform) {
  const token = reqUrl.searchParams.get('token');
  if (!token) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('missing token');
  }
  // QQ / 酷狗 / 酷我 统一走 provider 的 getQrImage
  if (['qq', 'kugou', 'kuwo'].includes(platform)) {
    const p = providers.get(platform);
    const buf = p && p.getQrImage ? p.getQrImage(token) : null;
    if (!buf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('二维码已过期, 请重新生成');
    }
    // 如果返回的是 Buffer, 直接输出 PNG
    if (Buffer.isBuffer(buf)) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(buf);
    }
    // 如果返回的是 data URL (base64), 转为 PNG
    const m = String(buf).match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) {
      const pngBuf = Buffer.from(m[2], 'base64');
      res.writeHead(200, {
        'Content-Type': `image/${m[1]}`,
        'Content-Length': pngBuf.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(pngBuf);
    }
    // 兜底: 返回 HTML 内嵌 base64 图片
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>扫码登录</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;font-family:sans-serif}img{max-width:90vw;max-height:90vh}</style></head><body><img src="${buf}" alt="QR"></body></html>`);
  }
  if (platform === 'netease') {
    const b64 = nc.getQrImage(token);
    if (!b64) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('二维码已过期, 请重新生成');
    }
    // api-enhanced 返回 data:image/png;base64,xxx 格式
    const m = b64.match(/^data:image\/(\w+);base64,(.+)$/);
    if (m) {
      const buf = Buffer.from(m[2], 'base64');
      res.writeHead(200, {
        'Content-Type': `image/${m[1]}`,
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(buf);
    }
    // 兜底: 如果不是 data URL, 返回 HTML 内嵌 base64 图片
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>网易云登录</title><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff;font-family:sans-serif}img{max-width:90vw;max-height:90vh}</style></head><body><img src="${b64}" alt="QR"></body></html>`);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end('unknown platform');
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
      unblock: false, // 已彻底移除
      qqUnblock: false, // 已彻底移除
      urlStrategy: process.env.URL_STRATEGY || 'enhanced-only',
      ncmLevel: process.env.NCM_LEVEL || 'standard',
      ncmLevels: process.env.NCM_LEVELS || 'standard,exhigh,lossless,hires',
      qrLogin: {
        qq: Boolean(qqProvider && qqProvider.qrLoginStart),
        netease: Boolean(nc.qrLoginStart),
      },
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
      hint: '本地调试可在 /admin 输入 ADMIN_PASSWORD 后临时关闭白名单, 或把来源加入 ALLOWLIST.',
    });
  }

  // ==================== 扫码登录路由 ====================
  if (action === 'qr_create') {
    const server = reqUrl.searchParams.get('server') || '';
    const proxyBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${nc.getAdapterPort()}`}`;
    // 获取玩家真实 IP (绕过网易云设备环境检测)
    const realIP = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';

    // QQ / 酷狗 / 酷我 统一走 provider 的 qrLoginStart
    if (['qq', 'kugou', 'kuwo'].includes(server)) {
      const p = providers.get(server);
      if (!p || !p.qrLoginStart) {
        return json(res, 400, { ok: false, error: `${server}_qr_not_supported`, message: `${server} 扫码登录不可用` });
      }
      const result = await p.qrLoginStart();
      return json(res, result.ok ? 200 : 502, {
        ok: result.ok,
        server,
        token: result.token,
        qrUrl: result.ok ? `${proxyBase}${result.qrUrl}` : null,
        qrContent: result.qrContent || null,
        message: result.message,
      });
    }
    if (server === 'netease') {
      if (!nc.qrLoginStart) {
        return json(res, 400, { ok: false, error: 'netease_qr_not_supported', message: '网易云扫码登录不可用' });
      }
      const result = await nc.qrLoginStart(realIP);
      return json(res, result.ok ? 200 : 502, {
        ok: result.ok,
        server: 'netease',
        token: result.token,
        qrUrl: result.ok ? `${proxyBase}${result.qrUrl}` : null,
        message: result.message,
      });
    }
    return json(res, 400, { ok: false, error: 'unsupported_server', message: `不支持的平台: ${server}` });
  }

  if (action === 'qr_check') {
    const server = reqUrl.searchParams.get('server') || '';
    const token = reqUrl.searchParams.get('token') || '';
    if (!token) return json(res, 400, { ok: false, error: 'missing_token', message: 'Query parameter token is required.' });

    // QQ / 酷狗 / 酷我 统一走 provider 的 qrLoginCheck
    if (['qq', 'kugou', 'kuwo'].includes(server)) {
      const p = providers.get(server);
      if (!p || !p.qrLoginCheck) {
        return json(res, 400, { ok: false, error: `${server}_qr_not_supported`, message: `${server} 扫码登录不可用` });
      }
      const result = await p.qrLoginCheck(token);
      // 登录成功时生成 6 位绑定码, 玩家回游戏输入绑定码完成绑定
      if (result.status === 'ok') {
        const info = buildLoginInfo(server, result);
        result.bindCode = storeBindCode(server, info);
        result.message = result.message || '登录成功, 请回游戏输入绑定码';
      }
      return json(res, 200, { ok: true, server, ...result });
    }
    if (server === 'netease') {
      if (!nc.qrLoginCheck) {
        return json(res, 400, { ok: false, error: 'netease_qr_not_supported', message: '网易云扫码登录不可用' });
      }
      const result = await nc.qrLoginCheck(token);
      return json(res, 200, { ok: true, server: 'netease', ...result });
    }
    return json(res, 400, { ok: false, error: 'unsupported_server', message: `不支持的平台: ${server}` });
  }

  // ==================== 绑定码验证端点 ====================
  // 玩家在游戏输入 6 位绑定码, 客户端调用此端点验证并获取账号信息
  if (action === 'qr_bind') {
    const code = (reqUrl.searchParams.get('code') || '').trim();
    if (!code || !/^\d{6}$/.test(code)) {
      return json(res, 400, { ok: false, error: 'invalid_code', message: '绑定码格式错误, 应为 6 位数字' });
    }
    const data = consumeBindCode(code);
    if (!data) {
      return json(res, 400, { ok: false, error: 'invalid_or_expired', message: '绑定码无效或已过期, 请重新扫码' });
    }
    return json(res, 200, { ok: true, ...data });
  }

  // 网易云 enhanced 模式 (仅 netease 支持)
  if (action === 'enhanced') {
    const checked = sanitizeEnhancedPath(reqUrl.searchParams.get('path') || '');
    if (!checked.ok) {
      return json(res, 400, {
        ok: false,
        error: checked.reason,
        message: checked.reason === 'UNSAFE_PATH_BLOCKED'
          ? '该底层路由未在测试台开放.'
          : '底层路由 path 不合法.',
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
  // 用户鉴权信息 (v2.4.0):
  //   - QQ: userId=uin (QQ号), token=qqmusic_key, cookie=完整 document.cookie (兜底)
  //   - 网易云: 免登录 (不接收 cookie)
  //   - 酷狗/酷我: cookie=完整 document.cookie (服务端原样作为 Cookie 头发送)
  const userId = reqUrl.searchParams.get('userid') || reqUrl.searchParams.get('userId') || '';
  const token = reqUrl.searchParams.get('token') || '';
  const cookie = reqUrl.searchParams.get('cookie') || '';

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

  // 音频代理基础 URL (用于包装需要 Referer 的防盗链域名 kuwo/kugou/migu)
  const proxyBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${nc.getAdapterPort()}`}`;

  try {
    // 多平台通用: 搜索
    if (type === 'search') {
      const songs = await api.search(id, limit);
      return json(res, 200, { ok: true, server, songs });
    }

    // 多平台通用: 完整单曲 (一次返回 name+url+lyric+time, 加速插件调用)
    if (type === 'song_full') {
      // v2.4.0 各平台登录态透传:
      //   - QQ: userId+token (兼容) + cookie (完整 cookie, 优先级更高)
      //   - 网易云: 免登录 (不传 cookie)
      //   - 酷狗/酷我: 传 cookie (服务端原样作为 Cookie 头发送)
      let detail;
      if (server === 'qq') {
        detail = await api.songFull(id, userId, token, cookie);
      } else if (server === 'netease') {
        detail = await api.songFull(id, '');
      } else {
        detail = await api.songFull(id, userId, token, cookie);
      }

      // 音频 URL 代理 (仅 kuwo/kugou/migu 防盗链域名需要代理)
      if (detail.url) detail.url = wrapProxyUrl(detail.url, proxyBase);
      // v2.4.3: 始终返回 200, 避免 Vercel 把 502 响应体替换为 HTML 错误页
      return json(res, 200, { ok: detail.ok, server, song: detail });
    }

    // 多平台通用: 播放 URL
    if (type === 'url') {
      let result;
      if (server === 'qq') {
        result = await api.songUrl(id, userId, token, cookie);
      } else if (server === 'netease') {
        result = await api.songUrl(id, '');
      } else {
        result = await api.songUrl(id, userId, token, cookie);
      }
      const wantsJson = bool(reqUrl.searchParams.get('json')) || bool(reqUrl.searchParams.get('debug'));
      if (!result.ok) {
        // v2.4.3: 始终返回 200, 避免 Vercel 把 502 响应体替换为 HTML 错误页
        return json(res, 200, {
          ok: false,
          error: 'no_playable_url',
          message: server === 'netease' ? '网易云未返回可播放 URL (可能是 VIP, 请扫码登录)' :
                   server === 'qq' ? 'QQ 音乐未返回可播放 URL (可能是 VIP, 请登录)' :
                   '可能是 VIP 歌曲, 请切换其他源或登录',
          server,
          needsLogin: result.needsLogin,
        });
      }
      // 音频 URL 代理 (仅防盗链域名需要)
      const finalUrl = wrapProxyUrl(result.url, proxyBase);
      if (wantsJson) return json(res, 200, { ok: true, url: finalUrl, server });
      return redirect(res, finalUrl);
    }

    // 多平台通用: 歌词
    if (type === 'lrc' || type === 'lyric') {
      const lrc = await api.lyric(id);
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

// 音频代理: 客户端无法发送 Referer 头, 通过服务端代理添加
// 仅 kuwo/kugou/migu 防盗链域名需要代理 (B站已移除, QQ/网易云直链无需代理)
const PROXY_DOMAIN_CONFIGS = [
  { match: /kuwo/i, referer: 'https://www.kuwo.cn/' },
  { match: /kugou/i, referer: 'https://www.kugou.com/' },
  { match: /migu/i, referer: 'https://music.migu.cn/' },
];

function getProxyReferer(hostname) {
  for (const cfg of PROXY_DOMAIN_CONFIGS) {
    if (cfg.match.test(hostname)) return cfg.referer;
  }
  return null;
}

function wrapProxyUrl(url, proxyBase) {
  if (!url || !proxyBase) return url;
  try {
    const hostname = new URL(url).hostname;
    if (!getProxyReferer(hostname)) return url; // 不需要代理的域名
    return `${proxyBase}/proxy?url=${encodeURIComponent(url)}`;
  } catch {
    return url;
  }
}

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

  const referer = getProxyReferer(parsed.hostname);
  if (!referer) {
    return json(res, 403, { ok: false, error: 'domain_not_allowed', message: 'This domain does not require proxying.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const proxyResp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
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
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = proxyResp.headers.get(h);
      if (v) headers[h] = v;
    }

    res.writeHead(proxyResp.status, headers);
    if (req.method === 'HEAD') return res.end();

    const reader = proxyResp.body;
    if (reader && typeof reader.pipe === 'function') {
      reader.pipe(res);
    } else {
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
  if (reqUrl.pathname === '/qr/qq') return handleQrImage(req, res, reqUrl, 'qq');
  if (reqUrl.pathname === '/qr/kugou') return handleQrImage(req, res, reqUrl, 'kugou');
  if (reqUrl.pathname === '/qr/kuwo') return handleQrImage(req, res, reqUrl, 'kuwo');
  if (reqUrl.pathname === '/qr/netease') return handleQrImage(req, res, reqUrl, 'netease');
  if (reqUrl.pathname === '/health') {
    reqUrl.searchParams.set('action', 'health');
    return handleApi(req, res, reqUrl);
  }
  if (reqUrl.pathname === '/api') return handleApi(req, res, reqUrl);
  if (reqUrl.pathname === '/proxy') return handleProxy(req, res, reqUrl);

  return json(res, 404, { ok: false, error: 'not_found' });
}

module.exports = { handle, VERSION };
