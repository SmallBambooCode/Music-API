'use strict';

const { handleMeting } = require('../lib/meting');
const { call } = require('../lib/ncm');
const {
  setCors,
  sendJson,
  sendText,
  redirect,
  getPath,
  getQuery,
  getOrigin,
  sendMaybeJsonp,
  readJson,
} = require('../lib/http');
const {
  checkAllowlist,
  getStoredAllowlist,
  setStoredAllowlist,
  isAdminAuthed,
  getClientIp,
  getRequestCandidates,
  hasRedisEnv,
} = require('../lib/allowlist');

function statusPage(req) {
  const origin = getOrigin(req);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Meting Enhanced Adapter</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:920px;margin:48px auto;padding:0 20px;line-height:1.65;color:#18181b;background:#fafafa}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
    pre{background:#18181b;color:#fafafa;padding:16px;border-radius:12px;overflow:auto}
    a{color:#2563eb}.card{background:white;border:1px solid #e4e4e7;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.04)}
  </style>
</head>
<body>
  <h1>Meting Enhanced Adapter 正在运行</h1>
  <div class="card">
    <p>兼容 Meting-API 的 <code>/api?server=netease&type=...&id=...</code> 输出格式，并通过 NeteaseCloudMusicApiEnhanced 获取网易云数据。</p>
    <p>API 已启用白名单校验：未命中白名单的域名、Referer 或客户端 IP 将返回 <code>403</code>，不会返回歌曲、歌单、歌词或播放地址。</p>
  </div>
  <h2>测试地址</h2>
  <pre>${origin}/api?server=netease&type=song&id=473403185
${origin}/api?server=netease&type=playlist&id=6907557348
${origin}/api?server=netease&type=url&id=473403185</pre>
  <p><a href="${origin}/test">打开测试页</a> · <a href="${origin}/admin">打开管理员白名单页面</a></p>
</body>
</html>`;
}

function adminPage(req) {
  const origin = getOrigin(req);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Meting Enhanced Admin</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:920px;margin:42px auto;padding:0 20px;line-height:1.65;color:#18181b;background:#fafafa}
    .card{background:white;border:1px solid #e4e4e7;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.04)}
    input,textarea,button{font:inherit} textarea{width:100%;min-height:180px;padding:12px;border:1px solid #d4d4d8;border-radius:10px;box-sizing:border-box} input{width:100%;padding:12px;border:1px solid #d4d4d8;border-radius:10px;box-sizing:border-box} button{padding:10px 16px;border:0;border-radius:10px;background:#18181b;color:white;cursor:pointer} button.secondary{background:#52525b} code{background:#f4f4f5;padding:2px 6px;border-radius:6px} pre{background:#18181b;color:#fafafa;padding:16px;border-radius:12px;overflow:auto}.muted{color:#71717a}.ok{color:#047857}.err{color:#b91c1c}
  </style>
</head>
<body>
  <h1>管理员白名单</h1>
  <div class="card">
    <p>只有白名单中的域名、来源 Referer 或客户端 IP 可以调用 <code>/api</code> 与 <code>/enhanced</code> 获取音乐数据。</p>
    <p class="muted">支持格式：<code>yuncan.xyz</code>、<code>https://yuncan.xyz</code>、<code>*.yuncan.xyz</code>、<code>124.221.251.223</code>、<code>120.85.43.0/24</code>。一行一个或逗号分隔。</p>
  </div>
  <div class="card">
    <label>管理员密码</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD" />
    <p><button onclick="loadList()">读取白名单</button> <button class="secondary" onclick="saveList()">保存白名单</button></p>
    <textarea id="rules" placeholder="yuncan.xyz&#10;*.yuncan.xyz&#10;124.221.251.223"></textarea>
    <p id="msg" class="muted"></p>
  </div>
  <div class="card">
    <h2>环境状态</h2>
    <pre id="status">等待读取...</pre>
  </div>
<script>
const api = '${origin}/admin/whitelist';
function password(){ return document.getElementById('password').value; }
function show(text, cls='muted'){ const el=document.getElementById('msg'); el.className=cls; el.textContent=text; }
async function loadList(){
  show('读取中...');
  const res = await fetch(api, { headers: { Authorization: 'Bearer ' + password() }});
  const data = await res.json().catch(()=>({error:'bad json'}));
  document.getElementById('status').textContent = JSON.stringify(data, null, 2);
  if(!res.ok){ show(data.message || data.error || '读取失败', 'err'); return; }
  document.getElementById('rules').value = (data.rules || []).join('\n');
  show('已读取', 'ok');
}
async function saveList(){
  show('保存中...');
  const rules = document.getElementById('rules').value.split(/[\n,]+/).map(x=>x.trim()).filter(Boolean);
  const res = await fetch(api, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+password() }, body: JSON.stringify({ rules }) });
  const data = await res.json().catch(()=>({error:'bad json'}));
  document.getElementById('status').textContent = JSON.stringify(data, null, 2);
  if(!res.ok){ show(data.message || data.error || '保存失败', 'err'); return; }
  document.getElementById('rules').value = (data.rules || []).join('\n');
  show('已保存并立即生效', 'ok');
}
</script>
</body>
</html>`;
}

function testPage(req) {
  const origin = getOrigin(req);
  const examples = [
    ['netease song', `${origin}/api?server=netease&type=song&id=473403185`],
    ['netease playlist', `${origin}/api?server=netease&type=playlist&id=6907557348&limit=20`],
    ['netease artist', `${origin}/api?server=netease&type=artist&id=12441107`],
    ['netease search', `${origin}/api?server=netease&type=search&id=KN33S0XXX`],
    ['netease lyric', `${origin}/api?server=netease&type=lrc&id=473403185`],
    ['netease url raw', `${origin}/api?server=netease&type=url&id=473403185&json=1`],
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Test</title></head><body><h1>测试页面</h1><p>注意：这些链接也会经过白名单校验。</p><ul>${examples
    .map(([name, url]) => `<li>${name}: <a href="${url}">${url}</a></li>`)
    .join('')}</ul></body></html>`;
}

async function handleAdmin(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') {
    return sendText(req, res, 200, adminPage(req), 'text/html; charset=utf-8');
  }

  if (pathname === '/admin/whitelist') {
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      return res.end();
    }

    let body = {};
    if (req.method === 'POST') body = await readJson(req);
    if (!isAdminAuthed(req, body)) {
      return sendJson(req, res, 401, { error: 'unauthorized', message: '管理员密码错误，或没有配置 ADMIN_PASSWORD。' });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const info = await getStoredAllowlist();
      return sendJson(req, res, 200, {
        ok: true,
        rules: info.rules,
        source: info.source,
        writable: info.writable,
        redisConfigured: hasRedisEnv(),
        clientIp: getClientIp(req),
        requestCandidates: getRequestCandidates(req),
        warning: info.writable ? '' : '当前没有可写 KV；若要通过页面保存白名单，请配置 Upstash Redis。',
      });
    }

    if (req.method === 'POST') {
      try {
        const rules = await setStoredAllowlist(body.rules || body.allowlist || '');
        return sendJson(req, res, 200, { ok: true, rules, source: 'redis', writable: true });
      } catch (error) {
        return sendJson(req, res, error.statusCode || 500, { error: 'save_failed', message: error.message });
      }
    }
  }

  return sendJson(req, res, 404, { error: 'admin_not_found' });
}

async function handleEnhancedProxy(req, res, pathname, query) {
  const route = '/' + pathname.replace(/^\/enhanced\/?/, '');
  if (!route || route === '/') return sendJson(req, res, 400, { error: 'enhanced route is required' });
  const result = await call(route, query, { ttl: Number(process.env.CACHE_TTL_JSON || 300) });
  return sendJson(req, res, result.status || 200, result.body);
}

function isPublicPage(pathname) {
  return pathname === '/' || pathname === '/api/index' || pathname === '/health' || pathname === '/test' || pathname.startsWith('/admin');
}

module.exports = async function handler(req, res) {
  try {
    const pathname = getPath(req);
    const query = getQuery(req);

    if (pathname.startsWith('/admin')) {
      return handleAdmin(req, res, pathname);
    }

    setCors(res);
    if (req.method === 'OPTIONS') {
      if (!isPublicPage(pathname)) {
        const gate = await checkAllowlist(req);
        if (!gate.allowed) {
          return sendJson(req, res, 403, { error: 'forbidden', message: 'Request source is not in allowlist.' }, 'null');
        }
      }
      res.statusCode = 204;
      return res.end();
    }

    if (!['GET', 'HEAD'].includes(req.method)) {
      return sendJson(req, res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/' || pathname === '/api/index') {
      return sendText(req, res, 200, statusPage(req), 'text/html; charset=utf-8');
    }
    if (pathname === '/health') {
      const allowlist = await getStoredAllowlist();
      return sendJson(req, res, 200, { ok: true, service: 'meting-enhanced-vercel', allowlistSource: allowlist.source, allowlistWritable: allowlist.writable });
    }
    if (pathname === '/test') {
      return sendText(req, res, 200, testPage(req), 'text/html; charset=utf-8');
    }

    const gate = await checkAllowlist(req);
    if (!gate.allowed) {
      return sendJson(req, res, 403, {
        error: 'forbidden',
        message: 'Request source is not in allowlist.',
        hint: 'Add your site domain, wildcard domain, or client IP in /admin.',
      }, 'null');
    }

    if (pathname.startsWith('/enhanced/')) {
      return handleEnhancedProxy(req, res, pathname, query);
    }

    // Native Vercel API path: /api?server=netease&type=...
    const result = await handleMeting(req, query);
    if (result.kind === 'redirect') return redirect(res, result.location, result.status || 302, gate.corsOrigin || '*');
    if (result.kind === 'text') return sendText(req, res, result.status || 200, result.text || '', 'text/plain; charset=utf-8', gate.corsOrigin || '*');
    return sendMaybeJsonp(req, res, result.status || 200, result.data, query.callback || query.jsonp, gate.corsOrigin || '*');
  } catch (error) {
    return sendJson(req, res, 500, {
      error: 'internal_error',
      message: error && error.message ? error.message : String(error),
    });
  }
};
