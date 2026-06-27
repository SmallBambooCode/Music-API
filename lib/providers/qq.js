'use strict';

// QQ 音乐 provider v0.20.0
//
// 公开接口:
//   - 搜索:    https://c.y.qq.com/soso/fcgi-bin/client_search_cp
//   - 播放URL: https://u.y.qq.com/cgi-bin/musicu.fcg (vkey 接口)
//   - 歌词:    https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg
//
// VIP 登录 (扫码):
//   QQ OAuth 扫码登录 (xui.ptlogin2 + ssl.ptlogin2)
//   流程: 获取 pt_login_sig → 获取二维码 PNG + qrsig → 轮询 ptqrlogin → 获取 uin + p_skey
//   登录后 vkey 接口带 Cookie: uin=o0XXX; p_skey=YYY, 即可获取 VIP 歌曲 purl
//
// 已完全移除解灰 (kuwo/migu/kugou/bilibili/pyncmd 等):
//   - 之前解灰返回"暂时无法播放" TTS 语音
//   - 改为登录 QQ 账号后直接播放 VIP 歌曲 (官方授权, 无防盗链问题)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER_SEARCH = 'https://y.qq.com/';
const REFERER_LYRIC = 'https://y.qq.com/pc/client/download.html';
const REFERER_QR_XLOGIN = 'https://xui.ptlogin2.qq.com/';
const DL_HOST = 'https://dl.stream.qqmusic.qq.com/';

// QQ OAuth 应用参数 (QQ 音乐网页版官方参数)
const QQ_OAUTH = {
  appid: '716027609',
  daid: '383',
  style: '33',
  loginText: '授权并登录',
  sUrl: 'https://graph.qq.com/oauth2.0/login_jump',
  pt3rdAid: '100497308',
  ptFeedbackLink: 'https://support.qq.com/products/77942?customInfo=.appid100497308',
};

// ==================== QR 扫码登录会话状态 (内存, TTL 5 分钟) ====================
const QR_SESSIONS = new Map(); // token -> { ptLoginSig, qrsig, uin?, pSkey?, createdAt }
const QR_TTL_MS = 5 * 60 * 1000;

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of QR_SESSIONS) {
    if (now - v.createdAt > QR_TTL_MS) QR_SESSIONS.delete(k);
  }
}, 60 * 1000).unref?.();

function genToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// 从 Set-Cookie 头提取指定 key 的值
function pickCookie(setCookieHeader, key) {
  if (!setCookieHeader) return '';
  // set-cookie 可能是单个字符串或数组 (Node fetch 行为)
  const lines = Array.isArray(setCookieHeader) ? setCookieHeader : String(setCookieHeader).split(/,(?=\s*\w+=)/);
  for (const line of lines) {
    const m = new RegExp(`\\b${key}=([^;]+)`).exec(line);
    if (m) return m[1];
  }
  return '';
}

// QQ OAuth hash33 算法 (ptqrtoken 计算)
function hash33(s) {
  let t = 0;
  for (let i = 0; i < s.length; i++) {
    t += (t << 5) + s.charCodeAt(i);
  }
  return 2147483647 & t;
}

