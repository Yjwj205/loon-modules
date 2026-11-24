# Loon 定时切换策略 —— 综合利用EMBY4837

> 作者：[Yjwj205](https://github.com/Yjwj205) / Minis
> 主页：<https://github.com/Yjwj205> · 仓库：<https://github.com/Yjwj205/loon-modules>

## 功能

每天准点把指定策略组切到指定节点，**一天只跑 2 次**，幂等（已在该节点则直接退出，不切换、不通知）。

> **已支持多组切换**：每个策略组可以各自设置两个时间点、组间互不影响 → 见下方
> [定时切换策略·多组](#定时切换策略多组新插件)（`policy-multi.plugin`）。本页这个准点版保持简单两时段，二者二选一。

| 时间 | 切换到 |
| --- | --- |
| 09:00 | `Matrix` |
| 19:00 | `吹雪云观影组` |

策略组默认 `综合利用EMBY4837`，时间与目标节点都能在插件参数里改。

## 插件版本

| 插件 | 版本日期 | 最低 Loon | 配置语法 |
| --- | --- | --- | --- |
| `policy-exact.plugin` | 2026-11-14 | 3.5.1 (983) | 新版 Script（v2） |
| `policy-multi.plugin` | 2026-11-15 | 3.5.1 (983) | 新版 Script（v2）· 多组多时段 |
| `kill-on-open.plugin` | 2026-11-19 | 3.5.1 (983) | 新版 Script（v2） |
| `fktg.plugin` | 2026-11-08 | — | `[Host]` IP→IP 映射 · 指向 `.147` |
| `fktg-201.plugin` | 2026-11-15 | — | `[Host]` IP→IP 映射 · 指向 `.201` |
| `fktg-180.plugin` | 2026-11-15 | — | `[Host]` IP→IP 映射 · 指向 `.180` |
| `ikuuu-checkin.plugin` | 2026-11-20 | 3.5.1 (983) | 新版 Script（v2）· 加 CK 快过期提醒 |
| `workbuddy-report.plugin` | 2026-11-24 | 3.5.1 (983) | 新版 Script（v2）· WorkBuddy 面板日报（公开版） |
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

# 定时切换策略·多组（新插件）

文件：`policy-multi.plugin` + `switch-multi.js`

> 与上面「定时切换策略·准点」并列的另一个插件，旧的 `policy-exact.plugin` 没有任何改动。
> 两个插件都会改策略组选择，**请只启用其中一个**。

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/policy-multi.plugin
```

## 结构：一个策略组一段，每段自带两个时间

```
① 启用        [ 关 ]          ← 关着的话本段两条 cron 根本不会执行
① 策略组      [ 填你的组名        ]
① 时间 1      [ 0 9 * * * ]   ① 时间 1 切到 [ 填节点名 ]
① 时间 2      [ 0 19 * * * ]  ① 时间 2 切到 [ 填节点名 ]

② 策略组      [ ]  ← 留空 = 本段不启用
③ 策略组      [ ]
④ 策略组      [ ]
```

- 插件里**不预置任何组名**，全部由你填；四段默认都是空的、开关默认关闭，**装上后一条 cron 都不会跑**。
- 每段有独立开关 `e1`~`e4`：关着时 Loon 直接跳过这两条定时（脚本完全不执行，不占 CPU、不写日志），
  打开且填了组名与目标才会真正切换。
- 每段两条 cron，各自用**本段自己的时间参数** —— A 组 8:00/20:00、B 组 9:30/18:00 都行，互不相干。
- **组与组互不影响**：一条 cron 只处理一个组，某组失败不牵连其他组。
- **留空即静默**：组名留空、或该时间点的目标留空 → 到点什么都不做，不切换、不通知。
- 组名与目标都支持：完整名 → 序号（从 1 开始）→ 唯一关键字；匹配忽略空格与引号。
- 目标写错时，通知里会列出该组可选的节点，不会瞎切。

## 通知长什么样

| 字段 | 内容 |
| --- | --- |
| 标题 | `策略已切换` / `策略切换部分失败` / `策略切换失败` |
| 副标题 | **策略组名** + 时间，例如 `综合利用EMBY4837 · 14:20`；多组时 `A 等 3 个组 · 14:20` |
| 正文 | 从哪个策略 → 切到哪个：`✓ 综合利用EMBY4837：Matrix → 吹雪云观影组` |

失败时正文会写清原因，例如
`✗ 综合利用EMBY4837：目标「打错的节点」没找到（可选：DIRECT / Matrix / 吹雪云观影组）`。

## 参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `e1` … `e4` | 关 | ①②③④ 启用开关；关闭时对应两条 cron 不执行（连脚本都不运行） |
| `g1` … `g4` | 空 | ①②③④ 策略组；留空 = 该段不启用 |
| `t1a` / `t1b` | `0 9 * * *` / `0 19 * * *` | ① 段的两个时间点（5 段 cron） |
| `v1a` / `v1b` | 空 | ① 段两个时间点各自切到哪个节点 |
| `t2a`…`t4b` | 各自默认 | ②③④ 段同构，段不启用时忽略 |
| `v2a`…`v4b` | 空 | 同上 |
| `notify` | 开 | 切换是否发通知 |

想再加段：复制一组 `gN` / `tNa` / `vNa` / `tNb` / `vNb` 参数和两条 cron 即可。

## 注意

- 与「准点」版二选一，别同时开。
- 只能切手动选择型（`select`）策略组；`url-test` / `fallback` / `ssid` 这类自动组切不动。
- 读不到 `all_policy_groups` 时会退化：直接按你填的组名原样切。
- 本地测试：`node test-switch-multi.js`（28 断言）、`node test-plugin-multi.js`（53 断言，插件与脚本联调）。
- Loon 参数只有 `input` / `select` / `switch`，`select` 候选值必须写死在插件里，做不出「读取你的策略组做下拉」；
  Sub-Store 那个「代理指向的策略」是 `[Rule]` 的 `PROXY` 映射（官方只允许 DIRECT / REJECT / PROXY），
  一个插件只有一格，脚本也读不到映射结果，所以不能拿来选组。

---

# 附：Fuck Telegram bad IPs（Loon 版）

文件：`fktg.plugin`（指向 .147）、`fktg-201.plugin`（指向 .201）、`fktg-180.plugin`（指向 .180）

把 Telegram 一直连到的「垃圾 IP」在 Loon 层重定向到好 IP，减少转圈卡顿。
原版是 Surge 模块 [Repcz/Tool · FKTG.sgmodule](https://github.com/Repcz/Tool/raw/X/Surge/Module/Function/FKTG.sgmodule)。

## 三个变体（目标 IP 不同，只装一个）

| 文件 | 安装地址 | 目标 IP |
| --- | --- | --- |
| `fktg.plugin` | `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/fktg.plugin` | `91.108.56.147` |
| `fktg-201.plugin` | `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/fktg-201.plugin` | `91.108.56.201` |
| `fktg-180.plugin` | `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/fktg-180.plugin` | `91.108.56.180` |

`[Host]` 里同一个源 IP 只能映射到一个目标，**三个同时装会互相覆盖**（后加载的生效），
想换目标就先停用/删除旧的。

- `fktg.plugin`：源 9 条（与 Surge 原版一致）
- `fktg-201.plugin` / `fktg-180.plugin`：源 11 条 = 原 9 条 + 另外两个「好 IP」，见下

## 安装

Loon → 配置 → 插件 → 右上角 `+` → 填上表里对应的 URL。

导入后确认插件为开启状态，重开 Telegram 生效。

## 原理 / 与 Surge 原版的差异

| Surge | Loon |
| --- | --- |
| `[Host]` 里写 `坏IP = 好IP1,好IP2` | `[Host]` 里写 `坏IP = 好IP,use-in-proxy=true`，**每条只能一个目标 IP** |
| `[General]` 里 `use-local-host-item-for-proxy = true` | 每条尾部加 `,use-in-proxy=true`（代理连接也走该映射，Telegram 走代理时必须） |

所以原版一条写两个目标 IP（`91.108.56.147,91.108.56.201`）在 Loon 上拆不开，
本仓库拆成三个变体，每个文件只指向一个目标 IP。想换目标：直接换装另一个变体，
或者把文件里的目标 IP 批量替换（Loon 编辑插件 → 点该插件 → 源码修改，或改仓库后重新导入）。

坏 IP 列表：

- `fktg.plugin` 保留源模块原样 9 条：
  `91.108.56.100 / .101 / .104 / .107 / .120 / .125 / .126 / .128 / .156`
- `fktg-201.plugin` / `fktg-180.plugin` 是 11 条：上面 9 条 **+ 另外两个好 IP**
  （`.201` 版补 `.147`、`.180`；`.180` 版补 `.147`、`.201`），
  这样只要你选定了某个目标，Telegram 不管是先连上哪个 DC5 IP，都会被拉到同一个目标上。

社区版一般还会补 `.109 .110 .113 .134 .138 .143 .145` 等，需要的话照着同样的格式往下加即可。

## 验证

- `use-in-proxy` / IP→IP 映射语法见 Loon 官方示例配置 `Loon0x00/LoonExampleConfig` 的 `[Host]` 段：
  「将目标 IP 映射到另一个 IP。」「use-in-proxy=true 表示代理连接也使用该映射。」
- 三个目标地址在本机实测均为 Telegram 新加坡 DC5（AS62014 Telegram Messenger Inc），443 端口可连通、
  发 `GET /` 会回 `HTTP/1.1 404 Not Found`（Telegram DC 的特征响应）：`.147 .180 .201` 全部通过。
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
| CK 剩余天数 | 开 | 开启后签到通知末尾显示「CK 剩余：X 天（到期时间）」；关闭只保留 ≤2 天的快过期提醒 |
| 先读流量再签到 | 关 | 打开后先把流量页读完、再发签到：页面必然早于签到落库，剩余流量 = 页面读数 + 今日签到赠送（显示为 ≈，并附两个加数）。关掉则签到后再读，数字就是官网口径 |

## 行为

- 定时：`POST https://ikuuu.org/user/checkin`（带 Cookie / Referer / XHR 头），解析 `{ret, msg}`；
- 失败自动重试：签到请求最多 3 次、间隔 1.5 秒；流量请求失败再补 1 次（偶发 TLS/线路抖动基本能自愈）；
- 播报：再 `GET /user`，页面正文是 base64 包在 `var originBody = "..."` 里的，脚本自己解码，
  只抓「剩余流量」这一行（解析失败就不显示，不影响签到结果；不报今日已用、不额外加签到时间）；
- 通知副标题：`签到成功` / `今日已签到` / `签到失败` / `Cookie 已失效`；
- **CK 剩余天数**：开关打开时，签到通知末尾多一行「CK 剩余：X 天（YYYY-MM-DD HH:mm 到期）」；
  Cookie 已过期则显示「CK：已过期（…）」。Cookie 里没有 `expire_in` 时不显示。
- **Cookie 快过期提醒**：站点在 Cookie 里带 `expire_in`（Unix 秒），脚本剩余 ≤ 2 天时单独推一条
  「iKuuu Cookie 即将过期」，写明到期时间；同一张票每天最多提醒一次，重新登录换了 `expire_in` 会重新计；
- 抓取 Cookie 成功时另有通知「已获取登录 Cookie」，提示你去关掉抓取开关；Cookie 没变化时不打扰；
- 手动：Loon → 脚本 → `iKuuu 签到（手动）`（generic 触发），随时跑一次。

## 性能

一次运行 = 签到 POST + 读流量 GET（顺序执行，读流量要在签到之后才准），日志里会分段打点：

```
[iKuuu] 签到返回 t=812ms 第 1 次
[iKuuu] 流量页 t=1050ms 请求 231ms 解码 18ms 大小 132KB
[iKuuu] 2026-11-22 计时版 总耗时 1063ms
```

- 主要成本是两次 HTTPS 往返（首包要建连，约 0.4~0.7s），代码本身只占几毫秒；
- 页面解析不再整页解码：base64 → 字节用查表、4 个字符一组；然后在字节里定位「剩余流量」，
  只解码标签附近的一小段（找不到才退回整页解码）。日志里的「解码」就是这一段耗时；
- 想同时要「加法」和「准确」就打开「先读流量再签到」：先 `GET /user` 拿到页面读数，再 `POST /user/checkin`，
  然后做一次加法：`剩余流量 ≈ 页面读数 + 今日签到赠送`，通知里会把两个加数都写出来，例如
  ```
  你获得了 1767 MB流量
  页面·签到 12.34GB||1767MB
  剩余流量：≈ 14.07 GB
  ```
  第二行的两个数分别是流量页读数和签到赠送量（`||` 分隔）。
  **为什么必须「先读」**：两个请求并行时，页面可能晚于签到落库才渲染 —— 2026-11-25 实测流量页请求花了
  6.3 秒（站点整点高峰），签到 0.39 秒就落库，拿到的 249.53 GB 其实已含当天赠送，再加一次就成了
  252.24 GB，而官网仍是 249.53 GB。改成「读到了再签到」之后，页面读数一定早于赠送落库，加法才站得住。
  代价：签到要等页面读完（页面慢的时候会晚几秒）；页面读不到时照常签到，只是这次不报剩余流量。
  消息里没有赠送量（或不是流量）时不加法，退回标注「（签到前）」。不开这个开关就是签到后的官网口径。

## 注意

- 自动抓 Cookie 依赖 MITM；不想开 MITM 就手动填 Cookie，签到本身不需要 MITM。
- 关掉 **抓取 Cookie** 只是让 request 脚本不再执行，插件声明的 `[Mitm] hostname` 仍会保留
  （Loon 不支持按开关撤销主机名）。要完全不做 MITM，把插件源码里 `[Mitm]` 那段删掉，
  或者干脆手动填 Cookie、不启用抓取。
- Cookie 过期后通知会提示「Cookie 已失效」，去 Safari 重新登录一次就会自动更新。
- cron 只在 Loon 运行（VPN 开启、没被系统杀掉）时触发，和仓库里其他插件一样。
- 本地测试：`node test-ikuuu.js`（90 个用例，覆盖抓 Cookie、开关与通知、去重、签到成功、已签到、失效、TLS 重试、请求节点、超时、手动优先、流量解析失败、先读模式的加法与页面失败兜底、CK 快过期提醒与剩余天数开关）。

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

## WorkBuddy 面板日报（公开版）

> 配套面板：[ithtelab/workbuddy-manager](https://github.com/ithtelab/workbuddy-manager) —— WorkBuddy 的 Web 管理端。
> 本插件**只读**：不签到、不改任何设置，只把面板账号池的状态播报到 Loon 通知里。

安装地址：

```
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/workbuddy-report.plugin
```

也可以直接点：[一键导入 Loon](loon://import?plugin=https%3A%2F%2Fraw.githubusercontent.com%2FYjwj205%2Floon-modules%2Fmain%2Fworkbuddy-report.plugin)

通知内容：

```
WorkBuddy 面板日报

✅ 今日签到：5/6 个账号
📈 今日用量：198 次 · 22.62M tokens
🎁 今日入账：+539 积分（含签到）
🙈 未签：foo@example.com
💸 消耗与剩余：160.39 积分 · 15,636 积分
```

- 「今日签到」的分母只算**能签到的号**：停用、面板临时禁用、缺 accessToken、国际版/企业版不支持签到的号都不计入；支持签到的号才会出现在「未签」里。
- 「未签」最多点 4 个名字，再多显示「等 N 个」；不想在锁屏上暴露昵称/邮箱，把「点名未签」关掉。
- 某一项接口失败只影响对应那一行，末尾提示「部分数据缺失」；全挂才播「获取失败」，并给出排查方向。

### 安装

1. 先部署 [WorkBuddy Manager](https://github.com/ithtelab/workbuddy-manager)，确认浏览器能打开面板；
2. 面板 → 设置 → **API Tokens** → 新建，权限选「只读 / readonly」，复制 `wbt_` 开头的令牌；
3. Loon → 插件 → 右上角 `+` → 粘贴上面的安装地址；
4. 打开插件参数，填「面板地址」和「只读 Token」；
5. 点插件里的 **WorkBuddy 面板日报（手动）** 测试，收到通知即配置成功。

> 只读令牌就够用，不需要管理员。令牌泄露时在面板里禁用即可。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| 面板地址 | 空 | WorkBuddy Manager 根地址，如 `https://wb.example.com`；末尾不用带斜杠，填成 `.../api` 也能识别 |
| 只读 Token | 空 | 面板 → API Tokens 新建的 `wbt_` 令牌，只读权限即可；直接粘贴 `Bearer wbt_...` 也会自动去掉前缀 |
| 面板分组 ID | 空 | 面板「设置 → 上游」里的多上游分组，填数字 ID；和 Loon 策略组无关，只有一个默认上游时留空 |
| 播报时间 | `0 9 * * *` | 5 段 cron（分 时 日 月 周），默认每天 09:00 |
| 请求节点 | 空 | 可选：节点名 / 策略组名 / `DIRECT`，留空跟随规则；面板偶尔连不上时固定一个节点 |
| 定时播报 | 开 | 关掉只剩手动触发 |
| 发通知 | 开 | 关掉只写日志（调试用） |
| 点名未签 | 开 | 关闭后只报「N/M 个账号」，不显示未签账号的昵称 |

> **「面板分组 ID」是什么？**
> WorkBuddy Manager 的「设置 → 上游」可以接多个 `workbuddy2api` 实例，每个实例是一套独立的账号池（面板里叫「上游」）。除默认上游外，每个分组有一个数字 ID；插件填了这个 ID 就播报对应分组的账号池，留空播报「默认上游」。
> **它和 Loon 的策略组 / 节点分组没有任何关系**，不要填 Loon 里的策略组名。

### 数据口径

| 通知里的行 | 来源接口 | 口径 |
|---|---|---|
| 今日签到 N/M + 未签点名 | `/api/checkin-logs?days=2` + `/api/accounts` | 今天（手机本地时区）里 `success` 的账号，按 uid 去重；`当前已签到`（code 10001）也算签到成功。M = 能签到的号数（停用 / 面板禁用 / 缺 token / 不支持签到的号不计入）。未签名单来自逐号 `checkin_today`；只有上游自动签到的汇总行时，读「成功 X + 已签到 Y」并标注「按自动签到汇总」，此时不点名 |
| 今日用量 | `/api/stats/summary` | `today_requests` / `today_tokens` |
| 今日入账 | `POST /api/accounts/refresh-credits` 返回的 `meta.*.expiries` | 今天（本地时区）**新建**的积分包金额之和：签到 / 猫猫旅行 / 活跃任务等入账都在里面。面板账本也按积分包的 `created` 记账，所以两边一致；老版本面板没有这些字段时退回 `/api/stats/credits` 的 `today.income` |
| 消耗与剩余 | `/api/stats/summary` + 刷新返回的 `credits`（快照兜底） | `today_credit` 是今日实际扣费；剩余额度是刷新刚问到的各账号积分合计，停用号不计。某个号刷新失败时用快照旧值补上，不会整段掉；拿不到刷新结果时退回 `/api/accounts/credits-snapshot` |

**只发一轮请求**：6 个只读 GET + 1 个刷新 POST 同时发出（刷新响应里已经带最新积分和积分包明细），拿齐就播报。刷新用的是 `force=false`，面板 60 秒内走缓存，不会每次都真查腾讯；只读令牌也能调。

### 安全与隐私

- 只用 `wbt_` **只读**令牌；调用的都是 GET，唯一的 POST 是面板页面加载时也会调的 `refresh-credits?force=false`（只刷新余额缓存，不签到、不改设置）。
- 令牌保存在 Loon 的插件配置里，脚本不会把它写进通知或日志。
- 通知可能显示账号昵称/邮箱；介意的话关掉「点名未签」。

### 兼容与排查

- Loon 3.5.1 (983)+（新版 Script 语法）。
- 面板建议保持最新版；脚本对账号列表、签到记录、快照等接口做了老字段兼容，缺接口时会自动用其他数据兜底。
- **401**：Token 无效或已停用 → 面板 → API Tokens 重新建一个只读令牌。
- **404**：面板地址填错，或面板版本过旧 → 填面板根地址，必要时升级面板。
- **返回的不是 JSON**：地址指到了面板网页 / 登录页（例如 Cloudflare Access）→ 改填 API 根地址，或先去掉外层登录。
- **网络错误**：手机到面板不通 → 在「请求节点」里固定一个节点，或确认面板能从公网访问。
- **时区**：面板的「今日用量 / 入账」按面板服务器时区统计，签到按手机本地时区判断；两边时区不一致时，午夜前后可能对不上。
- 本地测试：`node test-workbuddy-report.js`（93 个用例，覆盖正常播报、停用/不支持签到、自动签到汇总、接口缺失、401/404/422、登录页 HTML、多分组、毫秒时间戳、刷新响应直接出数、刷新部分失败、字段兼容等）。

### 文件

| 文件 | 用途 |
| --- | --- |
| `workbuddy-report.plugin` | 插件本体（参数、cron、手动入口） |
| `workbuddy-report.js` | 播报脚本（只读接口 + 余额缓存刷新） |
| `test-workbuddy-report.js` | 模拟 Loon 环境的本地测试 |

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
# 通用规则集（rules/）

从可莉规则站（`rule.kelee.one`）的 Loon `.lsr` 合并规则集，转成各客户端通用的 `.list`。

| 文件 | 源 | 规则数 | 直链 |
| --- | --- | ---: | --- |
| `rules/WeChat.list` | `Loon/WeChat.lsr`（微信分流） | 42 | `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/rules/WeChat.list` |

## 转换做了什么

- **语法规范化**：`DOMAIN, xx` → `DOMAIN,xx`（去掉逗号后的空格）、去行尾空白、LF 换行、文件末尾留一空行
- **分组排序**：按 `DOMAIN` → `DOMAIN-SUFFIX` → `IP-ASN` → `USER-AGENT` 分组，组内按字母排序，便于以后 diff
- **去重**：`DOMAIN,wxapp.tc.qq.com` 与 `DOMAIN-SUFFIX,wxapp.tc.qq.com` 重复，删掉 DOMAIN 那条（后缀已覆盖）
- **头部元信息**：来源 URL、源更新时间、规则总数、各类型计数，全部写成 `#` 注释，不影响任何客户端解析

规则语义零改动，只动了格式。

## 规则构成（WeChat.list）

| 类型 | 条数 | 说明 |
| --- | ---: | --- |
| `DOMAIN` | 17 | 精确域名：微信后台、支付、小程序/CDN 等 |
| `DOMAIN-SUFFIX` | 22 | 后缀：qq.com 系、wechat.com、tenpay.com、qpic.cn 等 |
| `IP-ASN` | 1 | `132203`（腾讯），带 `no-resolve` |
| `USER-AGENT` | 2 | `WeChat*` / `MicroMessenger*` |

## 兼容性

| 类型 | Surge | Loon | Clash / Mihomo / Stash | Shadowrocket |
| --- | :-: | :-: | :-: | :-: |
| `DOMAIN` / `DOMAIN-SUFFIX` | ✅ | ✅ | ✅ | ✅ |
| `IP-ASN` + `no-resolve` | ✅ | ✅ | ✅（`IP-ASN` 需 Meta 内核） | ✅ |
| `USER-AGENT` | ✅ | ✅ | ❌ | ✅ |

Clash 系用之前把最后两行 `USER-AGENT` 删掉，否则整份规则会解析失败；其余行不用改。

## 用法

Loon：`[Rule]` 里直接写「URL,策略」（订阅规则语法），位置越靠前优先级越高：

```ini
[Rule]
https://raw.githubusercontent.com/Yjwj205/loon-modules/main/rules/WeChat.list,微信
```

Surge：`RULE-SET, <URL>, <策略>`；Clash 系需要包成 `rule-providers`（`behavior: classical`）。

## 来源与更新

- 源站：`https://rule.kelee.one/Loon/WeChat.lsr`，文件内 `UpdateTime：2026-10-29 03:14:26`、`RuleCount：43`
- 本机（手机）与香港、美西两台 VPS 直连源站都是 **Cloudflare 403**（`Sorry, you have been blocked`），
  所以实际取自镜像 [`IamNewHands/loon-rules`](https://github.com/IamNewHands/loon-rules) 的 `loon/WeChat.lsr`
  （2026-11-01 同步，原文未改写，含源站 `#` 头）
- 刷新：`curl -sL https://raw.githubusercontent.com/IamNewHands/loon-rules/main/loon/WeChat.lsr`
  后重新跑一遍上面的规范化流程即可
