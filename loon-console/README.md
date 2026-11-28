# Loon 控制台（Scripting 单脚本小组件）

一个卡片看四件事，两个能点：

```
┌─────────────────────────────────────────┐
│ 🅻 Loon ●                     22:14  ⋯ ↻ │
│ ⏱ 运行时长                ⚙ 策略组      │
│    12天 03:05                16          │
│ [分流模式 ↻]  [节点选择 → 🇭🇰 香港 01 ▶] │
│ 🌐 🇭🇰 103.85.12.44 · 中国香港 · Loon 3.5.1│
└─────────────────────────────────────────┘
```

- **运行时长**：Loon 在线时长（桥接心跳推算），可切「设备开机时长」
- **策略组**：Loon 里策略组总数
- **运行模式胶囊**：点一下 分流 → 全局代理 → 全局直连 轮转
- **节点胶囊**：点一下切到该组的下一个节点；点右上角 `⋯` 进控制台，可以从候选列表里精确选节点、选要盯的策略组
- **公网 IP**：走当前代理出口打 `ip-api.com`，带国家/城市 + 国旗

## 安装

1. 下载 [`Loon-Console.scripting`](Loon-Console.scripting) 用 Scripting 导入，或 Scripting → 导入脚本 → 填：
   `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/loon-console/Loon-Console.scripting`
2. Loon 侧装桥接插件（**1.1.0 起才有心跳/在线时长**）：
   `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/loon-control/loon-control.plugin`
3. 桌面加 Scripting 小组件 → 编辑 → 选 `Loon 控制台`。

## 参数（可选）

```
bridge=http://1.1.1.1/loon-bridge
group=节点选择            ← 「节点」格子盯哪个策略组，留空自动挑
uptime=loon               ← loon=Loon 在线时长｜device=设备开机时长
```

## 运行时长是怎么来的

Loon 不向脚本暴露隧道启动时间，所以这里用**心跳**近似：

- `loon-control.js` 每次 cron 或桥接请求都往 `$persistentStore` 写一次时间戳；
- 两次心跳断档 ≤ 30 分钟 → 认为 Loon 一直在线，时长 = now − 首次打点；
- 断档 > 30 分钟 → 认为 Loon 重启/停过，从现在重新计时。

所以它是「近似运行时长」：Loon 重启后如果马上就有请求（断档很短），数字会偏大。要绝对准确就切成 `uptime=device`（设备开机时长，来自 `os.uptime()`）。

## 结构

```
Loon-Console.scripting
├── script.json
├── widget.tsx     ← 小组件本体：桥接请求、IP、时长、小/中号布局、刷新与切换 intent
├── index.tsx      ← 控制台页：切模式、选策略组、选节点、改配置、预览
├── global.d.ts
└── assets/loon.png
```

## 测试

```
node test-console.js     # 36 项：桥接解析 / 时长两种来源 / IP 与缓存 / 降级保留 / intent 调用 / 尺寸文案
```

## 依赖的桥接接口（loon-control.js v1.1.0）

| 接口 | 用途 |
|---|---|
| `?action=status&groups=<组>&select=1&sub_timeout=900` | 模式、策略组数、当前节点、候选数、`loon_uptime_ms` |
| `?action=set_mode&mode=next` | 切模式 |
| `?action=set_policy&policy=<组>&node=next` | 切节点（`node=` 具体名字也行） |
