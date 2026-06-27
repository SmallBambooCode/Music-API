# Ourcraft Music API v0.19.0

多平台音乐 API 服务端 (网易云 / 酷狗 / 酷我 / QQ音乐), 兼容 MetingJS 格式。

**v0.16.0 起 api-enhanced 已融合进本项目**, 不再需要启动外部 api-enhanced 服务, 一个进程即可同时拥有网易云 API + 自动解灰 (从其他音源匹配 VIP 歌曲)。

## 功能

- **四大平台**: netease / kugou / kuwo / qq
- **融合 api-enhanced**: 直接 require `@neteasecloudmusicapienhanced/api` 模块函数, 无需 HTTP 转发
- **两层解灰**:
  - 第一层 api-enhanced 内置 (`unblockmusic-utils` 6 模块: baka/bikonoo/byfuns/msls/qijieya/unm)
  - 第二层直接调用 `@unblockneteasemusic/server` (`match()` 含 **bilibili/bilivideo** B 站音源 + pyncmd/bodian/qq/kugou/kuwo/migu)
  - 第一层未命中时启用第二层, 大幅提升 VIP 歌曲命中率
- **song_full 端点**: 一次请求并发返回 name+url+lyric+time, 加速插件调用
- **MetingJS 兼容**: 输出 `title / author / url / pic / lrc` 标准格式
- **透传 api-enhanced**: `/api?action=enhanced&path=/xxx` 可调用 api-enhanced 任意模块 (含 login/cloudsearch/playlist_detail 等)
- **白名单**: 环境变量配置, 管理员临时开关

## 接口

```
{api}/api?server={platform}&type={type}&id={id|keyword}&userid=xxx&token=xxx
```

| type | 用途 | 返回 |
|---|---|---|
| `search` | 搜索歌曲 | `[{id, name, singer, time}]` |
| `song_full` | 完整单曲 (推荐插件使用) | `{id, name, singer, url, lyric, time, ok, source}` |
| `url` | 播放地址 | 302 重定向 |
| `lrc` | 歌词文本 | LRC 格式 |
| `playlist` | 网易云歌单 | MetingJS 格式 |
| `song` | MetingJS 兼容 | 同 playlist |
| `pic` | 封面图 (仅 netease) | 302 重定向 |

特殊端点:
```
/api?action=enhanced&path=/cloudsearch&keywords=xxx   # 透传 api-enhanced 任意模块
/api?action=health                                      # 健康检查
```

## 平台支持

| 平台 | 登录需求 | VIP 歌曲支持 | 备注 |
|---|---|---|---|
| `netease` | NCM_MUSIC_U (可选) | **支持 (自动解灰)** | 融合 api-enhanced, unblockmusic-utils |
| `kugou` | userid + token | 支持 (需登录) | trackercdn 接口 |
| `kuwo` | kw_token + kw_user_id | 支持 (需登录) | antiserver 接口 |
| `qq` | **无需登录** | 不支持 VIP | 公开 vkey 接口, 自带重试 |

### 解灰工作原理 (两层策略)

**第一层** (api-enhanced 内置, `unblockmusic-utils` 6 模块):

`matchID(id, source)` 不指定 source 时按 `fs.readdirSync(modulesDir)` 顺序遍历所有模块, 每个模块单独尝试, 返回第一个成功的 URL。模块列表 (来自 `unblockmusic-utils/modules/`):

| 模块 | 音源 |
|---|---|
| `baka` | api.baka.plus (第三方聚合) |
| `bikonoo` | ncm.bikonoo.com (第三方) |
| `byfuns` | api.byfuns.top (第三方) |
| `msls` | api.msls1441.com (第三方) |
| `qijieya` | api.qijieya.cn (第三方) |
| `unm` | `@unblockneteasemusic/server`, 内部按 `['pyncmd','bodian','qq']` 顺序匹配 |

实际命中哪个音源由各模块当前可用性决定, **不保证固定顺序**。

**第二层** (补充, 直接调用 `@unblockneteasemusic/server`):

第一层未命中时启用, 绕过 `unblockmusic-utils` 包装层, 直接调用 `@unblockneteasemusic/server` 的 `match(id, sources)` 函数。源列表由 `EXTRA_UNBLOCK_SOURCES` 环境变量配置, **默认包含 B 站两个音源**:

| 源 | 音源 |
|---|---|
| `bilibili` | B 站音乐 (`api.bilibili.com/audio/music-service-c/s`) |
| `bilivideo` | B 站视频音频流 (`api.bilibili.com/x/web-interface/wbi/search/type`) |
| `pyncmd` | 网易云公网音源 |
| `bodian` | 酷我 (bd-er.kuwo.cn) |
| `qq` | QQ 音乐 |
| `kugou` | 酷狗 |
| `kuwo` | 酷我 |
| `migu` | 咪咕 |

