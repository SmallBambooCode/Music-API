'use strict';

// 酷我音乐 API — 移植自 ZMusicGUI/KuwoMusicApi.kt
// 实测可用接口:
//   - 搜索: http://search.kuwo.cn/r.s?all={keyword} (返回单引号 JSON, SONGNAME 含 HTML 实体)
//   - 播放URL: http://antiserver.kuwo.cn/anti.s?...&rid=music_{mid} (纯文本 URL)
//   - 歌词: https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId={mid} (lrclist, 需转 LRC)
//
// v2.4.0: 支持完整 cookie 透传 (从浏览器 F12 document.cookie 复制)
//   - 如果传入 cookie, 所有请求会带上 Cookie 头
//   - 同时仍支持旧的 kw_token+kw_user_id URL 参数方式 (向后兼容)
//   - 也会尝试从 cookie 中提取 kw_token/kw_user_id (用于老接口)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER_SEARCH = 'http://www.kuwo.cn/';
const REFERER_WWW = 'https://www.kuwo.cn/';

async function httpGet(url, referer = REFERER_WWW, cookie = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

// 从 cookie 字符串中提取 kw_token/kw_user_id
function extractKuwoAuth(cookie) {
  if (!cookie) return { token: '', userId: '' };
  const tkMatch = cookie.match(/(?:^|;\s*)kw_token=([^;]+)/i);
  const uidMatch = cookie.match(/(?:^|;\s*)kw_user_id=([^;]+)/i);
  return {
    token: tkMatch ? tkMatch[1] : '',
    userId: uidMatch ? uidMatch[1] : '',
  };
}

// 搜索: 返回 [{id, name, singer}]
// 增加重试机制
async function search(keyword, limit = 30) {
  const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${limit}&rformat=json&encoding=utf8`;
  for (let i = 0; i < 3; i++) {
    const body = await httpGet(url, REFERER_SEARCH);
    if (body) {
      try {
        const json = body.replace(/'/g, '"');
        const root = JSON.parse(json);
        const abslist = Array.isArray(root.abslist) ? root.abslist : [];
        return abslist.map(s => ({
          id: s.DC_TARGETID || '',
          name: decodeHtmlEntities(s.SONGNAME || '未知'),
          singer: decodeHtmlEntities(s.ARTIST || '未知').replace(/\\u0026/g, '&'),
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

// 获取播放 URL (antiserver 返回纯文本 URL)
async function songUrl(mid, userId = '', token = '', cookie = '') {
  // 优先用显式传入的 token+userId; 没有就从 cookie 提取
  let tk = token;
  let uid = userId;
  if ((!tk || !uid) && cookie) {
    const extracted = extractKuwoAuth(cookie);
    if (!tk) tk = extracted.token;
    if (!uid) uid = extracted.userId;
  }
  // 构造完整 cookie (优先用透传的完整 cookie, 否则用提取的 token+userId 拼)
  let finalCookie = cookie;
  if (!finalCookie && tk && uid) {
    finalCookie = `kw_token=${tk}; kw_user_id=${uid}`;
  }
  const url = `http://antiserver.kuwo.cn/anti.s?useless=0&type=convert_url&format=mp3&response=url&rid=music_${mid}`;
  const body = await httpGet(url, '', finalCookie);
  if (!body) return { ok: false, url: '', lyric: '', time: 0 };
  const trimmed = body.trim();
  const playUrl = trimmed.split(/\r?\n/).find(l => l.startsWith('http')) || '';
  return { ok: Boolean(playUrl), url: playUrl, time: 0 };
}

// 获取歌词: openapi lrclist → LRC 格式
async function lyric(mid, userId = '', token = '', cookie = '') {
  // 优先用显式传入的 token+userId; 没有就从 cookie 提取
  let tk = token;
  let uid = userId;
  if ((!tk || !uid) && cookie) {
    const extracted = extractKuwoAuth(cookie);
    if (!tk) tk = extracted.token;
    if (!uid) uid = extracted.userId;
  }
  let finalCookie = cookie;
  if (!finalCookie && tk && uid) {
    finalCookie = `kw_token=${tk}; kw_user_id=${uid}`;
  }
  const url = `https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${mid}&httpsStatus=1`;
  const body = await httpGet(url, REFERER_WWW, finalCookie);
  if (!body) return '';
  try {
    const root = JSON.parse(body);
    if (root.code !== 200) return '';
    const lrclist = root.data && Array.isArray(root.data.lrclist) ? root.data.lrclist : [];
    const lines = [];
    let maxTime = 0;
    for (const item of lrclist) {
      const text = item.lineLyric || '';
      const time = parseFloat(item.time || '0');
      if (time > maxTime) maxTime = time;
      const total = Math.floor(time);
      const min = Math.floor(total / 60);
      const sec = total % 60;
      const cs = Math.floor((time - total) * 100);
      lines.push(`[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}]${text}`);
    }
    return { lyric: lines.join('\n'), time: Math.floor(maxTime) + 10 };
  } catch {
    return { lyric: '', time: 0 };
  }
}

// 一次性返回完整单曲信息 (服务端并发)
async function songFull(mid, userId = '', token = '', cookie = '') {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(mid, userId, token, cookie),
    lyric(mid, userId, token, cookie),
  ]);
  const lyricObj = lyricResult && typeof lyricResult === 'object' ? lyricResult : { lyric: '', time: 0 };
  return {
    id: mid,
    name: '未知', // 酷我 musicInfo 需签名, 无法通过 mid 反查
    singer: '未知',
    url: urlResult.url,
    lyric: lyricObj.lyric,
    time: lyricObj.time,
    ok: urlResult.ok,
  };
}

