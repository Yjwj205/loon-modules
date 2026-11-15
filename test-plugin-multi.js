/**
 * 插件 ↔ 脚本联调：把 policy-multi.plugin 的默认参数代进每条 [Script] 行，
 * 用模拟的 Loon 运行时跑 switch-multi.js。
 * 运行：node test-plugin-multi.js
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const plugin = fs.readFileSync(path.join(__dirname, "policy-multi.plugin"), "utf8");
const SRC = fs.readFileSync(path.join(__dirname, "switch-multi.js"), "utf8");

let pass = 0, fail = 0;
const errs = [];
function ok(c, n, x) { if (c) pass++; else { fail++; errs.push(n + (x ? "  → " + x : "")); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n, "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); }

// ---- 解析插件 ----
const args = {}, scriptLines = [];
let sec = null;
plugin.split("\n").forEach(line => {
  const s = line.trim();
  if (!s || s.startsWith("#!")) return;
  if (/^\[.+\]$/.test(s)) { sec = s; return; }
  if (sec === "[Argument]") {
    const name = s.split("=")[0].trim();
    let rest = s.slice(s.indexOf("=") + 1).trim();
    const kind = rest.slice(0, Math.max(rest.indexOf(","), 0)).trim();
    rest = rest.slice(rest.indexOf(",") + 1);
    const m = rest.match(/"([^"]*)"/);
    const bare = rest.split(",")[0].trim();
    args[name] = { kind, def: kind === "switch" ? bare.replace(/"/g, "") : (m ? m[1] : "") };
  }
  if (sec === "[Script]") scriptLines.push(s);
});

ok(Object.keys(args).length === 25, "① 参数 25 个（4 段 × 6 + 通知）", Object.keys(args).length);
ok(args.g1.def === "" && args.v1a.def === "" && args.v1b.def === "", "② 组名与目标默认留空，不预置任何人的组名");
ok(args.t1a.def === "0 9 * * *" && args.t1b.def === "0 19 * * *", "③ 默认时间参数有效");
ok(["e1","e2","e3","e4"].every(k => args[k] && args[k].kind === "switch" && args[k].def === "false"),
  "③ 四段启用开关默认关闭（不执行任何 cron）");

const cronLines = scriptLines.filter(l => l.startsWith("cron"));
ok(cronLines.length === 8, "④ 4 段 × 2 个时间 = 8 条 cron", cronLines.length);
ok(!scriptLines.some(l => l.startsWith("generic")), "④ 不再有 generic 脚本（方案工具已删除）");

cronLines.forEach(l => {
  const filled = l.replace(/\$\{(\w+)\}/g, (m, k) => (args[k] ? args[k].def : m));
  const cron = filled.match(/^cron ([0-9*\/,\- ]+) then/);
  ok(cron && cron[1].trim().split(/\s+/).length === 5, "⑤ cron 为 5 段: " + (cron ? cron[1] : filled.slice(0, 40)));
});

// 每条 cron 只带本段的 gN 与 vNa / vNb
cronLines.forEach((l, i) => {
  const seg = Math.floor(i / 2) + 1;
  const tag = i % 2 === 0 ? "a" : "b";
  ok(l.includes("${g" + seg + "}"), "⑥ 第 " + (i + 1) + " 条带 g" + seg);
  ok(l.includes("${v" + seg + tag + "}"), "⑥ 第 " + (i + 1) + " 条带 v" + seg + tag);
  const other = seg === 1 ? 2 : 1;
  ok(!l.includes("${g" + other + "}"), "⑥ 第 " + (i + 1) + " 条不串段");
  ok(l.includes("enable=${e" + seg + "}"), "⑥ 第 " + (i + 1) + " 条受 e" + seg + " 开关控制");
});

// ---- 跑一次：代入默认值 ----
function keysOf(line) {
  const m = line.match(/script\("([^"]+)",?\s*\{(.*?)\}\)/);
  return m ? Array.from(m[2].matchAll(/\$\{(\w+)\}/g)).map(x => x[1]) : [];
}

const subs = {
  "综合利用EMBY4837": ["DIRECT", "Matrix", "吹雪云观影组"],
  "吹雪云观影组": ["DIRECT", "吹雪云"]
};

function run(line, override) {
  const arg = {};
  keysOf(line).forEach(k => {
    const v = override && override[k] !== undefined ? override[k] : (args[k] ? args[k].def : "");
    arg[k] = args[k] && args[k].kind === "switch" ? (v === true || v === "true") : v;
  });
  const selected = {};
  const notices = [];
  let done = 0;
  const sandbox = {
    $argument: arg,
    $config: {
      getConfig: () => JSON.stringify({ all_policy_groups: Object.keys(subs) }),
      getSelectedPolicy: g => selected[g] || "",
      getSubPolicies: (g, cb) => cb(JSON.stringify(subs[g] || [])),
      setSelectPolicy: (a, b) => {
        if (Array.isArray(a)) {
          a.forEach((g, i) => { if ((subs[g] || []).includes(b[i])) selected[g] = b[i]; });
          return true;
        }
        if (!(subs[a] || []).includes(b)) return false;
        selected[a] = b;
        return true;
      }
    },
    $notification: { post: (t, s, b) => notices.push({ t, s, b }) },
    $done: () => { done++; },
    console: { log: () => {} },
    setTimeout, clearTimeout, Date, JSON, Object, Array, String, Number, Math, parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "switch-multi.js" });
  return { selected, notices, done };
}

// 默认全空 → 到点什么都不做
const empty = run(cronLines[0]);
eq(empty.notices.length, 0, "⑦ 默认组名为空 → 静默");
eq(empty.done, 1, "⑦ 仍然正常结束");

const r1 = run(cronLines[0], { g1: "综合利用EMBY4837", v1a: "Matrix" });
eq(r1.selected["综合利用EMBY4837"], "Matrix", "⑧ ①段时间1 生效");
eq(r1.notices[0].t, "策略已切换", "⑧ 发出通知");

const r1b = run(cronLines[1], { g1: "综合利用EMBY4837", v1b: "吹雪云观影组" });
eq(r1b.selected["综合利用EMBY4837"], "吹雪云观影组", "⑨ ①段时间2 用 v1b");

const r2 = run(cronLines[2], { g2: "吹雪云观影组", v2a: "吹雪云" });
eq(r2.selected["吹雪云观影组"], "吹雪云", "⑩ ②段用 g2/v2a 生效");

const r3 = run(cronLines[4], { g3: "", v3a: "x" });
eq(r3.notices.length, 0, "⑪ ③段组名留空 → 静默");

setTimeout(() => {
  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) { errs.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
  console.log("插件与脚本联调通过 ✅");
}, 50);
