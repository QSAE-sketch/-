# 轻聊 · 云网盘（独立服务）

> **现状（2026-11-14）：已停用，不再发布。**
> 平台一个工作区只有一个线上应用位，单独发布本服务会把聊天站覆盖掉。
> 网盘能力已内置进聊天站：`chatapp/src/drive.js` + `chatapp/public` 的「网盘」页，
> 与聊天共用 files 集合、blob 存储与 2GB 配额，聊天里发的文件天生就在网盘里。
> 本目录保留作独立部署备用方案（未来若有了第二个应用位，仍可直接 `node server.js` 跑起来）。

与轻聊聊天站共用账号的独立网盘服务：零第三方依赖，只用 Node 内置模块，单端口可直接跑。

## 本地运行

```bash
cd netdisk
node server.js
# 打开 http://127.0.0.1:3000
```

默认配置（都可用环境变量覆盖）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `DATA_DIR` | `./data` | 元数据 JSON + 文件字节都放这里 |
| `CHAT_API_BASE` | `https://qingliao-chat-33476.app.workbuddy.host` | 校验账号密码的聊天站 |
| `CHAT_SHARECODE` | `T7ELJZOC5A` | 聊天站网关要求的分享码 |
| `USER_QUOTA_BYTES` | 2 GiB | 每人配额 |
| `MAX_FILE_SIZE` | 2 GiB | 单文件上限 |
| `SERVICE_KEY` | `qingliao-netdisk-service-key` | 服务间导入密钥，需与聊天站 `NETDISK_SVC_KEY` 一致 |
| `JWT_SECRET` | 内置默认 | 正式环境务必换掉 |

## 与聊天站打通

1. **共用账号**：网盘登录时把账号密码转发给聊天站 `/api/login` 校验，通过后按 `user.id` 建本地映射，
   再签自己的 JWT。密码不落盘。
2. **文件自动存入网盘**：聊天站上传完成后，用服务密钥调本服务 `POST /api/svc/import` 把字节流式转过来。
   聊天站侧用 `NETDISK_URL` 开启，留空即关闭（默认关闭）。

## 测试

```bash
node test/e2e.js     # 自带聊天站(3401)+网盘(3402)，55 项
```

## ⚠️ 发布限制（踩过的坑，别再踩）

**本工作区的发布工具只会复用一个应用槽。** 对 `netdisk/` 目录执行 `workbuddy_sites_deploy`
并不会创建新应用，而是把当前线上的聊天站（`qingliao-chat-33476`）整个替换掉 —— 已经实测过一次，
只能再把 `chatapp/` 重新发布回来。

结论：**在拿到独立的应用位之前，不要部署这个目录。** 代码是完整可用的（本地 55/55 通过），
等有第二个应用槽再发布，然后把聊天站的 `NETDISK_URL` 指过去即可，两边代码不用改。
