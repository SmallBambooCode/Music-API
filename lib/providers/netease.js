'use strict';

// 网易云 provider — 包装现有的 enhanced-http-client, 提供与其他平台一致的接口
// 单曲 songFull 通过并发获取详情+URL+歌词, 加速插件调用 (3-5 次串行 → 3 次并发)

const enhancedHttp = require('../enhanced-http-client');

const platform = 'netease';

// 搜索歌曲
async function search(keyword, limit = 30) {
  const res = await enhancedHttp.searchSongs(keyword, limit, 0);
  const songs = res.songs || [];
  return songs.map(s => ({
    id: String(s.id || ''),
    name: s.name || '',
    singer: (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join(' / '),
    time: Math.floor((s.dt || 0) / 1000),
  })).filter(s => s.id);
}

// 获取播放 URL
async function songUrl(id) {
  const result = await enhancedHttp.songUrl(id);
  return {
    ok: result.ok,
    url: result.url || '',
    name: '',
    singer: '',
    time: 0,
  };
}

// 获取歌词
async function lyric(id) {
  return await enhancedHttp.lyric(id);
}

// 获取单曲详情 (name + singer + time)
async function songDetail(id) {
  const res = await enhancedHttp.songDetail(id);
  const song = res.songs && res.songs[0];
  if (!song) return { name: '', singer: '', time: 0 };
  return {
    name: song.name || '',
    singer: (song.ar || song.artists || []).map(a => a.name).filter(Boolean).join(' / '),
    time: Math.floor((song.dt || 0) / 1000),
  };
}

// 一次性返回完整单曲信息 (服务端并发, 加速插件调用)
async function songFull(id) {
  const [urlResult, lyricResult, detail] = await Promise.all([
    songUrl(id),
    lyric(id),
    songDetail(id),
  ]);
  return {
    id,
    name: detail.name,
    singer: detail.singer,
    url: urlResult.url,
    lyric: lyricResult,
    time: detail.time,
    ok: urlResult.ok,
  };
}

module.exports = {
  platform,
  search,
  songUrl,
  lyric,
  songFull,
  songDetail,
};
