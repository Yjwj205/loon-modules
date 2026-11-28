/**
 * Loon 控制台 · 单脚本小组件
 *
 * 中号：
 *   [logo] Loon ●                     22:14  ⋯ ↻
 *   ⏱ 运行时长 12天 04:31   ⚙ 策略组 16
 *   [分流模式 ↻]  [节点选择 → 🇭🇰 香港 01 ▶]
 *   🌐 103.85.12.44 · 香港 · Loon 3.5.1
 *
 * 数据都来自 loon-control 插件的本地桥接 http://1.1.1.1/loon-bridge：
 *   运行模式 / 策略组总数 / 当前节点 / 在线时长（心跳推算）/ 版本
 * 公网 IP 由 ip-api.com 提供（走 Loon 的代理，所以看到的是落地出口）。
 *
 * 参数（桌面 → 编辑小组件 → 参数），k=v 或 JSON：
 *   bridge=http://1.1.1.1/loon-bridge
 *   group=节点选择              ← 卡片上那个「节点」格子控制哪个策略组
 *   uptime=loon                 ← loon=Loon 在线时长（心跳推算）｜device=设备开机时长
 */

import * as os from "os"
import {
  AppIntentManager,
  AppIntentProtocol,
  Button,
  Circle,
  HStack,
  Image,
  Link,
  RoundedRectangle,
  Script,
  Spacer,
  Text,
  VStack,
  Widget,
  ZStack,
} from "scripting"

// ─────────────────────────────────────────────── 常量

const CFG_KEY = "loon_console_cfg_v1"
const SNAP_KEY = "loon_console_snap_v1"
const IP_KEY = "loon_console_ip_v1"

const FRESH_MS = 5 * 60 * 1000
const IP_TTL_MS = 10 * 60 * 1000
const REFRESH_MINUTES = 15

const DEFAULT_BRIDGE = "http://1.1.1.1/loon-bridge"
const BRIDGE_CANDIDATES = [
  "http://1.1.1.1/loon-bridge",
  "http://8.8.8.8/loon-bridge",
  "http://cp.cloudflare.com/loon-bridge",
]
const IP_API = "http://ip-api.com/json/?lang=zh-CN&fields=status,country,countryCode,regionName,city,query,isp"

const PRIORITY_GROUPS = ["节点选择", "PROXY", "Proxy", "国外网站", "国外流量", "GFW", "流媒体", "漏网之鱼", "FINAL", "Final", "苹果服务"]

type Mode = "filter" | "all_proxy" | "all_direct"

interface Cfg {
  bridge: string
  group: string
  uptime: "loon" | "device"
}

