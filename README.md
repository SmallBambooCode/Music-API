# Meting Enhanced Vercel v5

一个可以部署到 Vercel 的 Meting-API 兼容适配层。

## v5 修复内容

- 管理员接口 `/admin/allowlist`、`/admin/status` 绕过来源白名单，但仍要求 `ADMIN_PASSWORD`。
- 管理页使用相对路径请求，增加错误输出，不再出现“点了没反应但不知道为什么”。
- `NCM_COOKIE` 支持拆成 `NCM_MUSIC_U` 和 `NCM_CSRF`，避免 Vercel Import `.env` 时被分号/空格影响。
- 播放 URL 增强：自动多音质尝试 `NCM_LEVELS`。
- 播放 URL 回退：支持 `METING_FALLBACK_API`，可设置 `URL_PROVIDER=fallback-first` 或 `fallback-only`。
- `/health` 会返回环境变量是否存在、Cookie 长度、白名单数量、fallback 是否配置等诊断信息，不泄露具体密钥。

## 重要说明

这个项目不是“绕过会员/版权限制”的工具。`NCM_MUSIC_U` / `NCM_COOKIE` 只用于让上游接口按你自己的账号状态返回可访问资源。如果你的账号没有某首歌或某个音质的权限，上游可能仍然不会返回可播放 URL。

## Vercel 环境变量

推荐导入：

```env
NCM_MUSIC_U=你的 MUSIC_U
NCM_CSRF=你的 __csrf
NCM_LEVEL=standard
NCM_LEVELS=standard,higher,exhigh,lossless
ALLOWLIST=yuncan.xyz,*.yuncan.xyz
ADMIN_PASSWORD=换成你的管理员密码
CACHE_TTL_JSON=300
CACHE_TTL_URL=45
METING_FALLBACK_API=https://你原先的-meting-api-域名/api
URL_PROVIDER=fallback-first
ALLOWLIST_DISABLED_DEFAULT=false
DEBUG_RESPONSE=0
```

如果你没有旧 Meting API，就先留空：

```env
METING_FALLBACK_API=
URL_PROVIDER=enhanced-then-fallback
```

如果你原来的 Meting API 播放最稳，强烈建议：

```env
METING_FALLBACK_API=https://你原先的-meting-api-域名/api
URL_PROVIDER=fallback-first
```

## 部署后必须 Redeploy

Vercel 的环境变量修改只对新部署生效。修改或导入变量后，需要在 Deployments 里 Redeploy 最新部署。

## 管理员页面

访问：

```text
https://你的-vercel-域名.vercel.app/admin
```

输入 `ADMIN_PASSWORD` 后可以：

- 读取当前环境变量白名单
- 查看当前请求来源与 IP
- 查看环境变量诊断状态
- 临时关闭白名单
- 重新开启白名单

注意：临时关闭白名单不是持久化设置。它只存在于当前 Vercel Serverless 实例的内存里，用于测试接口是否被白名单挡住。测试完请重新开启。

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

未命中白名单的 API 请求会返回 403。

## 接口

### 单曲

```text
/api?server=netease&type=song&id=473403185
```

### 歌单

```text
/api?server=netease&type=playlist&id=6907557348&limit=50
```

### 歌词

```text
/api?server=netease&type=lrc&id=473403185
```

### 封面

```text
/api?server=netease&type=pic&id=473403185
```

### 播放地址诊断

```text
/api?server=netease&type=url&id=473403185&json=1
```

返回示例：

```json
{
  "url": "https://...",
  "meta": {
    "provider": "meting-fallback"
  }
}
```

如果失败，会返回 `detail.attempts`，用于判断是 Cookie、音质、fallback 还是白名单的问题。

## MetingJS 用法

```html
<meting-js
  server="netease"
  type="playlist"
  id="你的歌单ID"
  api="https://你的-vercel-域名.vercel.app/api?server=:server&type=:type&id=:id&auth=:auth&r=:r">
</meting-js>
```

## 本地语法检查

```bash
npm install
npm run lint:syntax
```
