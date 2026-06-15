'use strict';

const { call, callFirst, getLevelCandidates } = require('./ncm');
const { apiBaseUrl } = require('./http');

function jsonTtl() { return Number(process.env.CACHE_TTL_JSON || 300); }
function urlTtl() { return Number(process.env.CACHE_TTL_URL || 45); }

function artistsText(song) {
  const artists = song.ar || song.artists || song.artist || [];
  if (Array.isArray(artists)) return artists.map((a) => a && a.name).filter(Boolean).join(' / ');
  if (typeof artists === 'string') return artists;
  return '';
}

function coverOf(song) {
  return (song.al && song.al.picUrl) || (song.album && song.album.picUrl) || (song.al && song.al.pic_str) || (song.album && song.album.pic) || '';
}

function mapSong(song) {
  const id = String(song.id || song.songId || '');
  return { title: song.name || song.title || '', author: artistsText(song), pic: coverOf(song) || id, url: id, lrc: id };
}

function fillMetingLinks(req, items, server = 'netease') {
  const base = apiBaseUrl(req);
  return items.map((item) => {
    const x = { ...item };
    for (const key of ['url', 'pic', 'lrc']) {
      const value = String(x[key] || '');
      if (!value) continue;
      if (value.startsWith('@') || value.startsWith('http://') || value.startsWith('https://')) continue;
      x[key] = `${base}?server=${encodeURIComponent(server)}&type=${key}&id=${encodeURIComponent(value)}`;
    }
    return x;
  });
}

