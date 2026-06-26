'use strict';

// 多平台 provider 注册中心
// 各 provider 必须实现: { platform, search(keyword, limit), songUrl(id, userId, token), lyric(id), songFull(id, userId, token) }

const kugou = require('./kugou');
const kuwo = require('./kuwo');
const neteaseProvider = require('./netease');

const REGISTRY = {
  netease: neteaseProvider,
  kugou,
  kuwo,
};

const SUPPORTED = Object.keys(REGISTRY);

function get(server) {
  return REGISTRY[server] || null;
}

function isSupported(server) {
  return Boolean(REGISTRY[server]);
}

module.exports = { REGISTRY, SUPPORTED, get, isSupported };
