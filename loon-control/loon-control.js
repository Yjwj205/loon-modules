/**
 * Loon 控制面板（独立版）v1.0.0
 * 改写自 SylvanRoe/DashBoard-Kit 的 loon_dashboard_bridge.js，并去掉全部订阅相关逻辑。
 *
 * 一个脚本，两种用法：
 *   1) 面板卡片：cron / network-changed / generic 触发 → $done({title, content, icon, "icon-color"})
 *   2) 本地桥接：GET http://1.1.1.1/loon-bridge?action=status|set_mode|set_policy → JSON
 *
 * 只用 Loon 自己的 $config API，不读取、不解析任何机场/节点订阅链接：
 *   剩余流量 / 总额 / 到期时间 / 上下行累计 —— 这类数据原本靠机场订阅的
 *   subscription-userinfo 头解析，本版全部移除，面板里不再出现。
 *
 * Bridge 参数：
 *   action=status       读状态（默认）
 *   action=set_mode     mode=0|1|2|direct|filter|proxy|next
 *   action=set_policy   policy=组名[|组名2] & node=节点名|next
 *   可选：groups=A|B（只探这些组）、sub_timeout=1500（ms）、select=0（不补齐 policy_select）、
 *        latency=1（顺带测延迟）、debug=1（回传诊断字段）
 */

var SCRIPT_VERSION = "1.0.0";
var STORE_PREFIX = "loon_control_";

// 每类数据的缓存时长（Loon 侧每次触发都是新进程，所以只能落 $persistentStore）
var TTL = {
  sub: 120 * 1000,     // 策略组候选节点：2 分钟（订阅更新后最多 2 分钟才看到新节点）
  latency: 60 * 1000,  // 延迟：1 分钟
};

// 这些都是「内置策略」，Loon 常常把它们排在候选列表最前面
var BUILTIN_POLICIES = ["DIRECT", "REJECT", "REJECT-DROP", "REJECT-TINYGIF", "REJECT-NO-DROP", "PROXY"];

// 自动挑选要显示的策略组时，按这个顺序找（匹配到最多 4 个）
var PRIORITY_GROUPS = [
  "节点选择", "PROXY", "Proxy", "全局代理", "节点", "国外网站", "国外流量", "GFW",
  "AI", "ChatGPT", "OpenAI", "流媒体", "媒体", "苹果服务", "漏网之鱼", "FINAL", "Final",
];

var MODE_LABELS = { filter: "分流模式", all_proxy: "全局代理", all_direct: "全局直连" };
var MODE_BADGE = { filter: "🟢", all_proxy: "🟣", all_direct: "⚪" };
var MODE_COLOR = { filter: "#34C759", all_proxy: "#8B5CF6", all_direct: "#8E8E93" };

// ---------------------------------------------------------------- 基础工具

function log() {
  try {
    var args = ["[Loon面板]"];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  } catch (e) {}
}

function safeParse(text) {
  if (text === null || text === undefined) return null;
  if (typeof text !== "string") return text;
  var s = text.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

/** Loon 会把值包成 JSON 字符串返回：'"美国节点"' / 'null' / '[{"name":"x"}]' */
function decodeValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  var s = v.trim();
  if (!s || s === "null" || s === "undefined") return null;
  var first = s.charAt(0);
  if (first === '"' || first === "[" || first === "{") {
    var parsed = safeParse(s);
    if (parsed !== null && parsed !== undefined) return parsed;
    return s;
  }
  return s;
}

function toNameArray(v) {
  var d = decodeValue(v);
  if (!d) return [];
  if (Array.isArray(d)) {
    var names = [];
    for (var i = 0; i < d.length; i++) {
      var it = d[i];
      if (typeof it === "string" && it) names.push(it);
      else if (it && typeof it === "object") {
        var nm = it.name || it.policy || it.title;
        if (nm) names.push(String(nm));
      }
    }
    return names;
  }
  if (typeof d === "string" && d.indexOf(",") >= 0) {
    var parts = d.split(",");
    var out = [];
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j].trim();
      if (p) out.push(p);
    }
    return out;
  }
  return [];
}