// ==================== QR 扫码登录: 启动 (获取 pt_login_sig + qrsig) ====================
// 返回: { token, qrUrl } — qrUrl 指向服务端 /qr/qq?token=xxx 返回 PNG 图片
async function qrLoginStart() {
  // 1. xlogin: 获取 pt_login_sig cookie
  const xloginUrl = `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=${QQ_OAUTH.appid}&daid=${QQ_OAUTH.daid}&style=${QQ_OAUTH.style}&login_text=${encodeURIComponent(QQ_OAUTH.loginText)}&hide_title_bar=1&hide_border=1&target=self&s_url=${encodeURIComponent(QQ_OAUTH.sUrl)}&pt_3rd_aid=${QQ_OAUTH.pt3rdAid}&pt_feedback_link=${encodeURIComponent(QQ_OAUTH.ptFeedbackLink)}`;
  const xloginResp = await fetch(xloginUrl, { headers: { 'User-Agent': UA } });
  const xloginSetCookie = xloginResp.headers.get('set-cookie') || '';
  const ptLoginSig = pickCookie(xloginSetCookie, 'pt_login_sig');
  if (!ptLoginSig) return { ok: false, message: '获取 pt_login_sig 失败' };

  // 2. ptqrshow: 获取二维码图片 (PNG) + qrsig cookie
  const ptqrshowUrl = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QQ_OAUTH.appid}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=${QQ_OAUTH.daid}&pt_3rd_aid=${QQ_OAUTH.pt3rdAid}`;
  const qrResp = await fetch(ptqrshowUrl, {
    headers: { 'User-Agent': UA, 'Cookie': `pt_login_sig=${ptLoginSig}`, 'Referer': REFERER_QR_XLOGIN },
  });
  const qrSetCookie = qrResp.headers.get('set-cookie') || '';
  const qrsig = pickCookie(qrSetCookie, 'qrsig');
  if (!qrsig) return { ok: false, message: '获取 qrsig 失败' };

  // 缓存图片 buffer (供 /qr/qq?token=xxx 端点返回)
  const imageBuffer = Buffer.from(await qrResp.arrayBuffer());

  const token = genToken();
  QR_SESSIONS.set(token, { ptLoginSig, qrsig, imageBuffer, createdAt: Date.now() });

  return { ok: true, token, qrUrl: `/qr/qq?token=${token}` };
}

// 获取缓存的二维码图片 (供 /qr/qq?token=xxx 端点)
function getQrImage(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return null;
  }
  return sess.imageBuffer;
}

// ==================== QR 扫码登录: 轮询状态 ====================
// 返回: { status: "waiting"|"scanned"|"ok"|"expired", uin?, pSkey?, nickname? }
async function qrLoginCheck(token) {
  const sess = QR_SESSIONS.get(token);
  if (!sess) return { status: 'expired', message: '会话不存在或已过期' };
  if (Date.now() - sess.createdAt > QR_TTL_MS) {
    QR_SESSIONS.delete(token);
    return { status: 'expired', message: '二维码已过期' };
  }
  if (sess.uin && sess.pSkey) {
    return { status: 'ok', uin: sess.uin, pSkey: sess.pSkey, nickname: sess.nickname };
  }

  // ptqrlogin: 查询登录状态
  const ptqrtoken = hash33(sess.qrsig);
  const ptqrloginUrl = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(QQ_OAUTH.sUrl)}&ptqrtoken=${ptqrtoken}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=20102616&js_type=1&login_sig=${encodeURIComponent(sess.ptLoginSig)}&pt_uistyle=40&aid=${QQ_OAUTH.appid}&daid=${QQ_OAUTH.daid}&pt_3rd_aid=${QQ_OAUTH.pt3rdAid}`;
  const checkResp = await fetch(ptqrloginUrl, {
    headers: { 'User-Agent': UA, 'Referer': REFERER_QR_XLOGIN, 'Cookie': `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}` },
  });
  const text = await checkResp.text();

  // 响应: ptuiCB('code','status','redirectUrl','flag','message','nickname');
  const m = text.match(/ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)','([^']*)'\)/);
  if (!m) return { status: 'unknown', message: text.slice(0, 200) };

  const code = m[1];
  const redirectUrl = m[3];
  const message = m[5];
  const nickname = m[6] ? decodeURIComponent(m[6]) : '';

  if (code === '66') return { status: 'waiting', message: '二维码未失效, 等待扫码' };
  if (code === '67') return { status: 'scanned', message: '已扫码, 等待手机确认' };
  if (code !== '0') return { status: 'expired', message: message || '登录失败' };

  // code === '0': 登录成功, 跟随重定向获取 uin + p_skey
  if (redirectUrl) {
    const redirResp = await fetch(redirectUrl, {
      headers: { 'User-Agent': UA, 'Referer': REFERER_QR_XLOGIN, 'Cookie': `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}` },
      redirect: 'manual',
    });
    const redirSetCookie = redirResp.headers.get('set-cookie') || '';
    const pSkey = pickCookie(redirSetCookie, 'p_skey');
    const uinRaw = pickCookie(redirSetCookie, 'uin');
    const uin = uinRaw.replace(/^o0*/, '').replace(/^o/, '');
    if (uin && pSkey) {
      sess.uin = uin;
      sess.pSkey = pSkey;
      sess.nickname = nickname;
      QR_SESSIONS.set(token, sess);
      return { status: 'ok', uin, pSkey, nickname };
    }
  }
  return { status: 'expired', message: '登录成功但未获取到 cookie' };
}

