'use strict';

// 酷狗音乐 API — 移植自 ZMusicGUI/KugouMusicApi.kt
// 实测可用接口:
//   - 搜索: http://mobilecdn.kugou.com/api/v3/search/song
//   - 播放URL方案1: http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={hash}
//   - 播放URL方案2: http://trackercdn.kugou.com/i/v2/?key={MD5(hash+"kgcloudv2")}&hash={hash}
//   - 歌词搜索: http://lyrics.kugou.com/search
//   - 歌词下载: http://lyrics.kugou.com/download (base64 LRC)
//
// v2.4.0: 支持完整 cookie 透传 (从浏览器 F12 document.cookie 复制)
//   - 如果传入 cookie, 所有请求会带上 Cookie 头 (服务端原样透传)
//   - 同时仍支持旧的 userid+token URL 参数方式 (向后兼容)
//   - 也会尝试从 cookie 中提取 KugooID/KugooToken (或 userid/token) 作为 URL 参数

const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER = 'https://www.kugou.com/';

async function httpGet(url, referer = REFERER, cookie = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const headers = {
      'User-Agent': UA,
      'Referer': referer,
      'Accept': 'application/json, text/plain, */*',
    };
    if (cookie) headers.Cookie = cookie;
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) return '';
    return await resp.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

