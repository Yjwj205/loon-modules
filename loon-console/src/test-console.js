/**
 * loon-console/widget.tsx 逻辑测试（Node，mock Scripting 运行时）
 * esbuild 编成 CJS，注入假的 scripting / os 模块，验证：
 * 桥接解析、运行时长来源、IP 解析与缓存、交互 intent、尺寸分发、渲染文案。
 */
const fs = require("fs")
const path = require("path")
const Module = require("module")
const { execFileSync } = require("child_process")

const ROOT = __dirname
const OUT = "/tmp/loon_console_cjs.js"

execFileSync("esbuild", [
  path.join(ROOT, "widget.tsx"),
  "--bundle", "--platform=node", "--format=cjs",
  "--jsx-factory=__h", "--jsx-fragment=__frag",
  "--external:scripting", "--external:os",
  "--outfile=" + OUT,
], { stdio: "pipe" })

function __h(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}
const __frag = "Fragment"

let pass = 0
const fails = []
function ok(cond, name, extra) {
  if (cond) pass++
  else fails.push(name + (extra !== undefined ? " → " + extra : ""))
}
function eq(a, b, name) {
  ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

const intents = {}
const stub = new Proxy({}, {
  get: (_t, k) => {
    if (k === "AppIntentManager") {
      return {
        register: (opts) => {
          intents[opts.name] = opts.perform
          return (params) => ({ __intent: opts.name, params })
        },
      }
    }
    if (k === "AppIntentProtocol") return { AppIntent: "app", LiveActivityIntent: "live" }
    if (k === "Widget") return globalThis.__widget
    if (k === "Script") {
      return {
        directory: ROOT,
        name: "Loon 控制台",
        createRunURLScheme: (n) => "scripting://run/" + encodeURIComponent(n),
      }
    }
    return (props) => ({ type: String(k), props })
  },
})

const origLoad = Module._load
Module._load = function (request) {
  if (request === "scripting") return stub
  if (request === "os") return { uptime: () => globalThis.__osUptime }
  return origLoad.apply(this, arguments)
}

function walk(node, textOut, intentOut, depth = 0) {
  if (depth > 40 || node === null || node === undefined || node === false) return
  if (typeof node === "string" || typeof node === "number") { textOut.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, textOut, intentOut, depth + 1)); return }
  if (typeof node !== "object") return
  const type = node.type
  const props = node.props || {}
  if (typeof type === "function") { walk(type(props), textOut, intentOut, depth + 1); return }
  if (props.intent && props.intent.__intent) intentOut.push(props.intent.__intent)
  if (props.url) intentOut.push("url:" + props.url)
  walk(props.children, textOut, intentOut, depth + 1)
}

function render(view) {
  const text = []
  const intentsOut = []
  walk(view, text, intentsOut)
  return { text: text.join(" | "), intents: intentsOut }
}

async function freshModule({ parameter = "", family = "systemMedium", storage = {}, fetchImpl, osUptime = 86400 }) {
  globalThis.__osUptime = osUptime
  const store = storage
  globalThis.Storage = {
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; return true },
    remove: (k) => { delete store[k] },
  }
  let presented = null
  globalThis.__widget = {
    parameter, family,
    present: (v) => { presented = v },
    reloadAll: () => {},
  }
  globalThis.fetch = fetchImpl
  globalThis.__h = __h
  globalThis.__frag = __frag

  delete require.cache[require.resolve(OUT)]
  require(OUT)

  const t0 = Date.now()
  await new Promise((resolve) => {
    const tick = () => (presented || Date.now() - t0 > 4000) ? resolve() : setTimeout(tick, 10)
    tick()
  })
  return { view: presented, store }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const BRIDGE = {
  ok: true, service: "loon", script: "1.1.0",
  running_model: 1, running_mode: "filter", mode_label: "分流模式",
  policy_group_count: 16,
  all_policy_groups: ["节点选择", "国外网站", "流媒体"],
  groups: [{ group: "节点选择", selected: "🇭🇰 香港 01", candidate_count: 9, candidates: ["🇭🇰 香港 01", "🇯🇵 东京 02"] }],
  policy_select: { "节点选择": "🇭🇰 香港 01" },
  version: "Loon 3.5.1",
  loon_uptime_ms: 12 * 86400 * 1000 + 3 * 3600 * 1000,
}

