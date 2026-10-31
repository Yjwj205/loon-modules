# Loon 定时切换策略 —— 综合利用EMBY4837

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
`https://raw.githubusercontent.com/1433735029/loon-modules/main/policy-switcher.js`。
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
  - https://loon0x00.github.io/docs/Script/script_api/
  - https://loon0x00.github.io/docs/Script/script_v2/
