'use strict';

// 网易云 provider v0.20.0
// 单曲 songFull 通过并发获取详情+URL+歌词, 加速插件调用 (3-5 次串行 → 3 次并发)
// 已彻底移除解灰: VIP 歌曲改为用户扫码登录后获取 (per-player cookie)

const nc = require('../netease-client');

const platform = 'netease';

function artistNames(song) {
  const arr = song.ar || song.artists || song.artist || [];

  if (Array.isArray(arr)) {
    return arr.map(item => item && item.name).filter(Boolean).join(' / ');
  }

  if (typeof arr === 'string') return arr;

  return '';
}

function albumName(song) {
  const album = song.al || song.album || {};

  if (typeof album === 'string') return album;

  return album.name || '';
}

async function search(keyword, limit = 30) {
  const res = await nc.searchSongs(keyword, limit, 0);

  return (res.songs || [])
    .map(song => ({
      id: String(song.id || ''),
      name: song.name || '未知',
      singer: artistNames(song) || '未知',
      album: albumName(song),
      time: Math.floor((song.dt || 0) / 1000),
    }))
    .filter(song => song.id)
    .map(({ time, ...song }) => song);
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

  if (!song) {
    return {
      name: '',
      singer: '',
      album: '',
      time: 0,
    };
  }

  return {
    name: song.name || '',
    singer: artistNames(song),
    album: albumName(song),
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
    album: detail.album,
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
  const [playlistResult, trackResult] = await Promise.all([
    nc.playlistDetail(id),
    nc.playlistTracks(id, limit, offset),
  ]);

  const playlist = playlistResult && playlistResult.playlist
    ? playlistResult.playlist
    : playlistResult || {};

  const songs = (trackResult.songs || [])
    .map(song => ({
      id: String(song.id || ''),
      name: song.name || '',
      singer: artistNames(song),
      album: albumName(song),
      time: Math.floor((song.dt || 0) / 1000),
    }))
    .filter(song => song.id);

  return {
    id: String(playlist.id || id),
    name: playlist.name || '',
    cover: playlist.coverImgUrl || playlist.picUrl || '',
    creator: playlist.creator && playlist.creator.nickname || '',
    total: songs.length,
    trackCount: Number(playlist.trackCount || songs.length),
    songs,
  };
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