// ==================== HTTP 工具 ====================
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
// 支持登录态: uin (QQ 号) + qqmusic_key (p_skey)
async function musicuRequest(payload, retries = 3, uin = '', qqmusicKey = '') {
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(payload))}`;
  const cookieParts = [];
  if (uin) cookieParts.push(`uin=o0${uin}`);
  if (qqmusicKey) cookieParts.push(`p_skey=${qqmusicKey}`);
  const headers = { 'User-Agent': UA, Referer: REFERER_SEARCH, Accept: 'application/json, text/plain, */*' };
  if (cookieParts.length) headers['Cookie'] = cookieParts.join('; ');

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) { await new Promise(r => setTimeout(r, 600 * (i + 1))); continue; }
      const body = await resp.text();
      try {
        const root = JSON.parse(body);
        const code = root.req_0 && root.req_0.code;
        if (code === 0) return root.req_0.data;
        if (code === 2001 && i < retries) {
          await new Promise(r => setTimeout(r, 1200 * (i + 1)));
          continue;
        }
      } catch {}
      return null;
    } catch {
      if (i < retries) await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  return null;
}

// ==================== 搜索 ====================
// 返回 [{id(songmid), name, singer, time}]
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

// ==================== 通过 vkey 接口获取播放 URL ====================
// uin + qqmusicKey: 登录后可获取 VIP 歌曲 purl
async function fetchVkey(songmid, uin = '', qqmusicKey = '') {
  const data = await musicuRequest({
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid: '10000',
        songmid: [songmid],
        songtype: [0],
        uin: uin || '0',
        loginflag: uin ? 1 : 0,
        platform: '20',
      },
    },
  }, 3, uin, qqmusicKey);
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

// 播放 URL: 直接走 vkey, 登录后可获取 VIP 歌曲
// 已彻底移除解灰 (跨平台匹配已废弃, 改为 QQ 账号登录)
async function songUrl(songmid, uin = '', qqmusicKey = '') {
  const [url, info] = await Promise.all([
    fetchVkey(songmid, uin, qqmusicKey),
    fetchSongInfo(songmid),
  ]);
  return {
    ok: Boolean(url),
    url: url || '',
    name: info ? info.name : '未知',
    singer: info ? info.singer : '未知',
    time: info ? info.time : 0,
    needsLogin: !url && !uin, // 未登录且无 url → 提示需登录
  };
}

// 歌词 (base64 LRC)
async function lyric(songmid) {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&g_tk=5381&format=json&inCharset=utf8&outCharset=utf-8`;
  const body = await httpGet(url, REFERER_LYRIC);
  if (!body) return '';
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

// 完整单曲 (服务端并发)
async function songFull(songmid, uin = '', qqmusicKey = '') {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(songmid, uin, qqmusicKey),
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
    needsLogin: urlResult.needsLogin,
  };
}

// unblockEnabled 已废弃 (移除所有解灰, 保留接口兼容 health)
function unblockEnabled() { return false; }
function unblockSources() { return []; }

module.exports = {
  platform: 'qq',
  search,
  songUrl,
  lyric,
  songFull,
  unblockEnabled,
  unblockSources,
  qrLoginStart,
  qrLoginCheck,
  getQrImage,
};