// ==================== QR 扫码登录 ====================
// 酷我扫码登录 API:
//   获取二维码: https://www.kuwo.cn/api/www/user/scan/qr (需要主页 cookie)
//   轮询状态:   https://www.kuwo.cn/api/www/user/scan/qr/{token}
// 返回 status: 1=等待扫码, 2=已扫码, 3=已确认
const QR_SESSIONS = new Map(); // token -> { qrToken, qrContent, cookie, createdAt }
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

// 获取酷我主页 cookie (kg_mid 等, 用于扫码 API)
async function getKuwoCookie() {
  try {
    const resp = await fetch('https://www.kuwo.cn/', {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    const setCookie = resp.headers.get('set-cookie') || '';
    const cookies = setCookie.split(/,(?=\s*\w+=)/).map(c => c.split(';')[0]).filter(Boolean);
    return cookies.join('; ');
  } catch {
    return '';
  }
}

// 酷我扫码登录: 启动 (获取二维码)
async function qrLoginStart() {
  try {
    const cookie = await getKuwoCookie();
    const url = 'https://www.kuwo.cn/api/www/user/scan/qr?httpsStatus=1';
    const body = await httpGet(url, REFERER_WWW, cookie);
    if (!body) return { ok: false, message: '获取二维码失败: 网络错误' };
    // 检查是否返回 HTML (API 不可用)
    if (body.startsWith('<') || body.startsWith('<!DOCTYPE')) {
      console.log('[Kuwo QR] 返回 HTML 而非 JSON, API 可能已变更');
      return { ok: false, message: '酷我扫码登录暂不可用, 请用下方手动输入方式' };
    }
    let root;
    try { root = JSON.parse(body); } catch { return { ok: false, message: '酷我扫码登录暂不可用, 请用下方手动输入方式' }; }
    console.log('[Kuwo QR] scan/qr 响应:', JSON.stringify(root).slice(0, 300));
    if (root.code !== 200 || !root.data) {
      return { ok: false, message: `获取二维码失败: ${root.message || root.msg || '未知错误'}` };
    }
    const qrContent = root.data.url || '';
    const qrToken = root.data.token || '';
    if (!qrContent || !qrToken) return { ok: false, message: '获取二维码失败: 未返回二维码内容' };
    const token = genToken();
    QR_SESSIONS.set(token, { qrToken, qrContent, cookie, createdAt: Date.now() });
    return {
      ok: true,
      token,
      qrUrl: `/qr/kuwo?token=${token}`,
      qrContent,
    };
  } catch (err) {
    console.error('[Kuwo QR] qrLoginStart 异常:', err.message);
    return { ok: false, message: `酷我扫码登录暂不可用, 请用下方手动输入方式` };
  }
}

// 获取二维码图片 (返回二维码内容, bind.html 用 JS 生成)
function getQrImage(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return null;
  }
  return sess.qrContent;
}

// 酷我扫码登录: 轮询状态
async function qrLoginCheck(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return { status: 'expired', message: '会话不存在或已过期' };
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return { status: 'expired', message: '会话已过期' };
  }
  try {
    const url = `https://www.kuwo.cn/api/www/user/scan/qr/${sess.qrToken}?httpsStatus=1`;
    const body = await httpGet(url, REFERER_WWW, sess.cookie);
    if (!body) return { status: 'waiting', message: '等待扫码' };
    let root;
    try { root = JSON.parse(body); } catch { return { status: 'waiting', message: '等待扫码' }; }
    console.log('[Kuwo QR] scan/qr check 响应:', JSON.stringify(root).slice(0, 300));
    if (root.code !== 200 || !root.data) return { status: 'waiting', message: '等待扫码' };
    const st = root.data.status;
    if (st === 1) return { status: 'waiting', message: '等待扫码' };
    if (st === 2) return { status: 'scanned', message: '已扫码, 请在手机上确认' };
    if (st === 3) {
      const userId = root.data.userid || root.data.userId || '';
      const tokenVal = root.data.token || '';
      const nickname = root.data.nickname || '';
      if (!userId || !tokenVal) return { status: 'error', message: '登录成功但未返回有效凭证' };
      QR_SESSIONS.delete(token);
      return {
        status: 'ok',
        userId,
        token: tokenVal,
        nickname,
        cookie: `kw_user_id=${userId}; kw_token=${tokenVal}`,
      };
    }
    return { status: 'waiting', message: '等待扫码' };
  } catch (err) {
    console.error('[Kuwo QR] qrLoginCheck 异常:', err.message);
    return { status: 'error', message: err.message };
  }
}

module.exports = {
  platform: 'kuwo',
  search,
  songUrl,
  lyric,
  songFull,
  qrLoginStart,
  qrLoginCheck,
  getQrImage,
};
