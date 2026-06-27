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

// QQ OAuth 应用参数
// v0.21.3: 改用 QQ 互联 appid=549000912 + daid=5 (QQ音乐 appid=716027609 在服务器端 ptqrlogin 返回 403)
// QQ 互联的 appid 在服务器端能正常调用 ptqrlogin (Python 测试通过)
// 登录后用拿到的 uin + p_skey 调用 QQ 音乐 vkey 接口
const QQ_OAUTH = {
  appid: '549000912',
  daid: '5',
  sUrl: 'https://graph.qq.com/oauth2.0/show?which=Login&display=pc',
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
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Connection': 'keep-alive',
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
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
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
// 返回: { status: "waiting"|"scanned"|"ok"|"expired", uin?, pSkey?, nickname?, message? }
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
    // ptqrlogin: 查询登录状态 (用 httpsGet, 和 xlogin/ptqrshow 保持一致, 避免 fetch 的 Sec-Fetch-* 头触发 403)
    const ptqrtoken = hash33(sess.qrsig);
    const ptqrloginUrl = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(QQ_OAUTH.sUrl)}&ptqrtoken=${ptqrtoken}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052&action=0-0-${Date.now()}&js_ver=20102616&js_type=1&login_sig=${encodeURIComponent(sess.ptLoginSig)}&pt_uistyle=40&aid=${QQ_OAUTH.appid}&daid=${QQ_OAUTH.daid}`;

    let text = '';
    let httpStatus = 0;
    try {
      const resp = await httpsGet(ptqrloginUrl, `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}`);
      httpStatus = resp.status;
      text = resp.body || '';
    } catch (fetchErr) {
      return { status: 'unknown', message: `网络请求失败: ${fetchErr.message}` };
    }

    if (!text || text.length < 10) {
      return { status: 'unknown', message: `QQ 返回空响应 (HTTP ${httpStatus})` };
    }

    // 响应格式: ptuiCB('code','status','redirectUrl','flag','message','nickname');
    const m = text.match(/ptuiCB\('(\d+)','(\d+)','([^']*)','(\d+)','([^']*)','([^']*)'\)/);
    if (!m) {
      return { status: 'unknown', message: `解析失败: ${text.slice(0, 150)}` };
    }

    const code = m[1];
    const redirectUrl = m[3];
    const message = m[5];
    const nickname = m[6] ? decodeURIComponent(m[6]) : '';

    if (code === '66') return { status: 'waiting', message: '等待扫码' };
    if (code === '67') return { status: 'scanned', message: '已扫码, 等待手机确认' };
    if (code !== '0') {
      return { status: 'expired', message: message || `登录失败 code=${code}` };
    }

    // code === '0': 登录成功, 跟随重定向获取 uin + p_skey
    if (!redirectUrl) {
      return { status: 'expired', message: '登录成功但无重定向URL' };
    }

    // 用 httpsGet 手动跟随重定向, 每次收集 set-cookie
    let currentUrl = redirectUrl;
    let collectedCookies = `qrsig=${sess.qrsig}; pt_login_sig=${sess.ptLoginSig}`;
    let pSkey = '';
    let uin = '';

    for (let i = 0; i < 5; i++) {
      const redirResp = await httpsGet(currentUrl, collectedCookies);
      const redirSetCookie = redirResp.headers['set-cookie'] || '';

      const newPskey = pickCookie(redirSetCookie, 'p_skey');
      const newUin = pickCookie(redirSetCookie, 'uin');
      if (newPskey) pSkey = newPskey;
      if (newUin) uin = newUin.replace(/^o0*/, '').replace(/^o/, '');

      // 合并 cookie
      const allCookies = Array.isArray(redirSetCookie) ? redirSetCookie : [redirSetCookie];
      for (const line of allCookies) {
        const cm = line.match(/^([^=]+)=([^;]+)/);
        if (cm) {
          const k = cm[1].trim();
          const v = cm[2].trim();
          const regex = new RegExp(`\\b${k}=[^;]*;?\\s*`, 'g');
          collectedCookies = collectedCookies.replace(regex, '');
          collectedCookies += `; ${k}=${v}`;
        }
      }

      const location = redirResp.headers['location'];
      if (!location || pSkey) break;
      currentUrl = location.startsWith('http') ? location : `https://ssl.ptlogin2.qq.com${location}`;
    }

    if (uin && pSkey) {
      sess.uin = uin;
      sess.pSkey = pSkey;
      sess.nickname = nickname;
      QR_SESSIONS.set(token, sess);
      return { status: 'ok', uin, pSkey, nickname };
    }

    return { status: 'expired', message: `登录成功但未获取到 cookie (uin=${uin}, pSkey=${pSkey ? '有' : '无'})` };
  } catch (err) {
    return { status: 'unknown', message: `异常: ${err.message}` };
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
// v2.4.3: 重试 3 次超时 5 秒, 总最长时间大幅延长 (应对 QQ 搜索/详情接口不稳定)
// 支持登录态:
//   - uin (QQ 号) + qqmusic_key (QQ 音乐鉴权 token, F12 复制)
//   - p_skey (VIP 歌曲必需, F12 Network 请求头 cookie 可获取)
//   - cookie: 完整 document.cookie 字符串 (v2.4.0 新增, 优先级最高)
async function musicuRequest(payload, retries = 3, uin = '', qqmusicKey = '', cookie = '') {
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?data=${encodeURIComponent(JSON.stringify(payload))}`;
  let cookieStr = '';
  if (cookie) {
    // 优先使用完整 cookie
    cookieStr = cookie;
  } else {
    const cookieParts = [];
    if (uin) cookieParts.push(`uin=o0${uin.replace(/^o0*/, '').replace(/^o/, '')}`);
    if (qqmusicKey) cookieParts.push(`qqmusic_key=${qqmusicKey}`);
    cookieStr = cookieParts.join('; ');
  }
  const headers = { 'User-Agent': UA, Referer: REFERER_SEARCH, Accept: 'application/json, text/plain, */*' };
  if (cookieStr) headers['Cookie'] = cookieStr;

  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) { if (i < retries) await new Promise(r => setTimeout(r, 800 * (i + 1))); continue; }
      const body = await resp.text();
      try {
        const root = JSON.parse(body);
        const code = root.req_0 && root.req_0.code;
        if (code === 0) return root.req_0.data;
        // QQ 接口限流时返回 code=2001, 多等一会再重试
        if (code === 2001 && i < retries) {
          console.log(`[QQ musicu] 限流 code=2001, 等待 ${800 * (i + 1)}ms 后重试 (${i + 1}/${retries})`);
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
          continue;
        }
      } catch {}
      return null;
    } catch (err) {
      if (i < retries) {
        console.log(`[QQ musicu] 请求失败: ${err.message}, 等待 ${800 * (i + 1)}ms 后重试 (${i + 1}/${retries})`);
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
    }
  }
  return null;
}

// ==================== 搜索 ====================
// 返回 [{id(songmid), name, singer, time}]
// 增加重试机制应对 QQ 搜索接口不稳定
async function search(keyword, limit = 30) {
  const payload = {
    req_0: {
      module: 'music.search.SearchCgiService',
      method: 'DoSearchForQQMusicDesktop',
      param: { query: keyword, page_num: 1, num_per_page: limit },
    },
  };
  const data = await musicuRequest(payload, 3);
  if (!data) {
    // 搜索接口完全失败时, 尝试备用搜索接口
    console.log('[QQ search] musicuRequest 失败, 尝试备用搜索接口');
    return await searchBackup(keyword, limit);
  }
  const list = data.body && data.body.song && Array.isArray(data.body.song.list) ? data.body.song.list : [];
  return list.map(s => ({
    id: s.mid || '',
    name: s.name || '未知',
    singer: (s.singer || []).map(a => a.name).filter(Boolean).join(' / ') || '未知',
    time: s.interval || 0,
  })).filter(s => s.id);
}

// 备用搜索接口 (当主接口失败时使用)
async function searchBackup(keyword, limit = 30) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&p=1&n=${limit}&w=${encodeURIComponent(keyword)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, Referer: REFERER_SEARCH, Accept: 'application/json, text/plain, */*' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) continue;
      const body = await resp.text();
      const json = JSON.parse(body);
      const songList = json.data && json.data.song && Array.isArray(json.data.song.list) ? json.data.song.list : [];
      return songList.map(s => ({
        id: s.songmid || s.mid || '',
        name: s.songname || '未知',
        singer: (s.singer || []).map(a => a.name || '').filter(Boolean).join(' / ') || '未知',
        time: s.interval || 0,
      })).filter(s => s.id);
    } catch (e) {
      console.log(`[QQ search backup] 尝试 ${i + 1} 失败: ${e.message}`);
      if (i < 2) await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  return [];
}

// ==================== 通过 vkey 接口获取播放 URL ====================
// uin + qqmusicKey/p_skey: 登录后可获取 VIP 歌曲 purl
// cookie: 完整 document.cookie (v2.4.0, 优先级更高, 应包含 p_skey 以获取 VIP 歌曲)
// 注意: p_skey 是 HttpOnly, F12 document.cookie 无法获取, 需从 Network 请求头复制完整 cookie
async function fetchVkey(songmid, uin = '', qqmusicKey = '', cookie = '') {
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
  }, 3, uin, qqmusicKey, cookie);
  if (!data) return '';
  const info = data.midurlinfo && data.midurlinfo[0];
  if (!info) return '';
  const purl = info.purl || '';
  if (!purl) {
    // purl 为空说明需要 VIP 权限
    // 检查 cookie 中是否有 p_skey
    const hasPSkey = cookie && /\bp_skey=/.test(cookie);
    if (!hasPSkey) {
      console.log('[QQ vkey] purl 为空且 cookie 中无 p_skey, 可能无法获取 VIP 歌曲');
    } else {
      console.log('[QQ vkey] purl 为空, 可能该歌曲需要 VIP 或已下架');
    }
  }
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
async function songUrl(songmid, uin = '', qqmusicKey = '', cookie = '') {
  const [url, info] = await Promise.all([
    fetchVkey(songmid, uin, qqmusicKey, cookie),
    fetchSongInfo(songmid),
  ]);
  return {
    ok: Boolean(url),
    url: url || '',
    name: info ? info.name : '未知',
    singer: info ? info.singer : '未知',
    time: info ? info.time : 0,
    needsLogin: !url && !uin && !cookie, // 未登录且无 url → 提示需登录
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
async function songFull(songmid, uin = '', qqmusicKey = '', cookie = '') {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(songmid, uin, qqmusicKey, cookie),
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
