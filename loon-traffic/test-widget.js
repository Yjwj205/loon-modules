/**
 * loon-traffic widget.tsx 逻辑测试（Node，mock Scripting 运行时）
 * 先用 esbuild 把 TSX 编成 CJS，再注入假的 scripting 模块，验证数据层：
 * 桥接解析、可选流量源（只认 download/upload）、缓存、降级。
 */
const fs = require("fs")
const path = require("path")
const Module = require("module")
const { execFileSync } = require("child_process")

const ROOT = __dirname
const OUT = "/tmp/loon_widget_cjs.js"

execFileSync("esbuild", [
  path.join(ROOT, "widget.tsx"),
  "--bundle", "--platform=node", "--format=cjs",
  "--jsx-factory=__h", "--jsx-fragment=__frag",
  "--external:scripting",
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

const stubComponents = new Proxy({}, {
  get: (_t, k) => {
    if (k === "AppIntentManager") {
      return { register: (opts) => () => ({ __intent: opts.name }) }
    }
    if (k === "AppIntentProtocol") return { AppIntent: "app", LiveActivityIntent: "live" }
    if (k === "Widget") return globalThis.__widget
    if (k === "Script") return { directory: ROOT }
    return (props) => ({ type: String(k), props })
  },
})

const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === "scripting") return stubComponents
  return origLoad.apply(this, arguments)
}

