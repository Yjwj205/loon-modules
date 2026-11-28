/**
 * Loon 控制台 · 控制页（可选，widget.tsx 才是小组件本体）
 *
 * 打开这个脚本就是控制台：
 *   - 看状态（模式 / 策略组 / 当前节点 / 在线时长 / 公网 IP / 版本）
 *   - 一键切模式（分流 / 全局代理 / 全局直连）
 *   - 选策略组、选节点（从真实候选列表里挑，不是瞎猜的顺序）
 *   - 改桥接地址、改「节点」格子盯哪个组、切换时长来源
 */

import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  Script,
  Section,
  Spacer,
  Text,
  VStack,
  Widget,
  useState,
} from "scripting"

const CFG_KEY = "loon_console_cfg_v1"
const SNAP_KEY = "loon_console_snap_v1"
const DEFAULT_BRIDGE = "http://1.1.1.1/loon-bridge"

interface Cfg { bridge: string; group: string; uptime: "loon" | "device" }

function readCfg(): Cfg {
  try {
    const s = Storage.get<Cfg>(CFG_KEY, { shared: true }) as Cfg | null
    if (s && typeof s === "object") {
      return {
        bridge: (s.bridge || DEFAULT_BRIDGE).trim(),
        group: (s.group || "").trim(),
        uptime: s.uptime === "device" ? "device" : "loon",
      }
    }
  } catch {}
  return { bridge: DEFAULT_BRIDGE, group: "", uptime: "loon" }
}

function saveCfg(cfg: Cfg) {
  try {
    Storage.set(CFG_KEY, cfg, { shared: true })
    Storage.set(CFG_KEY, cfg)
  } catch {}
}

function readSnap(): any | null {
  try {
    return Storage.get(SNAP_KEY, { shared: true }) || Storage.get(SNAP_KEY)
  } catch {}
  return null
}

async function bridge(cfg: Cfg, params: string): Promise<any | null> {
  const base = cfg.bridge || DEFAULT_BRIDGE
  try {
    const res = await fetch(base + (base.includes("?") ? "&" : "?") + params, { timeout: 6 })
    if (!res || !res.ok) return null
    const j = JSON.parse(await res.text())
    return j && j.ok ? j : null
  } catch {
    return null
  }
}

async function promptSafe(opts: any, required = true): Promise<string | null> {
  const v = await Dialog.prompt(opts)
  if (v === null || v === undefined) return null
  if (required && String(v).trim() === "") return null
  return String(v)
}

async function sheet(title: string, options: string[]): Promise<string> {
  const actions = options.map((o) => ({ label: o }))
  const idx = await Dialog.actionSheet({ title, actions, cancelButton: true })
  if (idx === -1 || idx === undefined || idx === null || idx >= actions.length) return ""
  return actions[idx].label
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <HStack spacing={8} alignment="center">
      <Text font={13} foregroundStyle="#64748B" lineLimit={1}>{label}</Text>
      <Spacer />
      <Text font={13} fontWeight="semibold" foregroundStyle={color || "#1E293B"} lineLimit={1} minScaleFactor={0.7}>
        {value}
      </Text>
    </HStack>
  )
}

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "—"
  const t = Math.floor(ms / 1000)
  const d = Math.floor(t / 86400)
  const h = Math.floor((t % 86400) / 3600)
  const m = Math.floor((t % 3600) / 60)
  const p = (n: number) => String(n).padStart(2, "0")
  if (d > 0) return `${d}天 ${p(h)}:${p(m)}`
  if (h > 0) return `${h} 小时 ${m} 分`
  return `${m} 分 ${t % 60} 秒`
}

