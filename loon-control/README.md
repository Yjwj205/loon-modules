# Loon 控制面板（独立版）

从 `DashBoard-Kit.scripting`（SylvanRoe）里把 **Loon 那部分**单独抽出来重写的一个脚本，
不再依赖 iOS「Scripting」App，也不再碰任何机场/节点订阅链接。

一个 `loon-control.js` 同时干两件事：

| 触发方式 | 产出 |
|---|---|
| `cron` / `network-changed` / `generic` | Loon 里的**面板卡片**：运行模式、策略组数、各策略组当前节点、链路延迟、Loon 版本 |
| `request http://1.1.1.1/loon-bridge?...` | **JSON 桥接**：`status` / `set_mode` / `set_policy`，给桌面小组件、快捷指令、curl 用 |

## 文件

- `loon-control.plugin` — Loon 插件（`[Argument]` + 4 条 `[Script]`）
- `loon-control.js` — 全部逻辑（面板 + 桥接 + 心跳，约 900 行）
- `test-loon-control.js` — 本地测试，`node test-loon-control.js`，67 项全过

## 安装

**方式一：插件（推荐）**

Loon →「插件」→ 右上角 ➕ → 添加插件 → 粘贴 `loon-control.plugin` 的远程链接。

注意：插件里 `script(...)` 指向的是 `loon-control.js` 的 **http(s) 远程地址**，Loon 不会去读本地文件。
把两个文件放到你自己的 GitHub 仓库（或任意静态托管），再把 `loon-control.plugin` 里的地址换掉即可。

**方式二：直接写进配置的 `[Script]` 段**

```
[Script]
cron "*/10 * * * *" then script("https://<你的地址>/loon-control.js", {groups:"", latency:"true"}) with tag="Loon 面板", timeout=30
network-changed then script("https://<你的地址>/loon-control.js", {groups:"", latency:"true"}) with tag="Loon 面板 · 网络切换", timeout=30
request if ${url} ~= /^http:\/\/(1\.1\.1\.1|8\.8\.8\.8|cp\.cloudflare\.com)\/loon-bridge(\?|$)/i then script("https://<你的地址>/loon-control.js", {groups:"", latency:"true"}) with tag="Loon 桥接", timeout=30
```

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `groups` | 空 | 只显示这些策略组，逗号分隔，最多 4 个。留空自动挑「节点选择 / 国外网站 / 流媒体 / 漏网之鱼 …」 |
| `cronExpr` | `*/10 * * * *` | 面板刷新频率（5 段 cron，分 时 日 月 周） |
| `latency` | 开 | 面板里测一次链路延迟（打 `gstatic/generate_204`，多花 0.1–2 秒） |
| `enabled` | 开 | 定时 + 网络切换刷新 |

## 面板长什么样

```
🟢 分流模式 · 5 组 · ⏱ 89 ms
────────
🏷 节点选择 → 🇭🇰 香港 01
🏷 国外网站 → 🇭🇰 香港 01
🏷 流媒体 → 🇯🇵 东京 02
🏷 漏网之鱼 → 节点选择
────────
Loon 3.5.1 · 20:47
```

配色随模式变：分流 🟢 `#34C759`、全局代理 🟣 `#8B5CF6`、全局直连 ⚪ `#8E8E93`，出错 ❌ `#FF3B30`。

## 桥接 API

入口（IP 直连，不需要 DNS；`loon.lan` 这类假域名在 Loon 下请求都形成不了）：

```
GET http://1.1.1.1/loon-bridge?action=...
```

| 参数 | 说明 |
|---|---|
| `action=status`（默认） | 读状态 |
| `action=set_mode&mode=0\|1\|2` | 0 全局直连 / 1 分流 / 2 全局代理，也接受 `direct` `filter` `proxy` |
| `action=set_mode&mode=next` | 服务端自己算下一个模式（0→1→2→0），前端不用先读状态 |
| `action=set_policy&policy=组名&node=节点名` | 切指定策略组 |
| `action=set_policy&policy=组名&node=next` | 切到该组候选列表里的下一个（多组用 `\|` 分隔） |
| `groups=A\|B` | 只探这几个组的候选节点 |
| `sub_timeout=1500` | 候选节点探测总预算（ms） |
| `select=0` | 不补齐 `policy_select`（省掉逐组读选中值） |
| `latency=1` | 顺带测延迟（默认关，小组件自己有延迟逻辑） |
| `debug=1` | 回传 `sub_meta` / `config_api_keys` / `config_obj_keys` |

`status` 返回（字段名与原来的 DashBoard-Kit 兼容）：

