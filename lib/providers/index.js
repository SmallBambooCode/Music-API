'use strict';

// 多平台 provider 注册中心
// 各 provider 必须实现: { platform, search(keyword, limit), songUrl(id, userId, token), lyric(id), songFull(id, userId, token) }
// 可选: searchPlaylist(keyword, limit), playlistDetail(id, limit, offset)

const kugou = require('./kugou');
const kuwo = require('./kuwo');
const neteaseProvider = require('./netease');

const REGISTRY = {
  netease: neteaseProvider,
  kugou,
  kuwo,
};

const SUPPORTED = Object.keys(REGISTRY);

// 支持歌单搜索的平台
const PLAYLIST_SEARCH_SUPPORTED = Object.entries(REGISTRY)
  .filter(([, p]) => typeof p.searchPlaylist === 'function')
  .map(([name]) => name);

function get(server) {
  return REGISTRY[server] || null;
}

function isSupported(server) {
  return Boolean(REGISTRY[server]);
}

module.exports = { REGISTRY, SUPPORTED, PLAYLIST_SEARCH_SUPPORTED, get, isSupported };
