# Meting Enhanced Vercel v4

一个可以部署到 Vercel 的 Meting-API 兼容适配层。

v4 重点改动：

- 白名单**只能从 Vercel 环境变量 `ALLOWLIST` 设置**。
- `/admin` 页面不再支持新增、删除、保存白名单。
- `/admin` 页面只保留一个测试开关：管理员密码正确后，可以**临时关闭/重新开启白名单**。
- 这个临时开关只保存在当前 Serverless 运行实例内，重新部署、冷启动、实例回收或区域切换后可能自动恢复。
- 保留 v3 的播放 URL 回退机制：`METING_FALLBACK_API` + `URL_PROVIDER`。

## 重要说明

这个项目不是“绕过会员/版权限制”的工具。`NCM_COOKIE` 只用于让上游接口按你的账号状态返回可访问资源。如果你的账号没有某首歌/某个音质的权限，上游可能仍然不会返回可播放 URL。

## 快速部署到 Vercel

1. 解压本项目。
2. 上传到 GitHub。
3. 在 Vercel 导入仓库并 Deploy。
4. 在 Vercel Project Settings → Environment Variables 配置环境变量。
5. 修改环境变量后，必须 Redeploy。

## 推荐环境变量

```bash
NCM_COOKIE=MUSIC_U=你的值; __csrf=你的值; os=pc
NCM_LEVEL=exhigh
ALLOWLIST=yuncan.xyz,*.yuncan.xyz
ADMIN_PASSWORD=换成一个长密码
CACHE_TTL_JSON=300
CACHE_TTL_URL=60
METING_FALLBACK_API=https://你原先的-meting-api-域名/api
URL_PROVIDER=fallback-first
```

## 白名单规则

`ALLOWLIST` 支持逗号分隔或换行分隔：

```text
yuncan.xyz,*.yuncan.xyz,124.221.251.223,120.85.43.0/24
```

支持格式：

```text
yuncan.xyz
https://yuncan.xyz
*.yuncan.xyz
124.221.251.223
120.85.43.0/24
```

未命中白名单的请求会返回：

```json
{
  "error": "forbidden",
  "message": "Request source is not in allowlist."
}
```

## 管理员页面

访问：

```text
https://你的-vercel-域名.vercel.app/admin
```

输入 `ADMIN_PASSWORD` 后可以：

- 读取当前环境变量白名单
- 查看当前请求来源与 IP
- 临时关闭白名单
- 重新开启白名单

注意：临时关闭白名单不是持久化设置。它只存在于当前 Vercel Serverless 实例的内存里，用于测试接口是否被白名单挡住。测试完请重新开启。

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

调试时可以返回 JSON：

```text
/api?server=netease&type=url&id=473403185&json=1
```

## MetingJS 使用示例

```html
<meting-js
  server="netease"
  type="playlist"
  id="6907557348"
  api="https://你的-vercel-域名.vercel.app/api?server=:server&type=:type&id=:id&auth=:auth&r=:r">
</meting-js>
```

## 播放 URL 回退机制

如果你原先的 Meting-API 能播放普通歌曲，但新版 api-enhanced 拿不到 URL，可以配置：

```bash
METING_FALLBACK_API=https://你原先的-meting-api-域名/api
URL_PROVIDER=fallback-first
```

`URL_PROVIDER` 可选：

```text
enhanced-then-fallback   # 默认：先用 api-enhanced，失败再走旧 Meting-API
fallback-first           # 播放 URL 优先走旧 Meting-API，歌单/歌词/封面仍走新接口
```

如果你现在最怕再不能播放，建议先设置：

```bash
URL_PROVIDER=fallback-first
```

## 增强接口透传

也可以访问 api-enhanced 风格的路径：

```text
/enhanced/song/url/v1?id=473403185&level=exhigh
/enhanced/song/detail?ids=473403185
/enhanced/lyric?id=473403185
```

同样不会透传 `unblock=true`。

## 本地开发

```bash
npm install
npm run lint:syntax
npx vercel dev
```

## 紧急回滚

如果部署后播放异常，把前端 MetingJS 的 `api` 改回你原先的 Meting-API 地址即可立刻恢复。不要先删旧项目。
