# Ourcraft Music API

[![Version](https://img.shields.io/badge/version-0.28.0-blue.svg)](https://github.com/Yuncan050115/ourcraft-music-api)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/平台-网易云%20%7C%20酷狗%20%7C%20酷我-18181b)](#平台支持)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![MetingJS](https://img.shields.io/badge/MetingJS-兼容-ff6b6b)](https://github.com/metowolf/Meting)
[![Deploy](https://img.shields.io/badge/部署-自托管%20%7C%20Vercel-9cf)](#部署)

一个多平台音乐聚合 API 服务, 为 [Ourcraft](https://github.com/Yuncan050115) 项目提供统一的音乐接口, 同时可作为独立 API 服务于 **MetingJS**、**Minecraft ZMusicGUI**、**Node.js 应用** 等客户端。

> v0.28.0 起已移除所有用户登录/绑定功能 (VIP 登录无法在服务器端实现), 仅支持免费歌曲播放; 网易云若服务端配置 `NCM_COOKIE` 可直连 VIP 歌曲。

## 平台支持

| 平台 | 搜索 | 免费歌曲 | VIP 歌曲 | 歌单 |
|------|:----:|:--------:|:--------:|:----:|
| 网易云 | ✅ | ✅ | ✅ (服务端配置 cookie) | ✅ |
| 酷狗 | ✅ | ✅ | ❌ (IP 绑定) | ✅ |
| 酷我 | ✅ | ✅ | ❌ | ❌ |

> **酷狗 VIP 说明**: 酷狗的 `t` token 绑定浏览器 IP, 服务器端调用 `wwwapi.kugou.com` 会返回 `err_code=20006` (token 绑定其他 IP), 因此服务器端无法获取 VIP 歌曲 URL。这是酷狗服务端的限制, 非本 API 问题。

## 接口

### MetingJS 兼容格式

```
GET /api?server={platform}&type={type}&id={id}
```

| 参数 | 说明 | 示例 |
|------|------|------|
| `server` | 平台 | `netease` / `kugou` / `kuwo` |
| `type` | 类型 | `url` / `search` / `song` / `playlist` / `lrc` / `song_full` |
| `id` | 歌曲 ID / 关键词 / 歌单 ID | `174944` / `周杰伦` / `60198` |

### type 说明

| type | 返回格式 | 说明 |
|------|----------|------|
| `url` | 302 重定向 / JSON | 播放 URL (默认 302 跳转, `json=1` 返回 JSON) |
| `search` | JSON | 搜索歌曲列表 |
| `song` | JSON | 单曲信息 (MetingJS 格式) |
| `song_full` | JSON | 完整单曲 (name + url + lyric + time) |
| `lrc` | 文本 | 歌词 (LRC 格式) |
| `playlist` | JSON | 歌单内歌曲列表 (MetingJS 格式) |
| `playlist_search` | JSON | 搜索歌单 |

### 特殊端点

| 端点 | 说明 |
|------|------|
| `GET /api?action=health` | 健康检查 (含白名单状态) |
| `GET /api?action=enhanced&path=/xxx` | 网易云 enhanced 透传 |
| `GET /admin` | 白名单管理 (需 `ADMIN_PASSWORD`) |
| `GET /proxy?url=xxx` | 音频代理 (防盗链域名) |

### 示例

```bash
# MetingJS 兼容 - 获取播放 URL
curl "https://music.yuncan.xyz/api?server=netease&type=url&id=174944"

# 搜索歌曲
curl "https://music.yuncan.xyz/api?server=netease&type=search&id=周杰伦&limit=10"

# 获取歌单
curl "https://music.yuncan.xyz/api?server=netease&type=playlist&id=60198&limit=100"

# 完整单曲信息 (含歌词)
curl "https://music.yuncan.xyz/api?server=netease&type=song_full&id=174944&json=1"

# 健康检查
curl "https://music.yuncan.xyz/api?action=health"
```

## 部署

### 自托管 (推荐)

```bash
git clone https://github.com/Yuncan050115/ourcraft-music-api.git
cd ourcraft-music-api
npm install
cp .env.example .env
# 编辑 .env 配置环境变量
npm start
# 或用 PM2 守护
pm2 start server.js --name ourcraft-music-api
```

服务默认监听 `0.0.0.0:3000` (可通过 `ADAPTER_PORT` 修改)。

### Vercel

1. Fork 仓库到 GitHub
2. Vercel 导入项目
3. 配置环境变量 (见下表)
4. 部署完成

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADAPTER_PORT` | `3017` | 服务端口 |
| `NCM_LEVEL` | `standard` | 网易云音质 (standard/exhigh/lossless/hires) |
| `NCM_LEVELS` | `standard,exhigh,lossless,hires` | 可选音质列表 |
| `URL_STRATEGY` | `enhanced-only` | URL 策略 (enhanced-only / enhanced-then-outer) |
| `NCM_MUSIC_U` | — | 服务端网易云 MUSIC_U cookie (可选, 配置后可访问 VIP 歌曲) |
| `NCM_CSRF` | — | 服务端网易云 __csrf cookie |
| `NCM_COOKIE` | — | 服务端网易云完整 Cookie (优先级最高) |
| `PLAYLIST_LIMIT` | `100` | 歌单最大歌曲数 |
| `REQUEST_TIMEOUT` | `15000` | 请求超时 (毫秒) |
| `DEBUG_RESPONSE` | `1` | 调试模式 |
| `ALLOWLIST` | — | 白名单规则 (逗号分隔) |
| `ALLOW_LOCAL` | `true` | 允许本地访问 |
| `ALLOWLIST_DISABLED_DEFAULT` | `false` | 默认是否禁用白名单 |
| `ADMIN_PASSWORD` | — | 管理员密码 |

### 白名单配置

`ALLOWLIST` 支持以下格式 (逗号分隔):

| 格式 | 示例 | 说明 |
|------|------|------|
| 域名 | `example.com` | 精确匹配域名 |
| 通配符域名 | `*.example.com` | 匹配所有子域 |
| IP | `1.2.3.4` | 精确匹配 IP |
| CIDR | `10.0.0.0/8` | 匹配 IP 段 |

示例:
```env
ALLOWLIST=mcyc.top,bgp.strynir.cloud,yuncan.xyz,*.yuncan.xyz
ADMIN_PASSWORD=your_password
```

白名单通过 `Origin` / `Referer` / `Host` 头判断来源, 本地访问 (`localhost` / `127.0.0.1`) 永远允许。

## 功能

### 多平台搜索
- 网易云、酷狗、酷我三大平台
- 搜索结果缓存 5 分钟 (减少 API 调用)

### 网易云
- 基于 `@neteasecloudmusicapienhanced/api` 模块
- 服务端配置 `NCM_COOKIE` 后可直连 VIP 歌曲
- 多音质回退 (standard / exhigh / lossless / hires)
- enhanced 模式透传任意 api-enhanced 模块 (歌单搜索/详情)

### 酷狗音乐
- 搜索、免费歌曲播放、歌词、歌单
- VIP 歌曲因 IP 绑定无法服务器端获取 (详见上方说明)

### 白名单管理
- `/admin` 页面登录后可临时关闭白名单
- 支持 Origin / Referer / Host / IP / CIDR 多维度匹配
- 本地访问永远允许

## 客户端集成

### MetingJS / APlayer

```javascript
const meting = new MetingAPI({
  server: 'netease',
  type: 'playlist',
  id: '60198',
  api: 'https://music.yuncan.xyz/api'
});
```

### Minecraft ZMusicGUI

在 ZMusicGUI 配置中指定 API 地址:
```yaml
api: https://music.yuncan.xyz/api
```

### Node.js

```javascript
const resp = await fetch('https://music.yuncan.xyz/api?server=netease&type=url&id=174944&json=1');
const data = await resp.json();
if (data.ok) console.log(data.url);
```

## 构建

```bash
git clone https://github.com/Yuncan050115/ourcraft-music-api.git
cd ourcraft-music-api
npm install
npm start
```

**要求**: Node.js 18+

## 技术说明

- 网易云使用 `@neteasecloudmusicapienhanced/api` 模块, 服务端配置 cookie 可访问 VIP 歌曲
- 酷狗/酷我使用免费接口, 无需登录
- 音频代理仅用于防盗链域名 (kuwo/kugou)
- 所有 HTTP 请求使用 keepalive Agent 复用连接, 减少握手开销

## 更新日志

### v0.28.0 (2026-06-28)
- 🗑️ 移除 QQ 音乐 provider (限流超时已无法使用)
- 🗑️ 移除所有用户登录/绑定功能 (VIP 登录无法在服务器端实现)
- 🗑️ 移除绑定页面 `bind.html` 和二维码图片端点
- 🗑️ 移除网易云手机号登录 (phone_login / nc_sendcode / nc_verify)
- 🗑️ 移除网易云扫码登录 (qrLoginStart / qrLoginCheck / getQrImage)
- 🔧 简化 song_full / url 路由: 所有平台都不传 userId/token/cookie
- 🔧 保留服务端 NCM_COOKIE 环境变量 (可选, 配置后可访问 VIP 歌曲)
- 🔧 支持源精简为: netease / kugou / kuwo

### v0.27.0 (2026-06-28)
- ✨ 重做默认首页: 白色主题 + SVG 徽章 + 多平台检测
- 🔧 配置白名单环境变量 (`ALLOWLIST` + `ADMIN_PASSWORD`)

### v0.20.0
- ✨ 融合 api-enhanced, 单进程搞定

## 贡献指南

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建分支 (`git checkout -b feature/your-feature`)
3. 提交更改 (`git commit -m 'Add some feature'`)
4. 推送到分支 (`git push origin feature/your-feature`)
5. 创建 Pull Request

## 作者

**Yuncan** — [https://yuncan.xyz](https://yuncan.xyz)

## 许可证

本项目基于 [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html) 许可证开源。

```
Ourcraft Music API
Copyright (C) 2026 Yuncan

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.
```

> ⚠️ **声明**: 本软件为免费开源软件, 禁止任何形式的商业转售。使用者需自行承担合规风险, 开发者不对任何滥用行为负责。
