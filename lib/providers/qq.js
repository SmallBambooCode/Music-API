'use strict';

// QQ 音乐 provider v0.17.0
// 使用 QQ 音乐官方公开接口 (无签名):
//   - 搜索: https://c.y.qq.com/soso/fcgi-bin/client_search_cp (公开)
//   - 播放URL: https://u.y.qq.com/cgi-bin/musicu.fcg (vkey 接口)
//   - 歌词: https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg (base64 LRC)
//
// VIP 解灰: vkey 返回空 purl 时, 用 @unblockneteasemusic/server 跨平台匹配
//   传入歌名+歌手构建 data 对象, 搜索 B站/酷狗/酷我/migu 等音源

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER_SEARCH = 'https://y.qq.com/';
const REFERER_LYRIC = 'https://y.qq.com/pc/client/download.html';
const DL_HOST = 'https://dl.stream.qqmusic.qq.com/';

// @unblockneteasemusic/server 的 match 函数
// match(id, sources, data): data 提供时跳过网易云查询, 直接用歌名+歌手搜索其他平台
let unmMatch = null;
try {
  unmMatch = require('@unblockneteasemusic/server');
} catch (_) {}

// VIP 解灰的音源优先级 (B站优先, 用户要求)
function unblockSources() {
  const raw = String(process.env.QQ_UNBLOCK_SOURCES || '').trim();
  if (raw) return raw.split(',').map(x => x.trim()).filter(Boolean);
  return ['bilibili', 'bilivideo', 'kugou', 'kuwo', 'migu', 'pyncmd'];
}

function unblockEnabled() {
  const v = String(process.env.QQ_UNBLOCK_ENABLED || '').trim().toLowerCase();
  if (v === '') return true; // 默认开启
  return ['1', 'true', 'yes', 'on'].includes(v);
}

// 跨平台解灰: 用歌名+歌手构建 data, 调用 match 搜索其他平台
async function crossUnblock(songmid, name, singer, duration) {
  if (!unmMatch || !unblockEnabled()) return null;
  const artists = singer
    ? singer.split(' / ').map(n => ({ id: 0, name: n.trim() })).filter(a => a.name)
    : [{ id: 0, name: '' }];
  const data = {
    id: `qq_${songmid}`,
    name: name || '',
    duration: duration || 0,
    album: { id: 0, name: '' },
    artists,
  };
  try {
    const result = await unmMatch(`qq_${songmid}`, unblockSources(), data);
    if (result && typeof result.url === 'string' && result.url) {
      return { url: result.url, source: `unblock:${result.source || 'unknown'}` };
    }
  } catch (_) {}
  return null;
}

async function httpGet(url, referer = REFERER_SEARCH) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*' },
      signal: controller.signal,
    });
    if (!resp.ok) return '';
    return await resp.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// 带重试的 musicu.fcg 请求 (QQ 接口会限流, code=2001 时重试)
async function musicuRequest(payload, retries = 3) {
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(payload))}`;
  for (let i = 0; i <= retries; i++) {
    const body = await httpGet(url);
    if (!body) { await new Promise(r => setTimeout(r, 600 * (i + 1))); continue; }
    try {
      const root = JSON.parse(body);
      const code = root.req_0 && root.req_0.code;
      if (code === 0) return root.req_0.data;
      // code=2001 限流, 等待后重试
      if (code === 2001 && i < retries) {
        await new Promise(r => setTimeout(r, 1200 * (i + 1)));
        continue;
      }
    } catch {}
    return null;
  }
  return null;
}

// 搜索: 返回 [{id(songmid), name, singer, time}]
async function search(keyword, limit = 30) {
  const data = await musicuRequest({
    req_0: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, page_num: 1, num_per_page: limit },
    },
  });
  if (!data) return [];
  const list = data.body && data.body.song && Array.isArray(data.body.song.list) ? data.body.song.list : [];
  return list.map(s => ({
    id: s.mid || '',
    name: s.name || '未知',
    singer: (s.singer || []).map(a => a.name).filter(Boolean).join(' / ') || '未知',
    time: s.interval || 0,
  })).filter(s => s.id);
}

// 通过 vkey 接口获取播放 URL
async function fetchVkey(songmid) {
  const data = await musicuRequest({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '10000',
        songmid: [songmid],
        songtype: [0],
        uin: '0',
        loginflag: 1,
        platform: '20',
      },
    },
  });
  if (!data) return '';
  const info = data.midurlinfo && data.midurlinfo[0];
  if (!info) return '';
  const purl = info.purl || '';
  return purl ? DL_HOST + purl : '';
}

// 获取歌曲基本信息 (名称/歌手/时长)
async function fetchSongInfo(songmid) {
  const data = await musicuRequest({
    req_0: {
      module: 'music.pf_song_detail_svr',
      method: 'get_song_detail_yqq',
      param: { song_mid: songmid },
    },
  });
  if (!data) return null;
  const track = data.track_info;
  if (!track) return null;
  return {
    name: track.name || '未知',
    singer: (track.singer || []).map(a => a.name).filter(Boolean).join(' / ') || '未知',
    time: track.interval || 0,
  };
}

// 播放 URL (vkey → VIP 解灰跨平台匹配)
async function songUrl(songmid) {
  const [url, info] = await Promise.all([fetchVkey(songmid), fetchSongInfo(songmid)]);
  if (url) {
    return {
      ok: true,
      url,
      name: info ? info.name : '未知',
      singer: info ? info.singer : '未知',
      time: info ? info.time : 0,
    };
  }
  // VIP 解灰: vkey 返回空 purl, 跨平台匹配
  if (info && info.name && info.name !== '未知') {
    const cross = await crossUnblock(songmid, info.name, info.singer, info.time);
    if (cross) {
      return {
        ok: true,
        url: cross.url,
        name: info.name,
        singer: info.singer,
        time: info.time,
        source: cross.source,
      };
    }
  }
  return {
    ok: false,
    url: '',
    name: info ? info.name : '未知',
    singer: info ? info.singer : '未知',
    time: info ? info.time : 0,
  };
}

// 歌词 (base64 LRC)
async function lyric(songmid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8`;
  const body = await httpGet(url, REFERER_LYRIC);
  if (!body) return '';
  // QQ 返回可能带 callback 包裹
  const jsonStr = body.replace(/^callback\(/, '').replace(/\);?$/, '');
  try {
    const obj = JSON.parse(jsonStr);
    const b64 = obj.lyric || '';
    if (!b64) return '';
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// 一次性返回完整单曲 (服务端并发)
async function songFull(songmid) {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(songmid),
    lyric(songmid),
  ]);
  return {
    id: songmid,
    name: urlResult.name,
    singer: urlResult.singer,
    url: urlResult.url,
    lyric: lyricResult,
    time: urlResult.time,
    ok: urlResult.ok,
    source: urlResult.source,
  };
}

module.exports = {
  platform: 'qq',
  search,
  songUrl,
  lyric,
  songFull,
  unblockEnabled,
  unblockSources,
};