function lyricLineToTime(line) {
  const match = String(line).match(/^\[(\d{2}):(\d{2})[.:](\d+)\](.*)$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const milliseconds = Number(String(match[3]).padEnd(3, '0').slice(0, 3));
  return { time: minutes * 60000 + seconds * 1000 + milliseconds, text: match[4] || '' };
}

function parseLyric(lyric) {
  return String(lyric || '').split('\n').map(lyricLineToTime).filter(Boolean).sort((a, b) => a.time - b.time);
}

function formatTime(time) {
  const mm = String(Math.floor(time / 60000)).padStart(2, '0');
  const ss = String(Math.floor((time % 60000) / 1000)).padStart(2, '0');
  const ms = String(time % 1000).padStart(3, '0');
  return `${mm}:${ss}.${ms}`;
}

function mergeLyric(lyric, tlyric) {
  const original = parseLyric(lyric);
  const translated = parseLyric(tlyric);
  if (!translated.length) return String(lyric || '');
  const translatedByTime = new Map(translated.map((x) => [x.time, x.text]));
  return original.map((line) => {
    const t = translatedByTime.get(line.time);
    return `[${formatTime(line.time)}]${line.text}${t ? ` (${t})` : ''}`;
  }).join('\n');
}

function pickSongsFromBody(body) {
  if (!body) return [];
  if (Array.isArray(body.songs)) return body.songs;
  if (body.result && Array.isArray(body.result.songs)) return body.result.songs;
  if (body.data && Array.isArray(body.data.songs)) return body.data.songs;
  if (Array.isArray(body.data)) return body.data;
  if (body.playlist && Array.isArray(body.playlist.tracks)) return body.playlist.tracks;
  if (body.hotSongs && Array.isArray(body.hotSongs)) return body.hotSongs;
  return [];
}

async function songDetail(ids) {
  const idText = Array.isArray(ids) ? ids.join(',') : String(ids);
  const res = await call('/song/detail', { ids: idText }, { ttl: jsonTtl() });
  return pickSongsFromBody(res.body);
}

async function getSong(id) { return (await songDetail(id)).map(mapSong); }

async function getPlaylist(id, query = {}) {
  const limit = Math.min(Number(query.limit || 200), 500);
  const offset = Math.max(Number(query.offset || 0), 0);
  const res = await call('/playlist/detail', { id, n: limit, s: 8 }, { ttl: jsonTtl() });
  let songs = pickSongsFromBody(res.body);
  const trackIds = res.body && res.body.playlist && Array.isArray(res.body.playlist.trackIds) ? res.body.playlist.trackIds : [];
  if ((!songs.length || songs.length < Math.min(limit, trackIds.length)) && trackIds.length) {
    const ids = trackIds.slice(offset, offset + limit).map((x) => x.id).filter(Boolean);
    if (ids.length) songs = await songDetail(ids);
  }
  return songs.slice(0, limit).map(mapSong);
}

async function getSearch(keyword, query = {}) {
  const limit = Math.min(Number(query.limit || 30), 100);
  const res = await callFirst(['/cloudsearch', '/search'], { keywords: keyword, s: keyword, type: 1, limit, offset: query.offset || 0 }, { ttl: jsonTtl() });
  return pickSongsFromBody(res.body).map(mapSong);
}

async function getArtist(id, query = {}) {
  const limit = Math.min(Number(query.limit || 50), 100);
  const res = await callFirst(['/artist/songs', '/artist/top/song'], { id, limit, order: 'hot' }, { ttl: jsonTtl() });
  return pickSongsFromBody(res.body).slice(0, limit).map(mapSong);
}

async function getAlbum(id) {
  const res = await call('/album', { id }, { ttl: jsonTtl() });
  return pickSongsFromBody(res.body).map(mapSong);
}

async function getPic(id) {
  const songs = await songDetail(id);
  return songs[0] ? coverOf(songs[0]) : '';
}

async function getLyric(id) {
  const res = await call('/lyric', { id }, { ttl: jsonTtl() });
  const body = res.body || {};
  return mergeLyric(body.lrc && body.lrc.lyric, body.tlyric && body.tlyric.lyric);
}

function getFallbackApiBase() {
  const raw = String(process.env.METING_FALLBACK_API || process.env.LEGACY_METING_API || '').trim();
  if (!raw) return '';
  return raw.replace(/\?+$/, '').replace(/&+$/, '');
}

function urlProvider() { return String(process.env.URL_PROVIDER || 'enhanced-then-fallback').trim().toLowerCase(); }
function shouldUseFallbackFirst() { return ['fallback-first', 'meting-first', 'legacy-first'].includes(urlProvider()); }
function shouldUseFallbackOnly() { return ['fallback-only', 'meting-only', 'legacy-only'].includes(urlProvider()); }

async function fallbackMetingUrl(req, id, query = {}) {
  const base = getFallbackApiBase();
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('server', query.server || 'netease');
  url.searchParams.set('type', 'url');
  url.searchParams.set('id', id);
  if (query.auth) url.searchParams.set('auth', query.auth);
  url.searchParams.set('_', String(Date.now()));

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'meting-enhanced-vercel/0.6 fallback',
      'Referer': req.headers.referer || req.headers.origin || '',
    },
    redirect: 'manual',
  });

  const location = response.headers.get('location');
  if (location && /^https?:\/\//i.test(location)) return { url: location.replace(/^http:\/\//, 'https://'), meta: { provider: 'meting-fallback', status: response.status, mode: 'redirect' } };

  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const candidates = [json.url, json.data && json.data.url, Array.isArray(json.data) && json.data[0] && json.data[0].url].filter(Boolean);
    const playable = candidates.find((x) => typeof x === 'string' && /^https?:\/\//i.test(x));
    if (playable) return { url: playable.replace(/^http:\/\//, 'https://'), meta: { provider: 'meting-fallback', status: response.status, mode: 'json' } };
  } catch {}
  const playable = text.trim();
  if (/^https?:\/\//i.test(playable)) return { url: playable.replace(/^http:\/\//, 'https://'), meta: { provider: 'meting-fallback', status: response.status, mode: 'text' } };
  return null;
}

function pickUrlItem(body) {
  const data = body && Array.isArray(body.data) ? body.data : [];
  return data[0] || {};
}

async function enhancedUrl(id, query = {}) {
  const levels = getLevelCandidates(query.level);
  const attempts = [];
  for (const level of levels) {
    try {
      const res = await call('/song/url/v1', { id, level, os: 'pc', encodeType: 'flac' }, { ttl: urlTtl() });
      const body = res.body || {};
      const item = pickUrlItem(body);
      const url = item.url ? String(item.url).replace(/^http:\/\//, 'https://') : '';
      attempts.push({ route: '/song/url/v1', level, code: body.code || item.code, fee: item.fee, hasUrl: Boolean(url) });
      if (url) return { url, meta: { provider: 'api-enhanced', route: '/song/url/v1', level, br: item.br, size: item.size, type: item.type, fee: item.fee, attempts } };
    } catch (error) {
      attempts.push({ route: '/song/url/v1', level, error: error.message });
    }
  }
  try {
    const res = await call('/song/url', { id, br: 999000 }, { ttl: urlTtl() });
    const body = res.body || {};
    const item = pickUrlItem(body);
    const url = item.url ? String(item.url).replace(/^http:\/\//, 'https://') : '';
    attempts.push({ route: '/song/url', code: body.code || item.code, fee: item.fee, hasUrl: Boolean(url) });
    if (url) return { url, meta: { provider: 'api-enhanced', route: '/song/url', br: item.br, size: item.size, type: item.type, fee: item.fee, attempts } };
  } catch (error) { attempts.push({ route: '/song/url', error: error.message }); }
  return { url: '', meta: { provider: 'api-enhanced', reason: 'No playable URL returned by enhanced upstream.', attempts } };
}

async function getUrl(id, query = {}, req = null) {
  if (req && (shouldUseFallbackFirst() || shouldUseFallbackOnly())) {
    const fallbackFirst = await fallbackMetingUrl(req, id, query).catch((error) => ({ error: error.message }));
    if (fallbackFirst && fallbackFirst.url) return fallbackFirst;
    if (shouldUseFallbackOnly()) return { url: '', meta: { reason: 'Fallback API did not return a playable URL.', fallbackConfigured: Boolean(getFallbackApiBase()), fallbackError: fallbackFirst && fallbackFirst.error } };
  }

  const enhanced = await enhancedUrl(id, query);
  if (enhanced.url) return enhanced;

  if (req) {
    const fallback = await fallbackMetingUrl(req, id, query).catch((error) => ({ error: error.message }));
    if (fallback && fallback.url) return fallback;
    enhanced.meta.fallbackConfigured = Boolean(getFallbackApiBase());
    enhanced.meta.fallbackError = fallback && fallback.error;
  }
  return enhanced;
}

async function handleMeting(req, query) {
  const server = query.server || 'netease';
  const type = query.type || 'playlist';
  const id = query.id || '6907557348';

  if (server !== 'netease') return { kind: 'json', status: 400, data: { status: 400, message: 'Only server=netease is supported.', param: { server, type, id } } };
  if (!id) return { kind: 'json', status: 400, data: { status: 400, message: 'id is required', param: { server, type, id } } };

  if (type === 'url') {
    const result = await getUrl(id, query, req);
    if (!result.url) return { kind: 'json', status: 403, data: { error: 'no url', detail: result.meta } };
    if (query.raw === '1' || query.json === '1' || query.format === 'json') return { kind: 'json', status: 200, data: result };
    return { kind: 'redirect', status: 302, location: result.url };
  }
  if (type === 'pic') {
    const pic = await getPic(id);
    if (!pic) return { kind: 'json', status: 404, data: { error: 'no pic' } };
    if (query.raw === '1' || query.json === '1') return { kind: 'json', status: 200, data: { pic } };
    return { kind: 'redirect', status: 302, location: pic };
  }
  if (type === 'lrc') return { kind: 'text', status: 200, text: await getLyric(id) };

  let items;
  switch (type) {
    case 'song': items = await getSong(id); break;
    case 'playlist': items = await getPlaylist(id, query); break;
    case 'artist': items = await getArtist(id, query); break;
    case 'search': items = await getSearch(id, query); break;
    case 'album': items = await getAlbum(id); break;
    default: return { kind: 'json', status: 400, data: { status: 400, message: 'type 参数不合法', param: { server, type, id } } };
  }
  return { kind: 'json', status: 200, data: fillMetingLinks(req, items, server) };
}

module.exports = { handleMeting, fillMetingLinks, mergeLyric, getUrl, getFallbackApiBase };