function ControlPage() {
  const [cfg, setCfg] = useState<Cfg>(readCfg())
  const [snap, setSnap] = useState<any>(readSnap())
  const [groups, setGroups] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  async function reloadConfig() {
    setCfg(readCfg())
    setSnap(readSnap())
    Widget.reloadAll()
  }

  async function pullStatus(probeGroups?: string) {
    setBusy(true)
    try {
      const j = await bridge(
        cfg,
        "action=status&select=1&sub_timeout=1200" + (probeGroups ? "&groups=" + encodeURIComponent(probeGroups) : "")
      )
      if (!j) {
        await Dialog.alert("连不上桥接。检查 Loon 里已启用 loon-control 插件，且 1.1.1.1/loon-bridge 能被命中。")
        return null
      }
      setGroups(Array.isArray(j.all_policy_groups) ? j.all_policy_groups : [])
      return j
    } finally {
      setBusy(false)
    }
  }

  async function setMode(target: 0 | 1 | 2) {
    setBusy(true)
    try {
      const j = await bridge(cfg, "action=set_mode&mode=" + target)
      if (!j || !j.ok) {
        await Dialog.alert("切换失败：" + ((j && j.error) || "桥接无响应"))
      }
      setSnap(readSnap())
      Widget.reloadAll()
    } finally {
      setBusy(false)
    }
  }

  async function cycleMode() {
    setBusy(true)
    try {
      await bridge(cfg, "action=set_mode&mode=next")
      Widget.reloadAll()
    } finally {
      setBusy(false)
    }
  }

  async function pickGroup() {
    const j = await pullStatus()
    const all: string[] = Array.isArray(groups) && groups.length ? groups : (j && j.all_policy_groups) || []
    if (!all.length) {
      await Dialog.alert("没读到策略组，先点「测试桥接」。")
      return
    }
    const picked = await sheet("选择要控制/显示的策略组", all)
    if (!picked) return
    saveCfg({ ...cfg, group: picked })
    await reloadConfig()
  }

  async function pickNode() {
    const g = cfg.group
    if (!g) {
      await Dialog.alert("先在下面「选择策略组」，才知道要改哪个组的节点。")
      return
    }
    const j = await pullStatus(g)
    if (!j) return
    const detail = (j.groups || []).find((x: any) => x && x.group === g) || (j.groups || [])[0]
    const cands: string[] = (detail && detail.candidates) || (j.sub_policies || {})[g] || []
    if (!cands.length) {
      await Dialog.alert("这个组没有候选节点（可能组名不匹配或订阅还没刷新）。")
      return
    }
    const picked = await sheet(`${g}（当前 ${(detail && detail.selected) || "未记录"}）`, cands)
    if (!picked) return
    const r = await bridge(cfg, "action=set_policy&policy=" + encodeURIComponent(g) + "&node=" + encodeURIComponent(picked))
    if (!r || !r.ok) await Dialog.alert("切换失败：" + ((r && r.error) || "桥接无响应"))
    Widget.reloadAll()
  }

  async function nextNode() {
    const g = cfg.group
    if (!g) {
      await Dialog.alert("先在下面「选择策略组」。")
      return
    }
    const r = await bridge(cfg, "action=set_policy&policy=" + encodeURIComponent(g) + "&node=next")
    if (!r || !r.ok) await Dialog.alert("切换失败：" + ((r && r.error) || "桥接无响应"))
    Widget.reloadAll()
  }

  async function editBridge() {
    const v = await promptSafe({
      title: "桥接地址",
      message: "默认 http://1.1.1.1/loon-bridge（IP 直连，不需要 DNS）。",
      defaultValue: cfg.bridge,
      placeholder: DEFAULT_BRIDGE,
      keyboardType: "URL",
      confirmLabel: "保存",
      cancelLabel: "取消",
    }, true)
    if (v === null) return
    saveCfg({ ...cfg, bridge: v.trim() })
    await reloadConfig()
  }

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : "从未刷新"

  return (
    <NavigationStack>
      <List navigationTitle="Loon 控制台">
        <Section header={<Text>当前状态</Text>}>
          <VStack alignment="leading" spacing={8} padding={{ top: 6, bottom: 6 }}>
            <Row label="桥接" value={snap?.bridgeConnected ? "已连接" : "未连接"} color={snap?.bridgeConnected ? "#059669" : "#D97706"} />
            <Row label="运行模式" value={snap?.modeLabel || modeName(snap?.mode) || "—"} />
            <Row label="策略组总数" value={snap?.groupCount ? String(snap.groupCount) : "—"} />
            <Row label="当前节点" value={`${snap?.group || "—"} → ${snap?.node || "—"}`} />
            <Row
              label={snap?.uptimeSource === "device" ? "设备运行时长" : "Loon 运行时长"}
              value={fmtDuration(snap?.uptimeMs || 0)}
            />
            <Row label="公网 IP" value={snap?.ip ? `${snap.ipFlag || ""} ${snap.ip}${snap.ipRegion ? " · " + snap.ipRegion : ""}` : "—"} />
            <Row label="Loon 版本" value={snap?.version || "—"} />
            <Row label="最近刷新" value={updated} />
          </VStack>
        </Section>

        <Section header={<Text>运行模式</Text>}>
          <Button title="分流模式" action={() => setMode(1)} />
          <Button title="全局代理" action={() => setMode(2)} />
          <Button title="全局直连" action={() => setMode(0)} />
          <Button title="下一个模式" action={cycleMode} />
        </Section>

        <Section header={<Text>节点</Text>}>
          <Button title={cfg.group ? `策略组：${cfg.group}` : "选择策略组"} action={pickGroup} />
          <Button title="选择节点（从候选里挑）" action={pickNode} />
          <Button title="下一个节点" action={nextNode} />
          <VStack alignment="leading" spacing={4} padding={{ top: 4, bottom: 4 }}>
            <Text font={12} foregroundStyle="#64748B">
              桌面卡片上的「节点」格子点一下 = 切到该组的下一个节点；要精确挑某个节点就进这里。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>刷新与连接</Text>}>
          <Button title="测试桥接并同步状态" action={async () => { const j = await pullStatus(cfg.group || undefined); if (j) await Dialog.alert(`桥接正常\n模式：${j.mode_label || j.running_mode}\n策略组：${j.policy_group_count ?? (j.all_policy_groups || []).length}\n在线：${fmtDuration(j.loon_uptime_ms || 0)}`) }} />
          <Button title="设置桥接地址" action={editBridge} />
          <Button title="恢复默认桥接" action={async () => { saveCfg({ ...cfg, bridge: DEFAULT_BRIDGE }); await reloadConfig() }} />
        </Section>

        <Section header={<Text>时长来源</Text>}>
          <Button
            title={cfg.uptime === "device" ? "当前：设备开机时长（点此改回 Loon）" : "当前：Loon 在线时长（点此改成设备）"}
            action={async () => {
              saveCfg({ ...cfg, uptime: cfg.uptime === "device" ? "loon" : "device" })
              await reloadConfig()
            }}
          />
          <VStack alignment="leading" spacing={4} padding={{ top: 4, bottom: 4 }}>
            <Text font={12} foregroundStyle="#64748B">
              Loon 不提供隧道运行时长接口，这版用「插件心跳还在继续」来推算：插件每次 cron 或桥接请求都打点，
              断档超过约 30 分钟就认为 Loon 重启过、重新计时。想要绝对准确的数字就切成设备开机时长。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>小组件预览</Text>}>
          <Button title="预览中号" action={async () => { try { await Widget.preview({ family: "systemMedium" }) } catch (e: any) { await Dialog.alert(String(e?.message || e)) } }} />
          <Button title="预览小号" action={async () => { try { await Widget.preview({ family: "systemSmall" }) } catch (e: any) { await Dialog.alert(String(e?.message || e)) } }} />
          <VStack alignment="leading" spacing={4} padding={{ top: 4, bottom: 4 }}>
            <Text font={12} foregroundStyle="#64748B">
              组件参数：bridge=…&group=节点选择&uptime=loon
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>依赖</Text>}>
          <VStack alignment="leading" spacing={5} padding={{ top: 6, bottom: 6 }}>
            <Text font={12} foregroundStyle="#64748B">
              Loon 里需要 loon-control 插件（提供 /loon-bridge 与心跳），否则卡片只能用缓存。
            </Text>
            <Text font={11} foregroundStyle="#334155">
              https://raw.githubusercontent.com/Yjwj205/loon-modules/main/loon-control/loon-control.plugin
            </Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  )
}

function modeName(mode?: string): string {
  if (mode === "all_proxy") return "全局代理"
  if (mode === "all_direct") return "全局直连"
  if (mode === "filter") return "分流模式"
  return ""
}

async function run() {
  await Navigation.present(<ControlPage />)
  Script.exit()
}

run()