const IP_OK = {
  status: "success", country: "中国香港", countryCode: "HK",
  regionName: "香港", city: "香港", query: "103.85.12.44", isp: "NetLab",
}

function jsonRes(obj) {
  return { ok: true, status: 200, text: async () => JSON.stringify(obj), headers: {}, json: async () => obj }
}

;(async function main() {
  // 1. 桥接正常：模式 / 策略组 / 节点 / 版本 / 在线时长
  {
    const { view } = await freshModule({
      fetchImpl: async (url) => {
        const u = String(url)
        if (u.includes("/loon-bridge")) return jsonRes(BRIDGE)
        if (u.includes("ip-api.com")) return jsonRes(IP_OK)
        throw new Error("unexpected " + u)
      },
    })
    const snap = view.props.snap
    eq(snap.mode, "filter", "桥接：模式")
    eq(snap.groupCount, 16, "桥接：策略组总数")
    eq(snap.node, "🇭🇰 香港 01", "桥接：当前节点")
    eq(snap.version, "Loon 3.5.1", "桥接：版本")
    eq(snap.uptimeSource, "loon", "时长：默认用 Loon")
    ok(snap.uptimeMs > 12 * 86400 * 1000, "时长：取 loon_uptime_ms", snap.uptimeMs)

    const r1 = render(view)
    const text = r1.text
    ok(/12天 03:0\d/.test(text), "渲染：显示 12天 03:0x", text.slice(0, 200))
    ok(text.includes("16"), "渲染：显示策略组 16", text.slice(0, 200))
    ok(text.includes("分流模式"), "渲染：显示运行模式")
    ok(text.includes("103.85.12.44"), "渲染：显示公网 IP")
    ok(text.includes("🇭🇰") || text.includes("香港"), "渲染：显示节点/地区")
    ok(r1.intents.includes("LoonConsoleMode"), "渲染：模式胶囊挂了 intent", r1.intents.join(","))
    ok(r1.intents.includes("LoonConsoleNode"), "渲染：节点胶囊挂了 intent", r1.intents.join(","))
    ok(r1.intents.includes("LoonConsoleRefresh"), "渲染：刷新按钮挂了 intent", r1.intents.join(","))
  }

  // 2. 时长来源切设备
  {
    const { view } = await freshModule({
      parameter: "uptime=device",
      osUptime: 3 * 86400 + 7200,
      fetchImpl: async (url) => String(url).includes("/loon-bridge") ? jsonRes(BRIDGE) : jsonRes(IP_OK),
    })
    eq(view.props.snap.uptimeSource, "device", "时长：切到设备")
    ok(view.props.snap.uptimeMs > 3 * 86400 * 1000, "时长：os.uptime 按秒换毫秒", view.props.snap.uptimeMs)
    ok(render(view).text.includes("设备运行时长"), "渲染：标签写明设备")
  }

  // 3. 桥接挂掉 + 有缓存：保留数据、标未连接
  {
    const { view } = await freshModule({
      storage: {
        loon_console_snap_v1: {
          mode: "all_proxy", groupCount: 12, group: "节点选择", node: "🇯🇵 东京 02", nodeCount: 5,
          uptimeMs: 3600 * 1000, uptimeSource: "loon", fetchedAt: Date.now() - 3600 * 1000,
          ip: "1.2.3.4", ipRegion: "日本 · 东京", ipFlag: "🇯🇵", version: "Loon 3.5.0",
          bridgeConnected: true, updatedAt: new Date().toISOString(),
        },
      },
      fetchImpl: async () => { throw new Error("down") },
    })
    const snap = view.props.snap
    eq(snap.bridgeConnected, false, "降级：桥接断开")
    eq(snap.node, "🇯🇵 东京 02", "降级：保留节点")
    eq(snap.ip, "1.2.3.4", "降级：保留 IP")
  }

  // 4. IP 缓存 10 分钟内不重拉
  {
    let ipCalls = 0
    const store = { loon_console_ip_v1: { ip: "9.9.9.9", region: "美国 · 洛杉矶", flag: "🇺🇸", t: Date.now() } }
    const { view } = await freshModule({
      storage: store,
      fetchImpl: async (url) => {
        if (String(url).includes("ip-api.com")) { ipCalls++; return jsonRes(IP_OK) }
        return jsonRes(BRIDGE)
      },
    })
    eq(ipCalls, 0, "IP 缓存：不重复请求")
    eq(view.props.snap.ip, "9.9.9.9", "IP 缓存：用缓存值")
  }

  // 5. 指定 group 时，status 请求里带上 groups=（编码过）
  {
    const urls = []
    await freshModule({
      parameter: "group=流媒体",
      fetchImpl: async (url) => {
        urls.push(String(url))
        return String(url).includes("/loon-bridge") ? jsonRes(BRIDGE) : jsonRes(IP_OK)
      },
    })
    const statusUrl = urls.find((u) => u.includes("action=status")) || ""
    ok(statusUrl.includes("groups=" + encodeURIComponent("流媒体")), "参数：status 带 groups", statusUrl)
  }

  // 6. 点节点 → set_policy&node=next；点模式 → set_mode&mode=next
  {
    const urls = []
    const { view } = await freshModule({
      fetchImpl: async (url) => {
        urls.push(String(url))
        return String(url).includes("/loon-bridge") ? jsonRes(BRIDGE) : jsonRes(IP_OK)
      },
    })
    ok(!!intents["LoonConsoleNode"], "intent：节点 intent 已注册")
    ok(!!intents["LoonConsoleMode"], "intent：模式 intent 已注册")
    ok(!!intents["LoonConsoleRefresh"], "intent：刷新 intent 已注册")

    urls.length = 0
    await intents["LoonConsoleNode"]({ group: "节点选择" })
    ok(urls.some((u) => u.includes("action=set_policy") && u.includes(encodeURIComponent("节点选择")) && u.includes("node=next")),
      "intent：节点 next 调用正确", urls.join(" , "))

    urls.length = 0
    await intents["LoonConsoleMode"]()
    ok(urls.some((u) => u.includes("action=set_mode") && u.includes("mode=next")), "intent：模式 next 调用正确")

    const r2 = render(view)
    ok(r2.intents.includes("LoonConsoleNode"), "渲染：节点胶囊挂 intent")
    ok(r2.intents.includes("LoonConsoleMode"), "渲染：模式胶囊挂 intent")
  }

  // 7. 小号：仍然有模式/组数/IP
  {
    const { view } = await freshModule({
      family: "systemSmall",
      fetchImpl: async (url) => String(url).includes("/loon-bridge") ? jsonRes(BRIDGE) : jsonRes(IP_OK),
    })
    const text = render(view).text
    ok(text.includes("分流模式"), "小号：有模式")
    ok(text.includes("16 组"), "小号：有组数", text.slice(0,200))
    ok(text.includes("103.85.12.44"), "小号：有 IP", text.slice(0,200))
  }

  // 8. 桥接失败且无缓存：空态不崩
  {
    const { view } = await freshModule({ fetchImpl: async () => { throw new Error("nope") } })
    ok(!!view, "空态：仍渲染")
    const text = render(view).text
    ok(text.includes("—") || text.includes("Loon"), "空态：有占位内容", text.slice(0, 160))
  }

  // 9. 时长格式化：小时级 / 分钟级
  {
    const hourBridge = { ...BRIDGE, loon_uptime_ms: (5 * 3600 + 42 * 60) * 1000 }
    const { view } = await freshModule({
      fetchImpl: async (url) => String(url).includes("/loon-bridge") ? jsonRes(hourBridge) : jsonRes(IP_OK),
    })
    ok(/5时 4\d分|5 小时 4\d 分/.test(render(view).text), "格式化：小时级", render(view).text.slice(0, 160))
  }

  await sleep(20)
  console.log(`通过 ${pass}，失败 ${fails.length}`)
  if (fails.length) {
    fails.forEach((f) => console.log("  ✗ " + f))
    process.exit(1)
  }
})()