```json
{
  "ok": true, "service": "loon", "script": "1.0.0",
  "running_model": 1, "running_mode": "filter", "mode_label": "分流模式",
  "policy_select": {"节点选择": "🇭🇰 香港 01"},
  "sub_policies": {"节点选择": ["DIRECT", "🇭🇰 香港 01"]},
  "all_policy_groups": ["节点选择", "国外网站"],
  "policy_group_count": 2,
  "groups": [{"group": "节点选择", "selected": "🇭🇰 香港 01", "inferred": false, "candidate_count": 2}],
  "latency_ms": null, "version": "Loon 3.5.1", "ssid": "", "final": "", "timestamp": 1764243600000,
  "loon_uptime_ms": 1036800000, "heartbeat_start": 1763206800000
}
```

写操作返回 `{ok, action, result, status}`；`result.changed=false` 时 `ok=false` 并带 `error`。

## 心跳（v1.1.0 新增）

Loon 不暴露隧道运行时长，所以用「脚本还在跑」来推算：每次 cron / 桥接请求都往 `$persistentStore`
写时间戳（`loon_control_hb`），断档 ≤ 30 分钟视为一直在线，超过就重新计时。
`status` 里多返回：

| 字段 | 说明 |
|---|---|
| `loon_uptime_ms` | 推算的 Loon 在线时长（毫秒） |
| `heartbeat_start` | 本轮计时起点（Unix ms） |
| `heartbeat_resets` | 累计重置次数（能看出重启过几次） |

## 相对原 `loon_dashboard_bridge.js` 改了什么

**删掉的（订阅相关，全部不要了）**

- 机场订阅拉取与 `subscription-userinfo` 解析 → 剩余流量 / 已用 / 总额 / 剩余百分比 / 到期时间
- 上下行累计流量（同一份 header 里的 `download` / `upload`）
- 因此面板和桥接里都没有这些字段，`sub_url` 之类参数也不存在

**优化**

| 原实现 | 现在 |
|---|---|
| 每次 `status` 对最多 20 个策略组并发 `getSubPolicies`，每组各给 2500ms | 只探要显示的 ≤4 个组，整体一个 deadline，结果按组缓存 120 秒 |
| 每个请求逐组（最多 40 个）同步探 `getSelectedPolicy` | 保留补齐，但可 `select=0` 关掉；已记录的组直接跳过 |
| `getConfig()` 调两次（第二次可能拿到 `undefined`） | 整次运行只读一次并缓存 |
| 响应体永远塞着 `sub_debug` / `config_api_keys` / `config_obj_keys` | 默认不带，`debug=1` 才给 |
| 没有兜底超时，Loon 20s 超时后会把脚本再跑一遍（白烧 CPU） | 硬 watchdog（桥接 `sub_timeout+4s`、面板 12s）+ 单次 `$done` 保证 |
| `set_policy` 静默失败也回 `ok:true` | 如实回 `ok:false` + `error`，并在 `result.items` 里逐组说明 |
| 只能由客户端轮转节点 | 支持 `node=next`，服务端按候选列表轮转 |
| `version` 写死成 `"Loon"` | 从 `$loon` 解析真实版本（`Loon 3.5.1`） |
| 只有 JSON 桥接，没有可视界面 | 新增面板卡片（cron / 网络切换 / 手动） |
| 策略组选中值缺失时无处理 | 跳过 `DIRECT/REJECT` 推断真实生效策略（沿用原逻辑，加 `inferred` 标记） |

## 已知限制

- **Loon 没有暴露机场流量接口**，这版按你的要求干脆不显示剩余流量/总额/到期。想恢复只能重新引入订阅链接（就是被删掉的那部分）。
- 如果继续用 DashBoard-Kit 的 iOS 小组件：模式/策略组/切节点都还能用（接口保持兼容），但卡片上的「剩余流量 / 总额 / 到期」那几格会停在 App 里的默认值 —— 需要在 App 侧把订阅填项和这块 UI 去掉，否则看着像数据没更新。
- 候选节点缓存 120 秒，订阅刚更新完最多 2 分钟才看到新节点名。
- 部分 Loon 版本对「没有显式选择过」的策略组会返回空，此时用候选列表推断，面板里会标 ⚠️；也可以在 App 里手动指向某个节点把它「定」下来。

## 测试

```
$ node test-loon-control.js
通过 67，失败 0
```

覆盖：面板渲染 / 参数两种形态 / 缓存命中 / 推断选中值 / 桥接 status / 写操作三种 / `node=next` 轮转 / 失败上报 / 未知 action / 回调永不返回 / 无 `$config` / 延迟失败 / 非法配置 JSON / `"null"` 字符串过滤 / 订阅字段彻底不存在。
