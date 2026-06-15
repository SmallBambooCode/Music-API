# Meting Enhanced Vercel v6

这是一个兼容 Meting-API 输出格式的 Vercel Serverless 适配层。

## v6 修复点

- 管理员页面不再请求 `/admin/allowlist`，改为静态页面 `/admin/` 调用单一函数 `/api?action=admin-status`。
- 管理员开关和播放 API 都在同一个 `/api` Serverless 函数内，临时关闭白名单的内存状态能影响同一个运行实例内的 API 请求。
- 白名单只从 Vercel 环境变量 `ALLOWLIST` 读取，不支持网页增删。
- 播放地址支持旧 Meting-API 回退：`METING_FALLBACK_API` + `URL_PROVIDER=fallback-first`。
- Cookie 拆分为 `NCM_MUSIC_U`、`NCM_CSRF`，避免 `.env` 导入时分号和空格解析问题。

## Vercel 环境变量

建议导入：

```env
NCM_MUSIC_U=...
NCM_CSRF=...
NCM_LEVEL=standard
NCM_LEVELS=standard,higher,exhigh,lossless
ALLOWLIST=yuncan.xyz,*.yuncan.xyz,localhost,127.0.0.1
ADMIN_PASSWORD=...
ALLOWLIST_DISABLED_DEFAULT=false
CACHE_TTL_JSON=300
CACHE_TTL_URL=45
METING_FALLBACK_API=https://你原先的旧MetingAPI域名/api
URL_PROVIDER=fallback-first
DEBUG_RESPONSE=0
```

> 注意：如果不设置 `METING_FALLBACK_API`，播放地址只能走 enhanced 上游；如果你的旧 Meting-API 原本能播，务必把旧接口 base URL 填进去。

## 入口

- 管理页：`/admin/`
- 健康检查：`/api?action=health`
- Meting 兼容 API：`/api?server=netease&type=playlist&id=...`
- 播放地址测试：`/api?server=netease&type=url&id=歌曲ID&json=1`

## MetingJS 示例

```html
<meting-js
  server="netease"
  type="playlist"
  id="6907557348"
  api="https://你的-vercel-域名.vercel.app/api?server=:server&type=:type&id=:id&auth=:auth&r=:r">
</meting-js>
```

## 重要说明

- 修改 Vercel 环境变量后必须 Redeploy 当前 Production/Preview 部署。
- `MUSIC_U` 是账号登录态，不要提交到 GitHub。
- 本项目不绕过会员或版权限制。`NCM_COOKIE`/`NCM_MUSIC_U` 只用于请求账号本身有权限访问的内容。
