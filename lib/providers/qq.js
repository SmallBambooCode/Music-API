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

const https = require('node:https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER_SEARCH = 'https://y.qq.com/';
const REFERER_LYRIC = 'https://y.qq.com/pc/client/download.html';
const REFERER_QR_XLOGIN = 'https://xui.ptlogin2.qq.com/';
const DL_HOST = 'https://dl.stream.qqmusic.qq.com/';

// QQ OAuth 应用参数 (QQ 音乐网页版官方参数)
// 注意: 不使用 pt_3rd_aid (那是 QQ 互联第三方登录, 会导致二维码无法正常工作)
const QQ_OAUTH = {
  appid: '716027609',
  daid: '383',
  sUrl: 'https://y.qq.com/',
};

// 用 https 模块发送请求 (不自动跟随重定向, 可读取 set-cookie 头)
// Node fetch 的 redirect:'manual' 返回 opaqueredirect, 无法读取 set-cookie
// isBuffer=true 时返回 Buffer (用于二维码图片等二进制数据)
function httpsGet(url, cookie = '', isBuffer = false) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Referer': REFERER_QR_XLOGIN,
        'Cookie': cookie,
        'Accept': '*/*',
      },
    };
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on('data', (chunk) => chunks.push(chunk));
      resp.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: resp.statusCode,
          headers: resp.headers,
          body: isBuffer ? buf : buf.toString('utf8'),
          rawBuffer: buf,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

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
// 返回: { ok, token?, qrUrl?, message? }
async function qrLoginStart() {
  try {
    // 1. xlogin: 获取 pt_login_sig cookie (用 httpsGet 不跟随重定向)
    const xloginUrl = `https://xui.ptlogin2.qq.com/cgi-bin/xlogin?appid=${QQ_OAUTH.appid}&daid=${QQ_OAUTH.daid}&style=33&login_text=%E6%8E%88%E6%9D%83%E5%B9%B6%E7%99%BB%E5%BD%95&hide_title_bar=1&hide_border=1&target=self&s_url=${encodeURIComponent(QQ_OAUTH.sUrl)}`;
    const xloginResp = await httpsGet(xloginUrl);
    const xloginSetCookie = xloginResp.headers['set-cookie'] || '';
    const ptLoginSig = pickCookie(xloginSetCookie, 'pt_login_sig');
    if (!ptLoginSig) {
      console.error('[QQ QR] xlogin 未返回 pt_login_sig, set-cookie:', String(xloginSetCookie).slice(0, 200));
      return { ok: false, message: '获取 pt_login_sig 失败' };
    }

    // 2. ptqrshow: 获取二维码图片 (PNG) + qrsig cookie
    const ptqrshowUrl = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${QQ_OAUTH.appid}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}&daid=${QQ_OAUTH.daid}`;
    const qrResp = await httpsGet(ptqrshowUrl, `pt_login_sig=${ptLoginSig}`, true);
    const qrSetCookie = qrResp.headers['set-cookie'] || '';
    const qrsig = pickCookie(qrSetCookie, 'qrsig');
    if (!qrsig) {
      console.error('[QQ QR] ptqrshow 未返回 qrsig, set-cookie:', String(qrSetCookie).slice(0, 200));
      return { ok: false, message: '获取 qrsig 失败' };
    }

    // 缓存图片 buffer (供 /qr/qq?token=xxx 端点返回)
    const imageBuffer = qrResp.rawBuffer;

    const token = genToken();
    QR_SESSIONS.set(token, { ptLoginSig, qrsig, imageBuffer, createdAt: Date.now() });

    console.log(`[QQ QR] 二维码生成成功: token=${token.slice(0, 8)}... qrsig=${qrsig.slice(0, 10)}...`);
    return { ok: true, token, qrUrl: `/qr/qq?token=${token}` };
  } catch (err) {
    console.error('[QQ QR] qrLoginStart 异常:', err.message);
    return { ok: false, message: err.message };
  }
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
// 返回: { status: "waiting"|"scanned"|"ok"|"expired", uin?, pSkey?, nickname?, debug? }
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

  try {
    // ptqrlogin: 查询登录状态 (用 httpsGet, 不跟随重定向)
    const ptqrtoken = hash33(sess.qrsig);
    const ptqrloginUrl = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(QQ_OAUTH.sUrl)}&ptqrtoken=${ptqrtoken}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=20102616&js_type=1&login_sig=${encodeURIComponent(sess.ptLoginSig)}&pt_uistyle=40&aid=${QQ_OAUTH.appid}&daid=${QQ_OAUTH.daid}`;
    const checkResp = await httpsGet(ptqrloginUrl, `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}`);
    const text = checkResp.body || '';

    // 响应格式: ptuiCB('code','status','redirectUrl','flag','message','nickname');
    // 注意: nickname 可能包含中文, 用 [^']* 匹配
    const m = text.match(/ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)','([^']*)'\)/);
    if (!m) {
      console.error('[QQ QR] ptqrlogin 响应非 ptuiCB 格式:', text.slice(0, 300));
      return { status: 'unknown', message: '解析失败', debug: text.slice(0, 200) };
    }

    const code = m[1];
    const redirectUrl = m[3];
    const message = m[5];
    const nickname = m[6] ? decodeURIComponent(m[6]) : '';

    if (code === '66') return { status: 'waiting', message: '等待扫码' };
    if (code === '67') return { status: 'scanned', message: '已扫码, 等待手机确认' };
    if (code !== '0') {
      console.error(`[QQ QR] ptqrlogin code=${code} message=${message}`);
      return { status: 'expired', message: message || '登录失败' };
    }

    // code === '0': 登录成功, 跟随 check_sig 重定向获取 uin + p_skey
    // QQ 会返回 3-5 次 302 重定向, 每次设置不同 cookie
    // 用 httpsGet (不自动重定向), 手动跟随, 每次收集 set-cookie
    if (!redirectUrl) {
      return { status: 'expired', message: '登录成功但无重定向URL' };
    }

    let currentUrl = redirectUrl;
    let collectedCookies = `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}`;
    let pSkey = '';
    let uin = '';

    // 最多跟随 5 次重定向
    for (let i = 0; i < 5; i++) {
      const redirResp = await httpsGet(currentUrl, collectedCookies);
      const redirSetCookie = redirResp.headers['set-cookie'] || '';

      // 从 set-cookie 提取新 cookie, 合并到 collectedCookies
      const newPskey = pickCookie(redirSetCookie, 'p_skey');
      const newUin = pickCookie(redirSetCookie, 'uin');
      if (newPskey) pSkey = newPskey;
      if (newUin) uin = newUin.replace(/^o0*/, '').replace(/^o/, '');

      // 合并所有 cookie
      const allCookies = Array.isArray(redirSetCookie) ? redirSetCookie : [redirSetCookie];
      for (const line of allCookies) {
        const cm = line.match(/^([^=]+)=([^;]+)/);
        if (cm) {
          const k = cm[1].trim();
          const v = cm[2].trim();
          // 替换或添加
          const regex = new RegExp(`\\b${k}=[^;]*;?\\s*`, 'g');
          collectedCookies = collectedCookies.replace(regex, '');
          collectedCookies += `; ${k}=${v}`;
        }
      }

      // 检查是否还有重定向
      const location = redirResp.headers['location'];
      if (!location || pSkey) break;
      currentUrl = location.startsWith('http') ? location : `https://ssl.ptlogin2.qq.com${location}`;
    }

    if (uin && pSkey) {
      sess.uin = uin;
      sess.pSkey = pSkey;
      sess.nickname = nickname;
      QR_SESSIONS.set(token, sess);
      console.log(`[QQ QR] 登录成功: uin=${uin} nickname=${nickname}`);
      return { status: 'ok', uin, pSkey, nickname };
    }

    console.error(`[QQ QR] 登录成功但未获取到 cookie: uin=${uin} pSkey=${pSkey ? 'yes' : 'no'}`);
    return { status: 'expired', message: '登录成功但未获取到 cookie' };
  } catch (err) {
    console.error('[QQ QR] qrLoginCheck 异常:', err.message);
    return { status: 'unknown', message: err.message };
  }
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
