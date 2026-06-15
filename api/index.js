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
  isAdminAuthed,
  getClientIp,
  getRequestCandidates,
  getRuntimeAllowlistState,
  setRuntimeAllowlistDisabled,
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
    <p>API 已启用白名单校验：白名单只从 Vercel 环境变量 <code>ALLOWLIST</code> 读取。管理员页面只提供临时关闭/开启白名单的测试开关，不支持网页增删白名单。</p>
  </div>
  <h2>测试地址</h2>
  <pre>${origin}/api?server=netease&type=song&id=473403185
${origin}/api?server=netease&type=playlist&id=6907557348
${origin}/api?server=netease&type=url&id=473403185&json=1</pre>
  <p><a href="${origin}/test">打开测试页</a> · <a href="${origin}/admin">打开管理员页面</a></p>
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
    input,button{font:inherit} input{width:100%;padding:12px;border:1px solid #d4d4d8;border-radius:10px;box-sizing:border-box} button{padding:10px 16px;border:0;border-radius:10px;background:#18181b;color:white;cursor:pointer;margin-right:8px;margin-top:10px} button.secondary{background:#52525b} button.danger{background:#b91c1c} button.okbtn{background:#047857} code{background:#f4f4f5;padding:2px 6px;border-radius:6px} pre{background:#18181b;color:#fafafa;padding:16px;border-radius:12px;overflow:auto}.muted{color:#71717a}.ok{color:#047857}.err{color:#b91c1c}.warn{color:#b45309}
  </style>
</head>
<body>
  <h1>管理员测试开关</h1>
  <div class="card">
    <p>白名单只从 Vercel 环境变量 <code>ALLOWLIST</code> 读取；本页面不再支持新增、删除、保存白名单。</p>
    <p>管理员密码验证通过后，可以<strong>临时关闭白名单</strong>用于测试。这个开关只保存在当前 Serverless 运行实例内，重新部署、冷启动、实例回收或切换区域后可能自动恢复。</p>
  </div>
  <div class="card">
    <label>管理员密码</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD" />
    <p>
      <button onclick="loadStatus()">读取状态</button>
      <button class="danger" onclick="toggleAllowlist(true)">临时关闭白名单</button>
      <button class="okbtn" onclick="toggleAllowlist(false)">重新开启白名单</button>
    </p>
    <p id="msg" class="muted"></p>
  </div>
  <div class="card">
    <h2>环境变量白名单</h2>
    <pre id="rules">等待读取...</pre>
  </div>
  <div class="card">
    <h2>运行状态</h2>
    <pre id="status">等待读取...</pre>
  </div>
<script>
const api = '${origin}/admin/allowlist';
function password(){ return document.getElementById('password').value; }
function show(text, cls='muted'){ const el=document.getElementById('msg'); el.className=cls; el.textContent=text; }
function render(data){
  document.getElementById('status').textContent = JSON.stringify(data, null, 2);
  document.getElementById('rules').textContent = (data.rules || []).join('\n') || '(ALLOWLIST 未配置，白名单开启时所有 API 请求都会被拒绝)';
  const disabled = data.runtimeSwitch && data.runtimeSwitch.disabled;
  show(disabled ? '白名单当前已临时关闭：所有来源可请求 API。测试后请重新开启。' : '白名单当前已开启：只允许 ALLOWLIST 中的来源。', disabled ? 'warn' : 'ok');
}
async function loadStatus(){
  show('读取中...');
  const res = await fetch(api, { headers: { Authorization: 'Bearer ' + password() }});
  const data = await res.json().catch(()=>({error:'bad json'}));
  render(data);
  if(!res.ok) show(data.message || data.error || '读取失败', 'err');
}
async function toggleAllowlist(disabled){
  show(disabled ? '正在临时关闭白名单...' : '正在重新开启白名单...');
  const res = await fetch(api, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+password() }, body: JSON.stringify({ disabled }) });
  const data = await res.json().catch(()=>({error:'bad json'}));
  render(data);
  if(!res.ok) show(data.message || data.error || '操作失败', 'err');
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Test</title></head><body><h1>测试页面</h1><p>注意：这些链接会经过白名单校验；如果从当前页面点击，Referer 通常会命中当前部署域名。</p><ul>${examples
    .map(([name, url]) => `<li>${name}: <a href="${url}">${url}</a></li>`)
    .join('')}</ul></body></html>`;
}

async function handleAdmin(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') {
    return sendText(req, res, 200, adminPage(req), 'text/html; charset=utf-8');
  }

  if (pathname === '/admin/allowlist' || pathname === '/admin/whitelist') {
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

    if (req.method === 'POST') {
      setRuntimeAllowlistDisabled(Boolean(body.disabled));
    }

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST') {
      const info = await getStoredAllowlist();
      return sendJson(req, res, 200, {
        ok: true,
        rules: info.rules,
        source: info.source,
        writable: false,
        editable: false,
        clientIp: getClientIp(req),
        requestCandidates: getRequestCandidates(req),
        runtimeSwitch: getRuntimeAllowlistState(),
        message: '白名单只能通过 Vercel 环境变量 ALLOWLIST 设置；管理员页面只允许临时关闭/开启白名单。',
      });
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
      return sendJson(req, res, 200, {
        ok: true,
        service: 'meting-enhanced-vercel',
        allowlistSource: allowlist.source,
        allowlistWritable: false,
        allowlistEditable: false,
        runtimeSwitch: getRuntimeAllowlistState(),
      });
    }
    if (pathname === '/test') {
      return sendText(req, res, 200, testPage(req), 'text/html; charset=utf-8');
    }

    const gate = await checkAllowlist(req);
    if (!gate.allowed) {
      return sendJson(req, res, 403, {
        error: 'forbidden',
        message: 'Request source is not in allowlist.',
        hint: 'Add your site domain, wildcard domain, or client IP in the Vercel ALLOWLIST environment variable, or temporarily disable the allowlist from /admin.',
      }, 'null');
    }

    if (pathname.startsWith('/enhanced/')) {
      return handleEnhancedProxy(req, res, pathname, query);
    }

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