function argBool(v, dflt) {
  if (v === undefined || v === null || v === "") return dflt;
  var s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return dflt;
}

/** $argument 可能是对象，也可能是 JSON / "a=1&b=2" 字符串 */
function readArgument() {
  var raw = null;
  try { if (typeof $argument !== "undefined") raw = $argument; } catch (e) { raw = null; }
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  var s = String(raw).trim();
  if (!s) return {};
  var parsed = safeParse(s);
  if (parsed && typeof parsed === "object") return parsed;
  var out = {};
  var pairs = s.split("&");
  for (var i = 0; i < pairs.length; i++) {
    var kv = pairs[i];
    var idx = kv.indexOf("=");
    if (idx > 0) {
      try { out[decodeURIComponent(kv.slice(0, idx))] = decodeURIComponent(kv.slice(idx + 1)); }
      catch (e) { out[kv.slice(0, idx)] = kv.slice(idx + 1); }
    }
  }
  return out;
}

function parseQuery(url) {
  var query = {};
  if (!url) return query;
  var qi = url.indexOf("?");
  if (qi < 0) return query;
  var pairs = url.slice(qi + 1).split("&");
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i];
    if (!pair) continue;
    var eq = pair.indexOf("=");
    var k = eq >= 0 ? pair.slice(0, eq) : pair;
    var v = eq >= 0 ? pair.slice(eq + 1) : "";
    try { query[decodeURIComponent(k)] = decodeURIComponent(v); }
    catch (e) { query[k] = v; }
  }
  return query;
}

/** "group=A|B" / "group=A,B" → ["A","B"] */
function splitList(s) {
  if (!s) return [];
  var parts = String(s).split(/[|,，;；]/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 缓存

function cacheGet(key, ttlMs) {
  try {
    var raw = $persistentStore.read(STORE_PREFIX + key);
    if (!raw) return null;
    var obj = safeParse(raw);
    if (!obj || typeof obj.t !== "number") return null;
    if (Date.now() - obj.t > ttlMs) return null;
    return obj.v;
  } catch (e) { return null; }
}

function cacheSet(key, value) {
  try { $persistentStore.write(JSON.stringify({ t: Date.now(), v: value }), STORE_PREFIX + key); }
  catch (e) {}
}

// ---------------------------------------------------------------- Loon 配置读取

var _config = null;

/** 整次运行只调一次 getConfig()（原脚本调了两次，第二次还可能是 undefined） */
function readConfig() {
  if (_config) return _config;
  var obj = null;
  try {
    if (typeof $config !== "undefined" && typeof $config.getConfig === "function") {
      var decoded = decodeValue($config.getConfig());
      if (decoded && typeof decoded === "object") obj = decoded;
      else if (typeof decoded === "string") obj = safeParse(decoded);
    }
  } catch (e) {
    log("getConfig 失败:", String(e));
  }
  _config = obj || {};
  return _config;
}

function hasLoonConfigApi() {
  try { return typeof $config !== "undefined" && $config !== null; } catch (e) { return false; }
}

function listGroups(cfg) {
  var groups = Array.isArray(cfg.all_policy_groups) ? cfg.all_policy_groups.slice() : [];
  if (groups.length === 0 && cfg.policy_select && typeof cfg.policy_select === "object") {
    groups = Object.keys(cfg.policy_select);
  }
  var out = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (typeof g === "string" && g && out.indexOf(g) < 0) out.push(g);
  }
  return out;
}

/** getConfig().policy_select 只含部分组，且可能用字符串 "null" 表示空 */
function readRecordedSelection(cfg) {
  var out = {};
  var src = cfg.policy_select;
  if (!src || typeof src !== "object") return out;
  var keys = Object.keys(src);
  for (var i = 0; i < keys.length; i++) {
    var v = src[keys[i]];
    if (typeof v === "string" && v && v !== "null" && v !== "undefined") out[keys[i]] = v;
  }
  return out;
}

/** 同步读取单个策略组当前选择（新 API 优先，旧拼写兜底） */
function readSelected(group) {
  var apis = ["getSelectedPolicy", "getPolicy"];
  for (var i = 0; i < apis.length; i++) {
    var fn = null;
    try { fn = $config[apis[i]]; } catch (e) { fn = null; }
    if (typeof fn !== "function") continue;
    try {
      var v = decodeValue(fn.call($config, group));
      if (typeof v === "string" && v && v !== "null") return v;
      if (v && typeof v === "object") {
        var nm = v.selected || v.select || v.now || v.current || v.policy;
        if (typeof nm === "string" && nm) return nm;
      }
    } catch (e) {}
  }
  return "";
}

/**
 * 异步读候选节点。带整体 deadline，API 不存在 / 回调空 / 超时都会 resolve 空数组，
 * 不会像原脚本那样在 20 个组上各等 2.5 秒。
 */
function fetchSubPolicies(group, timeoutMs) {
  return new Promise(function (resolve) {
    if (!hasLoonConfigApi()) { resolve({ names: [], via: "no-api" }); return; }
    var wait = Math.max(300, Number(timeoutMs) || 1500);
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve({ names: [], via: "timeout" });
    }, wait);

    function finish(names, via) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ names: names || [], via: via });
    }

    var apis = ["getSubPolicies", "getSubPolicys"];
    var idx = 0;

    function attempt() {
      if (idx >= apis.length) { finish([], "unsupported"); return; }
      var api = apis[idx++];
      var fn = null;
      try { fn = $config[api]; } catch (e) { fn = null; }
      if (typeof fn !== "function") { attempt(); return; }
      try {
        var ret = fn.call($config, group, function (a, b) {
          var names = toNameArray(a);
          if (names.length === 0) names = toNameArray(b);
          if (names.length > 0) finish(names, api);
          else attempt();
        });
        if (ret && typeof ret.then === "function") {
          ret.then(function (v) {
            var names = toNameArray(v);
            if (names.length > 0) finish(names, api + ":promise");
          }).catch(function () {});
        }
      } catch (e) {
        attempt();
      }
    }

    attempt();
  });
}

