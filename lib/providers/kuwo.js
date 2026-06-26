'use strict';

// 酷我音乐 API — 移植自 ZMusicGUI/KuwoMusicApi.kt
// 实测可用接口:
//   - 搜索: http://search.kuwo.cn/r.s?all={keyword} (返回单引号 JSON, SONGNAME 含 HTML 实体)
//   - 播放URL: http://antiserver.kuwo.cn/anti.s?...&rid=music_{mid} (纯文本 URL)
//   - 歌词: https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId={mid} (lrclist, 需转 LRC)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const REFERER_SEARCH = 'http://www.kuwo.cn/';
const REFERER_WWW = 'https://www.kuwo.cn/';

async function httpGet(url, referer = REFERER_WWW, cookie = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
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

// 搜索: 返回 [{id, name, singer}]
async function search(keyword, limit = 30) {
  const url = `http://search.kuwo.cn/r.s?all=${encodeURIComponent(keyword)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${limit}&rformat=json&encoding=utf8`;
  const body = await httpGet(url, REFERER_SEARCH);
  if (!body) return [];
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
    return [];
  }
}

// 获取播放 URL (antiserver 返回纯文本 URL)
async function songUrl(mid, userId = '', token = '') {
  const cookie = (userId && token) ? `kw_token=${token}; kw_user_id=${userId}` : '';
  const url = `http://antiserver.kuwo.cn/anti.s?useless=0&type=convert_url&format=mp3&response=url&rid=music_${mid}`;
  const body = await httpGet(url, '', cookie);
  if (!body) return { ok: false, url: '', lyric: '', time: 0 };
  const trimmed = body.trim();
  const playUrl = trimmed.split(/\r?\n/).find(l => l.startsWith('http')) || '';
  return { ok: Boolean(playUrl), url: playUrl, time: 0 };
}

// 获取歌词: openapi lrclist → LRC 格式
async function lyric(mid, userId = '', token = '') {
  const cookie = (userId && token) ? `kw_token=${token}; kw_user_id=${userId}` : '';
  const url = `https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId=${mid}&httpsStatus=1`;
  const body = await httpGet(url, REFERER_WWW, cookie);
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
async function songFull(mid, userId = '', token = '') {
  const [urlResult, lyricResult] = await Promise.all([
    songUrl(mid, userId, token),
    lyric(mid, userId, token),
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

module.exports = {
  platform: 'kuwo',
  search,
  songUrl,
  lyric,
  songFull,
};
