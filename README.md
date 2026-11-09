# Loon 定时切换策略 —— 综合利用EMBY4837

> 作者：[Yjwj205](https://github.com/Yjwj205) / Minis
> 主页：<https://github.com/Yjwj205> · 仓库：<https://github.com/Yjwj205/loon-modules>

## 插件版本

| 插件 | 版本日期 | 最低 Loon | 配置语法 |
| --- | --- | --- | --- |
| `kill-on-open.plugin` | 2026-11-08 | 3.5.1 (983) | 新版 Script（v2） |
| `policy-switcher.plugin` | 2026-11-08 | 3.5.1 (983) | 新版 Script（v2） |
| `policy-exact.plugin` | 2026-11-08 | 3.5.1 (983) | 新版 Script（v2） |
| `fktg.plugin` | 2026-11-08 | — | `[Host]` IP→IP 映射 |
| `ikuuu-checkin.plugin` | 2026-11-10 | 3.5.1 (983) | 新版 Script（v2） |

版本日期写在插件元数据 `#!date` 中，以后每次改动插件都同步更新这一行。

## 已按你的要求写死

| 时间 | 切换到 |
| --- | --- |
| 09:00 | `Matrix` |
| 19:00 | `吹雪云观影组` |

策略组：`综合利用EMBY4837`
脚本：`switch-emb.js`（自包含，不需要传参数）

判断逻辑：取「当前时间之前最近的一档」；每天 00:00–08:59 沿用前一晚的「吹雪云观影组」，
到 09:00 切「Matrix」，19:00 再切回「吹雪云观影组」。已在该节点则不切换、不通知（幂等）。

## 文件

| 文件 | 用途 |
| --- | --- |
| `switch-emb.js` | 固定版脚本（本地安装用，无需托管） |
| `policy-switcher.js` | 可配置版脚本：策略组、时间表、通知都从参数读 |
| `policy-switcher.plugin` | 可配置版插件（UI 里填策略组 / 时间表 / 频率） |
| `test-fixed.js` | 固定版测试，7 个时间点用例全通过 |
| `test.js` | 可配置版测试，8 个用例全通过 |

## 安装方式一：本地脚本（不需要服务器，立刻能用）

1. 在聊天里点开 `switch-emb.js`，右上角分享 → **存储到「文件」** →
   `iCloud Drive/Loon/Script/`（没有该文件夹就在 Loon → 设置里打开「iCloud 同步/自动同步」，
   Loon 会自动建目录）；
2. Loon → 配置 → **脚本** → 右上角 `+` → 选择刚存进去的 `switch-emb.js`；
3. 类型选 **cron**，表达式填 `0 */5 * * * *`（每 5 分钟检查一次），别名随意，保存并启用；
4. 在 Loon → 脚本列表确认该条为开启状态。

> 想更准点：表达式改成 `0 * * * * *`（每分钟）。
> 若 Loon 只接受 5 段：`*/5 * * * *`。

## 安装方式二：插件（可在 UI 里自由改策略组和时间）

`policy-switcher.plugin` 里的脚本地址目前是占位符
`https://raw.githubusercontent.com/Yjwj205/loon-modules/main/policy-switcher.js`。
把 `policy-switcher.js` 传到任意 HTTPS 静态地址（GitHub raw / jsDelivr）后替换即可，
然后把 `.plugin` 文件（或它的 URL）导入 Loon → 插件。

插件参数：

| 参数 | 默认值 |
| --- | --- |
| 策略组名称 | 综合利用EMBY4837 |
| 时间表 | `09:00=Matrix;19:00=吹雪云观影组` |
| 检查频率 | `0 */5 * * * *` |
| 切换时通知 | 开 |

## 准点版（一天只跑 2 次，推荐）

文件：`switch-exact.js` + `policy-exact.plugin`

插件 `定时切换策略·准点` 里是两个独立的 cron：

```
cron ${amTime} then script(".../switch-exact.js", {${group}, ${amTarget}, ${notify}})   # 0 0 9 * * *
cron ${pmTime} then script(".../switch-exact.js", {${group}, ${pmTarget}, ${notify}})   # 0 0 19 * * *
```

- `amTime` / `pmTime`：6 段 cron（秒 分 时 日 月 周），默认 `0 0 9 * * *`、`0 0 19 * * *`；
- `amTarget` / `pmTarget`：目标节点或子策略名，UI 里可改；
- 一天总共 2 次 JS 执行，几乎零开销；
- 代价：那一刻若 Loon 没在运行（VPN 关闭 / 被强杀），本次不补切。

> 轮询版和准点版**不要同时装**，否则轮询版会在 5 分钟内把节点切回去。

## 注意

- cron 只在 Loon 运行（VPN 开启、未被强制退出）时触发；后台可能被 iOS 延迟，故用 5 分钟轮询兜底。
- 名称必须完全一致（含空格、emoji、大小写），不一致时 `setSelectPolicy` 返回 false，
  脚本会推一条失败通知写明原因。
- 只切 `select` 类型策略组；`auto-test`/`fallback` 组下次自动测速可能覆盖选择。
- 官方 API 与文档：
  - `$config.setSelectPolicy(策略组, 子策略)` / `getSelectedPolicy` / `getSubPolicies`
  - https://nsloon.app/docs/Script/script_api/
  - https://nsloon.app/docs/Script/script_v2/

---

# 附：Fuck Telegram bad IPs（Loon 版）

文件：`fktg.plugin`

把 Telegram 一直连到的「垃圾 IP」在 Loon 层重定向到好 IP，减少转圈卡顿。
原版是 Surge 模块 [Repcz/Tool · FKTG.sgmodule](https://github.com/Repcz/Tool/raw/X/Surge/Module/Function/FKTG.sgmodule)。

## 安装

Loon → 配置 → 插件 → 右上角 `+` → 填下面的 URL：

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/fktg.plugin
```

导入后确认插件为开启状态，重开 Telegram 生效。

## 原理 / 与 Surge 原版的差异

| Surge | Loon |
| --- | --- |
| `[Host]` 里写 `坏IP = 好IP1,好IP2` | `[Host]` 里写 `坏IP = 好IP,use-in-proxy=true`，**每条只能一个目标 IP** |
| `[General]` 里 `use-local-host-item-for-proxy = true` | 每条尾部加 `,use-in-proxy=true`（代理连接也走该映射，Telegram 走代理时必须） |

所以原版一条写两个目标 IP（`91.108.56.147,91.108.56.201`）在 Loon 上拆不开，
本插件统一指向 `91.108.56.147`。想换成 `91.108.56.201`，把文件里 9 行的目标 IP 批量替换即可
（Loon 编辑插件 → 点该插件 → 源码修改，或直接改仓库后重新导入）。

保留的坏 IP 与源模块一致（9 条）：

```
91.108.56.100 / .101 / .104 / .107 / .120 / .125 / .126 / .128 / .156
```

社区版一般还会补 `.109 .110 .113 .134 .138 .143 .145` 等，需要的话照着同样的格式往下加即可。

## 验证

- `use-in-proxy` / IP→IP 映射语法见 Loon 官方示例配置 `Loon0x00/LoonExampleConfig` 的 `[Host]` 段：
  「将目标 IP 映射到另一个 IP。」「use-in-proxy=true 表示代理连接也使用该映射。」
- 三个地址在本机实测 443 端口均可连通（`.100 .147 .201`），说明重定向目标有效。
- 文档：<https://nsloon.app/docs/Plugin/>、<https://nsloon.app/docs/DNS/hostmap/>

---

# iKuuu 每日签到（Loon 插件）

文件：`ikuuu-checkin.plugin` + `ikuuu-checkin.js` + `ikuuu-cookie.js`

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/ikuuu-checkin.plugin
```

自动签到 <https://ikuuu.org>，签完把「剩余流量 / 今日已用」一起推送。

## 为什么用 Cookie 登录，而不是账号密码

ikuuu.org 的登录页已经接入 **Geetest v4 行为验证码**：`POST /auth/login` 走
`phase` 多段流程（password → totp / email_code），password 阶段必须带 `captcha_result`。
脚本没法稳定过验证码，所以插件用 Cookie 而不是账号密码。

## Cookie 从哪来

**方式一：自动抓（默认，推荐）**

插件里有一条 `request` 脚本 + `[Mitm] hostname = ikuuu.org, *.ikuuu.org`：

1. 装好插件、确认 Loon 已开启 MITM 且证书已安装并在「关于本机 → 证书信任设置」里信任；
2. 用 Safari 打开 <https://ikuuu.org> 登录一次（正常浏览即可）；
3. 插件把请求头里的 Cookie 存进 Loon 本地存储（只存登录后才会出现的会话 Cookie，游客 Cookie 不会覆盖）。

**方式二：手动填**

Safari 登录后取出完整 Cookie，粘贴到插件设置里的「Cookie」（带不带 `Cookie:` 前缀都行、换行也行）。
手动填的值优先于自动抓取的值。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| Cookie | 空 | 可选。留空 = 用自动抓取的 |
| 签到时间 | `0 8 * * *` | 5 段 cron（分 时 日 月 周） |
| 定时签到 | 开 | 关掉后只剩手动触发 |
| 签到通知 | 开 | 关掉后只写日志 |

## 行为

- 定时：`POST https://ikuuu.org/user/checkin`（带 Cookie / Referer / XHR 头），解析 `{ret, msg}`；
- 播报：再 `GET /user`，页面正文是 base64 包在 `var originBody = "..."` 里的，脚本自己解码，
  抓「剩余流量」「今日已用」（解析失败只少一行，不影响签到结果）；
- 通知副标题：`签到成功` / `今日已签到` / `签到失败` / `Cookie 已失效`；
- 手动：Loon → 脚本 → `iKuuu 签到（手动）`（generic 触发），随时跑一次。

## 注意

- 自动抓 Cookie 依赖 MITM；不想开 MITM 就手动填 Cookie，签到本身不需要 MITM。
- Cookie 过期后通知会提示「Cookie 已失效」，去 Safari 重新登录一次就会自动更新。
- cron 只在 Loon 运行（VPN 开启、没被系统杀掉）时触发，和仓库里其他插件一样。
- 本地测试：`node test-ikuuu.js`（29 个用例，覆盖抓 Cookie / 成功 / 已签到 / 失效 / 超时 / 关通知 / 手动优先 / 流量解析失败）。

## 文件

| 文件 | 用途 |
| --- | --- |
| `ikuuu-checkin.plugin` | 插件本体（参数、cron、Mitm 声明） |
| `ikuuu-cookie.js` | request 脚本：抓登录 Cookie 存本地 |
| `ikuuu-checkin.js` | 签到 + 流量播报脚本 |
| `test-ikuuu.js` | 模拟 Loon 环境的本地测试 |