第二层使用 `Promise.any` 并发尝试所有源, 返回第一个成功的 URL。`@unblockneteasemusic/server` 的 13 个内置源见 [consts.js](https://github.com/unblockneteasemusic/server/blob/master/src/consts.js)。

日志会打印 `INFO: (provider/match) Replaced: [songId] songName` 提示替换成功, source 字段显示实际命中音源 (如 `extra:bilibili` / `extra:bilivideo` / `unblock` 等)。

## 本地运行

### 一键启动 (无需外部服务)

```powershell
npm install
node server.js
```

默认地址: `http://127.0.0.1:3017`

### .env 配置示例

```env
ADAPTER_PORT=3017

# 音质
NCM_LEVEL=standard
NCM_LEVELS=standard,exhigh,lossless,hires

# 解灰 (默认开启)
ENABLE_GENERAL_UNBLOCK=true

# 兜底策略
URL_STRATEGY=enhanced-only

# 登录态 (留空则用游客模式, VIP 歌曲靠解灰)
NCM_MUSIC_U=
NCM_CSRF=
# 或 NCM_COOKIE=MUSIC_U=xxx; __csrf=yyy; os=pc

# 白名单 (空表示不限制)
ALLOWLIST=
ALLOW_LOCAL=true

# 管理密码 (管理员接口不受白名单拦截)
ADMIN_PASSWORD=
```

## Vercel 部署

v0.16.0 融合 api-enhanced 后, Vercel 直接 `node server.js` 即可, 无需外部 NCM_API_BASE。

```env
ADAPTER_PORT=3017
ENABLE_GENERAL_UNBLOCK=true
URL_STRATEGY=enhanced-only
NCM_MUSIC_U=你的 MUSIC_U
NCM_CSRF=你的 __csrf
NCM_LEVEL=standard
ALLOWLIST=
ALLOW_LOCAL=false
ADMIN_PASSWORD=你的管理员密码
```

## MetingJS 接入

```html
<meting-js
  server="netease"
  type="playlist"
  id="60198"
  api="https://你的域名/api?server=:server&type=:type&id=:id&r=:r">
</meting-js>
```

## Provider 架构

```
ourcraft-music-api/lib/
├── providers/
│   ├── index.js          # Provider 注册中心
│   ├── netease.js        # 网易云 (调用 netease-client)
│   ├── kugou.js          # 酷狗
│   ├── kuwo.js           # 酷我
│   └── qq.js             # QQ音乐 (公开 vkey)
├── netease-client.js     # 直接 require api-enhanced 模块 + 解灰
├── provider.js           # 网易云转发层 (聚合 netease-client 接口)
├── meting.js             # MetingJS 格式转换
└── app.js                # HTTP 路由层
```

每个 provider 必须实现:
```javascript
{
  platform,                              // 平台标识
  search(keyword, limit),                // 搜索歌曲
  songUrl(id, userId, token),            // 播放 URL
  lyric(id),                             // 歌词
  songFull(id, userId, token)            // 完整单曲 (Promise.all 并发)
}
```

## 主要 API 示例

```text
# 搜索
/api?server=netease&type=search&id=周杰伦&limit=10
/api?server=kugou&type=search&id=晴天&limit=10
/api?server=qq&type=search&id=晴天&limit=10

# 完整单曲 (推荐插件使用)
/api?server=netease&type=song_full&id=186016          # 周杰伦"晴天", 自动解灰
/api?server=kugou&type=song_full&id=xxx&userid=xxx&token=xxx
/api?server=qq&type=song_full&id=0039MnYb0qxYhV

# 网易云歌单
/api?server=netease&type=playlist&id=60198

# 透传 api-enhanced 任意模块
/api?action=enhanced&path=/cloudsearch&keywords=周杰伦&limit=10
/api?action=enhanced&path=/playlist_detail&id=60198
/api?action=enhanced&path=/login_qr_key
```

## 常见问题

### 网易云歌曲播放 URL 不是 music.163.com?

是的, 这是解灰功能在工作。VIP 歌曲无法从网易云直接获取, 系统通过两层策略从其他音源匹配:
- 第一层: `unblockmusic-utils` 的 baka/bikonoo/byfuns/msls/qijieya/unm 模块
- 第二层: `@unblockneteasemusic/server` 直接调用, 含 **B 站 bilibili/bilivideo 音源**

URL 域名可能是 `bd-er.kuwo.cn` (bodian)、`mcdn.bilivideo.cn` (B 站视频音频流)、`api.baka.plus` 重定向等。`source` 字段会显示命中音源 (如 `unblock` / `extra:bilivideo` / `extra:bodian`)。

### 如何关闭解灰?

- 关闭第一层: 设置 `ENABLE_GENERAL_UNBLOCK=false`
- 关闭第二层: 设置 `ENABLE_EXTRA_UNBLOCK=false`
- 全部关闭: 两个变量都设为 `false`, 将只走多音质请求 + outer URL 兜底

### 如何只使用 B 站音源?

设置 `EXTRA_UNBLOCK_SOURCES=bilibili,bilivideo` 并关闭第一层 (`ENABLE_GENERAL_UNBLOCK=false`), 这样解灰只走 B 站两个音源。

### 酷狗/酷我 VIP 歌曲无法播放?

需要登录获取 Token, 通过 `userid` 和 `token` 参数传入:
```
/api?server=kugou&type=song_full&id=xxx&userid=你的ID&token=你的Token
```

### QQ 音乐部分歌曲无法播放?

QQ 音乐 VIP 歌曲返回空 URL, 属正常行为。建议插件端提示用户切换其他源或登录其他平台账号。

## 版本历史

| 版本 | 主要变更 |
|---|---|
| 0.16.0 | **融合 api-enhanced** (直接 require 模块), 两层解灰 (unblockmusic-utils + @unblockneteasemusic/server 含 B 站 bilibili/bilivideo 音源), 删除 enhanced-http-client.js |
| 0.15.0 | 新增 QQ音乐 provider, 清理屎山代码 (删 enhanced-module-client.js / doctor / scripts) |
| 0.14.0 | 多平台架构 (netease/kugou/kuwo), song_full 并发端点, Provider 注册中心 |
| 0.13.0 | 初始 Meting Enhanced Adapter |

## 许可与声明

本项目是适配层工程。底层网易云 API 来自 `@neteasecloudmusicapienhanced/api` (MIT), 解灰能力来自 `@neteasecloudmusicapienhanced/unblockmusic-utils` (MIT) 和 `@unblockneteasemusic/server` (LGPL-3.0)。请遵守相关平台服务条款与版权规则, 不要把 Cookie、管理员密码等敏感信息提交到 GitHub。
