'use strict';

// 网易云 provider 转发层 v0.16.0
// 融合 api-enhanced 后, 网易云底层直接由 netease-client 处理, 此文件仅做接口聚合。

const nc = require('./netease-client');

function providerName() { return 'embedded'; }

function providerMeta() {
  return {
    selectedProvider: 'embedded',
    unblock: nc.unblockEnabled(),
    ncmLevel: process.env.NCM_LEVEL || 'standard',
    hasCookie: Boolean(nc.buildCookie()),
  };
}

async function health() {
  return { ...providerMeta(), ...(await nc.health()) };
}

async function enhancedRaw(pathname, params = {}) {
  return nc.enhancedRaw(pathname, params);
}

module.exports = {
  providerName,
  providerMeta,
  health,
  enhancedRaw,
  songUrl: (...args) => nc.songUrl(...args),
  songDetail: (...args) => nc.songDetail(...args),
  playlistTracks: (...args) => nc.playlistTracks(...args),
  album: (...args) => nc.album(...args),
  artistSongs: (...args) => nc.artistSongs(...args),
  searchSongs: (...args) => nc.searchSongs(...args),
  lyric: (...args) => nc.lyric(...args),
};
