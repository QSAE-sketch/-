# 新发现：QQ 机器人配置 + 元器角色扮演（2026-07-13）

> 知识库结构化版见 topics/qq-workbuddy-channel.md 与 topics/yuanqi-roleplay-prompt.md。此处为本次实操速记。

## 实操结论
- WorkBuddy「注册 QQ 通道」= QQ 开放平台官方机器人；扫码绑定走云端 Webhook（codebuddy.cn），本机开关机不影响收发，IP 白名单 / 沙箱与此模式无关
- 群机器人不回消息：① 没 @它；② 未上线 / 沙箱群没配。判别法：私聊能回 = 通路完好，仅群场景未授权
- q.qq.com 个人开发者可**账号密码登录**（免手机扫码），手机摔了也能配
- WorkBuddy 的 QQ 通道只有 1 条，后注册会覆盖前者 → 多机器人需换软件 / 另一 WorkBuddy 实例
- 第三方方案：go-cqhttp / Mirai 已被腾讯封杀、易封号，勿用；NoneBot2 + nonebot-adapter-qq 官方协议可用但需本地进程挂着
- 元器（yuanqi.tencent.com）可账号密码登录免扫码；但**发布渠道实测无 QQ**（只有微信/官网/应用宝/第三方平台），智能体只能在元器内 / 分享链接用，无法一键进 QQ
- 沉淀：柳三刀武侠角色扮演提示词（含标点 140 字 ≤150）+ 武侠欢迎语
