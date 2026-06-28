'use strict';

// 网易云客户端 v0.28.0 — 直接调用 api-enhanced 模块函数 (无需启动外部 HTTP 服务)
//
// 已彻底移除所有解灰:
//   - 移除 api-enhanced 内置 unblock='true' 调用
//   - 移除 @unblockneteasemusic/server 第二层解灰
//
// 已彻底移除用户登录/绑定功能 (v0.28.0):
//   - 移除 phoneLogin / sendCaptcha / verifyCaptcha (手机号登录)
//   - 移除 qrLoginStart / qrLoginCheck / getQrImage (扫码登录)
//   - VIP 歌曲改为服务端配置 NCM_COOKIE 环境变量直连访问
//
// 环境变量:
//   NCM_MUSIC_U / NCM_CSRF / NCM_COOKIE  — 服务端网易云 cookie (可选, 配置后可访问 VIP 歌曲)
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

// 获取播放 URL (登录态优先 customCookie, 否则用全局 NCM_COOKIE; 多音质回退)
// v0.28.0: customCookie 仅用于服务端配置的 NCM_COOKIE 透传, 不再接收用户登录态
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
};
