/**
 * Loon 流量看板 · 单脚本小组件
 *
 * 从 DashBoard-Kit 的 loon_traffic 卡片抽出来，独立成一个小脚本：
 *   保留：累计下行 / 累计上行 / 策略组数 / 运行模式 / Loon 版本 / 更新时间
 *   删除：流量总额、剩余流量、实时延迟、到期时间
 *
 * 数据来源：
 *   1) Loon 侧桥接（loon-control 插件，GET http://1.1.1.1/loon-bridge?action=status）
 *      → 运行模式、策略组数、Loon 版本
 *   2) 可选「流量源」：机场订阅地址，只读响应头 subscription-userinfo 里的
 *      download / upload 两个字段（HEAD 优先，失败才 Range 1 字节）
 *      → 累计下行 / 累计上行。不导入任何节点，也不解析 total / expire。
 *
 * 组件参数（桌面长按 → 编辑小组件 → 参数），JSON 或 k=v 都行：
 *   bridge=http://1.1.1.1/loon-bridge
 *   traffic=https://你的机场订阅地址
 */

import {
  AppIntentManager,
  AppIntentProtocol,
  Button,
  Circle,
  HStack,
  Image,
  RoundedRectangle,
  Script,
  Spacer,
  Text,
  VStack,
  Widget,
  ZStack,
} from "scripting"

// Storage / fetch / UIImage 由运行时注入为全局对象，和 DashBoard-Kit 里的用法一致

// ─────────────────────────────────────────────── 常量

const CFG_KEY = "loon_traffic_cfg_v1"
const SNAP_KEY = "loon_traffic_snap_v1"
const SUB_KEY = "loon_traffic_sub_v1"

const FRESH_MS = 10 * 60 * 1000      // 快照 10 分钟内不重拉
const SUB_TTL_MS = 15 * 60 * 1000    // 订阅头 15 分钟内不重拉
const REFRESH_MINUTES = 15

const DEFAULT_BRIDGE = "http://1.1.1.1/loon-bridge"
const BRIDGE_CANDIDATES = [
  "http://1.1.1.1/loon-bridge",
  "http://8.8.8.8/loon-bridge",
  "http://cp.cloudflare.com/loon-bridge",
]
const SUB_UA = "Loon/3.5.1 (iPhone; iOS 17.5)"

type Mode = "filter" | "all_proxy" | "all_direct"

interface Snapshot {
  mode: Mode
  modeLabel: string
  groupCount: number
  version: string          // "Loon 3.5.1"
  download: string         // "15.0 GB" / ""
  upload: string           // "136.1 MB" / ""
  bridgeConnected: boolean
  bridgeError?: string
  hasTrafficSource: boolean
  updatedAt: string
}

interface Cfg {
  bridge: string
  traffic: string
}

// ─────────────────────────────────────────────── 配置

function parseParam(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const s = (raw || "").trim()
  if (!s) return out
  if (s.startsWith("{")) {
    try {
      const obj = JSON.parse(s)
      for (const k of Object.keys(obj)) out[k.toLowerCase()] = String(obj[k] ?? "")
      return out
    } catch {}
  }
  for (const part of s.split(/[&\n,]/)) {
    const t = part.trim()
    if (!t) continue
    const i = t.indexOf("=")
    if (i > 0) out[t.slice(0, i).trim().toLowerCase()] = t.slice(i + 1).trim()
  }
  return out
}

/** 优先级：小组件参数 > 配置页保存 > 默认 */
function readCfg(): Cfg {
  let saved: Cfg = { bridge: DEFAULT_BRIDGE, traffic: "" }
  try {
    const s = Storage.get<Cfg>(CFG_KEY, { shared: true }) as Cfg | null
    if (s && typeof s === "object") {
      saved = {
        bridge: (s.bridge || DEFAULT_BRIDGE).trim(),
        traffic: (s.traffic || "").trim(),
      }
    }
  } catch {}

  const param = parseParam(Widget.parameter || "")
  return {
    bridge: (param["bridge"] || saved.bridge || DEFAULT_BRIDGE).trim(),
    traffic: (param["traffic"] || param["sub"] || saved.traffic || "").trim(),
  }
}

