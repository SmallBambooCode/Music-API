'use strict';

let ncmApi = null;

function loadApi() {
  if (!ncmApi) ncmApi = require('@neteasecloudmusicapienhanced/api');
  return ncmApi;
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

function params(extra = {}) {
  const cookie = buildCookie();
  return { ...extra, ...(cookie ? { cookie } : {}) };
}

async function call(fn, data) {
  const api = loadApi();
  if (typeof api[fn] !== 'function') throw new Error(`@neteasecloudmusicapienhanced/api function not found: ${fn}`);
  const result = await api[fn](params(data));
  return result && result.body ? result.body : result;
}

function levels() {
  const primary = String(process.env.NCM_LEVEL || 'standard').trim() || 'standard';
  const configured = String(process.env.NCM_LEVELS || '').trim();
  const list = configured ? configured.split(',').map(x => x.trim()).filter(Boolean) : ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
  return [primary, ...list].filter((x, i, arr) => x && arr.indexOf(x) === i);
}

function normalizeUrl(value) {
  return String(value || '').replace(/^http:\/\//i, 'https://');
}

function firstSongUrl(body) {
  const data = body && Array.isArray(body.data) ? body.data[0] : null;
  return { item: data, url: normalizeUrl(data && (data.url || data.proxyUrl)) };
}

async function health() {
  try {
    const api = loadApi();
    return {
      ok: true,
      provider: 'module',
      hasFunctions: {
        song_url_v1: typeof api.song_url_v1 === 'function',
        playlist_track_all: typeof api.playlist_track_all === 'function',
        song_detail: typeof api.song_detail === 'function',
        lyric: typeof api.lyric === 'function',
      },
      hasCookie: Boolean(buildCookie()),
    };
  } catch (err) {
    return { ok: false, provider: 'module', message: err.message };
  }
}

async function songUrl(id) {
  const attempts = [];

  for (const level of levels()) {
    try {
      const body = await call('song_url_v1', { id: String(id), level });
      const extracted = firstSongUrl(body);
      attempts.push({
        route: 'song_url_v1',
        level,
        code: body && body.code,
        itemCode: extracted.item && extracted.item.code,
        fee: extracted.item && extracted.item.fee,
        levelReturned: extracted.item && extracted.item.level,
        type: extracted.item && extracted.item.type,
        hasUrl: Boolean(extracted.url),
      });
      if (extracted.url) return { ok: true, url: extracted.url, provider: 'api-enhanced-module:song_url_v1', attempts };
    } catch (err) {
      attempts.push({ route: 'song_url_v1', level, error: err.message });
    }
  }

  try {
    const body = await call('song_url', { id: String(id), br: '999000' });
    const extracted = firstSongUrl(body);
    attempts.push({
      route: 'song_url',
      code: body && body.code,
      itemCode: extracted.item && extracted.item.code,
      fee: extracted.item && extracted.item.fee,
      hasUrl: Boolean(extracted.url),
    });
    if (extracted.url) return { ok: true, url: extracted.url, provider: 'api-enhanced-module:song_url', attempts };
  } catch (err) {
    attempts.push({ route: 'song_url', error: err.message });
  }

  if (String(process.env.URL_STRATEGY || 'enhanced-only') === 'enhanced-then-outer') {
    return {
      ok: true,
      url: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`,
      provider: 'netease-outer-url',
      note: 'api-enhanced module did not return URL; URL_STRATEGY=enhanced-then-outer is enabled.',
      attempts,
    };
  }

  return { ok: false, provider: 'api-enhanced-module', message: 'api-enhanced module 未返回可播放 URL。', attempts };
}

async function songDetail(ids) {
  const body = await call('song_detail', { ids: String(ids) });
  return { songs: body && Array.isArray(body.songs) ? body.songs : [], raw: body };
}

async function playlistTracks(id, limit, offset) {
  const body = await call('playlist_track_all', { id: String(id), limit: String(limit || process.env.PLAYLIST_LIMIT || 100), offset: String(offset || 0) });
  return { songs: body && Array.isArray(body.songs) ? body.songs : [], raw: body };
}

async function album(id) {
  const body = await call('album', { id: String(id) });
  return { songs: body && Array.isArray(body.songs) ? body.songs : [], raw: body };
}

async function artistSongs(id, limit, offset) {
  const body = await call('artist_songs', { id: String(id), limit: String(limit || 100), offset: String(offset || 0) });
  return { songs: body && Array.isArray(body.songs) ? body.songs : [], raw: body };
}

async function searchSongs(keywords, limit, offset) {
  const body = await call('search', { keywords: String(keywords), type: '1', limit: String(limit || 30), offset: String(offset || 0) });
  return { songs: body && body.result && Array.isArray(body.result.songs) ? body.result.songs : [], raw: body };
}

async function lyric(id) {
  const body = await call('lyric', { id: String(id) });
  return (body && body.lrc && body.lrc.lyric) || (body && body.klyric && body.klyric.lyric) || '';
}

async function probe(id = '174944') {
  const results = [];
  for (const [name, fn] of [
    ['health', health],
    ['song_detail', () => songDetail(id)],
    ['song_url', () => songUrl(id)],
    ['playlist_track_all', () => playlistTracks('60198', 1, 0)]
  ]) {
    try {
      const res = await fn();
      results.push({ name, ok: true, keys: res && typeof res === 'object' ? Object.keys(res).slice(0, 10) : undefined, preview: JSON.stringify(res).slice(0, 300) });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = {
  health,
  songUrl,
  songDetail,
  playlistTracks,
  album,
  artistSongs,
  searchSongs,
  lyric,
  probe,
  buildCookie,
};
