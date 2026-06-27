'use strict';

// 网易云客户端 v0.20.0 — 直接调用 api-enhanced 模块函数 (无需启动外部 HTTP 服务)
//
// 已彻底移除所有解灰:
//   - 移除 api-enhanced 内置 unblock='true' 调用
//   - 移除 @unblockneteasemusic/server 第二层解灰
//   - VIP 歌曲改为用户扫码登录后获取 (login_qr_key/create/check)
//
// 新增扫码登录 (api-enhanced 原生模块):
//   - qrLoginStart(): 调用 login_qr_key + login_qr_create, 返回 { token, qrUrl }
//   - qrLoginCheck(token): 轮询 login_qr_check, 返回 { status, cookie, nickname }
//
// 环境变量:
//   NCM_MUSIC_U / NCM_CSRF / NCM_COOKIE  — 全局登录态 (服务端默认, 用于未登录用户)
//   NCM_LEVEL                              — 音质 (standard/exhigh/lossless/hires)
//   URL_STRATEGY                           — enhanced-only / enhanced-then-outer (兜底)

const api = require('@neteasecloudmusicapienhanced/api');

function boolEnv(name, fallback) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function getAdapterPort() {
  const n = Number(process.env.ADAPTER_PORT);
  return Number.isInteger(n) && n > 0 ? n : 3017;
}

// 服务端默认 cookie (NCM_COOKIE 环境变量, 用于未登录用户)
function defaultCookie() {
  const direct = String(process.env.NCM_COOKIE || '').trim();
  if (direct) return ensureOsPc(direct);
  const musicU = String(process.env.NCM_MUSIC_U || '').trim();
  const csrf = String(process.env.NCM_CSRF || '').trim();
  const parts = [];
  if (musicU) parts.push(`MUSIC_U=${musicU}`);
  if (csrf) parts.push(`__csrf=${csrf}`);
  if (parts.length) parts.push('os=pc');
  return parts.join('; ');
}

// 兼容 buildCookie 旧名 (health 接口)
function buildCookie() {
  return defaultCookie();
}

function ensureOsPc(cookie) {
  let c = String(cookie || '').trim();
  if (c && !/(^|;\s*)os=/.test(c)) c += '; os=pc';
  return c;
}

function levels() {
  const primary = String(process.env.NCM_LEVEL || 'standard').trim() || 'standard';
  const list = String(process.env.NCM_LEVELS || '').trim()
    ? String(process.env.NCM_LEVELS).split(',').map(x => x.trim()).filter(Boolean)
    : ['standard', 'exhigh', 'lossless', 'hires'];
  return [primary, ...list].filter((x, i, arr) => x && arr.indexOf(x) === i);
}

// api-enhanced 模块函数返回 { status, body, cookie }, 我们只要 body
function unwrap(result) {
  if (!result) return null;
  return result.body || null;
}

function firstSongUrl(body) {
  const item = body && Array.isArray(body.data) ? body.data[0] : null;
  return { item, url: normalizeUrl(item && (item.url || item.proxyUrl)) };
}

