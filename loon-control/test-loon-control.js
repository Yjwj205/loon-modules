/**
 * loon-control.js 本地测试（Node，mock Loon 运行时）
 * 运行：node test-loon-control.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "loon-control.js"), "utf8");

let pass = 0, fail = 0;
const fails = [];

function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (extra ? " → " + extra : "")); }
}

function eq(a, b, name) {
  ok(a === b, name, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * 运行一次脚本，返回 { done, logs, calls }
 */
async function run({ config, request, argument, store, http, api = {}, waitMs = 3000 }) {
  const logs = [];
  const calls = { setRunningModel: [], setSelectPolicy: [], getSubPolicies: [], getConfig: 0, http: [] };
  let doneArg = null;
  let doneCount = 0;

  const cfg = {};
  if (config !== undefined && config !== null) {
    cfg.getConfig = () => {
      calls.getConfig++;
      return typeof config === "string" ? config : JSON.stringify(config);
    };
    cfg.getSelectedPolicy = (name) => {
      const v = (config.policy_select || {})[name];
      return v === undefined || v === null ? "" : JSON.stringify(v);
    };
    cfg.getSubPolicies = (name, cb) => {
      calls.getSubPolicies.push(name);
      const list = (api.subPolicies || {})[name] || [];
      if (api.neverCallBack) return;
      setTimeout(() => cb(JSON.stringify(list.map(n => ({ type: "url-test", name: n })))), 1);
    };
    cfg.setSelectPolicy = (group, node) => {
      calls.setSelectPolicy.push([group, node]);
      if (api.setSelectPolicyResult === false) return false;
      return true;
    };
    cfg.setRunningModel = (m) => {
      calls.setRunningModel.push(m);
      return api.setRunningModelResult !== false;
    };
  }

  const storeMap = store || {};
  const ctx = {
    console: { log: (...a) => logs.push(a.map(String).join(" ")) },
    setTimeout, clearTimeout,
    Promise, JSON, Math, Date, Number, String, Object, Array, RegExp, Boolean, Error,
    decodeURIComponent, encodeURIComponent, isNaN, parseInt, parseFloat,
    $persistentStore: {
      read: (k) => (k in storeMap ? storeMap[k] : null),
      write: (v, k) => { storeMap[k] = String(v); return true; },
    },
    $done: (arg) => { doneCount++; doneArg = arg; },
    $loon: "Loon/3.5.1 (983)",
  };
  if (config !== undefined && config !== null) ctx.$config = cfg;
  if (request) ctx.$request = { url: request, method: "GET" };
  if (argument !== undefined) ctx.$argument = argument;
  ctx.$httpClient = {
    get: (opts, cb) => {
      calls.http.push(opts && opts.url ? opts.url : String(opts));
      if (http && http.fail) { setTimeout(() => cb("timeout", null, ""), 1); return; }
      const delay = (http && http.delay) || 40;
      setTimeout(() => cb(null, { status: 204, headers: {} }, ""), delay);
    },
  };

  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: "loon-control.js" });

  const deadline = Date.now() + waitMs;
  while (doneArg === null && Date.now() < deadline) await sleep(10);
  // 再等一下，确认没有第二次 $done
  await sleep(60);
  return { done: doneArg, doneCount, logs, calls, store: storeMap };
}

function panelJson(done) { return done; }
function bridgeJson(done) {
  if (!done || !done.response) return null;
  try { return JSON.parse(done.response.body); } catch (e) { return null; }
}

const BASE_CONFIG = {
  running_model: 1,
  all_policy_groups: ["节点选择", "国外网站", "流媒体", "漏网之鱼", "广告拦截"],
  policy_select: { "节点选择": "🇭🇰 香港 01", "广告拦截": "REJECT" },
  final: "漏网之鱼",
  ssid: "loon-wifi",
};

const SUBS = {
  "节点选择": ["DIRECT", "🇭🇰 香港 01", "🇯🇵 东京 02"],
  "国外网站": ["🇭🇰 香港 01", "🇸🇬 狮城 03"],
  "流媒体": ["🇯🇵 东京 02", "🇺🇸 洛杉矶 04"],
  "漏网之鱼": ["节点选择", "DIRECT"],
  "广告拦截": ["REJECT", "DIRECT"],
};

