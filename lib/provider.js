'use strict';

const httpClient = require('./enhanced-http-client');
const moduleClient = require('./enhanced-module-client');

function isLocalBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return /^(http:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?/i.test(raw);
  }
}

function isRemoteBase(value) {
  const raw = String(value || '').trim();
  if (!raw || isLocalBase(raw)) return false;
  return /^https?:\/\//i.test(raw);
}

function providerName() {
  const mode = String(process.env.PROVIDER_MODE || 'auto').toLowerCase();
  if (mode === 'http') return 'http';
  if (mode === 'module') return 'module';

  // Vercel 无法访问本地 localhost:3000 常驻服务。
  // 若没有远程 NCM_API_BASE，则自动切 module。
  if (process.env.VERCEL) {
    return isRemoteBase(process.env.NCM_API_BASE) ? 'http' : 'module';
  }

  return 'http';
}

function client() {
  return providerName() === 'module' ? moduleClient : httpClient;
}

function providerMeta() {
  return {
    selectedProvider: providerName(),
    mode: process.env.PROVIDER_MODE || 'auto',
    isVercel: Boolean(process.env.VERCEL),
    ncmApiBase: process.env.NCM_API_BASE || '',
    ignoredLocalBaseOnVercel: Boolean(process.env.VERCEL && isLocalBase(process.env.NCM_API_BASE)),
    hint: process.env.VERCEL && isLocalBase(process.env.NCM_API_BASE)
      ? 'Vercel 上的 localhost/127.0.0.1 只指向当前 Serverless 容器，不能连接你本机的 api-enhanced。v13 已自动切换 module 模式。'
      : undefined,
  };
}

async function health() {
  const c = client();
  const h = await c.health();
  return { ...providerMeta(), ...h };
}

async function probe(id) {
  return client().probe(id);
}

async function enhancedRaw(pathname, params = {}) {
  const c = client();
  if (typeof c.rawEnhanced === 'function') return c.rawEnhanced(pathname, params);
  if (typeof c.enhancedRaw === 'function') return c.enhancedRaw(pathname, params);
  return {
    ok: false,
    status: 501,
    body: {
      ok: false,
      error: 'raw_enhanced_not_supported',
      message: '当前 provider 不支持这个底层路由，或该路由未映射到 module 函数。',
      provider: providerName(),
      path: pathname,
    },
  };
}

module.exports = {
  providerName,
  providerMeta,
  client,
  health,
  probe,
  enhancedRaw,
  songUrl: (...args) => client().songUrl(...args),
  songDetail: (...args) => client().songDetail(...args),
  playlistTracks: (...args) => client().playlistTracks(...args),
  album: (...args) => client().album(...args),
  artistSongs: (...args) => client().artistSongs(...args),
  searchSongs: (...args) => client().searchSongs(...args),
  lyric: (...args) => client().lyric(...args),
};