/** 没有记录选中值时：跳过 DIRECT/REJECT 后的第一个成员，就是 Loon 实际生效的策略 */
function inferSelection(candidates) {
  if (!Array.isArray(candidates)) return "";
  for (var i = 0; i < candidates.length; i++) {
    var up = String(candidates[i]).trim().toUpperCase();
    if (BUILTIN_POLICIES.indexOf(up) < 0) return candidates[i];
  }
  return candidates.length > 0 ? candidates[0] : "";
}

/** 自动挑选要展示的策略组：优先常见组名，不够就用配置里的前几个 */
function pickGroups(allGroups, custom, maxGroups) {
  var limit = Math.max(1, Math.min(8, maxGroups || 4));
  var out = [];

  function push(g) {
    if (!g) return;
    if (out.indexOf(g) < 0) out.push(g);
  }

  function findByName(name) {
    for (var i = 0; i < allGroups.length; i++) {
      if (allGroups[i] === name) return allGroups[i];
    }
    var lower = String(name).toLowerCase();
    for (var j = 0; j < allGroups.length; j++) {
      if (String(allGroups[j]).toLowerCase().indexOf(lower) >= 0) return allGroups[j];
    }
    return "";
  }

  if (custom && custom.length > 0) {
    for (var c = 0; c < custom.length && out.length < limit; c++) {
      var hit = findByName(custom[c]);
      // 手填的组名可能不在 all_policy_groups 里（例如 Loon 还没加载配置），照样保留
      push(hit || custom[c]);
    }
    return out;
  }

  for (var p = 0; p < PRIORITY_GROUPS.length && out.length < limit; p++) {
    var matched = findByName(PRIORITY_GROUPS[p]);
    if (matched) push(matched);
  }
  for (var k = 0; k < allGroups.length && out.length < limit; k++) push(allGroups[k]);
  return out;
}

function readRuntimeVersion() {
  var s = "";
  try { if (typeof $loon !== "undefined" && $loon) s = String($loon); } catch (e) {}
  var m = s.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : "";
}

// ---------------------------------------------------------------- 延迟

