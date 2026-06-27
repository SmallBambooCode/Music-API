'use strict';

// 网易云 provider v0.20.0
// 单曲 songFull 通过并发获取详情+URL+歌词, 加速插件调用 (3-5 次串行 → 3 次并发)
// 已彻底移除解灰: VIP 歌曲改为用户扫码登录后获取 (per-player cookie)

const nc = require('../netease-client');

const platform = 'netease';

async function search(keyword, limit = 30) {
  const res = await nc.searchSongs(keyword, limit, 0);
  return (res.songs || [])
    .map(s => ({
      id: String(s.id || ''),
      name: s.name || '未知',
      singer: (s.ar || s.artists || []).map(a => a.name).filter(Boolean).join(' / ') || '未知',
      time: Math.floor((s.dt || 0) / 1000),
    }))
    .filter(s => s.id)
    .map(({ time, ...rest }) => rest);
}

// 获取播放 URL (带 per-player cookie)
async function songUrl(id, customCookie = '') {
  const result = await nc.songUrl(id, customCookie);
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
// customCookie: 玩家个人登录 cookie (优先), 否则用全局 NCM_COOKIE
async function songFull(id, customCookie = '') {
  const [urlResult, lyricResult, detail] = await Promise.all([
    songUrl(id, customCookie),
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
