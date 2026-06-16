# Meting Enhanced Adapter v12

v12 基于你已经跑通的 v11 继续做两件事：

1. 保留本地传统方式：`npx @neteasecloudmusicapienhanced/api@latest` 默认跑 3000，适配器跑 3017。
2. 重新加入白名单管理页 `/admin`，但只做“临时关闭 / 重新开启 / 读取状态”，白名单规则只从环境变量 `ALLOWLIST` 读取。

## 本地推荐跑法

窗口 1：

```powershell
npx @neteasecloudmusicapienhanced/api@latest
```

确认看到：

```text
Server started successfully @ http://localhost:3000
```

窗口 2：

```powershell
node server.js
```

打开：

```text
http://127.0.0.1:3017/test
http://127.0.0.1:3017/admin
```

## 一键跑法

```powershell
npm run both
```

v12 已把 Windows 的 `spawn` 改成 `shell: true`，不再使用 v11 那种容易出 `spawn EINVAL` 的写法。

## 端口规则

不要写共用 `PORT`。

```env
API_ENHANCED_PORT=3000
ADAPTER_PORT=3017
NCM_API_BASE=http://127.0.0.1:3000
```

api-enhanced 自己只认识 `PORT`，所以脚本启动它时会临时注入：

```text
PORT=API_ENHANCED_PORT
```

适配器自己只读：

```text
ADAPTER_PORT
```

## 管理页

```text
/admin
```

管理员接口：

```text
/api?action=admin-status&password=你的密码
/api?action=admin-toggle&disabled=true&password=你的密码
/api?action=admin-toggle&disabled=false&password=你的密码
```

密码错误会返回：

```json
{
  "ok": false,
  "auth": false,
  "reason": "BAD_PASSWORD",
  "message": "管理员密码不正确。"
}
```

未配置 `ADMIN_PASSWORD` 会返回：

```json
{
  "ok": false,
  "auth": false,
  "reason": "ADMIN_PASSWORD_NOT_CONFIGURED"
}
```

## 白名单规则

`ALLOWLIST` 示例：

```env
ALLOWLIST=localhost,127.0.0.1,yuncan.xyz,*.yuncan.xyz
```

支持：

```text
localhost
127.0.0.1
yuncan.xyz
*.yuncan.xyz
120.85.43.0/24
```

白名单只拦截音乐 API，不拦截 `/admin`、`/api?action=admin-status`、`/api?action=admin-toggle`、`/api?action=health`。

## Vercel

Vercel 不跑两个常驻端口。v12 在 Vercel 默认使用 `module` 模式：

```env
PROVIDER_MODE=module
```

本地传统方式使用：

```env
PROVIDER_MODE=http
```

如果 Vercel 上 module 模式不稳定，可以单独部署 api-enhanced，然后给本项目设置：

```env
PROVIDER_MODE=http
NCM_API_BASE=https://你的-api-enhanced-域名
```
