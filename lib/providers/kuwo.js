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
// v0.21.3: 酷我网页版经抓包确认无扫码登录 API
//   - 929c55c.js 显示网页版只支持手机短信登录和账号密码登录
//   - 所有 /api/www/user/scan/qr 系列接口都返回 "The request is illegal!"
//   - 因此酷我扫码登录直接返回不可用, 引导用户用账号密码登录或手动输入 cookie
//
// 替代方案 1: 账号密码登录 (POST wapi.kuwo.cn/api/www/login/loginByKw)
//   - 需要用户输入酷我账号密码, 用户体验不如扫码
//   - 暂未实现, 因为需要前端表单和后端新端点
//
// 替代方案 2: 手动输入 cookie (用户 F12 复制 document.cookie)
//   - 已支持, 通过 manual_bind 端点
//   - 在 bind.html 里有详细教程

// 酷我扫码登录: 启动 (直接返回不可用, 引导用户用账号密码登录或手动输入)
async function qrLoginStart() {
  return {
    ok: false,
    message: '酷我网页版暂不支持扫码登录, 请用账号密码登录或手动输入 Cookie',
  };
}

// 获取二维码图片 (酷我不支持, 永远返回 null)
function getQrImage(token) {
  return null;
}

// 酷我扫码登录: 轮询状态 (永远返回不支持)
async function qrLoginCheck(token) {
  return {
    status: 'expired',
    message: '酷我网页版暂不支持扫码登录, 请用账号密码登录或手动输入 Cookie',
  };
}

// ==================== 酷我手机短信验证码登录 ====================
// 流程 (从 929c55c.js 抓包确认):
//   1. GET  /api/common/captcha/getcode  → { img, token }  (图片验证码)
//   2. POST /api/sms/mobileLoginCode     → 发送短信 (需 verifyCode + verifyCodeToken + mobile)
//      body: { verifyCode, verifyCodeToken, mobile, userIp }
//      返回: { tm } (登录时需要)
//   3. POST /api/www/login/loginByMobile → 验证码登录 (需 mobile + smsCode + tm)
//      body: { mobile, verifyCode, smsCode, tm }
//      返回: { cookies } (含 kw_user_id, kw_token 等)

// 酷我会话存储 (csrf + 验证码 token + tm)
const KW_SESSIONS = new Map(); // sessionId -> { csrf, captchaToken, tm, mobile, createdAt }
const KW_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of KW_SESSIONS) {
    if (now - v.createdAt > KW_TTL_MS) KW_SESSIONS.delete(k);
  }
}, 60 * 1000).unref?.();

function genSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 访问首页拿 csrf cookie
async function kuwoGetCsrf() {
  const resp = await fetch('https://www.kuwo.cn/', {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
  });
  const setCookie = resp.headers.get('set-cookie') || '';
  const m = setCookie.match(/Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=([^;]+)/);
  return m ? m[1] : '';
}

// 步骤1: 获取图片验证码
// 返回: { ok, sessionId, img } — img 是 data:image/jpeg;base64,... 可直接 <img src=...>
async function getCaptcha() {
  try {
    const csrf = await kuwoGetCsrf();
    const url = 'https://wapi.kuwo.cn/api/common/captcha/getcode';
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.kuwo.cn/',
        'csrf': csrf,
        'Cookie': `Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=${csrf}`,
      },
    });
    const text = await resp.text();
    const root = JSON.parse(text);
    if (root.code !== 200 || !root.data) {
      return { ok: false, message: '获取验证码失败' };
    }
    const sessionId = genSessionId();
    KW_SESSIONS.set(sessionId, {
      csrf,
      captchaToken: root.data.token || '',
      createdAt: Date.now(),
    });
    return { ok: true, sessionId, img: root.data.img };
  } catch (err) {
    return { ok: false, message: `获取验证码异常: ${err.message}` };
  }
}

// 步骤2: 发送短信验证码
// 参数: sessionId, mobile, verifyCode (用户识别的图片验证码)
// 返回: { ok, message }
async function sendSms(sessionId, mobile, verifyCode) {
  const sess = KW_SESSIONS.get(sessionId);
  if (!sess) return { ok: false, message: '会话已过期, 请刷新验证码' };
  try {
    const url = 'https://wapi.kuwo.cn/api/sms/mobileLoginCode';
    const body = {
      verifyCode: String(verifyCode || ''),
      verifyCodeToken: sess.captchaToken,
      mobile: String(mobile || ''),
      userIp: '',
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.kuwo.cn/',
        'Content-Type': 'application/json',
        'csrf': sess.csrf,
        'Cookie': `Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=${sess.csrf}`,
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const root = JSON.parse(text);
    if (root.code !== 200) {
      return { ok: false, message: root.msg || '发送验证码失败' };
    }
    // 保存 tm (登录时需要)
    sess.tm = (root.data && root.data.tm) || '';
    sess.mobile = String(mobile);
    sess.verifyCode = String(verifyCode);
    KW_SESSIONS.set(sessionId, sess);
    return { ok: true, message: '验证码已发送' };
  } catch (err) {
    return { ok: false, message: `发送验证码异常: ${err.message}` };
  }
}

// 步骤3: 短信验证码登录
// 参数: sessionId, smsCode (用户收到的短信验证码)
// 返回: { ok, userId?, token?, nickname?, cookie?, message? }
async function loginByMobile(sessionId, smsCode) {
  const sess = KW_SESSIONS.get(sessionId);
  if (!sess) return { ok: false, message: '会话已过期, 请重新开始' };
  try {
    const url = 'https://wapi.kuwo.cn/api/www/login/loginByMobile';
    const body = {
      mobile: sess.mobile,
      verifyCode: sess.verifyCode,
      smsCode: String(smsCode || ''),
      tm: sess.tm || '',
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Referer': 'https://www.kuwo.cn/',
        'Content-Type': 'application/json',
        'csrf': sess.csrf,
        'Cookie': `Hm_Iuvt_cdb524f42f23cer9b268564v7y735ewrq2324=${sess.csrf}`,
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    const root = JSON.parse(text);
    if (root.code !== 200) {
      return { ok: false, message: root.msg || '登录失败' };
    }
    const cookies = root.data && root.data.cookies;
    if (!cookies) return { ok: false, message: '登录成功但未返回 cookie' };
    const cookieParts = [];
    let userId = '';
    let token = '';
    let nickname = '';
    for (const k in cookies) {
      cookieParts.push(`${k}=${cookies[k]}`);
      if (k === 'kw_user_id' || k === 'userid') userId = cookies[k];
      if (k === 'kw_token' || k === 'token') token = cookies[k];
      if (k === 'nickname' || k === 'userName') nickname = cookies[k];
    }
    KW_SESSIONS.delete(sessionId);
    return {
      ok: true,
      userId,
      token,
      nickname: nickname || `酷我用户${userId}`,
      cookie: cookieParts.join('; '),
    };
  } catch (err) {
    return { ok: false, message: `登录异常: ${err.message}` };
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
  getCaptcha,
  sendSms,
  loginByMobile,
};
