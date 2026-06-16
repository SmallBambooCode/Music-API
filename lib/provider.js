'use strict';

const httpClient = require('./enhanced-http-client');
const moduleClient = require('./enhanced-module-client');

function providerName() {
  const mode = String(process.env.PROVIDER_MODE || 'auto').toLowerCase();
  if (mode === 'http') return 'http';
  if (mode === 'module') return 'module';
  if (process.env.NCM_API_BASE) return 'http';
  if (process.env.VERCEL) return 'module';
  return 'http';
}

function client() {
  return providerName() === 'module' ? moduleClient : httpClient;
}

async function health() {
  const c = client();
  const h = await c.health();
  return { selectedProvider: providerName(), ...h };
}

async function probe(id) {
  return client().probe(id);
}

module.exports = {
  providerName,
  client,
  health,
  probe,
  songUrl: (...args) => client().songUrl(...args),
  songDetail: (...args) => client().songDetail(...args),
  playlistTracks: (...args) => client().playlistTracks(...args),
  album: (...args) => client().album(...args),
  artistSongs: (...args) => client().artistSongs(...args),
  searchSongs: (...args) => client().searchSongs(...args),
  lyric: (...args) => client().lyric(...args),
};
