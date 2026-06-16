# Meting Enhanced Vercel v7

这是一个兼容 Meting-API 输出格式的 Vercel Serverless 适配层。

## v7 修复点

- 不再要求 `METING_FALLBACK_API`，不会再让你填“旧 Meting-API 地址”。
- 播放地址逻辑改为：先走 api-enhanced 的 `/song/url/v1`、`/song/url`；如果上游不给 url，则按 xizeyoupan/Meting-API 的逻辑返回网易云 `https://music.163.com/song/media/outer/url?id=xxx.mp3`。
- 管理员页增加无 JS 兜底表单：输入密码后直接打开 JSON，能明确看到 `unauthorized`、`hasAdminPassword:false`、白名单状态等，不会只停在“等待读取”。
- 管理员接口仍然走同一个 `/api` 函数：`/api?action=admin-status`、`/api?action=admin-toggle`，临时关闭白名单能影响同一运行实例内的 Meting API。
- 白名单只从 Vercel 环境变量 `ALLOWLIST` 读取，不支持网页增删。

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
DEBUG_RESPONSE=0
```

> 修改 Vercel 环境变量后必须 Redeploy 当前 Production / Preview 部署。

## 入口

- 首页：`/`
- 管理页：`/admin/`
- 健康检查：`/api?action=health`
- 管理状态：`/api?action=admin-status&password=你的密码`
- 临时关闭白名单：`/api?action=admin-toggle&disabled=true&password=你的密码`
- 重新开启白名单：`/api?action=admin-toggle&disabled=false&password=你的密码`
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

## 排错顺序

1. 访问 `/api?action=health`，确认 `hasAdminPassword` 和 `hasNcmMusicU`。
2. 访问 `/admin/`，用“无 JS 兜底表单”读取状态。
3. 访问 `/api?action=admin-toggle&disabled=true&password=你的密码` 临时关闭白名单。
4. 访问 `/api?server=netease&type=url&id=歌曲ID&json=1`，确认返回 `url`。
5. 测试完成后重新开启白名单。

## 重要说明

`MUSIC_U` 是账号登录态，不要提交到 GitHub。本项目不会绕过会员或版权限制；`NCM_MUSIC_U` 只用于请求账号本身有权限访问的内容。若 api-enhanced 上游没有返回 url，v7 会按原 Meting-API 的兼容方式返回网易云 outer-url，避免播放器直接拿到空地址。
