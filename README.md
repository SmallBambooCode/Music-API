# Meting Enhanced Adapter v13

一个面向 MetingJS/APlayer 的网易云音乐适配器。项目核心目标是：

- 继续保留 MetingJS 习惯的 `server/type/id/api` 调用格式；
- 底层数据源接入 `NeteaseCloudMusicApiEnhanced/api-enhanced`；
- 输出统一转换为 MetingJS 需要的 `title / author / url / pic / lrc`；
- 本地可通过传统双服务方式调试，Vercel 可通过 module 模式部署；
- 提供只读环境变量白名单，以及管理员临时开关白名单的测试入口。

> 本项目不是解灰工具，不开放 `/song/url/match`，也不会向底层传递 `unblock` 参数。播放 URL 仅使用 api-enhanced 的正常 `/song/url/v1`、`/song/url` 能力，或者在你显式设置 `URL_STRATEGY=enhanced-then-outer` 时使用网易云 outer URL 兜底。

---

## 项目来源与关系

本项目是一个适配层，开发思路来自两个开源项目：

1. `xizeyoupan/Meting-API`  
   这个项目提供了 MetingJS 常用的 API 输出结构，前端播放器通过 `server/type/id` 请求，最终得到 `title / author / url / pic / lrc` 这类字段。

2. `NeteaseCloudMusicApiEnhanced/api-enhanced`  
   这个项目是网易云音乐第三方 Node.js API，提供搜索、歌单、歌词、评论、歌曲 URL 等更完整的底层接口。其 README 说明默认服务端口是 3000，指定端口需要设置 `PORT`；敏感信息如 cookie 推荐放在部署平台环境变量中。

v13 做的是：**把 api-enhanced 的底层接口结果转换成 MetingJS 可直接消费的格式**。

---

## 目录结构

```text
.
├── api/index.js                  # Vercel Serverless 入口
├── lib/
│   ├── app.js                    # HTTP 路由与业务入口
│   ├── allowlist.js              # 白名单与管理员密码逻辑
│   ├── enhanced-http-client.js   # 本地/远程 api-enhanced HTTP 客户端
│   ├── enhanced-module-client.js # Vercel module 模式客户端
│   ├── meting.js                 # api-enhanced → MetingJS 格式转换
│   └── provider.js               # http/module provider 自动选择
├── public/
│   ├── test.html                 # 调试台
│   └── admin.html                # 白名单管理页
├── scripts/
│   ├── start-enhanced.js         # 启动 api-enhanced
│   ├── start-both.js             # 同时启动 api-enhanced 与适配器
│   └── doctor.js                 # 命令行诊断
├── server.js                     # 本地 Node 服务入口
├── vercel.json
└── package.json
```

---

## 本地运行：推荐传统双窗口

### 1. 启动 api-enhanced

```powershell
npx @neteasecloudmusicapienhanced/api@latest
```

正常应看到：

```text
Server started successfully @ http://localhost:3000
```

### 2. 启动适配器

```powershell
node server.js
```

默认地址：

```text
http://127.0.0.1:3017/test
http://127.0.0.1:3017/admin
```

### 3. 本地 `.env.local`

复制：

```powershell
copy .env.example .env.local
```

本地建议：

```env
ADAPTER_PORT=3017
API_ENHANCED_PORT=3000
NCM_API_BASE=http://localhost:3000
PROVIDER_MODE=auto
ALLOWLIST=
ALLOW_LOCAL=true
ADMIN_PASSWORD=
```

注意：不要再写共用的 `PORT=3007`。api-enhanced 本体只认识 `PORT`，适配器不应该和它共用同一个端口变量。

---

## 一键运行

```powershell
npm run both
```

v13 的 `npm run both` 使用 Windows 兼容的 `shell: true`，比 v11 的 `spawn` 方式更稳。它会把：

```text
API_ENHANCED_PORT=3000
```

转换成 api-enhanced 需要的：

```text
PORT=3000
```

然后再启动适配器。

---

## Vercel 部署

Vercel 不能访问你电脑上的：

```text
http://localhost:3000
```

在 Vercel 里，`localhost` 只代表 Vercel 当前 Serverless 容器自己，不是你的电脑，也不是另一个常驻服务。因此 Vercel 上不要设置：

```env
NCM_API_BASE=http://localhost:3000
NCM_API_BASE=http://127.0.0.1:3000
```

v13 的 provider 规则：

```text
本地 auto + NCM_API_BASE=http://localhost:3000  => http 模式
Vercel auto + 无远程 NCM_API_BASE              => module 模式
Vercel auto + NCM_API_BASE 是 localhost/127     => 自动忽略并切 module
Vercel auto + NCM_API_BASE 是远程 https 地址    => http 模式
PROVIDER_MODE=module                           => 强制 module
PROVIDER_MODE=http                             => 强制 http
```

Vercel 推荐环境变量：

