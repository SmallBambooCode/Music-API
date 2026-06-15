'use strict';

const { handleMeting } = require('../lib/meting');
const { call } = require('../lib/ncm');
const { envSummary } = require('../lib/ncm');
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
  <title>Meting Enhanced Adapter v5</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:920px;margin:48px auto;padding:0 20px;line-height:1.65;color:#18181b;background:#fafafa}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
    pre{background:#18181b;color:#fafafa;padding:16px;border-radius:12px;overflow:auto}
    a{color:#2563eb}.card{background:white;border:1px solid #e4e4e7;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.04)}
  </style>
</head>
<body>
  <h1>Meting Enhanced Adapter v5 正在运行</h1>
  <div class="card">
    <p>兼容 Meting-API 的 <code>/api?server=netease&type=...&id=...</code> 输出格式。</p>
    <p>v5 修复：管理员接口绕过来源白名单但仍要求密码；Cookie 拆分变量；播放地址可优先回退旧 Meting-API；增强状态页。</p>
  </div>
  <h2>测试地址</h2>
  <pre>${origin}/api?server=netease&type=song&id=473403185
${origin}/api?server=netease&type=playlist&id=6907557348
${origin}/api?server=netease&type=url&id=473403185&json=1
${origin}/health</pre>
  <p><a href="${origin}/test">打开测试页</a> · <a href="${origin}/admin">打开管理员页面</a></p>
</body>
</html>`;
}

function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Meting Enhanced Admin</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:960px;margin:42px auto;padding:0 20px;line-height:1.65;color:#18181b;background:#fafafa}
    .card{background:white;border:1px solid #e4e4e7;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 10px 30px rgba(0,0,0,.04)}
    input,button{font:inherit} input{width:100%;padding:12px;border:1px solid #d4d4d8;border-radius:10px;box-sizing:border-box} button{padding:10px 16px;border:0;border-radius:10px;background:#18181b;color:white;cursor:pointer;margin-right:8px;margin-top:10px} button.secondary{background:#52525b} button.danger{background:#b91c1c} button.okbtn{background:#047857} code{background:#f4f4f5;padding:2px 6px;border-radius:6px} pre{background:#18181b;color:#fafafa;padding:16px;border-radius:12px;overflow:auto;white-space:pre-wrap}.muted{color:#71717a}.ok{color:#047857}.err{color:#b91c1c}.warn{color:#b45309}
  </style>
</head>
<body>
  <h1>管理员测试开关</h1>
  <div class="card">
    <p>白名单只从 Vercel 环境变量 <code>ALLOWLIST</code> 读取；本页面不支持网页增删白名单。</p>
    <p>管理员密码验证通过后，可以临时关闭/重新开启白名单。这个开关只保存在当前 Serverless 运行实例内，重新部署、冷启动、实例回收或切换区域后可能自动恢复。</p>
  </div>
  <div class="card">
    <label>管理员密码</label>
    <input id="password" type="password" autocomplete="current-password" placeholder="ADMIN_PASSWORD" />
    <p>
      <button id="statusBtn" type="button">读取状态</button>
      <button id="disableBtn" type="button" class="danger">临时关闭白名单</button>
      <button id="enableBtn" type="button" class="okbtn">重新开启白名单</button>
      <button id="healthBtn" type="button" class="secondary">读取公开健康检查</button>
    </p>
    <p id="msg" class="muted">页面已加载。请先输入管理员密码，再点“读取状态”。</p>
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
(function(){
  const api = '/admin/allowlist';
  const health = '/health';
  const $ = (id) => document.getElementById(id);
  function password(){ return $('password').value || ''; }
  function show(text, cls){ const el=$('msg'); el.className=cls||'muted'; el.textContent=text; }
  function render(data){
    $('status').textContent = JSON.stringify(data, null, 2);
    $('rules').textContent = (data.rules || []).join('\n') || '(ALLOWLIST 未配置，白名单开启时所有 API 请求都会被拒绝)';
    if (data.ok === false || data.error) return show(data.message || data.error || '请求失败', 'err');
    const disabled = data.runtimeSwitch && data.runtimeSwitch.disabled;
    show(disabled ? '白名单当前已临时关闭：所有来源可请求 API。测试后请重新开启。' : '白名单当前已开启：只允许 ALLOWLIST 中的来源。', disabled ? 'warn' : 'ok');
  }
  async function requestJson(url, options){
    const res = await fetch(url, { cache:'no-store', ...options });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch(e) { data = { ok:false, error:'non_json_response', status:res.status, body:text.slice(0, 1000) }; }
    data.httpStatus = res.status;
    data.httpOk = res.ok;
    return data;
  }
  async function loadStatus(){
    try {
      show('读取中...', 'muted');
      const data = await requestJson(api, { headers: { 'Authorization': 'Bearer ' + password(), 'X-Admin-Password': password() }});
      render(data);
    } catch(e) { show('请求失败：' + e.message, 'err'); $('status').textContent = String(e && e.stack || e); }
  }
  async function toggleAllowlist(disabled){
    try {
      show(disabled ? '正在临时关闭白名单...' : '正在重新开启白名单...', 'muted');
      const data = await requestJson(api, {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+password(), 'X-Admin-Password':password() },
        body: JSON.stringify({ disabled, password: password() })
      });
      render(data);
    } catch(e) { show('请求失败：' + e.message, 'err'); $('status').textContent = String(e && e.stack || e); }
  }
  async function loadHealth(){
    try { const data = await requestJson(health); $('status').textContent = JSON.stringify(data, null, 2); show('健康检查已读取。', 'ok'); }
    catch(e) { show('健康检查失败：' + e.message, 'err'); }
  }
  $('statusBtn').addEventListener('click', loadStatus);
  $('disableBtn').addEventListener('click', () => toggleAllowlist(true));
  $('enableBtn').addEventListener('click', () => toggleAllowlist(false));
  $('healthBtn').addEventListener('click', loadHealth);
})();
</script>
</body>
</html>`;
}

function testPage(req) {
  const origin = getOrigin(req);
  const examples = [
    ['netease song', `${origin}/api?server=netease&type=song&id=473403185`],
    ['netease playlist', `${origin}/api?server=netease&type=playlist&id=6907557348&limit=20`],
    ['netease lyric', `${origin}/api?server=netease&type=lrc&id=473403185`],
    ['netease url json', `${origin}/api?server=netease&type=url&id=473403185&json=1`],
  ];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Test</title></head><body><h1>测试页面</h1><p>这些链接会经过白名单校验；从当前页面点击时，Referer 通常会命中当前部署域名。</p><ul>${examples
    .map(([name, url]) => `<li>${name}: <a href="${url}">${url}</a></li>`)
    .join('')}</ul></body></html>`;
}

async function adminStatusPayload(req) {
  const info = await getStoredAllowlist();
  return {
    ok: true,
    rules: info.rules,
    source: info.source,
    writable: false,
    editable: false,
    clientIp: getClientIp(req),
    requestCandidates: getRequestCandidates(req),
    runtimeSwitch: getRuntimeAllowlistState(),
    env: {
      ...envSummary(),
      hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
      allowlistRawLength: String(process.env.ALLOWLIST || '').length,
      fallbackApiConfigured: Boolean(process.env.METING_FALLBACK_API),
      urlProvider: String(process.env.URL_PROVIDER || 'enhanced-then-fallback'),
    },
    message: '白名单只能通过 Vercel 环境变量 ALLOWLIST 设置；管理员页面只允许临时关闭/开启白名单。',
  };
}

async function handleAdmin(req, res, pathname) {
  if (pathname === '/admin' || pathname === '/admin/') {
    return sendText(req, res, 200, adminPage(), 'text/html; charset=utf-8', '*');
  }

  if (pathname === '/admin/allowlist' || pathname === '/admin/whitelist' || pathname === '/admin/status') {
    if (req.method === 'OPTIONS') {
      setCors(res, '*');
      res.statusCode = 204;
      return res.end();
    }

    let body = {};
    if (req.method === 'POST') body = await readJson(req);
    if (!isAdminAuthed(req, body)) {
      return sendJson(req, res, 401, {
        ok: false,
        error: 'unauthorized',
        message: '管理员密码错误，或没有在 Vercel 当前部署环境配置 ADMIN_PASSWORD。修改环境变量后必须 Redeploy。',
        env: { hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD) },
      }, '*');
    }

    if (req.method === 'POST') setRuntimeAllowlistDisabled(Boolean(body.disabled));
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST') {
      return sendJson(req, res, 200, await adminStatusPayload(req), '*');
    }
  }

  return sendJson(req, res, 404, { ok: false, error: 'admin_not_found' }, '*');
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

    if (pathname.startsWith('/admin')) return handleAdmin(req, res, pathname);

    setCors(res);
    if (req.method === 'OPTIONS') {
      if (!isPublicPage(pathname)) {
        const gate = await checkAllowlist(req, pathname);
        if (!gate.allowed) return sendJson(req, res, 403, { error: 'forbidden', message: 'Request source is not in allowlist.' }, 'null');
      }
      res.statusCode = 204;
      return res.end();
    }

    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(req, res, 405, { error: 'Method not allowed' });

    if (pathname === '/' || pathname === '/api/index') {
      return sendText(req, res, 200, statusPage(req), 'text/html; charset=utf-8');
    }
    if (pathname === '/health') {
      const allowlist = await getStoredAllowlist();
      return sendJson(req, res, 200, {
        ok: true,
        service: 'meting-enhanced-vercel',
        version: '0.5.0',
        allowlistSource: allowlist.source,
        allowlistWritable: false,
        allowlistEditable: false,
        runtimeSwitch: getRuntimeAllowlistState(),
        env: {
          ...envSummary(),
          hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
          allowlistCount: allowlist.rules.length,
          fallbackApiConfigured: Boolean(process.env.METING_FALLBACK_API),
          urlProvider: String(process.env.URL_PROVIDER || 'enhanced-then-fallback'),
        },
      });
    }
    if (pathname === '/test') return sendText(req, res, 200, testPage(req), 'text/html; charset=utf-8');

    const gate = await checkAllowlist(req, pathname);
    if (!gate.allowed) {
      return sendJson(req, res, 403, {
        error: 'forbidden',
        message: 'Request source is not in allowlist.',
        candidates: gate.candidates,
        hint: 'Add your site domain, wildcard domain, or client IP in the Vercel ALLOWLIST environment variable, or temporarily disable the allowlist from /admin.',
      }, 'null');
    }

    if (pathname.startsWith('/enhanced/')) return handleEnhancedProxy(req, res, pathname, query);

    const result = await handleMeting(req, query);
    if (result.kind === 'redirect') return redirect(res, result.location, result.status || 302, gate.corsOrigin || '*');
    if (result.kind === 'text') return sendText(req, res, result.status || 200, result.text, 'text/plain; charset=utf-8', gate.corsOrigin || '*');
    return sendMaybeJsonp(req, res, result.status || 200, result.data, query.callback || query.jsonp, gate.corsOrigin || '*');
  } catch (error) {
    const payload = {
      error: 'internal_error',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' || process.env.DEBUG_RESPONSE === '1' ? error.stack : undefined,
    };
    return sendJson(req, res, 500, payload);
  }
};
