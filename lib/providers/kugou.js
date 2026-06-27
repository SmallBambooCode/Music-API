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

// 从 cookie 字符串中提取 KugooID/KugooToken (或老式 userid/token)
function extractKugouAuth(cookie) {
  if (!cookie) return { userId: '', token: '' };
  const uidMatch = cookie.match(/(?:^|;\s*)KugooID=([^;]+)/i)
    || cookie.match(/(?:^|;\s*)userid=([^;]+)/i);
  const tkMatch = cookie.match(/(?:^|;\s*)KugooToken=([^;]+)/i)
    || cookie.match(/(?:^|;\s*)token=([^;]+)/i);
  return {
    userId: uidMatch ? uidMatch[1] : '',
    token: tkMatch ? tkMatch[1] : '',
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
async function resolvePlayUrlTracker(hash, userId = '', token = '', cookie = '') {
  const key = md5Hex(hash + 'kgcloudv2');
  let url = `http://trackercdn.kugou.com/i/v2/?key=${key}&hash=${hash}&br=hq&appid=1005&pid=2&behavior=play&cmd=25&filename=${hash}.mp3`;
  if (userId && token) url += `&userid=${userId}&token=${token}`;
  const body = await httpGet(url, '', cookie);
  if (!body) return '';
  try {
    const obj = JSON.parse(body);
    if (obj.status !== 1) return '';
    const rawUrl = obj.url || '';
    return rawUrl.split(' ').find(u => u.startsWith('http')) || '';
  } catch {
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

// 获取播放 URL (方案1 → 方案2)
async function songUrl(hash, userId = '', token = '', cookie = '') {
  const info = await fetchSongInfo(hash, userId, token, cookie);
  if (info && info.url) return { ok: true, url: info.url, name: info.name, singer: info.singer, time: info.time };
  const trackerUrl = await resolvePlayUrlTracker(hash, userId, token, cookie);
  if (trackerUrl) return { ok: true, url: trackerUrl, name: info ? info.name : '未知', singer: info ? info.singer : '未知', time: info ? info.time : 0 };
  return { ok: false, url: '', name: info ? info.name : '未知', singer: info ? info.singer : '未知', time: info ? info.time : 0 };
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

// ==================== QR 扫码登录 ====================
// 酷狗扫码登录 API (v0.21.3 通过抓包 kguser.v2.min.js 找到):
//   生成二维码: GET https://login-user.kugou.com/v2/qrcode
//     参数: appid, clientver, clienttime, mid, uuid, dfid, type=1, plat, qrcode_txt, srcappid=2919, signature
//     返回: { status:1, data:{ qrcode:"xxx", qrcode_img:"data:image/png;base64,..." } }
//   轮询状态: GET https://login-user.kugou.com/v2/get_userinfo_qrcode
//     参数: appid, clientver, clienttime, mid, uuid, dfid, plat, qrcode, srcappid=2919, signature
//     返回: { status:1, data:{ status:1/2/4, userid?, token?, nickname? } }
//       1=等待扫码, 2=已扫码等待确认, 4=已确认登录
//   签名: MD5(APPKEY + sorted(key=val, no separator) + APPKEY), APPKEY="NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt"
const KG_APPKEY = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KG_APPID = 1005;
const KG_CLIENTVER = 12027;
const KG_LOGIN_BASE = 'https://login-user.kugou.com/';
const KG_QRCODE_H5 = 'https://h5.kugou.com/apps/loginQRCode/html/index.html';

const QR_SESSIONS = new Map(); // token -> { qrcode, img, mid, createdAt }
const QR_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of QR_SESSIONS) {
    if (now - v.createdAt > QR_TTL_MS) QR_SESSIONS.delete(k);
  }
}, 60 * 1000).unref?.();

function genToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 酷狗签名算法 (来自 kGRequest 库)
// APPKEY + sorted(key=val) 拼接 (无分隔符) + APPKEY → MD5
function kugouSign(params) {
  const keys = Object.keys(params).sort();
  const parts = keys.map(k => `${k}=${params[k]}`);
  const signStr = KG_APPKEY + parts.join('') + KG_APPKEY;
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
}

// 生成 mid (酷狗用 kg_mid cookie, 32位 MD5)
function genMid() {
  return crypto.createHash('md5').update(String(Date.now()) + Math.random()).digest('hex');
}

// 酷狗扫码登录: 启动 (获取二维码)
async function qrLoginStart() {
  try {
    const mid = genMid();
    const clienttime = Math.floor(Date.now() / 1000);
    const qrcodeH5 = `${KG_QRCODE_H5}?appid=${KG_APPID}&`;
    const params = {
      appid: KG_APPID,
      clientver: KG_CLIENTVER,
      clienttime,
      mid,
      uuid: mid,
      dfid: '-',
      type: 1,
      plat: 1,
      qrcode_txt: qrcodeH5,
      srcappid: 2919,
    };
    params.signature = kugouSign(params);
    const url = `${KG_LOGIN_BASE}v2/qrcode?${new URLSearchParams(params).toString()}`;
    const body = await httpGet(url);
    if (!body) return { ok: false, message: '酷狗服务器繁忙或超时, 请重试或用手动输入方式' };
    if (body.startsWith('<') || body.startsWith('<!DOCTYPE')) {
      return { ok: false, message: '酷狗扫码登录暂不可用, 请用下方手动输入方式' };
    }
    let root;
    try { root = JSON.parse(body); } catch { return { ok: false, message: '酷狗扫码登录暂不可用, 请用下方手动输入方式' }; }
    if (root.status !== 1 || !root.data || !root.data.qrcode) {
      return { ok: false, message: `获取二维码失败: ${root.data || root.error_code || '未知错误'}` };
    }
    const { qrcode, qrcode_img } = root.data;
    const token = genToken();
    QR_SESSIONS.set(token, { qrcode, img: qrcode_img || '', mid, createdAt: Date.now() });
    console.log(`[Kugou QR] 二维码生成成功: qrcode=${qrcode.slice(0, 16)}...`);
    return {
      ok: true,
      token,
      qrUrl: `/qr/kugou?token=${token}`,
      qrContent: qrcode,
    };
  } catch (err) {
    console.error('[Kugou QR] qrLoginStart 异常:', err.message);
    return { ok: false, message: `酷狗扫码登录暂不可用, 请用下方手动输入方式` };
  }
}

// 获取二维码图片 (返回 base64 data URL)
function getQrImage(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return null;
  }
  return sess.img || sess.qrcode;
}

// 酷狗扫码登录: 轮询状态
async function qrLoginCheck(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return { status: 'expired', message: '会话不存在或已过期' };
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return { status: 'expired', message: '二维码已过期, 请重新生成' };
  }
  try {
    const clienttime = Math.floor(Date.now() / 1000);
    const params = {
      appid: KG_APPID,
      clientver: KG_CLIENTVER,
      clienttime,
      mid: sess.mid,
      uuid: sess.mid,
      dfid: '-',
      plat: 1,
      qrcode: sess.qrcode,
      srcappid: 2919,
    };
    params.signature = kugouSign(params);
    const url = `${KG_LOGIN_BASE}v2/get_userinfo_qrcode?${new URLSearchParams(params).toString()}`;
    const body = await httpGet(url);
    if (!body) return { status: 'waiting', message: '等待扫码' };
    let root;
    try { root = JSON.parse(body); } catch { return { status: 'waiting', message: '等待扫码' }; }
    if (root.status !== 1 || !root.data) return { status: 'waiting', message: '等待扫码' };
    const st = root.data.status;
    // 1=等待扫码, 2=已扫码等待确认, 4=已确认登录
    if (st === 1) return { status: 'waiting', message: '等待扫码' };
    if (st === 2) return { status: 'scanned', message: '已扫码, 请在手机上确认登录' };
    if (st === 4) {
      const userid = root.data.userid || root.data.uid || '';
      const tokenVal = root.data.token || '';
      const nickname = root.data.nickname || '';
      if (!userid || !tokenVal) return { status: 'error', message: '登录成功但未返回有效凭证' };
      QR_SESSIONS.delete(token);
      return {
        status: 'ok',
        userId: userid,
        token: tokenVal,
        nickname,
        cookie: `KugooID=${userid}; KugooToken=${tokenVal}`,
      };
    }
    return { status: 'waiting', message: '等待扫码' };
  } catch (err) {
    console.error('[Kugou QR] qrLoginCheck 异常:', err.message);
    return { status: 'error', message: err.message };
  }
}

module.exports = {
  platform: 'kugou',
  search,
  songUrl,
  lyric,
  songFull,
  fetchSongInfo,
  searchPlaylist,
  playlistDetail,
  qrLoginStart,
  qrLoginCheck,
  getQrImage,
};
