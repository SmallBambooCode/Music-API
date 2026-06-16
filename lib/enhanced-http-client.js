'use strict';

function readPort(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function getEnhancedPort() {
  return readPort('API_ENHANCED_PORT', 3000);
}

function getAdapterPort() {
  return readPort('ADAPTER_PORT', 3017);
}

function getBase() {
  const explicit = String(process.env.NCM_API_BASE || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `http://localhost:${getEnhancedPort()}`;
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

function addParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function request(pathname, params = {}, options = {}) {
  const url = addParams(new URL(pathname, getBase()), params);
  const cookie = buildCookie();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.REQUEST_TIMEOUT || 15000));

  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      redirect: options.redirect || 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://music.163.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
    });

    const raw = await resp.text();
    let body = raw;
    try { body = JSON.parse(raw); } catch {}

    return {
      ok: resp.ok,
      status: resp.status,
      url: url.toString(),
      raw,
      body,
      contentType: resp.headers.get('content-type') || '',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isAdapterHtml(res) {
  const s = typeof res.body === 'string' ? res.body : res.raw || '';
  return /Meting Enhanced Adapter|Meting Enhanced HTTP Adapter|meting-enhanced-adapter|适配器/.test(s);
}

function isJson(res) {
  return typeof res.body === 'object' && res.body !== null;
}

function normalizeUrl(value) {
  return String(value || '').replace(/^http:\/\//i, 'https://');
}

function levels() {
  const primary = String(process.env.NCM_LEVEL || 'standard').trim() || 'standard';
  const configured = String(process.env.NCM_LEVELS || '').trim();
  const list = configured ? configured.split(',').map(x => x.trim()).filter(Boolean) : ['standard', 'higher', 'exhigh', 'lossless', 'hires'];
  return [primary, ...list].filter((x, i, arr) => x && arr.indexOf(x) === i);
}

function firstSongUrl(body) {
  const data = body && Array.isArray(body.data) ? body.data[0] : null;
  return { item: data, url: normalizeUrl(data && (data.url || data.proxyUrl)) };
}

async function health() {
  const attempts = [];
  for (const [route, params] of [['/inner/version', {}], ['/search', { keywords: '网易云', limit: 1 }]]) {
    try {
      const res = await request(route, params);
      const selfLoop = isAdapterHtml(res);
      const json = isJson(res);
      attempts.push({
        route,
        requestUrl: res.url,
        status: res.status,
        ok: res.ok,
        json,
        selfLoop,
        code: json ? res.body.code : undefined,
        preview: typeof res.body === 'string' ? res.body.slice(0, 100) : undefined,
      });
      if (selfLoop) {
        return {
          ok: false,
          provider: 'http',
          reason: 'self_loop',
          message: 'NCM_API_BASE 指向了适配器自己，不是 api-enhanced。',
          base: getBase(),
          attempts,
        };
      }
      if (res.ok && json) {
        return { ok: true, provider: 'http', base: getBase(), route, attempts };
      }
    } catch (err) {
      attempts.push({ route, error: err.message });
    }
  }
  return {
    ok: false,
    provider: 'http',
    reason: 'upstream_unreachable_or_not_api_enhanced',
    message: '未检测到 api-enhanced HTTP 服务。传统方式请先运行 npx @neteasecloudmusicapienhanced/api@latest。',
    base: getBase(),
    attempts,
  };
}

async function songUrl(id) {
  const upstream = await health();
  if (!upstream.ok) return { ok: false, provider: 'api-enhanced-http', message: upstream.message, upstream, attempts: [] };

  const attempts = [];
  for (const level of levels()) {
    try {
      const res = await request('/song/url/v1', { id, level });
      const extracted = firstSongUrl(res.body);
      attempts.push({
        route: '/song/url/v1',
        requestUrl: res.url,
        status: res.status,
        json: isJson(res),
        code: res.body && res.body.code,
        itemCode: extracted.item && extracted.item.code,
        fee: extracted.item && extracted.item.fee,
        levelReturned: extracted.item && extracted.item.level,
        type: extracted.item && extracted.item.type,
        hasUrl: Boolean(extracted.url),
      });
      if (extracted.url) return { ok: true, url: extracted.url, provider: 'api-enhanced-http:/song/url/v1', attempts };
    } catch (err) {
      attempts.push({ route: '/song/url/v1', level, error: err.message });
    }
  }

  try {
    const res = await request('/song/url', { id, br: 999000 });
    const extracted = firstSongUrl(res.body);
    attempts.push({
      route: '/song/url',
      requestUrl: res.url,
      status: res.status,
      json: isJson(res),
      code: res.body && res.body.code,
      itemCode: extracted.item && extracted.item.code,
      fee: extracted.item && extracted.item.fee,
      hasUrl: Boolean(extracted.url),
    });
    if (extracted.url) return { ok: true, url: extracted.url, provider: 'api-enhanced-http:/song/url', attempts };
  } catch (err) {
    attempts.push({ route: '/song/url', error: err.message });
  }

  if (String(process.env.URL_STRATEGY || 'enhanced-only') === 'enhanced-then-outer') {
    return {
      ok: true,
      url: `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`,
      provider: 'netease-outer-url',
      note: 'api-enhanced did not return URL; URL_STRATEGY=enhanced-then-outer is enabled.',
      attempts,
    };
  }

  return { ok: false, provider: 'api-enhanced-http', message: 'api-enhanced 已连接，但未返回可播放 URL。', attempts };
}

async function songDetail(ids) {
  const res = await request('/song/detail', { ids });
  return { songs: res.body && Array.isArray(res.body.songs) ? res.body.songs : [], raw: res.body, status: res.status, requestUrl: res.url };
}

async function playlistTracks(id, limit, offset) {
  const res = await request('/playlist/track/all', { id, limit: limit || process.env.PLAYLIST_LIMIT || 100, offset: offset || 0 });
  return { songs: res.body && Array.isArray(res.body.songs) ? res.body.songs : [], raw: res.body, status: res.status, requestUrl: res.url };
}

async function album(id) {
  const res = await request('/album', { id });
  return { songs: res.body && Array.isArray(res.body.songs) ? res.body.songs : [], raw: res.body, status: res.status, requestUrl: res.url };
}

async function artistSongs(id, limit, offset) {
  const res = await request('/artist/songs', { id, limit: limit || 100, offset: offset || 0 });
  return { songs: res.body && Array.isArray(res.body.songs) ? res.body.songs : [], raw: res.body, status: res.status, requestUrl: res.url };
}

async function searchSongs(keywords, limit, offset) {
  const res = await request('/search', { keywords, type: 1, limit: limit || 30, offset: offset || 0 });
  return { songs: res.body && res.body.result && Array.isArray(res.body.result.songs) ? res.body.result.songs : [], raw: res.body, status: res.status, requestUrl: res.url };
}

async function lyric(id) {
  const res = await request('/lyric', { id });
  return (res.body && res.body.lrc && res.body.lrc.lyric) || (res.body && res.body.klyric && res.body.klyric.lyric) || '';
}

async function probe(id = '174944') {
  const routes = [
    ['/inner/version', {}],
    ['/search', { keywords: '网易云', limit: 1 }],
    ['/song/detail', { ids: id }],
    ['/song/url/v1', { id, level: process.env.NCM_LEVEL || 'standard' }],
    ['/song/url', { id, br: 999000 }],
    ['/playlist/track/all', { id: '60198', limit: 1 }],
  ];
  const results = [];
  for (const [route, params] of routes) {
    try {
      const res = await request(route, params);
      results.push({
        route,
        requestUrl: res.url,
        status: res.status,
        json: isJson(res),
        selfLoop: isAdapterHtml(res),
        code: res.body && res.body.code,
        keys: isJson(res) ? Object.keys(res.body).slice(0, 10) : undefined,
        preview: typeof res.body === 'string' ? res.body.slice(0, 120) : undefined,
      });
    } catch (err) {
      results.push({ route, error: err.message });
    }
  }
  return results;
}

async function rawEnhanced(pathname, params = {}) {
  return request(pathname, params);
}

module.exports = {
  getBase,
  getEnhancedPort,
  getAdapterPort,
  buildCookie,
  request,
  rawEnhanced,
  health,
  songUrl,
  songDetail,
  playlistTracks,
  album,
  artistSongs,
  searchSongs,
  lyric,
  probe,
};
