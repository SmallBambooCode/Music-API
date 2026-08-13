'use strict';

const provider = require('./provider');
const nc = require('./netease-client');

function originFromReq(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${nc.getAdapterPort()}`;
  return `${proto}://${host}`;
}

function artists(song) {
  const arr = song.ar || song.artists || song.artist || [];
  if (Array.isArray(arr)) return arr.map(a => a && a.name).filter(Boolean).join(' / ');
  if (typeof arr === 'string') return arr;
  return '';
}

function albumName(song) {
  const album = song.al || song.album || {};
  if (typeof album === 'string') return album;
  return album.name || '';
}

function cover(song) {
  const album = song.al || song.album || {};
  return album.picUrl || album.pic || album.coverImgUrl || song.picUrl || '';
}

function item(song, origin) {
  const id = String(song.id || song.songId || '');
  return {
    title: song.name || song.title || '',
    author: artists(song),
    album: albumName(song),
    url: `${origin}/api?server=netease&type=url&id=${encodeURIComponent(id)}`,
    pic: cover(song) || `${origin}/api?server=netease&type=pic&id=${encodeURIComponent(id)}`,
    lrc: `${origin}/api?server=netease&type=lrc&id=${encodeURIComponent(id)}`,
  };
}

function list(songs, origin) {
  return (songs || []).filter(song => song && (song.id || song.songId)).map(song => item(song, origin));
}

async function resolve(type, id, origin, opts = {}) {
  if (type === 'song') return list((await provider.songDetail(id)).songs, origin);
  if (type === 'playlist') {
    const tracks = await provider.playlistTracks(id, opts.limit, opts.offset);
    const songs = list((tracks && tracks.songs) || [], origin);
  
    if (!opts.includeMeta) return songs;
  
    const playlistResult = await provider.playlistDetail(id);
    const playlist = playlistResult && playlistResult.playlist
      ? playlistResult.playlist
      : playlistResult || {};
  
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
  if (type === 'album') return list((await provider.album(id)).songs, origin);
  if (type === 'artist') return list((await provider.artistSongs(id, opts.limit, opts.offset)).songs, origin);
  if (type === 'search') return list((await provider.searchSongs(id, opts.limit, opts.offset)).songs, origin);
  throw new Error(`unsupported list type: ${type}`);
}

module.exports = { originFromReq, item, list, resolve };
