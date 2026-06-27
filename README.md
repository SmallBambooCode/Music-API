# ourcraft-music-api

> Ourcraft 多平台音乐 API (Vercel 部署)

支持网易云/QQ音乐/酷狗/酷我四大平台，VIP 歌曲通过 cookie 透传播放。

## 平台

| 平台 | 登录方式 | VIP 歌曲 |
|------|----------|----------|
| 网易云 | 免登录 (enhanced 模式) | 不支持 |
| QQ音乐 | F12 cookie (uin + qqmusic_key) | 支持 |
| 酷狗 | F12 cookie (KugooID + KugooToken) | 支持 |
| 酷我 | F12 cookie (kw_user_id + kw_token) | 支持 |

## 接口

```
GET /api?server={platform}&type={type}&id={id}&userid={userid}&token={token}&cookie={cookie}
```

| type | 说明 |
|------|------|
| search | 搜索歌曲 |
| song_full | 完整单曲 (name+url+lyric+time) |
| url | 播放 URL (302 重定向) |
| lrc | 歌词文本 |
| playlist_search | 搜索歌单 |
| playlist_detail | 歌单详情 |

特殊端点:
- `/api?action=health` 健康检查
- `/api?action=enhanced&path=/xxx` 网易云 enhanced 透传
- `/bind?platform={qq|kugou|kuwo}` 账号绑定教程页
- `/proxy?url=xxx` 音频代理 (防盗链域名)

## 部署

1. Fork 仓库到 GitHub
2. Vercel 导入项目
3. 配置环境变量 (可选):
   - `NCM_LEVEL`: 网易云音质 (standard/exhigh/lossless/hires)
   - `URL_STRATEGY`: enhanced-only / enhanced-then-outer
   - `ADMIN_PASSWORD`: 管理员密码
   - `ALLOWLIST`: IP 白名单
4. 部署完成

## 技术说明

- 网易云使用 `@neteasecloudmusicapienhanced/api` 模块，免登录
- QQ/酷狗/酷我使用 F12 cookie 透传，服务端原样作为 Cookie 头发送
- 音频代理仅用于防盗链域名 (kuwo/kugou)
- Vercel 函数超时 10 秒，QQ 接口已优化重试策略

## 作者

Yuncan — https://yuncan.xyz
