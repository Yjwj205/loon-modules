# Loon 定时切换策略 —— 综合利用EMBY4837

> 作者：[Yjwj205](https://github.com/Yjwj205) / Minis
> 主页：<https://github.com/Yjwj205> · 仓库：<https://github.com/Yjwj205/loon-modules>

## 功能

每天准点把指定策略组切到指定节点，**一天只跑 2 次**，幂等（已在该节点则直接退出，不切换、不通知）。

| 时间 | 切换到 |
| --- | --- |
| 09:00 | `Matrix` |
| 19:00 | `吹雪云观影组` |

策略组默认 `综合利用EMBY4837`，时间与目标节点都能在插件参数里改。

## 插件版本

| 插件 | 版本日期 | 最低 Loon | 配置语法 |
| --- | --- | --- | --- |
| `policy-exact.plugin` | 2026-11-14 | 3.5.1 (983) | 新版 Script（v2） |
| `kill-on-open.plugin` | 2026-11-08 | 3.5.1 (983) | 新版 Script（v2） |
| `fktg.plugin` | 2026-11-08 | — | `[Host]` IP→IP 映射 |
| `ikuuu-checkin.plugin` | 2026-11-11 | 3.5.1 (983) | 新版 Script（v2） |
| `youtube-enhance/youtube-enhance.plugin` | 2026-11-12 | 3.5.1 (988) | 新版 Script（v2） |
| `youtube-zh/YouTube-zh.lpx` | 2026-11-07（上游） | 3.5.1 (983) | 新版 Script（v2）· 汉化 + 自动跟随上游 |

版本日期写在插件元数据 `#!date` 中，以后每次改动插件都同步更新这一行。

## 文件

| 文件 | 用途 |
| --- | --- |
| `policy-exact.plugin` | 插件本体（唯一维护的切换策略版本） |
| `switch-exact.js` | 准点切换脚本：按传入的 target 切换，幂等 + 复核 |

## 安装

1. 导入插件（复制到 Loon → 插件 → 右上角 `+` → URL）：

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/policy-exact.plugin
```

2. 在插件参数里按需修改：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `group` | `综合利用EMBY4837` | 必须与 Loon 中的策略组名完全一致 |
| `amTime` | `0 9 * * *` | 早上触发时间，5 段 cron |
| `amTarget` | `Matrix` | 早上切换为 |
| `pmTime` | `0 19 * * *` | 晚上触发时间，5 段 cron |
| `pmTarget` | `吹雪云观影组` | 晚上切换为 |
| `notify` | 开 | 切换时是否发通知 |

插件里是两条独立的 cron：

```
cron ${amTime} then script(".../switch-exact.js", {${group}, ${amTarget}, ${notify}})   # 0 9 * * *
cron ${pmTime} then script(".../switch-exact.js", {${group}, ${pmTarget}, ${notify}})   # 0 19 * * *
```

- `amTime` / `pmTime`：5 段 cron（分 时 日 月 周），默认 `0 9 * * *`、`0 19 * * *`；
  想改点只需改时/分，例如 `30 8 * * *` = 每天 08:30。
- 一天总共 2 次 JS 执行，几乎零开销；
- 代价：那一刻若 Loon 没在运行（VPN 关闭 / 被强杀），本次不补切。

## 注意

- Loon 的 cron 支持 5 段（分 时 日 月 周）与 6 段（秒 分 时 日 月 周），本仓库统一用 5 段。
- cron 只在 Loon 运行（VPN 开启、未被强制退出）时触发；后台可能被 iOS 延迟执行。
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

自动签到 <https://ikuuu.org>，签完顺带把「剩余流量」推送。

## 为什么用 Cookie 登录，而不是账号密码

ikuuu.org 的登录页已经接入 **Geetest v4 行为验证码**：`POST /auth/login` 走
`phase` 多段流程（password → totp / email_code），password 阶段必须带 `captcha_result`。
脚本没法稳定过验证码，所以插件用 Cookie 而不是账号密码。

## Cookie 从哪来

**方式一：自动抓（默认，推荐）**

插件里有一条 `request` 脚本 + `[Mitm] hostname = ikuuu.org, *.ikuuu.org`：

1. 装好插件、确认 Loon 已开启 MITM 且证书已安装并在「关于本机 → 证书信任设置」里信任；
2. 保持插件里的 **抓取 Cookie** 开关为开，用 Safari 打开 <https://ikuuu.org> 登录一次（正常浏览即可）；
3. 插件把请求头里的 Cookie 存进 Loon 本地存储（只存登录后才会出现的会话 Cookie，游客 Cookie 不会覆盖）；
4. 会收到一条「已获取登录 Cookie」通知 —— 这时把 **抓取 Cookie** 开关关掉即可，
   签到继续用这份 Cookie，之后浏览 ikuuu.org 不再触发抓取脚本。

**方式二：手动填**

Safari 登录后取出完整 Cookie，粘贴到插件设置里的「Cookie」（带不带 `Cookie:` 前缀都行、换行也行）。
手动填的值优先于自动抓取的值。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| Cookie | 空 | 可选。留空 = 用自动抓取/已保存的 |
| 抓取 Cookie | 开 | 打开时访问 ikuuu.org 自动保存登录 Cookie；抓到后会提示你关掉它 |
| 请求节点 | 空 | 可选：节点名 / 策略组名 / `DIRECT`。留空跟随规则；偶发证书错误时可固定到常用节点 |
| 签到时间 | `0 8 * * *` | 5 段 cron（分 时 日 月 周） |
| 定时签到 | 开 | 关掉后只剩手动触发 |
| 签到通知 | 开 | 关掉后只写日志 |

## 行为

- 定时：`POST https://ikuuu.org/user/checkin`（带 Cookie / Referer / XHR 头），解析 `{ret, msg}`；
- 失败自动重试：签到请求最多 3 次、间隔 1.5 秒；流量请求失败再补 1 次（偶发 TLS/线路抖动基本能自愈）；
- 播报：再 `GET /user`，页面正文是 base64 包在 `var originBody = "..."` 里的，脚本自己解码，
  只抓「剩余流量」这一行（解析失败就不显示，不影响签到结果；不报今日已用、不带时间戳）；
- 通知副标题：`签到成功` / `今日已签到` / `签到失败` / `Cookie 已失效`；
- 抓取 Cookie 成功时另有通知「已获取登录 Cookie」，提示你去关掉抓取开关；Cookie 没变化时不打扰；
- 手动：Loon → 脚本 → `iKuuu 签到（手动）`（generic 触发），随时跑一次。

## 注意

- 自动抓 Cookie 依赖 MITM；不想开 MITM 就手动填 Cookie，签到本身不需要 MITM。
- 关掉 **抓取 Cookie** 只是让 request 脚本不再执行，插件声明的 `[Mitm] hostname` 仍会保留
  （Loon 不支持按开关撤销主机名）。要完全不做 MITM，把插件源码里 `[Mitm]` 那段删掉，
  或者干脆手动填 Cookie、不启用抓取。
- Cookie 过期后通知会提示「Cookie 已失效」，去 Safari 重新登录一次就会自动更新。
- cron 只在 Loon 运行（VPN 开启、没被系统杀掉）时触发，和仓库里其他插件一样。
- 本地测试：`node test-ikuuu.js`（46 个用例，覆盖抓 Cookie、开关与通知、去重、签到成功、已签到、失效、TLS 重试、请求节点、超时、手动优先、流量解析失败）。

## 常见问题：通知「TLS 校验失败 / certificate verify failed」

插件声明了 `[Mitm] hostname = ikuuu.org`，Loon 会把**脚本自己发出的请求也拦下来**，
用 Loon CA 签发证书；而 Loon 的脚本 HTTP 客户端不认自己的 CA，就会报
`SSL handshake failed ... certificate verify failed`。

脚本已经给签到/流量请求都加了 `insecure: true` 跳过校验证书，并且失败会自动重试 3 次。
如果还是偶发出现，按这个顺序排：

1. **线路/节点**：在插件「请求节点」里填一个常用节点或策略组名（留空 = 跟随规则）。
   策略组在多个节点间切换时，个别节点证书异常就会偶发报错 —— 固定到好节点能直接排除；
2. **MITM 证书**：检查 Loon 的 Mitm 证书是否安装、并在「设置 → 通用 → 关于本机 → 证书信任设置」里打开；
3. **彻底不用 MITM**：把插件源码里的 `[Mitm]` 段删掉，Cookie 手动填 —— 签到本身不需要 MITM。

## 文件

| 文件 | 用途 |
| --- | --- |
| `ikuuu-checkin.plugin` | 插件本体（参数、cron、Mitm 声明） |
| `ikuuu-cookie.js` | request 脚本：抓登录 Cookie 存本地 |
| `ikuuu-checkin.js` | 签到 + 流量播报脚本 |
| `test-ikuuu.js` | 模拟 Loon 环境的本地测试 |

---

## YouTube Enhance（去广告 / 后台播放 / PiP / 4x 倍速）

> 源：[gholts/surge → `modules/youtube-enhance.sgmodule`](https://github.com/gholts/surge/blob/main/modules/youtube-enhance.sgmodule)（Apache-2.0，基于 Maasea 的代码）

安装地址：

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/youtube-enhance/youtube-enhance.plugin
```

一键导入：`loon://import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2FYjwj205%2Floon-modules%2Fmain%2Fyoutube-enhance%2Fyoutube-enhance.plugin`

### 功能

| 开关 | 作用 |
| --- | --- |
| `blockUpload` | 去掉底部「上传」入口 |
| `blockShorts` | 去掉 Shorts 标签页与入口 |
| `autoHd` | 优先最高可用分辨率（有 Premium 授权时用高码率） |
| `blockGames` | 去掉首页 Playables 小游戏 |
| `blockVerticalLive` | 去掉首页竖屏直播 |
| `jumpAhead` | 显示 Jump Ahead 跳转按钮 |
| `blockStore` | 去掉创作者商店、商品卡与浮层 |
| `blockAi` | 去掉 Ask、AI 摘要及相关控件 |
| `onTheGo` | 兼容 UI 组件上启用 On-the-go 控件 |

另有固定行为（没有开关）：后台播放、画中画、最高 4x 倍速、广告位清理。

### 从 Surge 转 Loon 改了什么

| Surge | Loon |
| --- | --- |
| `#!arguments` + `{{{x}}}` 占位符 | `[Argument]` 的 `switch` 参数 + `script(..., {${x}})` 对象参数 |
| `engine=jsc` / `engine=webview` | Loon 只有 JSC；webview 那两个脚本用到的 `TextDecoder` / `CompressionStream` / `Uint8Array.fromBase64` 由适配层补 polyfill（gzip 走 `$utils.gzip`/`$utils.ungzip`） |
| `$argument` 是 JSON 字符串 | Loon 给的是对象；适配层先归一化（类型、snake_case→camelCase）再转成脚本要的 JSON 字符串 |
| `#!REQUIREMENT` 条件脚本 | `with enable=${autoHd}` |
| `[URL Rewrite] ... - reject` | `[Rewrite] ... reject` |
| `[MITM] hostname = %APPEND% ...` | `[Mitm] hostname = ...` |

**脚本业务逻辑一行没改**，只在每个脚本前面加了适配层（`adapter.js`，构建时内联）；
`response.js` / `ump.js` 仍是上游原文件。

### 文件

| 文件 | 用途 |
| --- | --- |
| `youtube-enhance/youtube-enhance.plugin` | 插件本体（9 个开关、7 条脚本规则、2 条广告 Rewrite） |
| `youtube-enhance/scripts/request.js` | ad_break 拦截、log_event 去头、initplayback / videoplayback 请求体（autoHd） |
| `youtube-enhance/scripts/response.js` | browse / next / player / search 等响应改写 |
| `youtube-enhance/scripts/key.js` | 从 `/config` 抓 clientKey / encryptKey（UMP 解密用） |
| `youtube-enhance/scripts/ump.js` | initplayback UMP 解密改写（去广告核心） |
| `youtube-enhance/adapter.js` | 适配层源码（构建时内联进上面 4 个脚本） |
| `youtube-enhance/test.js` | `node test.js`，22 个用例模拟 Loon 环境 |

### 注意

- 最低 **Loon 3.5.1 (988)**：`ump.js` 要用 `$utils.gzip` / `$utils.ungzip`。
- 必须开 MITM 且信任 Loon 证书；`[Mitm]` 含 `*.googlevideo.com`，和 Surge 原版一致。
- 脚本是**本地副本**，上游改版不会自动跟进；需要更新时重新构建再推一次。
- 仅处理 Innertube 的 `application/x-protobuf` 响应；JSON 接口原样放行。

---

# YouTube 去广告（汉化版 · 自动跟随上游）

文件：`youtube-zh/YouTube-zh.lpx`（由 `youtube-zh/sync.py` 生成，别手改）

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/youtube-zh/YouTube-zh.lpx
```

源：[devchristian1337/loon-plugins · Plugins/YouTube.lpx](https://github.com/devchristian1337/loon-plugins/blob/main/Plugins/YouTube.lpx)

## 和上游的区别

- 插件名、简介、16 个参数的标题与说明、全部注释、12 条脚本条目名、脚本内通知与日志页标题都汉化了；
- 两个脚本镜像到本仓库 `youtube-zh/scripts/`，插件里的脚本地址改成本仓库 raw，不依赖上游存活；
- 规则、正则、脚本逻辑**一个字没改**，纯粹是文案层汉化。

## 自动更新

`.github/workflows/sync-youtube-zh.yml` 每 2 小时抓一次上游，比对 `#!date` 与 SHA-256，
有变化就重新镜像脚本、重套翻译、跑自检，然后自动提交。上游改了措辞导致翻译对不上时，
不会报错也不会显示乱码——那一条保持英文，并记进 `youtube-zh/report.md` 的「未翻译的英文」，补进
`i18n.json` 即可。

细节见 [`youtube-zh/README.md`](youtube-zh/README.md)。

> `youtube-enhance/` 和 `youtube-zh/` 是两套不同的 YouTube 方案（来源不同），**不要同时装**。

---
