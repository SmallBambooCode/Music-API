# Ourcraft Music API

[![Version](https://img.shields.io/badge/version-0.27.0-blue.svg)](https://github.com/Yuncan050115/ourcraft-music-api)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/平台-网易云%20%7C%20QQ%20%7C%20酷狗%20%7C%20酷我-18181b)](#平台支持)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.html)
[![MetingJS](https://img.shields.io/badge/MetingJS-兼容-ff6b6b)](https://github.com/metowolf/Meting)
[![Deploy](https://img.shields.io/badge/部署-自托管%20%7C%20Vercel-9cf)](#部署)

一个多平台音乐聚合 API 服务, 为 [Ourcraft](https://github.com/Yuncan050115) 项目提供统一的音乐接口, 同时可作为独立 API 服务于 **MetingJS**、**Minecraft ZMusicGUI**、**Node.js 应用** 等客户端。

## 平台支持

| 平台 | 搜索 | 免费歌曲 | VIP 歌曲 | 歌单 | 登录方式 |
|------|:----:|:--------:|:--------:|:----:|----------|
| 网易云 | ✅ | ✅ | ✅ (验证码登录) | ✅ | 验证码 / Cookie |
| QQ 音乐 | ✅ | ✅ | ✅ (扫码登录) | ❌ | QQ OAuth 扫码 |
| 酷狗 | ✅ | ✅ | ❌ (IP 绑定) | ✅ | F12 Cookie |
| 酷我 | ✅ | ✅ | ❌ | ❌ | F12 Cookie |

> **酷狗 VIP 说明**: 酷狗的 `t` token 绑定浏览器 IP, 服务器端调用 `wwwapi.kugou.com` 会返回 `err_code=20006` (token 绑定其他 IP), 因此服务器端无法获取 VIP 歌曲 URL。这是酷狗服务端的限制, 非本 API 问题。

## 接口

### MetingJS 兼容格式

```
GET /api?server={platform}&type={type}&id={id}
```

| 参数 | 说明 | 示例 |
|------|------|------|
| `server` | 平台 | `netease` / `qq` / `kugou` / `kuwo` |
| `type` | 类型 | `url` / `search` / `song` / `playlist` / `lrc` / `song_full` |
| `id` | 歌曲 ID / 关键词 / 歌单 ID | `174944` / `周杰伦` / `60198` |
| `userid` | 用户 ID (可选) | — |
| `token` | 鉴权 token (可选) | — |
| `cookie` | 完整 Cookie (可选, 优先级最高) | `KugooID=xxx; t=yyy` |

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
| `GET /bind` | 账号绑定页面 (QQ 扫码 / 网易云验证码) |
| `GET /admin` | 白名单管理 (需 `ADMIN_PASSWORD`) |
| `GET /qr/qq?token=xxx` | QQ 登录二维码图片 |
| `GET /qr/netease?token=xxx` | 网易云登录二维码图片 |
| `GET /proxy?url=xxx` | 音频代理 (防盗链域名) |

### 示例

```bash
# MetingJS 兼容 - 获取播放 URL
curl "https://music.yuncan.xyz/api?server=netease&type=url&id=174944"

# 搜索歌曲
curl "https://music.yuncan.xyz/api?server=netease&type=search&id=周杰伦&limit=10"

# 获取歌单
curl "https://music.yuncan.xyz/api?server=netease&type=playlist&id=60198&limit=100"

# QQ 音乐 (需登录态)
curl "https://music.yuncan.xyz/api?server=qq&type=url&id=0039MnYb0qxYhV"

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

> **注意**: Vercel 函数超时 10 秒, QQ 接口已优化重试策略。生产环境建议自托管。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ADAPTER_PORT` | `3017` | 服务端口 |
| `NCM_LEVEL` | `standard` | 网易云音质 (standard/exhigh/lossless/hires) |
| `NCM_LEVELS` | `standard,exhigh,lossless,hires` | 可选音质列表 |
| `ENABLE_GENERAL_UNBLOCK` | `true` | 解灰第一层 (api-enhanced 内置) |
| `ENABLE_EXTRA_UNBLOCK` | `true` | 解灰第二层 (@unblockneteasemusic/server) |
| `EXTRA_UNBLOCK_SOURCES` | `bilibili,bilivideo,pyncmd,bodian,qq,kugou,kuwo,migu` | 第二层音源 |
| `QQ_UNBLOCK_ENABLED` | `true` | QQ 跨平台解灰 |
| `QQ_UNBLOCK_SOURCES` | `kugou,kuwo,migu,pyncmd` | QQ 解灰音源 |
| `DISABLE_FLAC` | `false` | `true` 时降级为 320k/mp3 |
| `URL_STRATEGY` | `enhanced-only` | URL 策略 (enhanced-only / enhanced-then-outer) |
| `NCM_MUSIC_U` | — | 网易云 MUSIC_U cookie |
| `NCM_CSRF` | — | 网易云 __csrf cookie |
| `NCM_COOKIE` | — | 网易云完整 Cookie (优先级最高) |
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
- 网易云、QQ、酷狗、酷我四大平台
- 搜索结果缓存 5 分钟 (减少 API 调用)

### 网易云解灰
- 第一层: api-enhanced 内置 `unblockmusic-utils` 6 模块
- 第二层: `@unblockneteasemusic/server` (含 B 站音源)
- VIP 歌曲通过验证码登录获取 MUSIC_U cookie 播放

### QQ 音乐 VIP
- QQ OAuth 扫码登录 (QQ 互联 appid 549000912)
- 登录后 vkey 接口带 Cookie 获取 VIP 歌曲 purl
- vkey URL 缓存 10 分钟 (仅免费歌曲)
- keepalive Agent 复用 TCP/TLS 连接, 避免 QQ 反爬限流

### 网易云验证码登录
- `GET /api?action=nc_sendcode&phone=xxx` 发送验证码
- `GET /api?action=nc_verify&phone=xxx&captcha=yyy` 验证并登录
- 登录成功返回绑定码, 玩家回游戏输入即可绑定

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

- 网易云使用 `@neteasecloudmusicapienhanced/api` 模块, 免登录或验证码登录
- QQ 音乐使用 QQ OAuth 扫码登录 + `musicu.fcg` vkey 接口
- 酷狗/酷我使用 F12 cookie 透传, 服务端原样作为 Cookie 头发送
- 音频代理仅用于防盗链域名 (kuwo/kugou)
- 所有 HTTP 请求使用 keepalive Agent 复用连接, 减少握手开销

## 更新日志

### v0.27.0 (2026-06-28)
- ✨ 重做默认首页: 白色主题 + SVG 徽章 + 多平台检测
- ✨ 首页说明可被 MetingJS / Minecraft ZMusicGUI / Node.js 等客户端使用
- 🔧 配置白名单环境变量 (`ALLOWLIST` + `ADMIN_PASSWORD`)
- 🗑️ 删除旧版 test.html (Meting Enhanced Adapter v13)
- 📝 新版 README 含 SVG 徽章

### v0.26.1 (2026-06-28)
- 🐛 修复网易云验证码登录: 改用 `login_cellphone` + `captcha` 参数获取 MUSIC_U

### v0.26.0 (2026-06-28)
- ✨ 网易云验证码登录 (`nc_sendcode` + `nc_verify` 端点)
- ✨ QQ 音乐 vkey URL 缓存 (10 分钟, 仅免费歌曲)
- 🐛 QQ 音乐点歌卡顿 5 秒: 减少重试次数 + 缓存
- ✨ BossBar 歌词显示 (ZMusicGUI v2.5.4)

### v0.25.0 (2026-06-27)
- ✨ QQ 音乐搜索结果缓存 (5 分钟)
- ✨ keepalive Agent 复用 TCP/TLS 连接
- 🔧 QQ 重试策略优化 (1.5s/3s/5s)

### v0.23.0
- 🗑️ 移除酷狗扫码登录 (VIP 受 IP 绑定无法服务器端获取)

### v0.20.0
- ✨ 融合 api-enhanced, 单进程搞定
- ✨ 网易云解灰 (unblockmusic-utils + @unblockneteasemusic/server)

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