function saveCfg(cfg: Cfg) {
  try {
    Storage.set(CFG_KEY, cfg, { shared: true })
    Storage.set(CFG_KEY, cfg)
  } catch {}
}

// ─────────────────────────────────────────────── 缓存

function getSnap(): Snapshot | null {
  try {
    const s =
      Storage.get<Snapshot>(SNAP_KEY, { shared: true }) ||
      Storage.get<Snapshot>(SNAP_KEY)
    if (s && typeof s === "object" && (s as any).mode) return s as Snapshot
  } catch {}
  return null
}

function saveSnap(snap: Snapshot) {
  try {
    Storage.set(SNAP_KEY, snap, { shared: true })
    Storage.set(SNAP_KEY, snap)
  } catch {}
}

function isStale(snap: Snapshot | null): boolean {
  if (!snap) return true
  const t = Date.parse(snap.updatedAt || "")
  if (!t) return true
  return Date.now() - t > FRESH_MS
}

// ─────────────────────────────────────────────── Loon 桥接

async function callBridge(cfg: Cfg, params: string): Promise<any | null> {
  const list: string[] = []
  if (cfg.bridge) list.push(cfg.bridge)
  for (const c of BRIDGE_CANDIDATES) if (list.indexOf(c) < 0) list.push(c)

  for (const base of list) {
    try {
      const res = await fetch(base + (base.includes("?") ? "&" : "?") + params, { timeout: 3 })
      if (!res || !res.ok) continue
      const text = await res.text()
      const json = JSON.parse(text)
      if (json && json.ok) return json
    } catch {}
  }
  return null
}

function modeFromModel(model: any): Mode {
  if (model === 0) return "all_direct"
  if (model === 2) return "all_proxy"
  return "filter"
}

const MODE_LABEL: Record<Mode, string> = {
  filter: "分流模式",
  all_proxy: "全局代理",
  all_direct: "全局直连",
}

function normalizeVersion(v: any): string {
  const s = String(v || "").trim()
  if (!s) return "Loon"
  return s.toLowerCase().startsWith("loon") ? s : "Loon " + s
}

// ─────────────────────────────────────────────── 流量源（可选，只读 download/upload）

function headerValue(res: any, name: string): string {
  const h: any = res && res.headers
  if (!h) return ""
  if (typeof h.get === "function") {
    try {
      return h.get(name) || h.get(name.toLowerCase()) || ""
    } catch {
      return ""
    }
  }
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === name.toLowerCase()) return String(h[k])
  }
  return ""
}

function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return "0 B"
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  const kb = bytes / 1024
  return `${Math.max(0.1, Math.round(kb * 10) / 10).toFixed(1)} KB`
}

/** 只认 download / upload，total 和 expire 一律不解析 */
function parseUpDown(header: string): { download: number; upload: number } | null {
  if (!header) return null
  const num = (key: string) => {
    const m = header.match(new RegExp(key + "\\s*=\\s*([0-9.eE+\\-]+)"))
    return m ? Number(m[1]) : NaN
  }
  const download = num("download")
  const upload = num("upload")
  if (!isFinite(download) && !isFinite(upload)) return null
  return { download: isFinite(download) ? download : 0, upload: isFinite(upload) ? upload : 0 }
}

async function fetchTraffic(url: string): Promise<{ download: number; upload: number } | null> {
  const base = { headers: { "User-Agent": SUB_UA }, timeout: 6 }
  const attempts: any[] = [
    { ...base, method: "HEAD" },
    { ...base, method: "GET", headers: { "User-Agent": SUB_UA, Range: "bytes=0-0" } },
    { ...base, method: "GET" },
  ]
  for (const opt of attempts) {
    try {
      const res = await fetch(url, opt)
      const parsed = parseUpDown(headerValue(res, "subscription-userinfo"))
      if (parsed) return parsed
    } catch {}
  }
  return null
}