function normalizeUrl(v) {
  return String(v || '').replace(/^http:\/\//i, 'https://');
}

// 解灰已彻底禁用 (兼容 health 接口)
function unblockEnabled() {
  return false;
}
function extraUnblockEnabled() {
  return false;
}
function extraUnblockSources() {
  return [];
}

// 调用 api-enhanced 模块, 可传入自定义 cookie (用于 per-player 登录态)
// realIP: 玩家真实 IP (用于绕过网易云设备环境检测)
async function call(name, params = {}, customCookie = '', realIP = '') {
  const fn = api[name];
  if (typeof fn !== 'function') {
    return { ok: false, status: 404, message: `api-enhanced 模块不存在: ${name}` };
  }
  const cookie = customCookie || defaultCookie();
  const finalParams = { ...params, cookie: cookie || undefined };
  if (realIP) finalParams.realIP = realIP;
  try {
    const result = await fn(finalParams);
    return { ok: true, status: result.status || 200, body: unwrap(result), cookie: result.cookie || '' };
  } catch (err) {
    return { ok: false, status: 500, message: err.message };
  }
}

// 健康检查 — 探测 api-enhanced 模块本身是否可用
async function health() {
  try {
    const r = await call('inner_version', {});
    if (r.ok && r.body && typeof r.body === 'object') {
      return { ok: true, mode: 'embedded', version: r.body.version || 'unknown' };
    }
    return { ok: false, mode: 'embedded', message: r.message || 'inner_version 未返回版本' };
  } catch (err) {
    return { ok: false, mode: 'embedded', message: err.message };
  }
}

// ==================== 手机号密码登录 (api-enhanced 模块) ====================
// v0.24.0: 替代扫码登录, 用户体验更好, 不需要 APP 扫码
// 调用 login_cellphone, api-enhanced 内部会自动 MD5 哈希 password
// 返回 { ok, cookie, nickname, userId }
async function phoneLogin(phone, password, countrycode = '86', realIP = '') {
  if (!phone || !password) return { ok: false, message: '请填写手机号和密码' };
  const r = await call('login_cellphone', { phone, password, countrycode }, '', realIP);
  if (!r.ok || !r.body) return { ok: false, message: r.message || '登录失败' };
  // code=200 成功; 部分响应没有 code 字段也视为成功 (有 cookie 即可)
  if (r.body.code !== undefined && r.body.code !== 200) {
    return { ok: false, message: r.body.message || r.body.msg || `登录失败 code=${r.body.code}` };
  }
  const cookie = r.cookie || '';
  if (!cookie || !/MUSIC_U=/.test(cookie)) {
    return { ok: false, message: '登录响应未包含 MUSIC_U 凭证' };
  }
  let nickname = '';
  let userId = '';
  try {
    const profile = r.body.profile || {};
    nickname = profile.nickname || '';
    userId = String(profile.userId || '');
  } catch {}
  if (!nickname) {
    try {
      const m = cookie.match(/nickname=([^;]+)/);
      if (m) nickname = decodeURIComponent(m[1]);
    } catch {}
  }
  return { ok: true, cookie, nickname: nickname || '网易云用户', userId };
}

// ==================== 手机号验证码登录 (api-enhanced 模块) ====================
// v0.26.0: 替代密码登录, 用户体验更好, 不需要记住密码
// 流程: sendCaptcha(发送验证码) → verifyCaptcha(验证并获取 MUSIC_U cookie)
// 调用 captcha_sent + captcha_verify
// 返回 { ok, cookie, nickname, userId }

// 发送验证码到手机
// 返回 { ok, message }
async function sendCaptcha(phone, ctcode = '86', realIP = '') {
  if (!phone) return { ok: false, message: '请填写手机号' };
  const r = await call('captcha_sent', { phone, ctcode }, '', realIP);
  if (!r.ok || !r.body) return { ok: false, message: r.message || '发送验证码失败' };
  // code=200 成功
  if (r.body.code !== undefined && r.body.code !== 200) {
    return { ok: false, message: r.body.message || r.body.msg || `发送失败 code=${r.body.code}` };
  }
  return { ok: true, message: '验证码已发送' };
}

// 验证验证码并登录
// 返回 { ok, cookie, nickname, userId }
// v0.26.1: captcha_verify 只验证验证码不返回 cookie, 改用 login_cellphone + captcha 参数登录
async function verifyCaptcha(phone, captcha, ctcode = '86', realIP = '') {
  if (!phone || !captcha) return { ok: false, message: '请填写手机号和验证码' };
  // 先验证验证码是否正确 (可选, 给出更明确的错误提示)
  const verify = await call('captcha_verify', { phone, captcha, ctcode }, '', realIP);
  if (verify.ok && verify.body && verify.body.code !== undefined && verify.body.code !== 200) {
    return { ok: false, message: verify.body.message || verify.body.msg || `验证码错误 code=${verify.body.code}` };
  }
  // 用 login_cellphone + captcha 参数登录 (不传 password, 传 captcha)
  // api-enhanced 内部 login_cellphone 支持 captcha 参数 (验证码登录)
  const r = await call('login_cellphone', { phone, captcha, countrycode: ctcode }, '', realIP);
  if (!r.ok || !r.body) return { ok: false, message: r.message || '登录失败' };
  if (r.body.code !== undefined && r.body.code !== 200) {
    return { ok: false, message: r.body.message || r.body.msg || `登录失败 code=${r.body.code}` };
  }
  const cookie = r.cookie || '';
  if (!cookie || !/MUSIC_U=/.test(cookie)) {
    return { ok: false, message: '登录响应未包含 MUSIC_U 凭证 (验证码可能已过期)' };
  }
  let nickname = '';
  let userId = '';
  try {
    const profile = r.body.profile || {};
    nickname = profile.nickname || '';
    userId = String(profile.userId || '');
  } catch {}
  if (!nickname) {
    try {
      const m = cookie.match(/nickname=([^;]+)/);
      if (m) nickname = decodeURIComponent(m[1]);
    } catch {}
  }
  return { ok: true, cookie, nickname: nickname || '网易云用户', userId };
}

// ==================== QR 扫码登录 (api-enhanced 模块) ====================
// 会话状态: token -> { key, createdAt }
const QR_SESSIONS = new Map();
const QR_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of QR_SESSIONS) {
    if (now - v.createdAt > QR_TTL_MS) QR_SESSIONS.delete(k);
  }
}, 60 * 1000).unref?.();

