'use strict';

// B站 provider v0.2.0
// 将 B站视频作为歌单/歌曲来源:
//   - 搜索视频 (作为歌单候选): /x/web-interface/search/type?search_type=video
//   - 视频分P (作为歌单详情): /x/web-interface/view?bvid=...
//   - 音频流 URL: /x/player/playurl?bvid=...&cid=...&fnval=16 (DASH audio)
//
// 实测: 三个接口均无需 WBI 签名, 只需正确 Referer + Accept-Language 即可
// 音源说明: B站视频的 DASH 流包含独立音轨, 取第一个 audio stream 的 base_url
// 注意: B站音频 URL 播放时需要 Referer: https://www.bilibili.com/ 头

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

let cachedCookie = '';

async function httpGet(url, referer = REFERER, cookie = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = {
      'User-Agent': UA,
      Referer: referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
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

async function fetchCookie() {
  if (cachedCookie) return cachedCookie;
  try {
    const resp = await fetch('https://www.bilibili.com', {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    const setCookies = resp.headers.get('set-cookie');
    if (setCookies) {
      cachedCookie = setCookies.split(/,\s*(?=[A-Za-z])/).map(c => c.split(';')[0]).join('; ');
    }
  } catch {}
  return cachedCookie;
}

// 搜索视频 (作为歌单候选)
async function search(keyword, limit = 30) {
  const cookie = await fetchCookie();
  const encoded = encodeURIComponent(keyword);
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encoded}&page=1&page_size=${limit}`;
  const body = await httpGet(url, `https://search.bilibili.com/all?keyword=${encoded}`, cookie);
  if (!body) return [];
  try {
    const root = JSON.parse(body);
    if (root.code !== 0) return [];
    const list = root.data && Array.isArray(root.data.result) ? root.data.result : [];
    return list.map(v => ({
      id: v.bvid || '',
      name: (v.title || '').replace(/<[^>]+>/g, ''),
      singer: v.author || '未知',
      time: 0,
      cover: v.pic ? (v.pic.startsWith('//') ? 'https:' + v.pic : v.pic) : '',
    })).filter(v => v.id);
  } catch {
    return [];
  }
}

// 获取视频分P列表 (作为歌单详情)
// 返回 { songs, total } — 每个分P是一首歌, id 为 "bvid:cid"
async function playlistDetail(bvid, limit = 100, offset = 0) {
  const cookie = await fetchCookie();
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const body = await httpGet(url, REFERER, cookie);
  if (!body) return { songs: [], total: 0 };
  try {
    const root = JSON.parse(body);
    if (root.code !== 0) return { songs: [], total: 0 };
    const data = root.data || {};
    const pages = Array.isArray(data.pages) ? data.pages : [];
    // limit 限制返回的分P数量
    const sliced = pages.slice(offset, offset + limit);
    const songs = sliced.map((p, i) => ({
      id: `${bvid}:${p.cid}`,
      name: p.part ? `${data.title} - P${offset + i + 1} ${p.part}` : (data.title || '未知'),
      singer: data.owner && data.owner.name || '未知',
      time: p.duration || 0,
    }));
    return { songs, total: pages.length };
  } catch {
    return { songs: [], total: 0 };
  }
}

// 搜索歌单 (搜索视频, 返回为歌单格式)
async function searchPlaylist(keyword, limit = 30) {
  const results = await search(keyword, limit);
  return results.map(v => ({
    id: v.id,
    name: v.name,
    cover: v.cover,
    creator: v.singer,
    songCount: 0, // 视频分P数未知, 需要查看详情
  }));
}

// 从 bvid:cid 获取音频流 URL (原始 B站 URL, 由路由层包装为代理 URL)
async function fetchAudioUrl(bvid, cid) {
  const cookie = await fetchCookie();
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&fnval=16&platform=pc`;
  const body = await httpGet(url, REFERER, cookie);
  if (!body) return '';
  try {
    const root = JSON.parse(body);
    if (root.code !== 0) return '';
    const dash = root.data && root.data.dash;
    if (dash && Array.isArray(dash.audio) && dash.audio.length > 0) {
      // 取第一个音轨 (通常是最高音质)
      return dash.audio[0].base_url || dash.audio[0].baseUrl || '';
    }
    // 退化: durl 格式 (非 DASH)
    if (dash && Array.isArray(dash.durl) && dash.durl.length > 0) {
      return dash.durl[0].url || '';
    }
    return '';
  } catch {
    return '';
  }
}

// 获取播放 URL (id 格式: "bvid:cid" 或纯 bvid)
async function songUrl(id) {
  const parts = String(id).split(':');
  const bvid = parts[0];
  const cid = parts[1] || '';
  // 如果没有 cid, 先获取视频信息拿到第一个 page 的 cid
  let actualCid = cid;
  let name = '未知';
  let singer = '未知';
  let time = 0;
  if (!actualCid) {
    const detail = await playlistDetail(bvid, 1, 0);
    if (detail.songs.length > 0) {
      const first = detail.songs[0];
      actualCid = first.id.split(':')[1] || '';
      name = first.name;
      singer = first.singer;
      time = first.time;
    }
  }
  if (!actualCid) return { ok: false, url: '', name, singer, time };
  const audioUrl = await fetchAudioUrl(bvid, actualCid);
  return { ok: Boolean(audioUrl), url: audioUrl, name, singer, time };
}

// 歌词 (B站视频无歌词)
async function lyric() {
  return '';
}

// 一次性返回完整单曲 (并发获取音频 URL + 视频信息)
async function songFull(id) {
  const parts = String(id).split(':');
  const bvid = parts[0];
  let cid = parts[1] || '';

  // 先获取视频信息 (拿 name/singer, 以及没有 cid 时拿第一个 page 的 cid)
  const detail = await playlistDetail(bvid, 1, 0);
  let name = '未知';
  let singer = '未知';
  let time = 0;
  if (detail.songs.length > 0) {
    const match = cid
      ? detail.songs.find(s => s.id.endsWith(':' + cid))
      : detail.songs[0];
    if (match) {
      name = match.name;
      singer = match.singer;
      time = match.time;
      if (!cid) cid = match.id.split(':')[1] || '';
    }
  }

  const audioUrl = cid ? await fetchAudioUrl(bvid, cid) : '';

  return {
    id,
    name,
    singer,
    url: audioUrl,
    lyric: '',
    time,
    ok: Boolean(audioUrl),
    source: 'bilibili',
  };
}

module.exports = {
  platform: 'bilibili',
  search,
  songUrl,
  lyric,
  songFull,
  searchPlaylist,
  playlistDetail,
};