interface Snap {
  mode: Mode
  groupCount: number
  group: string
  node: string
  nodeCount: number
  uptimeMs: number          // 采集那一刻的时长
  uptimeSource: "loon" | "device"
  fetchedAt: number          // 采集时间戳（用于把时长往后推）
  ip: string
  ipRegion: string
  ipFlag: string
  version: string
  bridgeConnected: boolean
  bridgeError?: string
  updatedAt: string
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

function readCfg(): Cfg {
  let saved: Cfg = { bridge: DEFAULT_BRIDGE, group: "", uptime: "loon" }
  try {
    const s = Storage.get<Cfg>(CFG_KEY, { shared: true }) as Cfg | null
    if (s && typeof s === "object") {
      saved = {
        bridge: (s.bridge || DEFAULT_BRIDGE).trim(),
        group: (s.group || "").trim(),
        uptime: s.uptime === "device" ? "device" : "loon",
      }
    }
  } catch {}

  const p = parseParam(Widget.parameter || "")
  const up = (p["uptime"] || "").toLowerCase()
  return {
    bridge: (p["bridge"] || saved.bridge || DEFAULT_BRIDGE).trim(),
    group: (p["group"] || saved.group || "").trim(),
    uptime: up === "device" ? "device" : up === "loon" ? "loon" : saved.uptime,
  }
}

function saveCfg(cfg: Cfg) {
  try {
    Storage.set(CFG_KEY, cfg, { shared: true })
    Storage.set(CFG_KEY, cfg)
  } catch {}
}

// ─────────────────────────────────────────────── 缓存

function getSnap(): Snap | null {
  try {
    const s = Storage.get<Snap>(SNAP_KEY, { shared: true }) || Storage.get<Snap>(SNAP_KEY)
    if (s && typeof s === "object" && (s as any).mode) return s as Snap
  } catch {}
  return null
}

function saveSnap(snap: Snap) {
  try {
    Storage.set(SNAP_KEY, snap, { shared: true })
    Storage.set(SNAP_KEY, snap)
  } catch {}
}

// ─────────────────────────────────────────────── 桥接

async function callBridge(cfg: Cfg, params: string): Promise<any | null> {
  const list: string[] = []
  if (cfg.bridge) list.push(cfg.bridge)
  for (const c of BRIDGE_CANDIDATES) if (list.indexOf(c) < 0) list.push(c)

  for (const base of list) {
    try {
      const res = await fetch(base + (base.includes("?") ? "&" : "?") + params, { timeout: 3.5 })
      if (!res || !res.ok) continue
      const json = JSON.parse(await res.text())
      if (json && json.ok) return json
    } catch {}
  }
  return null
}

function modeFromModel(m: any): Mode {
  if (m === 0) return "all_direct"
  if (m === 2) return "all_proxy"
  return "filter"
}

const MODE_LABEL: Record<Mode, string> = {
  filter: "分流模式",
  all_proxy: "全局代理",
  all_direct: "全局直连",
}

function pickGroup(all: string[], prefer: string): string {
  if (prefer) {
    const exact = all.find((g) => g === prefer)
    if (exact) return exact
    const fuzzy = all.find((g) => g.toLowerCase().includes(prefer.toLowerCase()))
    if (fuzzy) return fuzzy
    return prefer
  }
  for (const p of PRIORITY_GROUPS) {
    const hit = all.find((g) => g === p) || all.find((g) => g.toLowerCase().includes(p.toLowerCase()))
    if (hit) return hit
  }
  return all[0] || ""
}

// ─────────────────────────────────────────────── 设备运行时长

function deviceUptimeMs(): number {
  try {
    const up = (os as any).uptime ? (os as any).uptime() : 0
    const n = Number(up) || 0
    if (n <= 0) return 0
    // Node 的 os.uptime() 是秒；万一运行时给的是毫秒，按数量级纠正
    return n > 1e11 ? n : n * 1000
  } catch {
    return 0
  }
}

// ─────────────────────────────────────────────── 公网 IP

function flagOf(code: string): string {
  const cc = (code || "").trim().toUpperCase()
  if (cc.length !== 2) return ""
  const base = 0x1f1e6
  return String.fromCodePoint(base + cc.charCodeAt(0) - 65, base + cc.charCodeAt(1) - 65)
}

async function fetchIp(): Promise<{ ip: string; region: string; flag: string } | null> {
  try {
    const c: any = Storage.get(IP_KEY, { shared: true }) || Storage.get(IP_KEY)
    if (c && typeof c.t === "number" && Date.now() - c.t < IP_TTL_MS && c.ip) {
      return { ip: c.ip, region: c.region || "", flag: c.flag || "" }
    }
  } catch {}

  try {
    const res = await fetch(IP_API, { timeout: 5 })
    if (!res || !res.ok) return null
    const j = await res.json()
    if (!j || j.status !== "success" || !j.query) return null
    const region = [j.country || "", j.city || j.regionName || ""].filter(Boolean).join(" · ")
    const out = { ip: String(j.query), region, flag: flagOf(j.countryCode) }
    try {
      Storage.set(IP_KEY, { ...out, t: Date.now() }, { shared: true })
      Storage.set(IP_KEY, { ...out, t: Date.now() })
    } catch {}
    return out
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────── 快照

async function buildSnapshot(cfg: Cfg, groupOverride?: string): Promise<Snap> {
  const prev = getSnap()
  let mode: Mode = prev?.mode || "filter"
  let groupCount = prev?.groupCount || 0
  let version = prev?.version || "Loon"
  let connected = false
  let bridgeError = ""
  let group = (cfg.group || groupOverride || prev?.group || "").trim()
  let node = ""
  let nodeCount = 0
  let loonUptime = 0

  const hint = (cfg.group || groupOverride || "").trim()
  const status = await callBridge(
    cfg,
    "action=status&select=1&sub_timeout=900&groups=" + encodeURIComponent(hint)
  )

  if (status) {
    connected = true
    if (typeof status.running_model === "number") mode = modeFromModel(status.running_model)
    else if (typeof status.running_mode === "string") {
      const rm = String(status.running_mode).toLowerCase()
      mode = rm === "all_direct" ? "all_direct" : rm === "all_proxy" ? "all_proxy" : "filter"
    }
    const all: string[] = Array.isArray(status.all_policy_groups) ? status.all_policy_groups : []
    groupCount = typeof status.policy_group_count === "number" ? status.policy_group_count : all.length
    version = String(status.version || "Loon")
    if (!version.toLowerCase().startsWith("loon")) version = "Loon " + version

    // 服务端已经帮我们挑了组（没传 groups 时按常见组名挑），优先用它回传的那一组
    const detail = Array.isArray(status.groups) && status.groups.length > 0 ? status.groups[0] : null
    if (detail) {
      group = detail.group || group || all[0] || ""
      node = detail.selected || ""
      nodeCount = typeof detail.candidate_count === "number" ? detail.candidate_count : 0
    } else if (group) {
      node = (status.policy_select || {})[group] || ""
    }
    if (!group) group = all[0] || ""
    if (!node && group) node = (status.policy_select || {})[group] || ""
    loonUptime = typeof status.loon_uptime_ms === "number" ? status.loon_uptime_ms : 0
  } else {
    bridgeError = "桥接无响应"
    if (prev) {
      group = prev.group
      node = prev.node
      nodeCount = prev.nodeCount
    }
  }

  const ip = (await fetchIp().catch(() => null)) || {
    ip: prev?.ip || "",
    region: prev?.ipRegion || "",
    flag: prev?.ipFlag || "",
  }

  let uptimeMs = 0
  let uptimeSource: "loon" | "device" = cfg.uptime
  if (cfg.uptime === "device") {
    uptimeMs = deviceUptimeMs()
  } else if (loonUptime > 0) {
    uptimeMs = loonUptime
  } else {
    // 桥接没给（老版本插件）就退回设备时长，界面上会标出来
    uptimeMs = deviceUptimeMs()
    uptimeSource = "device"
  }

  return {
    mode,
    groupCount,
    group,
    node,
    nodeCount,
    uptimeMs,
    uptimeSource,
    fetchedAt: Date.now(),
    ip: ip.ip,
    ipRegion: ip.region,
    ipFlag: ip.flag,
    version,
    bridgeConnected: connected,
    bridgeError,
    updatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────── 格式化

function pad(n: number): string {
  return n < 10 ? "0" + n : String(n)
}

function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "—"
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}天 ${pad(hours)}:${pad(minutes)}`
  if (hours > 0) return `${hours}时 ${pad(minutes)}分`
  return `${minutes}分 ${pad(total % 60)}秒`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "--:--"
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function clip(s: string, max: number): string {
  const t = String(s || "")
  return t.length <= max ? t : t.slice(0, max - 1) + "…"
}

// ─────────────────────────────────────────────── 小部件

function loadLoonImage(): any {
  try {
    const light = (globalThis as any).UIImage?.fromFile(`${Script.directory}/assets/loon.png`)
    if (light) return { light, dark: light }
  } catch {}
  return null
}

const LOON_IMAGE = loadLoonImage()

function Logo({ size }: { size: number }) {
  if (LOON_IMAGE) return <Image image={LOON_IMAGE} resizable={true} frame={{ width: size, height: size }} />
  return <Image systemName="balloon.2.fill" font={{ name: "system", size: size }} foregroundStyle="#7C3AED" />
}

function BridgeDot({ connected, size = 5 }: { connected?: boolean; size?: number }) {
  return (
    <HStack spacing={3} alignment="center">
      <Circle fill={connected ? "#10B981" : "#F59E0B"} frame={{ width: size, height: size }} />
      {!connected ? (
        <Image systemName="exclamationmark.triangle.fill" font={{ name: "system", size: size + 3 }} foregroundStyle="#F59E0B" />
      ) : null}
    </HStack>
  )
}

function IconButton({ systemName, url, intent }: { systemName: string; url?: string; intent?: any }) {
  const circle = (
    <ZStack frame={{ width: 22, height: 22 }}>
      <Circle fill={{ light: "rgba(0,0,0,0.04)", dark: "rgba(255,255,255,0.08)" } as any} />
      <Circle
        stroke={{
          shapeStyle: { light: "rgba(0,0,0,0.06)", dark: "rgba(255,255,255,0.12)" } as any,
          strokeStyle: { lineWidth: 0.8 },
        }}
      />
      <Image systemName={systemName} font={{ name: "system", size: 10.5 }} foregroundStyle={{ light: "#64748B", dark: "#94A3B8" } as any} />
    </ZStack>
  )
  if (url) return <Link url={url}>{circle}</Link>
  return <Button intent={intent} buttonStyle="plain">{circle}</Button>
}

const C = {
  title: { light: "#1E293B", dark: "#F8FAFC" } as any,
  label: { light: "#64748B", dark: "#94A3B8" } as any,
  dim: { light: "#94A3B8", dark: "#64748B" } as any,
  divider: { light: "rgba(0,0,0,0.08)", dark: "rgba(255,255,255,0.12)" } as any,
  accent: { light: "#0284C7", dark: "#38BDF8" } as any,
  bg: { light: "#FFFFFF", dark: "#0F172A" } as any,
  warn: { light: "#D97706", dark: "#FBBF24" } as any,
  green: { light: "#059669", dark: "#34D399" } as any,
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

function uptimeNow(snap: Snap): number {
  // 采集之后的时间继续往后走，这样卡片上的时长不会停在上次刷新那一刻
  const extra = Date.now() - (snap.fetchedAt || Date.now())
  return Math.max(0, (snap.uptimeMs || 0) + Math.max(0, extra))
}

function Metric({ label, value, icon, color, big }: { label: string; value: string; icon: string; color: any; big?: number }) {
  return (
    <VStack alignment="leading" spacing={2}>
      <HStack spacing={4} alignment="center">
        <Image systemName={icon} font={{ name: "system", size: big ? 10 : 9 }} foregroundStyle={color} />
        <Text font={big ? 10 : 9.5} fontWeight="medium" foregroundStyle={C.label} lineLimit={1}>
          {label}
        </Text>
      </HStack>
      <Text
        font={big || 17}
        fontWeight="bold"
        foregroundStyle={C.title}
        monospacedDigit
        lineLimit={1}
        minScaleFactor={0.7}
      >
        {value}
      </Text>
    </VStack>
  )
}

function ModePill({ snap }: { snap: Snap }) {
  const color = modeColor(snap.mode)
  return (
    <Button intent={LoonModeIntent()} buttonStyle="plain">
      <HStack
        spacing={4}
        alignment="center"
        padding={{ top: 3, bottom: 3, leading: 8, trailing: 8 }}
        background={modeBg(snap.mode)}
        clipShape={{ type: "rect", cornerRadius: 6 }}
      >
        <Image systemName={modeIcon(snap.mode)} font={{ name: "system", size: 10 }} foregroundStyle={color} />
        <Text font={11} fontWeight="bold" foregroundStyle={color} lineLimit={1}>
          {MODE_LABEL[snap.mode]}
        </Text>
        <Image systemName="arrow.triangle.2.circlepath" font={{ name: "system", size: 8 }} foregroundStyle={color} />
      </HStack>
    </Button>
  )
}

function NodePill({ snap, compact }: { snap: Snap; compact?: boolean }) {
  const nodeText = snap.node ? clip(snap.node, compact ? 12 : 16) : "未记录"
  return (
    <Button intent={LoonNodeIntent({ group: snap.group })} buttonStyle="plain">
      <HStack
        spacing={4}
        alignment="center"
        padding={{ top: 3, bottom: 3, leading: 8, trailing: 8 }}
        background={{ light: "rgba(0,0,0,0.04)", dark: "rgba(255,255,255,0.08)" } as any}
        clipShape={{ type: "rect", cornerRadius: 6 }}
      >
        <Image systemName="point.3.connected.trianglepath.dotted" font={{ name: "system", size: 9.5 }} foregroundStyle={C.accent} />
        <Text font={compact ? 10 : 11} fontWeight="semibold" foregroundStyle={C.title} lineLimit={1}>
          {nodeText}
        </Text>
        <Image systemName="chevron.forward.2" font={{ name: "system", size: 8 }} foregroundStyle={C.dim} />
      </HStack>
    </Button>
  )
}

function IpLine({ snap, compact }: { snap: Snap; compact?: boolean }) {
  const text = snap.ip ? `${snap.ip}${snap.ipRegion ? " · " + snap.ipRegion : ""}` : "IP 获取失败"
  return (
    <HStack spacing={4} alignment="center">
      <Image systemName="network" font={{ name: "system", size: compact ? 9 : 9.5 }} foregroundStyle={C.accent} />
      <Text
        font={compact ? 9 : 9.5}
        fontWeight="medium"
        foregroundStyle={snap.ip ? C.label : C.warn}
        lineLimit={1}
        minScaleFactor={0.75}
      >
        {snap.ipFlag ? snap.ipFlag + " " : ""}
        {text}
      </Text>
    </HStack>
  )
}

function ConsoleURL(): string {
  try {
    return Script.createRunURLScheme(Script.name)
  } catch {
    return "scripting://"
  }
}

// ─────────────────────────────────────────────── 中号

function MediumCard({ snap }: { snap: Snap }) {
  const uptime = formatDuration(uptimeNow(snap))
  return (
    <VStack
      alignment="leading"
      spacing={0}
      padding={{ top: 12, bottom: 10, leading: 15, trailing: 15 }}
      widgetBackground={C.bg}
    >
      <HStack spacing={6} alignment="center">
        <Logo size={18} />
        <Text font={15} fontWeight="bold" foregroundStyle={C.title}>Loon</Text>
        <BridgeDot connected={snap.bridgeConnected} size={6} />
        <Spacer />
        <Text font={10} fontWeight="medium" foregroundStyle={C.label} monospacedDigit>
          {formatTime(snap.updatedAt)}
        </Text>
        <IconButton systemName="slider.horizontal.3" url={ConsoleURL()} />
        <IconButton systemName="arrow.triangle.2.circlepath" intent={LoonRefreshIntent()} />
      </HStack>

      <Spacer minLength={9} />

      <HStack alignment="center" spacing={0}>
        <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
          <Metric
            label={snap.uptimeSource === "device" ? "设备运行时长" : "Loon 运行时长"}
            value={uptime}
            icon="clock"
            color={C.green}
            big={24}
          />
        </VStack>
        <VStack alignment="leading" spacing={2} frame={{ width: 74 }}>
          <Metric label="策略组" value={snap.groupCount > 0 ? String(snap.groupCount) : "—"} icon="square.stack.3d.up" color={C.accent} big={24} />
        </VStack>
      </HStack>

      <Spacer minLength={9} />

      <HStack spacing={6} alignment="center">
        <ModePill snap={snap} />
        <NodePill snap={snap} />
      </HStack>

      <Spacer minLength={8} />

      <HStack spacing={4} alignment="center">
        <IpLine snap={snap} />
        <Spacer />
        <Text font={9} foregroundStyle={C.dim} lineLimit={1}>{snap.version}</Text>
      </HStack>
    </VStack>
  )
}

// ─────────────────────────────────────────────── 小号

function SmallCard({ snap }: { snap: Snap }) {
  const uptime = formatDuration(uptimeNow(snap))
  return (
    <VStack
      alignment="leading"
      spacing={0}
      padding={{ top: 12, bottom: 10, leading: 13, trailing: 13 }}
      widgetBackground={C.bg}
    >
      <HStack spacing={4} alignment="center" frame={{ height: 18 }}>
        <Logo size={15} />
        <Text font={11.5} fontWeight="bold" foregroundStyle={C.title} lineLimit={1}>Loon</Text>
        <BridgeDot connected={snap.bridgeConnected} size={5} />
        <Spacer minLength={2} />
        <IconButton systemName="arrow.triangle.2.circlepath" intent={LoonRefreshIntent()} />
      </HStack>

      <Spacer minLength={7} />

      <Text font={9} fontWeight="medium" foregroundStyle={C.label} lineLimit={1}>
        {snap.uptimeSource === "device" ? "设备运行时长" : "Loon 运行时长"}
      </Text>
      <Text font={19} fontWeight="bold" foregroundStyle={C.title} monospacedDigit lineLimit={1} minScaleFactor={0.7}>
        {uptime}
      </Text>

      <Spacer minLength={6} />

      <HStack spacing={5} alignment="center">
        <ModePill snap={snap} />
        <Text font={9.5} foregroundStyle={C.label} lineLimit={1}>{`${snap.groupCount || 0} 组`}</Text>
      </HStack>

      <Spacer minLength={5} />

      <HStack spacing={4} alignment="center">
        <Button intent={LoonNodeIntent({ group: snap.group })} buttonStyle="plain">
          <HStack spacing={3} alignment="center">
            <Image systemName="point.3.connected.trianglepath.dotted" font={{ name: "system", size: 9 }} foregroundStyle={C.accent} />
            <Text font={9.5} fontWeight="semibold" foregroundStyle={C.title} lineLimit={1} minScaleFactor={0.8}>
              {snap.node ? clip(snap.node, 11) : "未记录"}
            </Text>
            <Image systemName="chevron.forward.2" font={{ name: "system", size: 7.5 }} foregroundStyle={C.dim} />
          </HStack>
        </Button>
        <Spacer />
      </HStack>

      <Spacer minLength={4} />

      <IpLine snap={snap} compact />
    </VStack>
  )
}

function LoonConsoleWidget({ snap, family }: { snap: Snap; family?: string }) {
  if (family === "systemSmall") return <SmallCard snap={snap} />
  return <MediumCard snap={snap} />
}

// ─────────────────────────────────────────────── 交互

async function refreshAndSave(): Promise<void> {
  const cfg = readCfg()
  const snap = await buildSnapshot(cfg)
  saveSnap(snap)
}

const LoonRefreshIntent = AppIntentManager.register({
  name: "LoonConsoleRefresh",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    try { await refreshAndSave() } catch {}
    Widget.reloadAll()
  },
})

const LoonModeIntent = AppIntentManager.register({
  name: "LoonConsoleMode",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    try {
      const cfg = readCfg()
      await callBridge(cfg, "action=set_mode&mode=next")
      await refreshAndSave()
    } catch {}
    Widget.reloadAll()
  },
})

const LoonNodeIntent = AppIntentManager.register({
  name: "LoonConsoleNode",
  protocol: AppIntentProtocol.AppIntent,
  perform: async ({ group }: { group: string }) => {
    try {
      const cfg = readCfg()
      const g = group || cfg.group || ""
      if (g) await callBridge(cfg, "action=set_policy&policy=" + encodeURIComponent(g) + "&node=next")
      const snap = await buildSnapshot(cfg, g)
      saveSnap(snap)
    } catch {}
    Widget.reloadAll()
  },
})

// ─────────────────────────────────────────────── 入口

const EMPTY: Snap = {
  mode: "filter",
  groupCount: 0,
  group: "",
  node: "",
  nodeCount: 0,
  uptimeMs: 0,
  uptimeSource: "device",
  fetchedAt: Date.now(),
  ip: "",
  ipRegion: "",
  ipFlag: "",
  version: "Loon",
  bridgeConnected: false,
  bridgeError: "尚未连接桥接",
  updatedAt: new Date().toISOString(),
}

async function main() {
  const cfg = readCfg()
  saveCfg(cfg)

  const cached = getSnap()
  let snap = cached

  const stale = !cached || Date.now() - (cached.fetchedAt || 0) > FRESH_MS
  if (stale) {
    const fresh = await buildSnapshot(cfg).catch(() => null)
    if (fresh && (fresh.bridgeConnected || !cached)) {
      snap = fresh
      saveSnap(fresh)
    } else if (fresh && cached) {
      snap = { ...cached, bridgeConnected: false, bridgeError: fresh.bridgeError }
    }
  }

  Widget.present(<LoonConsoleWidget snap={snap || EMPTY} family={Widget.family} />, {
    policy: "after",
    date: new Date(Date.now() + REFRESH_MINUTES * 60 * 1000),
  })
}

main().catch((e) => {
  console.log("Loon 控制台渲染失败:", e)
  Widget.present(<LoonConsoleWidget snap={EMPTY} family={Widget.family} />)
})
