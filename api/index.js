'use strict';

const { handleMeting } = require('../lib/meting');
const { envSummary } = require('../lib/ncm');
const { setCors, sendJson, sendText, redirect, getQuery, sendMaybeJsonp, readJson } = require('../lib/http');
const { checkAllowlist, getStoredAllowlist, isAdminAuthed, getClientIp, getRequestCandidates, getRuntimeAllowlistState, setRuntimeAllowlistDisabled } = require('../lib/allowlist');

function statusPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meting Enhanced Adapter v6</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:920px;margin:48px auto;padding:0 20px;line-height:1.65;background:#fafafa;color:#18181b}.card{background:white;border:1px solid #e4e4e7;border-radius:16px;padding:20px;margin:16px 0}code{background:#f4f4f5;padding:2px 6px;border-radius:6px}pre{background:#18181b;color:white;padding:16px;border-radius:12px;overflow:auto}</style></head><body><h1>Meting Enhanced Adapter v6 正在运行</h1><div class="card"><p>v6 使用单一 <code>/api</code> 函数处理管理开关和 Meting 接口，避免 Vercel rewrite 导致管理员页面卡死，也保证临时关闭白名单能影响同一个函数实例内的播放接口。</p></div><pre>/api?action=health
/api?action=admin-status
/api?server=netease&type=playlist&id=6907557348
/api?server=netease&type=url&id=473403185&json=1</pre><p><a href="/admin/">打开管理员页面</a></p></body></html>`;
}

async function adminStatusPayload(req) {
  const info = await getStoredAllowlist();
  return {
    ok: true,
    version: '0.6.0',
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
      fallbackApiConfigured: Boolean(process.env.METING_FALLBACK_API || process.env.LEGACY_METING_API),
      urlProvider: String(process.env.URL_PROVIDER || 'enhanced-then-fallback'),
    },
    message: '白名单只从 Vercel 环境变量 ALLOWLIST 读取；本页面只允许用 ADMIN_PASSWORD 临时关闭/开启白名单。',
  };
}

async function healthPayload(req) {
  const allowlist = await getStoredAllowlist();
  return {
    ok: true,
    service: 'meting-enhanced-vercel',
    version: '0.6.0',
    env: {
      ...envSummary(),
      hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD),
      allowlistCount: allowlist.rules.length,
      allowlistRawLength: String(process.env.ALLOWLIST || '').length,
      allowlistDisabledDefault: String(process.env.ALLOWLIST_DISABLED_DEFAULT || ''),
      fallbackApiConfigured: Boolean(process.env.METING_FALLBACK_API || process.env.LEGACY_METING_API),
      urlProvider: String(process.env.URL_PROVIDER || 'enhanced-then-fallback'),
    },
    runtimeSwitch: getRuntimeAllowlistState(),
    note: 'No secrets are returned here. If hasAdminPassword/hasNcmMusicU is false after setting Vercel env vars, redeploy the same environment you are visiting.',
  };
}

async function handleAdmin(req, res, query) {
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
      message: '管理员密码错误，或当前访问的 Deployment 没读到 ADMIN_PASSWORD。修改 Vercel 环境变量后必须 Redeploy 当前 Production/Preview。',
      env: { hasAdminPassword: Boolean(process.env.ADMIN_PASSWORD) },
    }, '*');
  }
  if (req.method === 'POST') {
    const disabled = body.disabled !== undefined ? Boolean(body.disabled) : query.disabled === '1' || query.disabled === 'true';
    setRuntimeAllowlistDisabled(disabled);
  }
  return sendJson(req, res, 200, await adminStatusPayload(req), '*');
}

module.exports = async function handler(req, res) {
  try {
    const query = getQuery(req);
    setCors(res, '*');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    if (query.action === 'health') return sendJson(req, res, 200, await healthPayload(req), '*');
    if (query.action === 'admin-status' || query.action === 'admin-toggle') return handleAdmin(req, res, query);

    if (req.method === 'GET' && !query.server && !query.type && !query.id) {
      return sendText(req, res, 200, statusPage(), 'text/html; charset=utf-8', '*');
    }

    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(req, res, 405, { error: 'Method not allowed' }, '*');

    const gate = await checkAllowlist(req);
    if (!gate.allowed) {
      return sendJson(req, res, 403, {
        error: 'forbidden',
        message: 'Request source is not in allowlist.',
        candidates: gate.candidates,
        rules: gate.rules,
        hint: 'Add your site domain, wildcard domain, or client IP in Vercel ALLOWLIST, or temporarily disable allowlist from /admin/ with ADMIN_PASSWORD.',
      }, 'null');
    }

    const result = await handleMeting(req, query);
    if (result.kind === 'redirect') return redirect(req, res, result.location, result.status || 302, gate.corsOrigin || '*');
    if (result.kind === 'text') return sendText(req, res, result.status || 200, result.text, 'text/plain; charset=utf-8', gate.corsOrigin || '*');
    return sendMaybeJsonp(req, res, result.status || 200, result.data, query.callback || query.jsonp, gate.corsOrigin || '*');
  } catch (error) {
    return sendJson(req, res, 500, {
      error: 'internal_error',
      message: error.message,
      stack: process.env.DEBUG_RESPONSE === '1' ? error.stack : undefined,
    }, '*');
  }
};