async function readTrafficCached(url: string): Promise<{ download: number; upload: number } | null> {
  if (!url) return null
  try {
    const c: any = Storage.get(SUB_KEY, { shared: true }) || Storage.get(SUB_KEY)
    if (c && c.url === url && typeof c.t === "number" && Date.now() - c.t < SUB_TTL_MS) {
      return { download: c.download, upload: c.upload }
    }
  } catch {}

  const fresh = await fetchTraffic(url)
  if (fresh) {
    try {
      Storage.set(SUB_KEY, { url, t: Date.now(), download: fresh.download, upload: fresh.upload }, { shared: true })
      Storage.set(SUB_KEY, { url, t: Date.now(), download: fresh.download, upload: fresh.upload })
    } catch {}
  }
  return fresh
}

// ─────────────────────────────────────────────── 快照

async function buildSnapshot(cfg: Cfg): Promise<Snapshot> {
  const prev = getSnap()
  let mode: Mode = prev?.mode || "filter"
  let groupCount = prev?.groupCount || 0
  let version = prev?.version || "Loon"
  let connected = false
  let bridgeError = ""

  const json = await callBridge(cfg, "action=status&sub_timeout=800&select=0&latency=0")
  if (json) {
    connected = true
    if (typeof json.running_model === "number") mode = modeFromModel(json.running_model)
    else if (typeof json.running_mode === "string") {
      const rm = String(json.running_mode).toLowerCase()
      mode = rm === "all_direct" ? "all_direct" : rm === "all_proxy" ? "all_proxy" : "filter"
    }
    if (typeof json.policy_group_count === "number") groupCount = json.policy_group_count
    else if (Array.isArray(json.all_policy_groups)) groupCount = json.all_policy_groups.length
    version = normalizeVersion(json.version)
  } else {
    bridgeError = "桥接无响应"
  }

  let download = ""
  let upload = ""
  if (cfg.traffic) {
    const t = await readTrafficCached(cfg.traffic)
    if (t) {
      download = formatBytes(t.download)
      upload = formatBytes(t.upload)
    }
  } else {
    // 没填流量源：沿用上次的数字，不显示假的默认值
    download = prev?.download || ""
    upload = prev?.upload || ""
  }

  return {
    mode,
    modeLabel: MODE_LABEL[mode],
    groupCount,
    version,
    download,
    upload,
    bridgeConnected: connected,
    bridgeError,
    hasTrafficSource: !!cfg.traffic,
    updatedAt: new Date().toISOString(),
  }
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "--:--"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

// ─────────────────────────────────────────────── 小部件

function loadLoonImage(): any {
  try {
    const base = Script.directory
    const light = (globalThis as any).UIImage?.fromFile(`${base}/assets/loon.png`)
    if (light) return { light, dark: light }
  } catch {}
  return null
}

const LOON_IMAGE = loadLoonImage()

function Logo({ size }: { size: number }) {
  if (LOON_IMAGE) {
    return <Image image={LOON_IMAGE} resizable={true} frame={{ width: size, height: size }} />
  }
  return (
    <Image
      systemName="balloon.2.fill"
      font={{ name: "system", size: size }}
      foregroundStyle="#7C3AED"
    />
  )
}

function BridgeDot({ connected, size = 5 }: { connected?: boolean; size?: number }) {
  return (
    <HStack spacing={3} alignment="center">
      <Circle fill={connected ? "#10B981" : "#F59E0B"} frame={{ width: size, height: size }} />
      {!connected ? (
        <Image
          systemName="exclamationmark.triangle.fill"
          font={{ name: "system", size: size + 3 }}
          foregroundStyle="#F59E0B"
        />
      ) : null}
    </HStack>
  )
}

function RefreshButton() {
  return (
    <Button intent={LoonRefreshIntent()} buttonStyle="plain">
      <ZStack frame={{ width: 22, height: 22 }}>
        <Circle fill={{ light: "rgba(0,0,0,0.04)", dark: "rgba(255,255,255,0.08)" } as any} />
        <Circle
          stroke={{
            shapeStyle: { light: "rgba(0,0,0,0.06)", dark: "rgba(255,255,255,0.12)" } as any,
            strokeStyle: { lineWidth: 0.8 },
          }}
        />
        <Image
          systemName="arrow.triangle.2.circlepath"
          font={{ name: "system", size: 10.5 }}
          foregroundStyle={{ light: "#64748B", dark: "#94A3B8" } as any}
        />
      </ZStack>
    </Button>
  )
}

const C = {
  title: { light: "#1E293B", dark: "#F8FAFC" } as any,
  label: { light: "#64748B", dark: "#94A3B8" } as any,
  divider: { light: "rgba(0,0,0,0.08)", dark: "rgba(255,255,255,0.12)" } as any,
  accent: { light: "#0284C7", dark: "#38BDF8" } as any,
  dl: { light: "#16A34A", dark: "#22C55E" } as any,
  ul: { light: "#D97706", dark: "#F59E0B" } as any,
  bg: { light: "#FFFFFF", dark: "#0F172A" } as any,
  warn: { light: "#D97706", dark: "#FBBF24" } as any,
}

function modeColor(mode: Mode): any {
  if (mode === "all_proxy") return { light: "#7C3AED", dark: "#A78BFA" } as any
  if (mode === "all_direct") return { light: "#059669", dark: "#34D399" } as any
  return { light: "#0284C7", dark: "#38BDF8" } as any
}

function modeBg(mode: Mode): any {
  if (mode === "all_proxy") return { light: "rgba(124,58,237,0.10)", dark: "rgba(167,139,250,0.16)" } as any
  if (mode === "all_direct") return { light: "rgba(5,150,105,0.10)", dark: "rgba(52,211,153,0.16)" } as any
  return { light: "rgba(2,132,199,0.10)", dark: "rgba(56,189,248,0.16)" } as any
}

function modeIcon(mode: Mode): string {
  if (mode === "all_proxy") return "globe"
  if (mode === "all_direct") return "bolt.horizontal.fill"
  return "arrow.triangle.branch"
}

function TrafficCell({ label, value, color, iconSize, textSize }: {
  label: string
  value: string
  color: any
  iconSize: number
  textSize: number
}) {
  return (
    <VStack alignment="center" spacing={3} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={4} alignment="center">
        <Image
          systemName={label === "累计下行" ? "arrow.down.circle.fill" : "arrow.up.circle.fill"}
          font={{ name: "system", size: iconSize }}
          foregroundStyle={color}
        />
        <Text font={iconSize - 0.5} fontWeight="medium" foregroundStyle={C.label}>
          {label}
        </Text>
      </HStack>
      <Text
        font={textSize}
        fontWeight="bold"
        foregroundStyle={C.title}
        monospacedDigit
        lineLimit={1}
        minScaleFactor={0.7}
      >
        {value || "—"}
      </Text>
    </VStack>
  )
}

function ModeCell({ snap, compact }: { snap: Snapshot; compact?: boolean }) {
  const color = modeColor(snap.mode)
  return (
    <VStack alignment="center" spacing={compact ? 2 : 2.5} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={3} alignment="center">
        <Image
          systemName={modeIcon(snap.mode)}
          font={{ name: "system", size: compact ? 9 : 10 }}
          foregroundStyle={color}
        />
        <Text font={compact ? 9 : 10} fontWeight="medium" foregroundStyle={C.label} lineLimit={1}>
          运行模式
        </Text>
      </HStack>
      <Button intent={LoonSwitchModeIntent()} buttonStyle="plain">
        <HStack
          spacing={2}
          alignment="center"
          padding={{ top: 1, bottom: 1, leading: 6, trailing: 6 }}
          background={modeBg(snap.mode)}
          clipShape={{ type: "rect", cornerRadius: 5 }}
        >
          <Text font={compact ? 9.5 : 11} fontWeight="bold" foregroundStyle={color} lineLimit={1}>
            {snap.modeLabel}
          </Text>
          <Image
            systemName="arrow.triangle.2.circlepath"
            font={{ name: "system", size: 8 }}
            foregroundStyle={color}
          />
        </HStack>
      </Button>
    </VStack>
  )
}

function GroupCell({ snap, compact }: { snap: Snapshot; compact?: boolean }) {
  return (
    <VStack alignment="center" spacing={compact ? 2 : 2.5} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={3} alignment="center">
        <Image
          systemName="cpu"
          font={{ name: "system", size: compact ? 9 : 10 }}
          foregroundStyle={C.accent}
        />
        <Text font={compact ? 9 : 10} fontWeight="medium" foregroundStyle={C.label} lineLimit={1}>
          策略组数
        </Text>
      </HStack>
      <Text
        font={compact ? 11.5 : 13}
        fontWeight="bold"
        foregroundStyle={C.title}
        monospacedDigit
        lineLimit={1}
      >
        {snap.groupCount > 0 ? String(snap.groupCount) : "—"}
      </Text>
    </VStack>
  )
}

// ─────────────────────────────────────────────── 中号

function MediumCard({ snap }: { snap: Snapshot }) {
  return (
    <VStack
      alignment="leading"
      spacing={0}
      padding={{ top: 14, bottom: 12, leading: 16, trailing: 16 }}
      widgetBackground={C.bg}
    >
      <HStack spacing={6} alignment="center">
        <Logo size={18} />
        <Text font={15.5} fontWeight="bold" foregroundStyle={C.title}>
          Loon
        </Text>
        <BridgeDot connected={snap.bridgeConnected} size={6} />
        <Spacer />
        <Text font={10.5} fontWeight="medium" foregroundStyle={C.label} monospacedDigit>
          {`更新于 ${formatTime(snap.updatedAt)}`}
        </Text>
        <RefreshButton />
      </HStack>

      <Spacer minLength={8} />

      <HStack alignment="center" spacing={0}>
        <TrafficCell label="累计下行" value={snap.download} color={C.dl} iconSize={11.5} textSize={23} />
        <RoundedRectangle fill={C.divider} cornerRadius={0.5} frame={{ width: 1, height: 38 }} />
        <TrafficCell label="累计上行" value={snap.upload} color={C.ul} iconSize={11.5} textSize={23} />
      </HStack>

      <Spacer minLength={9} />

      <HStack alignment="center" spacing={0}>
        <GroupCell snap={snap} />
        <ModeCell snap={snap} />
      </HStack>

      <Spacer minLength={8} />

      <HStack spacing={4} alignment="center">
        <Text font={9.5} foregroundStyle={C.label} lineLimit={1} minScaleFactor={0.8}>
          {snap.hasTrafficSource ? snap.version : `${snap.version} · 未填流量源`}
        </Text>
        <Spacer />
        <Text
          font={9.5}
          fontWeight="bold"
          foregroundStyle={snap.bridgeConnected ? C.label : C.warn}
          monospacedDigit
          lineLimit={1}
        >
          {snap.bridgeConnected ? "桥接已连接" : "桥接未连接"}
        </Text>
      </HStack>
    </VStack>
  )
}

// ─────────────────────────────────────────────── 小号

function SmallCard({ snap }: { snap: Snapshot }) {
  return (
    <VStack
      alignment="leading"
      spacing={0}
      padding={{ top: 13, bottom: 11, leading: 13, trailing: 13 }}
      widgetBackground={C.bg}
    >
      <HStack spacing={4} alignment="center" frame={{ height: 18 }}>
        <Logo size={15} />
        <Text
          font={11.5}
          fontWeight="bold"
          foregroundStyle={C.title}
          lineLimit={1}
          minScaleFactor={0.8}
          allowsTightening={true}
        >
          Loon
        </Text>
        <BridgeDot connected={snap.bridgeConnected} size={5} />
        <Spacer minLength={2} />
        <RefreshButton />
      </HStack>

      <Spacer minLength={8} />

      <HStack alignment="center" spacing={0}>
        <TrafficCell label="累计下行" value={snap.download} color={C.dl} iconSize={10} textSize={16} />
        <RoundedRectangle fill={C.divider} cornerRadius={0.5} frame={{ width: 1, height: 28 }} />
        <TrafficCell label="累计上行" value={snap.upload} color={C.ul} iconSize={10} textSize={16} />
      </HStack>

      <Spacer minLength={8} />

      <HStack alignment="center" spacing={0}>
        <GroupCell snap={snap} compact />
        <ModeCell snap={snap} compact />
      </HStack>

      <Spacer minLength={6} />

      <HStack spacing={4} alignment="center">
        <Text font={8.5} foregroundStyle={C.label} lineLimit={1} minScaleFactor={0.8}>
          {snap.version}
        </Text>
        <Spacer />
        <Text font={8.5} foregroundStyle={C.label} monospacedDigit lineLimit={1}>
          {`更新于 ${formatTime(snap.updatedAt)}`}
        </Text>
      </HStack>
    </VStack>
  )
}

function LoonTrafficWidget({ snap, family }: { snap: Snapshot; family?: string }) {
  if (family === "systemSmall") return <SmallCard snap={snap} />
  return <MediumCard snap={snap} />
}

// ─────────────────────────────────────────────── 交互

const LoonRefreshIntent = AppIntentManager.register({
  name: "LoonTrafficRefresh",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_params: undefined) => {
    try {
      const cfg = readCfg()
      const snap = await buildSnapshot(cfg)
      saveSnap(snap)
    } catch {}
    Widget.reloadAll()
  },
})

