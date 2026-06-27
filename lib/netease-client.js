'use strict';

// 网易云客户端 v0.16.0 — 直接调用 api-enhanced 模块函数 (无需启动外部 HTTP 服务)
//
// 融合方式: require('@neteasecloudmusicapienhanced/api') 直接调用模块函数
// 必要功能: 搜索 / 详情 / URL / 歌词 / 歌单 / 专辑 / 歌手歌曲
// 解灰功能: 两层策略
//   1) api-enhanced 内部解灰 (unblock='true') — 走 unblockmusic-utils 6 模块
//   2) 补充解灰: 直接调用 @unblockneteasemusic/server 的 match(), 传入扩展源数组
//      (含 bilibili / bilivideo), 作为 B 站音源补充
//
// 环境变量:
//   NCM_MUSIC_U / NCM_CSRF / NCM_COOKIE  — 登录态 (VIP 歌曲需要)
//   NCM_LEVEL                            — 音质 (standard/exhigh/lossless/hires)
//   URL_STRATEGY                         — enhanced-only / enhanced-then-outer (兜底)
//   DISABLE_FLAC                         — unblockmusic-utils 用, true 时降级为 320k/mp3
//   ENABLE_EXTRA_UNBLOCK                 — 第二层 B 站补充解灰开关 (默认 true)
//   EXTRA_UNBLOCK_SOURCES                — 自定义补充源 (逗号分隔, 默认含 bilibili/bilivideo)
//
// 解灰原理:
//   第一层 (api-enhanced 内置): unblockmusic-utils.matchID 遍历 modules/ 6 个第三方模块
//     - baka / bikonoo / byfuns / msls / qijieya / unm
//     - unm 模块内部调用 @unblockneteasemusic/server, 写死 ['pyncmd','bodian','qq']
//   第二层 (补充): 直接调用 @unblockneteasemusic/server 的 match(id, sources)
//     - sources 由 EXTRA_UNBLOCK_SOURCES 配置, 默认 ['bilibili','bilivideo','pyncmd','bodian','qq','kugou','kuwo','migu']
//     - 这样第一层未命中的 VIP 歌曲可从 B 站等其他音源继续尝试

const api = require('@neteasecloudmusicapienhanced/api');
// 直接 require @unblockneteasemusic/server 的 match 函数 (其 main 就是 src/provider/match.js)
// 不走 unblockmusic-utils 的 unm.js 包装层, 可自由传入源数组
let unmMatch = null;
try {
  unmMatch = require('@unblockneteasemusic/server');
} catch (_) {
  // 依赖缺失时降级 (仅第一层解灰可用)
}

function boolEnv(name, fallback) {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function getAdapterPort() {
  const n = Number(process.env.ADAPTER_PORT);
  return Number.isInteger(n) && n > 0 ? n : 3017;
}

function buildCookie() {
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

// 解灰是否启用 (本实现直接传 unblock='true', 此开关仅用于 health 信息展示)
// 真正的全局开关在 api-enhanced 的 song_url_v1.js 中, 由 ENABLE_GENERAL_UNBLOCK 控制
function unblockEnabled() {
  return boolEnv('ENABLE_GENERAL_UNBLOCK', true);
}

// 第二层补充解灰 (直接调用 @unblockneteasemusic/server) 是否启用
function extraUnblockEnabled() {
  return boolEnv('ENABLE_EXTRA_UNBLOCK', true);
}

// 第二层补充解灰的源列表 (默认含 B 站两个音源 + 其他常用源)
function extraUnblockSources() {
  const raw = String(process.env.EXTRA_UNBLOCK_SOURCES || '').trim();
  if (raw) {
    return raw.split(',').map(x => x.trim()).filter(Boolean);
  }
  // 默认源: B 站优先 (用户要求), 然后其他常用音源
  return ['bilibili', 'bilivideo', 'pyncmd', 'bodian', 'qq', 'kugou', 'kuwo', 'migu'];
}

// 调用 @unblockneteasemusic/server 的 match 函数, 返回 URL 或 null
// match(id, sources) 内部会并发或顺序尝试所有 sources, 返回第一个成功的 URL
async function extraUnblock(id) {
  if (!unmMatch || !extraUnblockEnabled()) return null;
  const sources = extraUnblockSources();
  try {
    const result = await unmMatch(id, sources);
    if (result && typeof result.url === 'string' && result.url) {
      return { url: normalizeUrl(result.url), source: `extra:${result.source || 'unknown'}` };
    }
  } catch (_) {
    // 静默失败, 由上层回退到多音质 / outer
  }
  return null;
}

// 调用 api-enhanced 模块, 自动注入 cookie
async function call(name, params = {}) {
  const fn = api[name];
  if (typeof fn !== 'function') {
    return { ok: false, status: 404, message: `api-enhanced 模块不存在: ${name}` };
  }
  const cookie = buildCookie();
  try {
    const result = await fn({ ...params, cookie: cookie || undefined });
    return { ok: true, status: result.status || 200, body: unwrap(result) };
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

// 获取播放 URL (两层解灰 + 多音质回退 + outer 兜底)
async function songUrl(id) {
  const unblock = unblockEnabled();

  // 第一层: api-enhanced 内置解灰 (unblockmusic-utils 6 模块)
  if (unblock) {
    const r = await call('song_url_v1', { id, level: 'standard', unblock: 'true' });
    if (r.ok) {
      const { url } = firstSongUrl(r.body);
      if (url) return { ok: true, url, source: 'unblock' };
    }
  }

  // 第二层: 直接调用 @unblockneteasemusic/server 的 match (含 B 站音源)
  // 第一层未命中时尝试, 补充 bilibili / bilivideo 等音源
  const extra = await extraUnblock(id);
  if (extra) {
    return { ok: true, url: extra.url, source: extra.source };
  }

  // 多音质依次尝试 (不解灰)
  for (const level of levels()) {
    const r = await call('song_url_v1', { id, level });
    if (r.ok) {
      const { url } = firstSongUrl(r.body);
      if (url) return { ok: true, url, source: `level:${level}` };
    }
  }

  // 旧版接口兜底
  {
    const r = await call('song_url', { id, br: 999000 });
    if (r.ok) {
      const { url } = firstSongUrl(r.body);
      if (url) return { ok: true, url, source: 'legacy' };
    }
  }

  // outer URL 兜底
  if (String(process.env.URL_STRATEGY || 'enhanced-only') === 'enhanced-then-outer') {
    return { ok: true, url: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, source: 'outer' };
  }
  return { ok: false, message: '网易云未返回可播放 URL (可能是 VIP 且解灰失败)' };
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