(async function main() {
  // ---------- 1. 面板卡片 ----------
  {
    const r = await run({ config: BASE_CONFIG, argument: { groups: "", latency: "true" }, api: { subPolicies: SUBS } });
    const card = panelJson(r.done);
    ok(!!card, "面板：返回卡片");
    eq(card.title, "Loon", "面板：标题");
    ok(/分流模式/.test(card.content), "面板：显示运行模式", card.content);
    ok(/5 组/.test(card.content), "面板：策略组数", card.content);
    ok(card.content.includes("节点选择"), "面板：显示策略组", card.content);
    ok(card.content.includes("🇭🇰 香港 01"), "面板：显示选中节点", card.content);
    ok(/ms/.test(card.content), "面板：显示延迟", card.content);
    ok(card.content.includes("Loon 3.5.1"), "面板：显示真实版本号", card.content);
    eq(card["icon-color"], "#34C759", "面板：分流模式配色");
    eq(card.icon, "gauge.with.dots.needle.67percent", "面板：图标");
    eq(r.doneCount, 1, "面板：$done 只调用一次");
    ok(!/剩余流量|总额|到期/.test(card.content), "面板：不含订阅流量字段");
    ok(r.calls.getConfig === 1, "面板：getConfig 只读一次", String(r.calls.getConfig));
    ok(r.calls.getSubPolicies.length <= 4, "面板：最多探 4 个策略组", r.calls.getSubPolicies.join(","));
  }

  // ---------- 2. 推断选中值（跳过 DIRECT） ----------
  {
    const r = await run({ config: BASE_CONFIG, argument: { groups: "", latency: "false" }, api: { subPolicies: SUBS } });
    const card = panelJson(r.done);
    ok(/国外网站 → 🇭🇰 香港 01/.test(card.content), "推断：国外网站取候选第一个", card.content);
    ok(/流媒体 → 🇯🇵 东京 02/.test(card.content), "推断：流媒体取候选第一个", card.content);
    ok(!r.calls.http.length, "延迟关闭时不发请求", r.calls.http.join(","));
  }

  // ---------- 3. 记忆缓存的组不重复探测 ----------
  {
    const store = {};
    await run({ config: BASE_CONFIG, argument: { groups: "", latency: "false" }, api: { subPolicies: SUBS }, store });
    const second = await run({ config: BASE_CONFIG, argument: { groups: "", latency: "false" }, api: { subPolicies: SUBS }, store });
    ok(second.calls.getSubPolicies.length === 0, "缓存：第二轮不再调 getSubPolicies", second.calls.getSubPolicies.join(","));
    ok(/流媒体/.test(panelJson(second.done).content), "缓存：命中后仍能显示");
  }

  // ---------- 4. 桥接 status ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=status&sub_timeout=1500",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    ok(!!j, "桥接：返回 JSON");
    eq(j.ok, true, "桥接：ok=true");
    eq(j.running_model, 1, "桥接：running_model");
    eq(j.running_mode, "filter", "桥接：running_mode");
    eq(j.policy_select["节点选择"], "🇭🇰 香港 01", "桥接：policy_select");
    ok(Array.isArray(j.sub_policies["节点选择"]) && j.sub_policies["节点选择"].length === 3, "桥接：sub_policies 为纯名字数组");
    ok(j.all_policy_groups.length === 5, "桥接：all_policy_groups");
    eq(j.policy_group_count, 5, "桥接：policy_group_count");
    eq(j.sub_meta, undefined, "桥接：默认不带调试字段");
    ok(/Loon 3\.5\.1/.test(j.version), "桥接：版本号带 Loon 前缀", j.version);
    eq(r.doneCount, 1, "桥接：$done 只调用一次");
    eq(r.done.response.status, 200, "桥接：HTTP 200");
  }

  // ---------- 5. 桥接 debug=1 ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=status&debug=1",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    ok(!!j.sub_meta, "debug=1：带 sub_meta");
    ok(Array.isArray(j.config_api_keys), "debug=1：带 config_api_keys");
    ok(Array.isArray(j.config_obj_keys), "debug=1：带 config_obj_keys");
  }

  // ---------- 6. 桥接 set_mode next ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_mode&mode=next",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    eq(j.ok, true, "set_mode：ok");
    eq(r.calls.setRunningModel[0], 2, "set_mode：分流(1) 的 next 是全局代理(2)");
    eq(j.result.running_mode, "all_proxy", "set_mode：回报新模式");
    eq(j.status.running_mode, "all_proxy", "set_mode：附带最新状态");
  }

  // ---------- 7. 桥接 set_mode 直连/无效 ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_mode&mode=direct",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    eq(r.calls.setRunningModel[0], 0, "set_mode：direct → 0");
  }
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_mode&mode=fly",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    eq(j.ok, false, "set_mode：无效参数 ok=false");
    eq(r.done.response.status, 200, "set_mode：无效参数仍返回 200 JSON（前端好处理）");
    ok(/无效/.test(j.error || ""), "set_mode：给出错误原因", j.error);
  }

  // ---------- 8. 桥接 set_policy 指定节点 ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_policy&policy=" + encodeURIComponent("节点选择") + "&node=" + encodeURIComponent("🇯🇵 东京 02"),
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    eq(j.ok, true, "set_policy：ok");
    eq(r.calls.setSelectPolicy[0][0], "节点选择", "set_policy：组名");
    eq(r.calls.setSelectPolicy[0][1], "🇯🇵 东京 02", "set_policy：节点名");
  }

  // ---------- 9. 桥接 set_policy node=next ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_policy&policy=" + encodeURIComponent("节点选择") + "&node=next",
      api: { subPolicies: SUBS },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    eq(r.calls.setSelectPolicy[0][1], "🇯🇵 东京 02", "set_policy next：香港 01 的下一个是东京 02");
    eq(j.result.items[0].from, "🇭🇰 香港 01", "set_policy next：回报切换前节点");
  }

  // ---------- 10. set_policy 失败要如实报错 ----------
  {
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=set_policy&policy=" + encodeURIComponent("节点选择") + "&node=xxx",
      api: { subPolicies: SUBS, setSelectPolicyResult: false },
      waitMs: 4000,
    });
    const j = bridgeJson(r.done);
    eq(j.ok, false, "set_policy 失败：ok=false");
    ok(/setSelectPolicy/.test(j.error || ""), "set_policy 失败：说明原因", j.error);
  }

  // ---------- 11. 未知 action ----------
  {
    const r = await run({ config: BASE_CONFIG, request: "http://1.1.1.1/loon-bridge?action=boom", api: { subPolicies: SUBS }, waitMs: 4000 });
    eq(r.done.response.status, 400, "未知 action：400");
    eq(bridgeJson(r.done).ok, false, "未知 action：ok=false");
  }

  // ---------- 12. getSubPolicies 永远不回调，不能卡住 ----------
  {
    const t0 = Date.now();
    const r = await run({
      config: BASE_CONFIG,
      request: "http://1.1.1.1/loon-bridge?action=status&sub_timeout=600",
      api: { neverCallBack: true },
      waitMs: 6000,
    });
    const cost = Date.now() - t0;
    ok(bridgeJson(r.done).ok === true, "死回调：仍然返回状态");
    ok(cost < 4000, "死回调：不超时太久（" + cost + "ms）");
  }

  // ---------- 13. 没有 $config 时面板给红卡 ----------
  {
    const r = await run({ config: undefined, argument: {} });
    const card = panelJson(r.done);
    ok(card && /❌/.test(card.content), "无 $config：给错误卡片", JSON.stringify(card));
    eq(card["icon-color"], "#FF3B30", "无 $config：红色");
    eq(r.doneCount, 1, "无 $config：$done 只调用一次");
  }

  // ---------- 14. 延迟请求失败不影响面板 ----------
  {
    const r = await run({ config: BASE_CONFIG, argument: { latency: "true" }, api: { subPolicies: SUBS }, http: { fail: true } });
    const card = panelJson(r.done);
    ok(!/ms/.test(card.content), "延迟失败：面板里不显示 ms", card.content);
    ok(/分流模式/.test(card.content), "延迟失败：其余信息照常");
  }

  // ---------- 15. $argument 为 JSON 字符串 / 对象两种形态 ----------
  {
    const r = await run({ config: BASE_CONFIG, argument: JSON.stringify({ groups: "广告拦截", latency: "false" }), api: { subPolicies: SUBS } });
    const card = panelJson(r.done);
    ok(/广告拦截 → REJECT/.test(card.content), "参数：字符串形式生效", card.content);
    ok(!/节点选择/.test(card.content), "参数：指定组后只显示该组", card.content);
  }

  // ---------- 16. 全局代理配色 + 模式标签 ----------
  {
    const cfg = Object.assign({}, BASE_CONFIG, { running_model: 2 });
    const r = await run({ config: cfg, argument: { latency: "false" }, api: { subPolicies: SUBS } });
    const card = panelJson(r.done);
    ok(/全局代理/.test(card.content), "模式：全局代理");
    eq(card["icon-color"], "#8B5CF6", "模式：全局代理配色");
  }

  // ---------- 17. getConfig 返回非法 JSON 时不能崩 ----------
  {
    const r = await run({ config: "not-json", argument: { latency: "false" }, api: { subPolicies: SUBS }, waitMs: 2000 });
    ok(!!r.done, "坏配置：仍然有输出");
    eq(r.doneCount, 1, "坏配置：$done 只调用一次");
  }

  // ---------- 18. policy_select 里的 "null" 字符串要过滤掉 ----------
  {
    const cfg = Object.assign({}, BASE_CONFIG, { policy_select: { "节点选择": "null", "广告拦截": "REJECT" } });
    const r = await run({ config: cfg, request: "http://1.1.1.1/loon-bridge?action=status", api: { subPolicies: SUBS }, waitMs: 4000 });
    const j = bridgeJson(r.done);
    eq(j.policy_select["节点选择"], "🇭🇰 香港 01", "null 字符串：用候选列表推断出真实节点", j.policy_select["节点选择"]);
  }

  // ---------- 19. 订阅相关关键字彻底消失 ----------
  {
    ok(!/fetchSubscriptionUserinfo|parseSubscriptionUserinfo|subscription-userinfo"\s*\]/i.test(SRC),
      "源码：没有订阅流量解析函数");
    ok(!/remainGb|totalGb|remainPct|expireText/.test(SRC), "源码：没有剩余流量/总额/到期字段");
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log("失败项：");
    fails.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
})();