const LoonSwitchModeIntent = AppIntentManager.register({
  name: "LoonTrafficSwitchMode",
  protocol: AppIntentProtocol.AppIntent,
  perform: async (_params: undefined) => {
    try {
      const cfg = readCfg()
      await callBridge(cfg, "action=set_mode&mode=next")
      const snap = await buildSnapshot(cfg)
      saveSnap(snap)
    } catch {}
    Widget.reloadAll()
  },
})

// ─────────────────────────────────────────────── 入口

const EMPTY: Snapshot = {
  mode: "filter",
  modeLabel: "分流模式",
  groupCount: 0,
  version: "Loon",
  download: "",
  upload: "",
  bridgeConnected: false,
  bridgeError: "尚未连接桥接",
  hasTrafficSource: false,
  updatedAt: new Date().toISOString(),
}

async function main() {
  const cfg = readCfg()
  saveCfg(cfg) // 让 AppIntent 里也能读到同一份配置

  const cached = getSnap()
  let snap = cached

  if (isStale(cached)) {
    const fresh = await buildSnapshot(cfg).catch(() => null)
    if (fresh && (fresh.bridgeConnected || !cached)) {
      snap = fresh
      saveSnap(fresh)
    } else if (fresh) {
      // 拉失败但桥接断开：保留旧数据，只把连接状态标红
      snap = { ...cached!, bridgeConnected: false, bridgeError: fresh.bridgeError }
    }
  }

  Widget.present(<LoonTrafficWidget snap={snap || EMPTY} family={Widget.family} />, {
    policy: "after",
    date: new Date(Date.now() + REFRESH_MINUTES * 60 * 1000),
  })
}

main().catch((e) => {
  console.log("Loon 流量看板渲染失败:", e)
  Widget.present(<LoonTrafficWidget snap={EMPTY} family={Widget.family} />)
})