function genToken() {
  return 'nc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 启动扫码登录: 调用 login_qr_key + login_qr_create
// realIP: 玩家真实 IP (绕过网易云设备环境检测)
async function qrLoginStart(realIP = '') {
  // 1. 获取 unikey
  const keyResp = await call('login_qr_key', {}, '', realIP);
  if (!keyResp.ok || !keyResp.body) return { ok: false, message: 'login_qr_key 失败' };
  const unikey = keyResp.body.unikey || (keyResp.body.data && keyResp.body.data.unikey);
  if (!unikey) return { ok: false, message: '未返回 unikey' };

  // 2. 获取二维码图片 (qrimg base64)
  const createResp = await call('login_qr_create', { key: unikey, qrimg: true }, '', realIP);
  if (!createResp.ok || !createResp.body) return { ok: false, message: 'login_qr_create 失败' };
  const qrimgBase64 = createResp.body.qrimg || (createResp.body.data && createResp.body.data.qrimg) || '';

  const token = genToken();
  QR_SESSIONS.set(token, { key: unikey, qrimgBase64, realIP, createdAt: Date.now() });

  return { ok: true, token, qrUrl: `/qr/netease?token=${token}` };
}

// 获取缓存的二维码图片 (供 /qr/netease?token=xxx 端点返回)
function getQrImage(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return null;
  }
  return sess.qrimgBase64;
}

// 轮询登录状态
// 返回: { status: "waiting"|"scanned"|"ok"|"expired", cookie?, nickname? }
async function qrLoginCheck(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return { status: 'expired', message: '会话不存在或已过期' };
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return { status: 'expired', message: '二维码已过期' };
  }
  if (sess.cookie) {
    return { status: 'ok', cookie: sess.cookie, nickname: sess.nickname };
  }

  const checkResp = await call('login_qr_check', { key: sess.key }, '', sess.realIP || '');
  if (!checkResp.ok || !checkResp.body) return { status: 'unknown', message: '查询失败' };

  // body.code: 800=expired, 801=waiting, 802=scanned, 803=authorized (登录成功)
  const code = checkResp.body.code;
  const cookie = checkResp.cookie || '';

  if (code === 801) return { status: 'waiting', message: '等待扫码' };
  if (code === 802) return { status: 'scanned', message: '已扫码, 等待手机确认' };
  if (code === 803 && cookie) {
    // 提取昵称
    let nickname = '';
    try {
      const m = cookie.match(/nickname=([^;]+)/);
      if (m) nickname = decodeURIComponent(m[1]);
    } catch {}
    sess.cookie = cookie;
    sess.nickname = nickname;
    QR_SESSIONS.set(token, sess);
    return { status: 'ok', cookie, nickname };
  }
  if (code === 800) {
    QR_SESSIONS.delete(token);
    return { status: 'expired', message: '二维码已过期' };
  }
  return { status: 'unknown', message: `未知 code=${code}` };
}

// 获取播放 URL (登录态优先 customCookie, 否则用全局 NCM_COOKIE; 多音质回退)
async function songUrl(id, customCookie = '') {
  // 多音质依次尝试
  for (const level of levels()) {
    const r = await call('song_url_v1', { id, level }, customCookie);
    if (r.ok) {
      const { url } = firstSongUrl(r.body);
      if (url) return { ok: true, url, source: `level:${level}` };
    }
  }

  // 旧版接口兜底
  {
    const r = await call('song_url', { id, br: 999000 }, customCookie);
    if (r.ok) {
      const { url } = firstSongUrl(r.body);
      if (url) return { ok: true, url, source: 'legacy' };
    }
  }

  // outer URL 兜底
  if (String(process.env.URL_STRATEGY || 'enhanced-only') === 'enhanced-then-outer') {
    return { ok: true, url: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, source: 'outer' };
  }
  return { ok: false, message: '网易云未返回可播放 URL (可能是 VIP 歌曲, 请登录)' };
}