```env
PROVIDER_MODE=module
NCM_MUSIC_U=你的 MUSIC_U
NCM_CSRF=你的 __csrf
NCM_LEVEL=standard
NCM_LEVELS=standard,higher,exhigh,lossless,hires
URL_STRATEGY=enhanced-only
PLAYLIST_LIMIT=100
REQUEST_TIMEOUT=15000
DEBUG_RESPONSE=0
ALLOWLIST=
ALLOW_LOCAL=false
ALLOWLIST_DISABLED_DEFAULT=false
ADMIN_PASSWORD=你的管理员密码
```

修改 Vercel 环境变量后，必须 Redeploy。

---

## MetingJS 接入

```html
<meting-js
  server="netease"
  type="playlist"
  id="60198"
  api="https://你的域名/api?server=:server&type=:type&id=:id&r=:r">
</meting-js>
```

输出格式示例：

```json
[
  {
    "title": "歌曲名",
    "author": "歌手",
    "url": "https://你的域名/api?server=netease&type=url&id=174944",
    "pic": "https://p*.music.126.net/xxx.jpg",
    "lrc": "https://你的域名/api?server=netease&type=lrc&id=174944"
  }
]
```

---

## 主要 API

### 健康检查

```text
/api?action=health
```

### 诊断底层接口

```text
/api?action=probe&id=174944
```

### 歌曲播放 URL

```text
/api?server=netease&type=url&id=174944&json=1&debug=1
```

### 歌单转 MetingJS 格式

```text
/api?server=netease&type=playlist&id=60198&limit=5
```

### 搜索转 MetingJS 格式

```text
/api?server=netease&type=search&id=周杰伦&limit=5
```

### 歌曲详情转 MetingJS 格式

```text
/api?server=netease&type=song&id=174944
```

### 歌词

```text
/api?server=netease&type=lrc&id=174944
```

### 封面图跳转

```text
/api?server=netease&type=pic&id=174944
```

---

## 底层 enhanced 调试接口

调试台 `/test` 增加了底层接口测试：

```text
/api?action=enhanced&path=/search&keywords=周杰伦&limit=5&type=1
/api?action=enhanced&path=/song/detail&ids=174944
/api?action=enhanced&path=/lyric&id=174944
/api?action=enhanced&path=/check/music&id=174944
/api?action=enhanced&path=/comment/music&id=174944&limit=1
/api?action=enhanced&path=/playlist/track/all&id=60198&limit=5
/api?action=enhanced&path=/album&id=32311
/api?action=enhanced&path=/artist/songs&id=6452&limit=5
```

为了避免误用，`action=enhanced` 不开放包含 `match` 或 `unblock` 的路由。

---

## 白名单与管理员页

管理页：

```text
/admin
```

白名单只从环境变量读取：

```env
ALLOWLIST=localhost,127.0.0.1,yuncan.xyz,*.yuncan.xyz
```

支持格式：

```text
localhost
127.0.0.1
yuncan.xyz
*.yuncan.xyz
120.85.43.0/24
```

管理员接口永远不受白名单拦截，但必须校验 `ADMIN_PASSWORD`：

```text
/api?action=admin-status&password=你的密码
/api?action=admin-toggle&disabled=true&password=你的密码
/api?action=admin-toggle&disabled=false&password=你的密码
```

密码错误会明确返回：

```json
{
  "ok": false,
  "auth": false,
  "reason": "BAD_PASSWORD",
  "message": "管理员密码不正确。"
}
```

未配置管理员密码会明确返回：

```json
{
  "ok": false,
  "auth": false,
  "reason": "ADMIN_PASSWORD_NOT_CONFIGURED",
  "message": "服务端没有配置 ADMIN_PASSWORD。"
}
```

---

## 常见问题

### 1. 为什么本地 `127.0.0.1:3000` 不行，但 `localhost:3000` 可以？

这通常是 Windows/Node/fetch 对 IPv4、IPv6、本机解析的差异导致的。v13 本地默认使用：

```env
NCM_API_BASE=http://localhost:3000
```

### 2. 为什么 Vercel 上 `localhost:3000` 不行？

Vercel 的函数环境里没有你本机那个 api-enhanced 服务。`localhost` 只代表当前 Serverless 容器。v13 在 Vercel 上会自动切 module 模式，除非你提供一个真正公网可访问的远程 `NCM_API_BASE`。

### 3. 为什么歌单能出、播放 URL 不出？

先打开：

```text
/api?action=health
/api?action=probe&id=174944
```

重点看：

```text
provider.selectedProvider
provider.ok
attempts[].status
attempts[].hasUrl
```

如果 `hasUrl=false`，说明底层 api-enhanced 没有给该歌曲返回播放 URL。默认 `URL_STRATEGY=enhanced-only` 会明确失败，不假装成功。

---

## 许可与声明

本项目是适配层示例工程。底层接口能力来自 `NeteaseCloudMusicApiEnhanced/api-enhanced`，MetingJS 输出约定参考 `xizeyoupan/Meting-API` 风格。请遵守相关平台服务条款与版权规则，不要把 Cookie、管理员密码等敏感信息提交到 GitHub。