function freshModule({ parameter = "", family = "systemMedium", storage = {}, fetchImpl }) {
  const store = storage
  globalThis.__storage = store
  globalThis.Storage = {
    get: (k) => (k in store ? store[k] : null),
    set: (k, v) => { store[k] = v; return true },
    remove: (k) => { delete store[k] },
  }
  let presented = null
  globalThis.__widget = {
    parameter,
    family,
    present: (view) => { presented = view },
    reloadAll: () => {},
  }
  globalThis.fetch = fetchImpl
  globalThis.__h = __h
  globalThis.__frag = __frag

  delete require.cache[require.resolve(OUT)]
  require(OUT)

  // main() 是异步的，轮询等它调用 present
  return new Promise((resolve) => {
    const t0 = Date.now()
    const tick = () => {
      if (presented || Date.now() - t0 > 4000) resolve({ view: presented, store })
      else setTimeout(tick, 10)
    }
    tick()
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function jsonResponse(obj) {
  return { ok: true, status: 200, text: async () => JSON.stringify(obj), headers: {} }
}

const BRIDGE_OK = {
  ok: true, service: "loon", script: "1.0.0",
  running_model: 1, running_mode: "filter", mode_label: "分流模式",
  policy_group_count: 16,
  all_policy_groups: new Array(16).fill("g"),
  version: "Loon 3.5.1",
}

const SUB_HEADER = "upload=142697267; download=16106127360; total=107374182400; expire=1798761600"

function subResponse(header, withHeader = true) {
  return {
    ok: true, status: 200,
    headers: withHeader ? { "subscription-userinfo": header } : {},
    text: async () => "proxies: []",
  }
}

;(async function main() {
  // 1. 桥接正常 + 无流量源
  {
    const { view } = await freshModule({
      fetchImpl: async (url) => {
        if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
        throw new Error("unexpected " + url)
      },
    })
    const snap = view && view.props && view.props.snap
    ok(!!snap, "样例：拿到 snap")
    eq(snap && snap.mode, "filter", "桥接：运行模式")
    eq(snap && snap.groupCount, 16, "桥接：策略组数")
    eq(snap && snap.version, "Loon 3.5.1", "桥接：版本")
    eq(snap && snap.bridgeConnected, true, "桥接：连接状态")
    eq(snap && snap.download, "", "无流量源：累计下行留空")
    eq(snap && snap.hasTrafficSource, false, "无流量源：标记")
  }

  // 2. 带流量源：HEAD 拿到头，只取 download/upload
  {
    const calls = []
    const { view } = await freshModule({
      parameter: "traffic=https://sub.example.com/api?token=abc",
      fetchImpl: async (url, opt) => {
        calls.push({ url: String(url), method: opt && opt.method })
        if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
        return subResponse(SUB_HEADER)
      },
    })
    const snap = view.props.snap
    eq(snap.download, "15.0 GB", "流量源：download 15GB")
    eq(snap.upload, "136.1 MB", "流量源：upload 136MB")
    eq(snap.hasTrafficSource, true, "流量源：已识别")
    ok(calls.some((c) => c.method === "HEAD"), "流量源：优先 HEAD")
    ok(!snap.totalGb && !snap.remainGb && !snap.expireText, "流量源：不带总额/剩余/到期字段")
  }

  // 3. HEAD 无头 → Range 命中
  {
    let n = 0
    const { view } = await freshModule({
      parameter: '{"traffic":"https://sub.example.com/x"}',
      fetchImpl: async (url, opt) => {
        if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
        n++
        if (opt && opt.method === "HEAD") return subResponse("", false)
        return subResponse(SUB_HEADER)
      },
    })
    eq(view.props.snap.download, "15.0 GB", "降级：HEAD 失败后仍拿到流量")
    ok(n >= 2, "降级：确实重试了", n)
  }

  // 4. 桥接挂掉 + 有缓存 → 保留旧数据，只标未连接
  {
    const store = {
      loon_traffic_snap_v1: {
        mode: "all_proxy", modeLabel: "全局代理", groupCount: 12, version: "Loon 3.5.0",
        download: "20.1 GB", upload: "300.0 MB", bridgeConnected: true,
        hasTrafficSource: false, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    }
    const { view } = await freshModule({
      storage: store,
      fetchImpl: async () => { throw new Error("network down") },
    })
    const snap = view.props.snap
    eq(snap.bridgeConnected, false, "降级：桥接断开")
    eq(snap.groupCount, 12, "降级：保留缓存策略组数")
    eq(snap.download, "20.1 GB", "降级：保留缓存流量")
  }

  // 5. 缓存新鲜时不重复请求
  {
    let bridgeCalls = 0
    const store = {
      loon_traffic_snap_v1: {
        mode: "filter", modeLabel: "分流模式", groupCount: 8, version: "Loon 3.5.1",
        download: "", upload: "", bridgeConnected: true, hasTrafficSource: false,
        updatedAt: new Date().toISOString(),
      },
    }
    const { view } = await freshModule({
      storage: store,
      fetchImpl: async () => { bridgeCalls++; return jsonResponse(BRIDGE_OK) },
    })
    eq(bridgeCalls, 0, "缓存：10 分钟内不发请求", bridgeCalls)
    eq(view.props.snap.groupCount, 8, "缓存：直接用旧快照")
  }

  // 6. 流量缓存 15 分钟内复用
  {
    let subCalls = 0
    const store = {
      loon_traffic_sub_v1: { url: "https://sub.example.com/a", t: Date.now(), download: 5 * 1024 ** 3, upload: 1024 ** 3 },
    }
    const { view } = await freshModule({
      storage: store,
      parameter: "traffic=https://sub.example.com/a",
      fetchImpl: async (url) => {
        if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
        subCalls++
        return subResponse(SUB_HEADER)
      },
    })
    eq(subCalls, 0, "流量缓存：15 分钟内不重拉", subCalls)
    eq(view.props.snap.download, "5.0 GB", "流量缓存：用缓存值")
  }

  // 7. 参数解析：k=v 与 JSON 两种写法
  {
    const seen = []
    const fetchImpl = async (url) => {
      seen.push(String(url))
      if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
      return subResponse(SUB_HEADER)
    }
    await freshModule({ parameter: "bridge=http://8.8.8.8/loon-bridge&traffic=https://s/a", fetchImpl })
    ok(seen[0].startsWith("http://8.8.8.8/loon-bridge"), "参数：k=v 生效", seen[0])
  }

  // 8. 桥接返回 all_proxy → 标签正确
  {
    const { view } = await freshModule({
      fetchImpl: async () => jsonResponse({ ...BRIDGE_OK, running_model: 2, version: "3.5.1" }),
    })
    eq(view.props.snap.mode, "all_proxy", "模式：2 → 全局代理")
    eq(view.props.snap.version, "Loon 3.5.1", "版本：自动补 Loon 前缀")
  }

  // 9. 订阅头里只有 upload/download，没有 total 也能显示
  {
    const { view } = await freshModule({
      parameter: "traffic=https://s/b",
      fetchImpl: async (url) => {
        if (String(url).includes("/loon-bridge")) return jsonResponse(BRIDGE_OK)
        return subResponse("download=1048576; upload=2048")
      },
    })
    eq(view.props.snap.download, "1.0 MB", "无 total：仍解析 download")
    eq(view.props.snap.upload, "2.0 KB", "无 total：仍解析 upload")
  }

  // 10. 小号尺寸走 SmallCard
  {
    const { view } = await freshModule({ family: "systemSmall", fetchImpl: async () => jsonResponse(BRIDGE_OK) })
    const inner = view.type(view.props)
    eq(inner.type && inner.type.name, "SmallCard", "尺寸：小号用 SmallCard", inner.type && (inner.type.name || inner.type))
  }

  await sleep(20)
  console.log(`通过 ${pass}，失败 ${fails.length}`)
  if (fails.length) {
    fails.forEach((f) => console.log("  ✗ " + f))
    process.exit(1)
  }
})()