async function songDetail(ids) {
  const r = await call('song_detail', { ids: Array.isArray(ids) ? ids.join(',') : String(ids) });
  return { songs: (r.body && Array.isArray(r.body.songs)) ? r.body.songs : [] };
}

async function playlistTracks(id, limit = 100, offset = 0) {
  const r = await call('playlist_track_all', { id, limit, offset });
  return { songs: (r.body && Array.isArray(r.body.songs)) ? r.body.songs : [] };
}

async function playlistDetail(id) {
  const r = await call('playlist_detail', { id });
  return r.body || null;
}

async function album(id) {
  const r = await call('album', { id });
  return { songs: (r.body && Array.isArray(r.body.songs)) ? r.body.songs : [] };
}

async function artistSongs(id, limit = 100, offset = 0) {
  const r = await call('artist_songs', { id, limit, offset, order: 'hot' });
  return { songs: (r.body && Array.isArray(r.body.songs)) ? r.body.songs : [] };
}

async function searchSongs(keywords, limit = 30, offset = 0) {
  // cloudsearch 返回完整字段 (ar/dt/al), search 只返回简化字段 (artists/duration)
  const r = await call('cloudsearch', { keywords, type: 1, limit, offset });
  if (r.ok && r.body && r.body.result && Array.isArray(r.body.result.songs)) {
    return { songs: r.body.result.songs };
  }
  // 兜底: 旧版 search (字段不同, 由调用方兼容处理)
  const r2 = await call('search', { keywords, type: 1, limit, offset });
  const songs = (r2.body && r2.body.result && Array.isArray(r2.body.result.songs)) ? r2.body.result.songs : [];
  // 兼容字段: 把 artists/duration 标准化为 ar/dt
  for (const s of songs) {
    if (!s.ar && s.artists) s.ar = s.artists;
    if (!s.dt && s.duration) s.dt = s.duration;
  }
  return { songs };
}

// 搜索歌单 (type=1000)
async function searchPlaylists(keywords, limit = 30, offset = 0) {
  const r = await call('cloudsearch', { keywords, type: 1000, limit, offset });
  if (!r.ok || !r.body || !r.body.result) return [];
  const list = Array.isArray(r.body.result.playlists) ? r.body.result.playlists : [];
  return list.map(p => ({
    id: String(p.id || ''),
    name: p.name || '',
    cover: (p.coverImgUrl || p.picUrl || ''),
    creator: (p.creator && p.creator.nickname) || '',
    songCount: p.trackCount || 0,
  })).filter(p => p.id);
}

async function lyric(id) {
  const r = await call('lyric', { id });
  return (r.body && r.body.lrc && r.body.lrc.lyric) || '';
}

// 透传任意 api-enhanced 模块 (供 /api?action=enhanced&path=/xxx 使用)
async function enhancedRaw(pathname, params = {}) {
  const name = String(pathname || '').replace(/^\//, '').replace(/\?.*$/, '').trim();
  if (!name) return { ok: false, status: 400, message: 'empty path' };
  // 安全过滤: 不允许调用 unblock / match 相关底层模块
  if (/match|unblock/i.test(name)) {
    return { ok: false, status: 403, message: 'UNSAFE_PATH_BLOCKED' };
  }
  const r = await call(name, params);
  return { ...r, url: `embedded://${name}` };
}

module.exports = {
  getAdapterPort,
  buildCookie,
  defaultCookie,
  levels,
  unblockEnabled,
  extraUnblockEnabled,
  extraUnblockSources,
  health,
  songUrl,
  songDetail,
  playlistTracks,
  playlistDetail,
  album,
  artistSongs,
  searchSongs,
  searchPlaylists,
  lyric,
  enhancedRaw,
  phoneLogin,
  sendCaptcha,
  verifyCaptcha,
  qrLoginStart,
  qrLoginCheck,
  getQrImage,
};
