# Loon 流量看板（Scripting 单脚本小组件）

从 [DashBoard-Kit](https://github.com/SylvanRoe/Scripting) 的 `loon_traffic` 卡片抽出来独立成的小脚本。

**保留**：累计下行 / 累计上行 / 策略组数 / 运行模式 / Loon 版本 / 更新时间
**删除**：流量总额、剩余流量、实时延迟、到期时间

## 安装

1. 下载 [`Loon-Traffic.scripting`](Loon-Traffic.scripting)，用 Scripting 打开导入；
   或者 Scripting → 导入脚本 → 填远程地址：
   `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/loon-traffic/Loon-Traffic.scripting`
2. Loon 侧装桥接插件（只提供状态接口，不碰订阅）：
   `https://raw.githubusercontent.com/Yjwj205/loon-modules/main/loon-control/loon-control.plugin`
3. 桌面添加 Scripting 小组件 → 编辑 → 选 `Loon 流量看板`。

## 小组件参数（可选）

参数留空就用默认。也可以写成 k=v 或 JSON：

```
bridge=http://1.1.1.1/loon-bridge&traffic=https://你的机场订阅地址
```

| 参数 | 说明 |
|---|---|
| `bridge` | 桥接地址，默认 `http://1.1.1.1/loon-bridge`（IP 直连，不需要 DNS） |
| `traffic` | 可选。填了才显示累计上下行 |

## 关于累计上下行（重要）

Loon **不提供**累计流量接口——`$config` 里只有运行模式、策略组、选中值这些。
DashBoard-Kit 里那两个大数字其实来自机场订阅响应头：

```
subscription-userinfo: upload=...; download=...; total=...; expire=...
```

所以这版的处理是：

- 填了「流量源」→ 只读 `download` / `upload` 两个字段（HEAD 优先，失败才 Range 1 字节），
  **不导入任何节点，也不解析 total / expire**，所以没有总额、剩余、到期。
- 没填 → 两格显示 `—`，卡片其余部分照常工作。

## 结构

```
Loon-Traffic.scripting
├── script.json
├── widget.tsx      ← 全部逻辑：桥接请求、流量头解析、缓存、小/中号两种布局、两个 AppIntent
├── index.tsx       ← 可选配置页（看状态、改桥接、填流量源、预览）
├── global.d.ts
└── assets/loon.png
```

## 交互

- 右上角刷新按钮：拉一次桥接（+ 流量源）→ `Widget.reloadAll()`
- 中号卡片的「运行模式」胶囊：点一下按 分流 → 全局代理 → 全局直连 轮转（服务端 `mode=next`）
- 时间线：15 分钟后由系统唤醒刷新；快照 10 分钟内不重复请求，流量头缓存 15 分钟

## 测试

```
node test-widget.js     # 27 项：桥接解析 / 只读 download-upload / HEAD→Range 降级 / 缓存 / 降级保留旧值 / 尺寸分发
```
