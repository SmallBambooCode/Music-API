'use strict';

// 网易云 provider v0.16.0 — 包装 netease-client, 提供与其他平台一致的接口
// 单曲 songFull 通过并发获取详情+URL+歌词, 加速插件调用 (3-5 次串行 → 3 次并发)
// 解灰: netease-client.songUrl 内部已自动启用 (ENABLE_GENERAL_UNBLOCK=true)

const nc = require('../netease-client');

const platform = 'netease';

// 搜索歌曲 — 按热度排序 (原唱 pop 值最高, 排前面)
async function search(keyword, limit = 30) {
  const res = await nc.searchSongs(keyword, limit, 0);
  const songs = res.songs || [];
  return songs
    .map(s => ({
      id: String(s.id || ''),
      name: s.name || '',
      singer: (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join(' / '),
      time: Math.floor((s.dt || 0) / 1000),
      pop: s.pop || 0,
    }))
    .filter(s => s.id)
    .sort((a, b) => b.pop - a.pop)
    .map(({ pop, ...rest }) => rest);
}

// 获取播放 URL (带解灰)
async function songUrl(id) {
  const result = await nc.songUrl(id);
  return {
    ok: result.ok,
    url: result.url || '',
    name: '',
    singer: '',
    time: 0,
    source: result.source,
  };
}

// 获取歌词
async function lyric(id) {
  return await nc.lyric(id);
}

// 获取单曲详情 (name + singer + time)
async function songDetail(id) {
  const res = await nc.songDetail(id);
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
    source: urlResult.source,
  };
}

// 搜索歌单
async function searchPlaylist(keyword, limit = 30) {
  return await nc.searchPlaylists(keyword, limit, 0);
}

// 歌单详情: 返回歌单内歌曲列表
async function playlistDetail(id, limit = 100, offset = 0) {
  const res = await nc.playlistTracks(id, limit, offset);
  const songs = (res.songs || []).map(s => ({
    id: String(s.id || ''),
    name: s.name || '',
    singer: (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join(' / '),
    time: Math.floor((s.dt || 0) / 1000),
  })).filter(s => s.id);
  return { songs, total: songs.length };
}

module.exports = {
  platform,
  search,
  songUrl,
  lyric,
  songFull,
  songDetail,
  searchPlaylist,
  playlistDetail,
};
