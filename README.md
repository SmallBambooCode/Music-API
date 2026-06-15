# Meting Enhanced Vercel

一个可以部署到 Vercel 的 Meting-API 兼容适配层：

- 保留原 Meting-API 的调用风格：`/api?server=netease&type=playlist&id=...`
- 返回字段保持 `title / author / pic / url / lrc`，适配 MetingJS / APlayer 常见用法
- 后端使用 `@neteasecloudmusicapienhanced/api`，也可通过 `NCM_API_BASE` 指向单独部署的 api-enhanced 服务
- 支持 `NCM_COOKIE` 登录态：只请求你账号本来有权限获得的音源 URL
- 支持管理员页面配置白名单：`/admin`
- 未命中白名单的请求不能获取歌曲、歌单、歌词、封面、播放地址等数据
- 不实现、不开启、也不透传 `unblock=true` 或全局解灰能力

## 重要说明

这个项目不是“绕过会员/版权限制”的工具。`NCM_COOKIE` 只用于让上游接口按你的账号状态返回可访问资源。如果你的账号没有某首歌/某个音质的权限，上游可能仍然不会返回可播放 URL。

`NCM_COOKIE` 等同于你的网页登录态，泄露后可能导致账号被别人使用。不要发给任何人，不要写进 Git，不要放到前端代码里，只能放在 Vercel 环境变量里。

## 快速部署到 Vercel

1. 解压本项目。
2. 上传到 GitHub。
3. 在 Vercel 导入仓库并 Deploy。
4. 在 Vercel Project Settings → Environment Variables 配置：

```bash
NCM_COOKIE=MUSIC_U=你的值; __csrf=你的值; os=pc
NCM_LEVEL=exhigh
ALLOWLIST=yuncan.xyz,*.yuncan.xyz
ADMIN_PASSWORD=换成一个很长的随机密码
```

5. 访问：

```text
https://你的项目域名.vercel.app/admin
```

如果你只使用 `ALLOWLIST` 环境变量，管理员页面只能读取，不能持久化保存。
如果要在管理员页面保存白名单，需要配置 Upstash Redis：

```bash
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
ALLOWLIST_REDIS_KEY=meting-enhanced:allowlist:v1
```

Vercel Marketplace 里的 Upstash Redis 集成会自动把所需环境变量加到项目里。

## NCM_COOKIE 怎么获得

只建议获取你自己账号的 Cookie。

1. 用电脑浏览器打开网易云音乐网页版并登录自己的账号。
2. 按 `F12` 打开开发者工具。
3. 切到 `Application` / `应用`。
4. 左侧找到 `Cookies`，选择网易云音乐域名。
5. 找到并复制这些值：
   - `MUSIC_U`
   - `__csrf`，如果有
6. 在 Vercel 环境变量里写成：

```bash
NCM_COOKIE=MUSIC_U=复制到的值; __csrf=复制到的值; os=pc
```

如果没有 `__csrf`，可以先只填：

```bash
NCM_COOKIE=MUSIC_U=复制到的值; os=pc
```

不要复制到 README、GitHub、前端 JS、聊天记录或公开 issue。

## 白名单规则

白名单会检查请求的：

- `Origin`
- `Referer`
- 客户端 IP，即 `x-forwarded-for` / `x-real-ip` 等

支持格式：

```text
yuncan.xyz
https://yuncan.xyz
*.yuncan.xyz
124.221.251.223
120.85.43.0/24
```

默认建议至少配置：

```bash
ALLOWLIST=yuncan.xyz,*.yuncan.xyz
```

如果你要本地调试，可以临时加：

```bash
ALLOWLIST=yuncan.xyz,*.yuncan.xyz,localhost,127.0.0.1,::1
```

不建议生产环境使用 `*`。

## 管理员页面

访问：

```text
/admin
```

需要环境变量：

```bash
ADMIN_PASSWORD=你的管理员密码
```

页面功能：

- 输入管理员密码
- 读取当前白名单
- 修改白名单
- 保存到 Upstash Redis

没有配置 Upstash Redis 时，页面不能持久化保存，只能通过 `ALLOWLIST` 环境变量控制。

## Meting API 兼容接口

### 单曲

```text
/api?server=netease&type=song&id=473403185
```

### 歌单

```text
/api?server=netease&type=playlist&id=6907557348&limit=50
```

### 搜索

```text
/api?server=netease&type=search&id=关键词
```

### 歌手热门歌曲

```text
/api?server=netease&type=artist&id=12441107
```

### 歌词

```text
/api?server=netease&type=lrc&id=473403185
```

### 封面

```text
/api?server=netease&type=pic&id=473403185
```

### 播放地址

默认 302 跳转到音频 URL：

```text
/api?server=netease&type=url&id=473403185
```

调试时返回 JSON：

```text
/api?server=netease&type=url&id=473403185&json=1
```

## MetingJS 示例

```html
<meting-js
  server="netease"
  type="playlist"
  id="6907557348"
  api="https://你的-vercel-域名.vercel.app/api?server=:server&type=:type&id=:id&auth=:auth&r=:r">
</meting-js>
```

你的站点域名必须在白名单里，否则接口会返回 `403`。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NCM_COOKIE` | 网易云登录态 Cookie，可选但推荐。 |
| `NCM_LEVEL` | 音质等级：`standard`、`higher`、`exhigh`、`lossless`、`hires`、`jyeffect`、`sky`、`dolby`、`jymaster`。 |
| `NCM_API_BASE` | 可选。若你单独部署了 api-enhanced，可以填它的根地址。 |
| `ALLOWLIST` | 只读环境变量白名单。 |
| `ADMIN_PASSWORD` | 管理员页面密码。 |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL。 |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token。 |
| `ALLOWLIST_REDIS_KEY` | 白名单保存 key，默认 `meting-enhanced:allowlist:v1`。 |
| `CACHE_TTL_JSON` | 歌曲/歌单/歌词缓存秒数，默认 `300`。 |
| `CACHE_TTL_URL` | 播放 URL 缓存秒数，默认 `60`。 |

## 本地开发

```bash
npm install
cp .env.example .env.local
npm run dev
```

语法检查：

```bash
npm run lint:syntax
```

## 常见问题

### 1. 为什么管理员页面保存失败？

因为没有配置 Upstash Redis。Vercel Serverless 不适合把配置持久化写入本地文件，所以页面保存需要 Redis 这类外部存储。

### 2. 为什么白名单里有域名还是 403？

浏览器请求可能没有 `Origin`，但通常会有 `Referer`。如果你是服务端请求，则主要靠客户端 IP 命中白名单。可以在 `/admin` 页面读取状态，查看 `requestCandidates`。

### 3. 为什么 VIP 歌曲还是没有播放地址？

说明上游没有给当前账号返回可播放 URL。这个适配层不会绕过版权或会员限制。