function md5Hex(input) {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

// 从 cookie 字符串中提取酷狗鉴权信息
// 支持两种 cookie 格式:
//   1. 浏览器 F12 复制的完整 cookie (含 KuGoo 复合 cookie, 内有 t=token)
//   2. 扫码登录返回的 KugooID + KugooToken
function extractKugouAuth(cookie) {
  if (!cookie) return { userId: '', token: '', dfid: '', mid: '', appId: '1014' };
  // KugooID (浏览器 cookie) 或 userid (老式)
  const uidMatch = cookie.match(/(?:^|;\s*)KugooID=([^;]+)/i)
    || cookie.match(/(?:^|;\s*)userid=([^;]+)/i);
  const userId = uidMatch ? uidMatch[1] : '';
  // KuGoo 复合 cookie: KugooID=xxx&KugooPwd=xxx&...&t=xxx (URL编码)
  // t 字段是 web 会话 token, 用于 wwwapi play/getdata 接口
  let token = '';
  const kugooMatch = cookie.match(/(?:^|;\s*)KuGoo=([^;]+)/i);
  if (kugooMatch) {
    const decoded = decodeURIComponent(kugooMatch[1]);
    const tMatch = decoded.match(/[&?]t=([^&]+)/);
    if (tMatch) token = tMatch[1];
  }
  // 兜底: 扫码登录返回的 KugooToken
  if (!token) {
    const tkMatch = cookie.match(/(?:^|;\s*)KugooToken=([^;]+)/i)
      || cookie.match(/(?:^|;\s*)token=([^;]+)/i);
    if (tkMatch) token = tkMatch[1];
  }
  // dfid, mid, a_id (wwwapi 接口需要)
  const dfidMatch = cookie.match(/(?:^|;\s*)(?:kg_dfid|dfid)=([^;]+)/i);
  const midMatch = cookie.match(/(?:^|;\s*)(?:kg_mid|mid)=([^;]+)/i);
  const appIdMatch = cookie.match(/(?:^|;\s*)a_id=([^;]+)/i);
  return {
    userId,
    token,
    dfid: dfidMatch ? dfidMatch[1] : '',
    mid: midMatch ? midMatch[1] : '',
    appId: appIdMatch ? appIdMatch[1] : '1014',
  };
}

// 搜索: 返回 [{id, name, singer}]
// 增加重试机制
async function search(keyword, limit = 30) {
  const url = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&page=1&pagesize=${limit}&keyword=${encodeURIComponent(keyword)}`;
  for (let i = 0; i < 3; i++) {
    const body = await httpGet(url);
    if (body) {
      try {
        const root = JSON.parse(body);
        if (root.status !== 1) {
          if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
          continue;
        }
        const info = root.data && Array.isArray(root.data.info) ? root.data.info : [];
        return info.map(s => ({
          id: s.hash || '',
          name: s.songname || '未知',
          singer: s.singername || '未知',
          time: 0,
        })).filter(s => s.id);
      } catch {
        if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
    }
    if (i < 2) await new Promise(r => setTimeout(r, 500 * (i + 1)));
  }
  return [];
}

// 获取歌曲信息 (name/singer/time/url 方案1)
async function fetchSongInfo(hash, userId = '', token = '', cookie = '') {
  // 优先用显式传入的 userid+token; 没有就从 cookie 提取
  let uid = userId;
  let tk = token;
  if ((!uid || !tk) && cookie) {
    const extracted = extractKugouAuth(cookie);
    if (!uid) uid = extracted.userId;
    if (!tk) tk = extracted.token;
  }
  let url = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}&from=mkugou`;
  if (uid && tk) url += `&userid=${uid}&token=${tk}`;
  const body = await httpGet(url, REFERER, cookie);
  if (!body) return null;
  try {
    const obj = JSON.parse(body);
    if (obj.errcode !== 0) return null;
    return {
      name: obj.songName || obj.fileName || '未知',
      singer: obj.choricSinger || obj.author_name || '未知',
      time: obj.timeLength || 0,
      url: obj.url || '',
    };
  } catch {
    return null;
  }
}

// 播放URL方案2: trackercdn (key=MD5(hash+"kgcloudv2"))
// 多参数尝试: VIP歌曲需要 vip=1 + area_id + 正确的 token
async function resolvePlayUrlTracker(hash, userId = '', token = '', cookie = '') {
  const auth = extractKugouAuth(cookie);
  const uid = userId || auth.userId;
  const tk = token || auth.token;
  const key = md5Hex(hash + 'kgcloudv2');

  // 尝试多种参数组合
  const attempts = [
    // 方案A: 带 VIP 标志 + area_id (移动APP VIP播放)
    { url: `http://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=hq&appid=1005&pid=2&behavior=play&cmd=25&filename=${hash}.mp3&vip=1&area_id=1${uid ? `&userid=${uid}` : ''}${tk ? `&token=${tk}` : ''}` },
    // 方案B: 标准 trackercdn (免费歌曲)
    { url: `http://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=hq&appid=1005&pid=2&behavior=play&cmd=25&filename=${hash}.mp3${uid ? `&userid=${uid}` : ''}${tk ? `&token=${tk}` : ''}` },
    // 方案C: br=sq (标准质量, 有些VIP歌曲允许sq播放)
    { url: `http://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=sq&appid=1005&pid=2&behavior=play&cmd=25&filename=${hash}.mp3${uid ? `&userid=${uid}` : ''}${tk ? `&token=${tk}` : ''}` },
  ];

  for (const { url } of attempts) {
    const body = await httpGet(url, '', cookie);
    if (!body) continue;
    try {
      const obj = JSON.parse(body);
      if (obj.status === 1) {
        const rawUrl = obj.url || '';
        const playUrl = rawUrl.split(' ').find(u => u.startsWith('http')) || '';
        if (playUrl) {
          console.log(`[Kugou Tracker] 获取成功: ${playUrl.slice(0, 80)}...`);
          return playUrl;
        }
      }
    } catch {
      // continue
    }
  }
  return '';
}

// 播放URL方案4: 移动端 getSongInfo (cmd=201, 支持 VIP)
async function resolvePlayUrlMobile(hash, userId = '', token = '', cookie = '') {
  const auth = extractKugouAuth(cookie);
  const uid = userId || auth.userId;
  const tk = token || auth.token;
  if (!uid || !tk) return '';

  // m.kugou.com cmd=201 是 VIP 播放接口
  const url = `http://m.kugou.com/app/i/getSongInfo.php?cmd=201&hash=${hash}&from=mkugou&userid=${uid}&token=${tk}&clienttime=${Math.floor(Date.now() / 1000)}&appid=1005`;
  const body = await httpGet(url, 'https://m.kugou.com/', cookie);
  if (!body) return '';
  try {
    const obj = JSON.parse(body);
    if (obj.errcode !== 0) return '';
    // VIP 播放URL在 url 或 play_url 字段
    const playUrl = obj.url || obj.play_url || '';
    if (playUrl) console.log(`[Kugou Mobile] 获取成功: ${playUrl.slice(0, 80)}...`);
    return playUrl;
  } catch {
    return '';
  }
}

// 播放URL方案3 (VIP): wwwapi.kugou.com/yy/index.php?r=play/getdata
// 这是网页版播放器用的接口, 带 cookie 可获取 VIP 歌曲
// 返回格式: https://webfs.kugou.com/{timestamp}/{hash1}/v3/{hash2}/yp/full/ap1014_us{userId}_{token}_pi{xxx}_mx{xxx}_s{songId}.mp3
async function resolvePlayUrlWWW(hash, userId = '', token = '', cookie = '') {
  const auth = extractKugouAuth(cookie);
  const uid = userId || auth.userId;
  const tk = token || auth.token;
  if (!uid || !tk) {
    console.log('[Kugou WWW] 无 userid/token, 跳过 wwwapi 接口');
    return '';
  }
  const dfid = auth.dfid || '-';
  const mid = auth.mid || genMid();
  const appId = auth.appId || '1014';
  const clienttime = Math.floor(Date.now() / 1000);
  // 签名参数 (必须按字母序排序后拼接)
  const params = {
    album_id: '',
    appid: appId,
    clienttime: String(clienttime),
    clientver: String(KG_CLIENTVER),
    dfid,
    hash,
    mid,
    platid: '4',
    srcappid: '2919',
    token: tk,
    userid: uid,
  };
  params.signature = kugouSign(params);
  const url = `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&${new URLSearchParams(params).toString()}`;
  const body = await httpGet(url, REFERER, cookie);
  if (!body) return '';
  try {
    // 可能是 JSONP 格式: callback({...})
    const jsonStr = body.replace(/^\w+\(/, '').replace(/\);?\s*$/, '');
    const root = JSON.parse(jsonStr);
    if (root.err_code !== 0) {
      console.log(`[Kugou WWW] err_code=${root.err_code}, err_msg=${root.err_msg || ''}`);
      return '';
    }
    const playUrl = (root.data && root.data.play_url) || '';
    if (playUrl) console.log(`[Kugou WWW] 获取成功: ${playUrl.slice(0, 80)}...`);
    return playUrl;
  } catch (e) {
    console.log(`[Kugou WWW] JSON 解析失败: ${e.message}`);
    return '';
  }
}

// 获取歌词: 搜索候选 → 下载 base64 LRC
async function fetchLyrics(hash, songName, duration, cookie = '') {
  const keyword = encodeURIComponent(songName);
  const durationMs = (duration || 0) * 1000;
  const searchUrl = `http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${keyword}&duration=${durationMs}&hash=${hash}`;
  const searchBody = await httpGet(searchUrl, '', cookie);
  if (!searchBody) return '';
  let candidate;
  try {
    const root = JSON.parse(searchBody);
    const candidates = root.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    candidate = { id: candidates[0].id || '', accesskey: candidates[0].accesskey || '' };
  } catch {
    return '';
  }
  if (!candidate.id || !candidate.accesskey) return '';

  const dlUrl = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${candidate.id}&accesskey=${candidate.accesskey}&fmt=lrc&charset=utf8`;
  const dlBody = await httpGet(dlUrl, '', cookie);
  if (!dlBody) return '';
  try {
    const obj = JSON.parse(dlBody);
    if (obj.status !== 200) return '';
    const b64 = obj.content || '';
    if (!b64) return '';
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

// 获取播放 URL (方案1 getSongInfo → 方案3 wwwapi VIP → 方案2 trackercdn)
async function songUrl(hash, userId = '', token = '', cookie = '') {
  // 先获取歌曲信息 (name/singer/time)
  const info = await fetchSongInfo(hash, userId, token, cookie);
  const name = info ? info.name : '未知';
  const singer = info ? info.singer : '未知';
  const time = info ? info.time : 0;
  // 免费歌曲: getSongInfo 直接返回 url
  if (info && info.url) return { ok: true, url: info.url, name, singer, time };
  // VIP 歌曲: wwwapi play/getdata (需要 cookie 中的 t token)
  const wwwUrl = await resolvePlayUrlWWW(hash, userId, token, cookie);
  if (wwwUrl) return { ok: true, url: wwwUrl, name, singer, time };
  // 兜底: trackercdn
  const trackerUrl = await resolvePlayUrlTracker(hash, userId, token, cookie);
  if (trackerUrl) return { ok: true, url: trackerUrl, name, singer, time };
  return { ok: false, url: '', name, singer, time };
}

// 获取歌词 (单独端点)
async function lyric(hash, cookie = '') {
  const info = await fetchSongInfo(hash, '', '', cookie);
  return fetchLyrics(hash, info ? info.name : '', info ? info.time : 0, cookie);
}

// 一次性返回完整单曲信息 (加速插件调用, 服务端并发)
async function songFull(hash, userId = '', token = '', cookie = '') {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(hash, userId, token, cookie),
    lyric(hash, cookie),
  ]);
  return {
    id: hash,
    name: urlResult.name,
    singer: urlResult.singer,
    url: urlResult.url,
    lyric: lyricResult,
    time: urlResult.time,
    ok: urlResult.ok,
  };
}

// ==================== 歌单功能 ====================
// 实测可用接口:
//   搜索歌单: http://mobilecdn.kugou.com/api/v3/search/special?keyword={kw}&page=1&pagesize=30
//   歌单详情: http://mobilecdn.kugou.com/api/v3/special/song?specialid={id}&page=1&pagesize=30

// 搜索歌单: 返回 [{id, name, cover, creator, songCount}]
async function searchPlaylist(keyword, limit = 30) {
  const url = `http://mobilecdn.kugou.com/api/v3/search/special?format=json&page=1&pagesize=${limit}&keyword=${encodeURIComponent(keyword)}`;
  const body = await httpGet(url);
  if (!body) return [];
  try {
    const root = JSON.parse(body);
    if (root.status !== 1) return [];
    const info = root.data && Array.isArray(root.data.info) ? root.data.info : [];
    return info.map(p => ({
      id: String(p.specialid || ''),
      name: p.specialname || '未知',
      cover: p.img || '',
      creator: p.nickname || '',
      songCount: p.songcount || 0,
    })).filter(p => p.id);
  } catch {
    return [];
  }
}

// 歌单详情: 返回歌单内歌曲列表
async function playlistDetail(specialid, limit = 100, offset = 0) {
  const page = Math.floor(offset / Math.max(limit, 1)) + 1;
  const url = `http://mobilecdn.kugou.com/api/v3/special/song?format=json&page=${page}&pagesize=${limit}&specialid=${encodeURIComponent(specialid)}`;
  const body = await httpGet(url);
  if (!body) return { songs: [], total: 0 };
  try {
    const root = JSON.parse(body);
    if (root.status !== 1) return { songs: [], total: 0 };
    const info = root.data && Array.isArray(root.data.info) ? root.data.info : [];
    const songs = info.map(s => {
      // filename 格式: "歌手 - 歌名"
      const filename = s.filename || '';
      const parts = filename.split(' - ');
      const singer = parts.length > 1 ? parts.slice(0, -1).join(' - ') : '未知';
      const name = parts.length > 1 ? parts[parts.length - 1] : filename || '未知';
      return {
        id: s.hash || '',
        name,
        singer,
        time: s.duration || 0,
      };
    }).filter(s => s.id);
    return { songs, total: (root.data && root.data.total) || songs.length };
  } catch {
    return { songs: [], total: 0 };
  }
}

// ==================== 已移除: QR 扫码登录 ====================
// v0.23.0: 移除酷狗扫码登录
// 原因: 服务器 IP 无法获取 VIP 歌曲播放 URL
//   - 浏览器 cookie 中的 t token 绑定浏览器 IP, 服务器用返回 20006
//   - QR 扫码返回的 API token 无 VIP 权限, wwwapi 返回 30020
//   - trackercdn/m.kugou 等接口均无法获取 VIP 歌曲 URL
// 替代方案: 用网易云登录态兜底播放 VIP 歌曲

module.exports = {
  platform: 'kugou',
  search,
  songUrl,
  lyric,
  songFull,
  fetchSongInfo,
  searchPlaylist,
  playlistDetail,
};