/** 通过当前路由打一个 204，给出链路延迟；失败返回 null（不阻塞面板） */
function measureLatency(node, timeoutMs) {
  return new Promise(function (resolve) {
    var client = null;
    try { client = (typeof $httpClient !== "undefined") ? $httpClient : null; } catch (e) { client = null; }
    if (!client || typeof client.get !== "function") { resolve(null); return; }

    var wait = Math.max(600, Number(timeoutMs) || 2500);
    var settled = false;
    var t0 = Date.now();
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(null);
    }, wait + 700);

    var options = {
      url: "http://www.gstatic.com/generate_204",
      timeout: wait,
      "auto-redirect": false,
      "auto-cookie": false,
    };
    if (node) options.node = node;

    try {
      client.get(options, function (err, resp) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) { resolve(null); return; }
        var status = resp && resp.status;
        if (status && status !== 204 && status !== 200 && status !== 302) { resolve(null); return; }
        resolve(Date.now() - t0);
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    }
  });
}

// ---------------------------------------------------------------- 快照

function modeFromModel(model) {
  if (model === 0) return "all_direct";
  if (model === 2) return "all_proxy";
  return "filter";
}

function modelFromMode(mode) {
  var m = String(mode || "").toLowerCase();
  if (m === "0" || m === "direct" || m === "all_direct" || m === "全局直连") return 0;
  if (m === "2" || m === "proxy" || m === "all_proxy" || m === "全局代理") return 2;
  if (m === "1" || m === "filter" || m === "rule" || m === "分流模式") return 1;
  return -1;
}

/**
 * @param opts {groups:[], maxGroups:number, subTimeout:number, fillSelect:boolean, latency:boolean, includeSub:boolean}
 */
