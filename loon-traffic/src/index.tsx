/**
 * Loon 流量看板 · 配置页（可选）
 * 所有渲染逻辑都在 widget.tsx；这个文件只负责三件事：看状态、填桥接地址、填可选流量源。
 * 也可以完全不进这里 —— 直接在桌面小组件的「参数」里写 bridge=... / traffic=...
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
} from "scripting"

const CFG_KEY = "loon_traffic_cfg_v1"
const SNAP_KEY = "loon_traffic_snap_v1"
const DEFAULT_BRIDGE = "http://1.1.1.1/loon-bridge"

interface Cfg { bridge: string; traffic: string }

function readCfg(): Cfg {
  try {
    const s = Storage.get<Cfg>(CFG_KEY, { shared: true }) as Cfg | null
    if (s && typeof s === "object") {
      return { bridge: (s.bridge || DEFAULT_BRIDGE).trim(), traffic: (s.traffic || "").trim() }
    }
  } catch {}
  return { bridge: DEFAULT_BRIDGE, traffic: "" }
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

async function promptSafe(opts: any, required = true): Promise<string | null> {
  const v = await Dialog.prompt(opts)
  if (v === null || v === undefined) return null
  if (required && String(v).trim() === "") return null
  return String(v)
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

function ConfigPage() {
  const [cfg, setCfg] = useState<Cfg>(readCfg())
  const [snap, setSnap] = useState<any>(readSnap())

  async function reload() {
    setCfg(readCfg())
    setSnap(readSnap())
    Widget.reloadAll()
  }

  async function editBridge() {
    const v = await promptSafe({
      title: "桥接地址",
      message: "Loon 侧插件（loon-control.plugin）提供的本地接口。默认 http://1.1.1.1/loon-bridge 即可，不需要 DNS。",
      defaultValue: cfg.bridge,
      placeholder: DEFAULT_BRIDGE,
      keyboardType: "URL",
      confirmLabel: "保存",
      cancelLabel: "取消",
    }, true)
    if (v === null) return
    saveCfg({ ...cfg, bridge: v.trim() })
    await reload()
  }

  async function editTraffic() {
    const v = await promptSafe({
      title: "流量源（可选）",
      message: "填机场订阅地址。只读取响应头里的 download / upload 两个累计值，不导入节点、不解析总额和到期时间。留空则累计上下行显示「—」。",
      defaultValue: cfg.traffic,
      placeholder: "https://example.com/api/v1/client/subscribe?token=...",
      keyboardType: "URL",
      confirmLabel: "保存",
      cancelLabel: "取消",
    }, false)
    if (v === null) return
    saveCfg({ ...cfg, traffic: v.trim() })
    await reload()
  }

  async function clearTraffic() {
    saveCfg({ ...cfg, traffic: "" })
    await reload()
  }

  async function testBridge() {
    const base = cfg.bridge || DEFAULT_BRIDGE
    try {
      const res = await fetch(base + (base.includes("?") ? "&" : "?") + "action=status&select=0&sub_timeout=600", { timeout: 4 })
      const text = await res.text()
      try {
        const j = JSON.parse(text)
        await Dialog.alert({
          title: j.ok ? "桥接正常" : "桥接返回异常",
          message: `模式：${j.mode_label || j.running_mode || "-"}\n策略组：${j.policy_group_count ?? (j.all_policy_groups || []).length} 组\n版本：${j.version || "-"}\n脚本：${j.script || "-"}`,
        })
      } catch {
        await Dialog.alert({ title: "返回不是 JSON", message: text.slice(0, 200) })
      }
    } catch (e: any) {
      await Dialog.alert({
        title: "连不上桥接",
        message: `${String(e?.message || e)}\n\n检查：1) Loon 里已装 loon-control 插件并开启；2) 插件里那条 request 规则没被别的规则抢先匹配。`,
      })
    }
  }

  const updated = snap?.updatedAt ? new Date(snap.updatedAt).toLocaleTimeString() : "从未刷新"

  return (
    <NavigationStack>
      <List navigationTitle="Loon 流量看板">
        <Section header={<Text>当前状态</Text>}>
          <VStack alignment="leading" spacing={8} padding={{ top: 6, bottom: 6 }}>
            <Row label="桥接" value={snap?.bridgeConnected ? "已连接" : "未连接"} color={snap?.bridgeConnected ? "#059669" : "#D97706"} />
            <Row label="运行模式" value={snap?.modeLabel || "—"} />
            <Row label="策略组数" value={snap?.groupCount ? String(snap.groupCount) : "—"} />
            <Row label="累计下行 / 上行" value={`${snap?.download || "—"} / ${snap?.upload || "—"}`} />
            <Row label="Loon 版本" value={snap?.version || "—"} />
            <Row label="最近更新" value={updated} />
          </VStack>
        </Section>

        <Section header={<Text>连接</Text>}>
          <Button title="设置桥接地址" action={editBridge} />
          <Button title="测试桥接" action={testBridge} />
          <Button title="恢复默认桥接" action={async () => { saveCfg({ ...cfg, bridge: DEFAULT_BRIDGE }); await reload() }} />
        </Section>

        <Section header={<Text>流量源（可选）</Text>}>
          <Button title={cfg.traffic ? "更换订阅地址" : "填写订阅地址"} action={editTraffic} />
          {cfg.traffic ? <Button title="清除流量源" action={clearTraffic} /> : null}
          <VStack alignment="leading" spacing={5} padding={{ top: 6, bottom: 6 }}>
            <Text font={12} foregroundStyle="#64748B">
              只读 download / upload 两个数字，不导入节点、不显示总额、剩余、到期。
            </Text>
            <Text font={12} foregroundStyle="#64748B">
              留空就用不了这两格，会显示「—」—— Loon 自己也不提供累计流量接口。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>桌面小组件</Text>}>
          <Button title="预览中号小组件" action={async () => { try { await Widget.preview({ family: "systemMedium" }) } catch (e: any) { await Dialog.alert({ title: "预览失败", message: String(e?.message || e) }) } }} />
          <Button title="预览小号小组件" action={async () => { try { await Widget.preview({ family: "systemSmall" }) } catch (e: any) { await Dialog.alert({ title: "预览失败", message: String(e?.message || e) }) } }} />
          <VStack alignment="leading" spacing={5} padding={{ top: 6, bottom: 6 }}>
            <Text font={12} foregroundStyle="#64748B">
              长按桌面小组件 →「编辑小组件」→ 选这个脚本。参数可以留空，也可以写：
            </Text>
            <Text font={11} foregroundStyle="#334155">
              bridge=http://1.1.1.1/loon-bridge&traffic=https://订阅地址
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>依赖</Text>}>
          <VStack alignment="leading" spacing={5} padding={{ top: 6, bottom: 6 }}>
            <Text font={12} foregroundStyle="#64748B">
              Loon 里需要装 loon-control 插件（提供 /loon-bridge 接口），否则卡片只能显示缓存。
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

async function run() {
  await Navigation.present(<ConfigPage />)
  Script.exit()
}

run()