async function buildSnapshot(opts) {
  var cfg = readConfig();
  var runningModel = typeof cfg.running_model === "number" ? cfg.running_model : 1;
  var mode = modeFromModel(runningModel);
  var allGroups = listGroups(cfg);
  var policySelect = readRecordedSelection(cfg);

  // 1. 补上 getConfig 没给的组（同步调用，便宜）
  if (opts.fillSelect !== false) {
    var fillLimit = Math.min(allGroups.length, 60);
    for (var i = 0; i < fillLimit; i++) {
      var g = allGroups[i];
      if (!g || policySelect[g]) continue;
      var sel = readSelected(g);
      if (sel) policySelect[g] = sel;
    }
  }

  // 2. 候选节点：只探需要展示的组，命中缓存就不探
  var picks = pickGroups(allGroups, opts.groups, opts.maxGroups);
  var subPolicies = {};
  var subMeta = {};
  if (opts.includeSub !== false) {
    var pending = [];
    for (var p = 0; p < picks.length; p++) {
      var name = picks[p];
      var cached = cacheGet("sub:" + name, TTL.sub);
      if (Array.isArray(cached) && cached.length > 0) {
        subPolicies[name] = cached;
        subMeta[name] = "cache";
      } else {
        pending.push(name);
      }
    }
    if (pending.length > 0) {
      var deadline = Date.now() + Math.max(500, opts.subTimeout || 1500);
      var results = await Promise.all(pending.map(function (n) {
        var remain = Math.max(400, deadline - Date.now());
        return fetchSubPolicies(n, Math.min(remain, opts.subTimeout || 1500)).then(function (r) {
          return { group: n, names: r.names, via: r.via };
        });
      }));
      for (var r = 0; r < results.length; r++) {
        var item = results[r];
        subMeta[item.group] = item.via;
        if (item.names && item.names.length > 0) {
          subPolicies[item.group] = item.names;
          cacheSet("sub:" + item.group, item.names);
        }
      }
    }
  }

  // 3. 仍无记录的组用候选列表推断
  var inferred = {};
  for (var key in subPolicies) {
    if (!Object.prototype.hasOwnProperty.call(subPolicies, key)) continue;
    if (policySelect[key]) continue;
    var guess = inferSelection(subPolicies[key]);
    if (guess) {
      policySelect[key] = guess;
      inferred[key] = guess;
    }
  }

  // 4. 延迟（可选，带缓存）
  var latencyMs = null;
  if (opts.latency) {
    var cachedLatency = cacheGet("latency", TTL.latency);
    if (typeof cachedLatency === "number") {
      latencyMs = cachedLatency;
    } else {
      latencyMs = await measureLatency(opts.latencyNode || "", 2500);
      if (typeof latencyMs === "number") cacheSet("latency", latencyMs);
    }
  }

  var details = [];
  for (var d = 0; d < picks.length; d++) {
    var gname = picks[d];
    details.push({
      group: gname,
      selected: policySelect[gname] || "",
      inferred: !!inferred[gname],
      candidate_count: (subPolicies[gname] || []).length,
      candidates: (subPolicies[gname] || []).slice(0, 40),
    });
  }

  return {
    running_model: runningModel,
    running_mode: mode,
    mode_label: MODE_LABELS[mode],
    policy_group_count: allGroups.length,
    all_policy_groups: allGroups,
    policy_select: policySelect,
    sub_policies: subPolicies,
    groups: details,
    inferred_select: inferred,
    sub_meta: subMeta,
    latency_ms: latencyMs,
    version: readRuntimeVersion(),
    ssid: cfg.ssid ? String(cfg.ssid) : "",
    final: cfg.final ? String(cfg.final) : "",
    global_proxy: cfg.global_proxy ? String(cfg.global_proxy) : "",
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 面板渲染

function clip(text, max) {
  var s = String(text || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** 22:07:03 这种格式，不依赖 Intl（部分 Loon 版本的 JSC 没有完整 ICU） */
function clockText() {
  var d = new Date();
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function renderPanel(snap, note) {
  var mode = snap.running_mode;
  var lines = [];

  var head = (MODE_BADGE[mode] || "🟢") + " " + (MODE_LABELS[mode] || "分流模式") +
    " · " + snap.policy_group_count + " 组";
  if (typeof snap.latency_ms === "number") head += " · ⏱ " + snap.latency_ms + " ms";
  lines.push(head);

  if (snap.groups.length > 0) {
    lines.push("────────");
    for (var i = 0; i < snap.groups.length; i++) {
      var g = snap.groups[i];
      var sel = g.selected || (g.candidate_count > 0 ? "（未记录）" : "—");
      lines.push("🏷 " + clip(g.group, 10) + " → " + clip(sel, 22));
    }
  } else {
    lines.push("未读到任何策略组");
  }

  var missing = 0;
  for (var j = 0; j < snap.groups.length; j++) {
    if (!snap.groups[j].selected) missing++;
  }
  if (missing > 0) lines.push("⚠️ " + missing + " 组未记录选择，已按候选列表推断");

  lines.push("────────");
  var tail = (snap.version ? "Loon " + snap.version : "Loon") + " · " + clockText();
  if (note) tail += " · " + note;
  lines.push(tail);

  return {
    title: "Loon",
    content: lines.join("\n"),
    icon: "gauge.with.dots.needle.67percent",
    "icon-color": MODE_COLOR[mode] || "#34C759",
  };
}

// ---------------------------------------------------------------- 桥接

function bridgeFailure(text) {
  var snap = {
    running_mode: "filter",
    policy_group_count: 0,
    groups: [],
    version: readRuntimeVersion(),
  };
  return {
    title: "Loon",
    content: "❌ " + text + "\n请确认脚本是通过 Loon 插件运行的",
    icon: "exclamationmark.triangle",
    "icon-color": "#FF3B30",
  };
}

async function handleSetMode(modeParam) {
  var cfg = readConfig();
  var current = typeof cfg.running_model === "number" ? cfg.running_model : 1;
  var result = { ok: false, changed: false, from: modeFromModel(current) };

  var target = modelFromMode(modeParam);
  if (String(modeParam).toLowerCase() === "next" || String(modeParam).toLowerCase() === "cycle") {
    target = (current + 1) % 3; // 0 直连 → 1 分流 → 2 代理 → 0
  }
  if (target < 0) {
    result.error = "无效的 mode：" + modeParam;
    return result;
  }

  var changed = false;
  try {
    if (hasLoonConfigApi() && typeof $config.setRunningModel === "function") {
      changed = $config.setRunningModel(target) === true;
    }
  } catch (e) {
    result.error = String(e);
  }

  result.ok = changed;
  result.changed = changed;
  result.running_model = target;
  result.running_mode = modeFromModel(target);
  result.mode_label = MODE_LABELS[result.running_mode];
  if (!changed && !result.error) result.error = "setRunningModel 返回 false（可能已在该模式或参数无效）";
  return result;
}

async function handleSetPolicy(policyParam, nodeParam) {
  var cfg = readConfig();
  var policySelect = readRecordedSelection(cfg);
  var groups = splitList(policyParam);
  var nodes = splitList(nodeParam);
  var result = { ok: false, changed: false, items: [] };

  if (groups.length === 0) { result.error = "缺少 policy 参数"; return result; }

  for (var i = 0; i < groups.length; i++) {
    var groupName = groups[i];
    var want = nodes[i] || nodes[0] || "";
    var item = { group: groupName, node: "", changed: false };

    if (!want) { item.error = "缺少 node 参数"; result.items.push(item); continue; }

    if (String(want).toLowerCase() === "next" || String(want).toLowerCase() === "cycle") {
      var current = policySelect[groupName] || readSelected(groupName) || "";
      var cached = cacheGet("sub:" + groupName, TTL.sub);
      var names = Array.isArray(cached) && cached.length > 0
        ? cached
        : (await fetchSubPolicies(groupName, 1500)).names;
      if (!names || names.length === 0) {
        item.error = "拿不到该组的候选节点";
        result.items.push(item);
        continue;
      }
      var idx = names.indexOf(current);
      var next = names[(idx + 1) % names.length];
      item.from = current;
      want = next;
    }

    try {
      if (hasLoonConfigApi() && typeof $config.setSelectPolicy === "function") {
        item.changed = $config.setSelectPolicy(groupName, want) === true;
      }
    } catch (e) {
      item.error = String(e);
    }
    item.node = want;
    result.items.push(item);
    if (item.changed) result.changed = true;
  }

  result.ok = result.changed;
  if (!result.changed && !result.error) {
    var firstErr = "";
    for (var k = 0; k < result.items.length; k++) {
      if (result.items[k].error) { firstErr = result.items[k].error; break; }
    }
    result.error = firstErr || "setSelectPolicy 全部返回 false";
  }
  return result;
}

function bridgeResponse(payload, status) {
  return {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify(payload),
  };
}

async function handleBridge(query, arg) {
  var action = query.action || "status";
  var payload = { ok: true, service: "loon", script: SCRIPT_VERSION };

  // 写操作：先做，再回报状态（小组件点一下就想要新状态）
  if (action === "set_mode") {
    var modeRes = await handleSetMode(query.mode || "");
    payload.ok = modeRes.ok;
    payload.action = "set_mode";
    payload.result = modeRes;
    if (!modeRes.ok) payload.error = modeRes.error;
  } else if (action === "set_policy") {
    var policyRes = await handleSetPolicy(query.policy || "", query.node || "");
    payload.ok = policyRes.ok;
    payload.action = "set_policy";
    payload.result = policyRes;
    if (!policyRes.ok) payload.error = policyRes.error;
  } else if (action !== "status") {
    payload.ok = false;
    payload.error = "未知 action：" + action + "（可用 status / set_mode / set_policy）";
    return bridgeResponse(payload, 400);
  }

  if (action !== "status") {
    // 写操作后要给前端一份最新状态，但可以省掉候选节点探测
    var afterWrite = await buildSnapshot({
      groups: splitList(query.groups || arg.groups),
      maxGroups: 4,
      subTimeout: 600,
      fillSelect: true,
      includeSub: false,
      latency: false,
    });
    // 有些 Loon 版本 setRunningModel 之后 getConfig() 还没刷新，
    // 直接用本次写入的目标值覆盖，保证前端拿到的是「刚切过去的模式」
    if (payload.action === "set_mode" && payload.result && payload.result.changed) {
      afterWrite.running_model = payload.result.running_model;
      afterWrite.running_mode = payload.result.running_mode;
      afterWrite.mode_label = payload.result.mode_label;
    }
    if (payload.action === "set_policy" && payload.result && payload.result.changed) {
      var items = payload.result.items || [];
      for (var s = 0; s < items.length; s++) {
        if (items[s].changed && items[s].node) afterWrite.policy_select[items[s].group] = items[s].node;
      }
    }
    payload.status = afterWrite;
    if (query.debug === "1") payload.status.sub_meta = afterWrite.sub_meta;
    return bridgeResponse(payload);
  }

  var latencyOn = argBool(query.latency, false);
  var snap = await buildSnapshot({
    groups: splitList(query.groups || arg.groups),
    maxGroups: 4,
    subTimeout: Number(query.sub_timeout) > 0 ? Number(query.sub_timeout) : 1500,
    fillSelect: query.select !== "0",
    includeSub: true,
    latency: latencyOn,
  });

  // 兼容 DashBoard-Kit 小组件原有的字段命名
  payload.running_model = snap.running_model;
  payload.running_mode = snap.running_mode;
  payload.mode_label = snap.mode_label;
  payload.policy_select = snap.policy_select;
  payload.all_policy_groups = snap.all_policy_groups;
  payload.policy_group_count = snap.policy_group_count;
  payload.sub_policies = snap.sub_policies;
  payload.groups = snap.groups;
  payload.selected_policy_inferred = snap.inferred_select;
  payload.latency_ms = snap.latency_ms;
  payload.version = snap.version ? "Loon " + snap.version : "Loon";
  payload.ssid = snap.ssid;
  payload.final = snap.final;
  payload.global_proxy = snap.global_proxy;
  payload.timestamp = Date.now();

  if (query.debug === "1") {
    payload.sub_meta = snap.sub_meta;
    payload.config_api_keys = (function () {
      try { return Object.keys($config || {}); } catch (e) { return []; }
    })();
    payload.config_obj_keys = Object.keys(readConfig() || {});
  }
  return bridgeResponse(payload);
}

// ---------------------------------------------------------------- 入口

var finished = false;

function finishBridge(body) {
  if (finished) return;
  finished = true;
  try { $done({ response: body }); } catch (e) { log("$done 失败", e); }
}

function finishPanel(card) {
  if (finished) return;
  finished = true;
  try { $done(card); } catch (e) { log("$done 失败", e); }
}

function isBridgeRequest() {
  try {
    return typeof $request !== "undefined" && $request && typeof $request.url === "string" &&
      /\/loon-bridge(\?|$)/.test($request.url);
  } catch (e) { return false; }
}

(async function main() {
  var arg = readArgument();
  var bridge = isBridgeRequest();
  var query = bridge ? parseQuery($request.url) : {};

  // 硬 watchdog：Loon 侧请求超时后会把脚本再跑一遍，所以宁可提前给个结果
  var budget = bridge
    ? Math.max(2000, Math.min(15000, (Number(query.sub_timeout) || 1500) + 4000))
    : 12000;
  var watchdog = setTimeout(function () {
    if (bridge) {
      finishBridge(bridgeResponse({ ok: false, service: "loon", error: "脚本采集超时" }, 504));
    } else {
      finishPanel(bridgeFailure("采集超时（" + Math.round(budget / 1000) + "s）"));
    }
  }, budget);

  try {
    if (bridge) {
      var body = await handleBridge(query, arg);
      clearTimeout(watchdog);
      finishBridge(body);
      return;
    }

    if (!hasLoonConfigApi()) {
      clearTimeout(watchdog);
      finishPanel(bridgeFailure("读不到 $config"));
      return;
    }

    var snap = await buildSnapshot({
      groups: splitList(arg.groups),
      maxGroups: 4,
      subTimeout: 1500,
      fillSelect: true,
      includeSub: true,
      latency: argBool(arg.latency, true),
    });
    clearTimeout(watchdog);
    finishPanel(renderPanel(snap, ""));
  } catch (err) {
    clearTimeout(watchdog);
    log("运行失败:", String(err));
    if (bridge) {
      finishBridge(bridgeResponse({ ok: false, service: "loon", error: String(err) }, 500));
    } else {
      finishPanel(bridgeFailure(String(err && err.message ? err.message : err)));
    }
  }
})();
