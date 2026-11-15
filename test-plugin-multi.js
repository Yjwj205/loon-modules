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

ok(Object.keys(args).length === 22, "① 参数 22 个（4 段 × 5 + 通知 + 工具）", Object.keys(args).length);
ok(args.g1.def === "综合利用EMBY4837" && args.v1a.def === "Matrix", "② ①段默认值正确");
ok(args.g2.def === "" && args.g3.def === "" && args.g4.def === "", "③ ②③④段默认留空");

const cronLines = scriptLines.filter(l => l.startsWith("cron"));
ok(cronLines.length === 8, "④ 4 段 × 2 个时间 = 8 条 cron", cronLines.length);

cronLines.forEach(l => {
  const filled = l.replace(/\$\{(\w+)\}/g, (m, k) => (args[k] ? args[k].def : m));
  const cron = filled.match(/^cron ([0-9*\/,\- ]+) then/);
  ok(cron && cron[1].trim().split(/\s+/).length === 5, "⑤ cron 为 5 段: " + (cron ? cron[1] : filled.slice(0, 40)));
});

// 每条 cron 只能带本段的 gN 与 vNa / vNb
cronLines.forEach((l, i) => {
  const seg = Math.floor(i / 2) + 1;
  const tag = i % 2 === 0 ? "a" : "b";
  ok(l.includes("${g" + seg + "}"), "⑥ 第 " + (i + 1) + " 条带 g" + seg);
  ok(l.includes("${v" + seg + tag + "}"), "⑥ 第 " + (i + 1) + " 条带 v" + seg + tag);
  ok(!l.includes("${g" + (seg === 1 ? 2 : 1) + "}"), "⑥ 第 " + (i + 1) + " 条不串段");
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
    if (args[k] && args[k].kind === "switch") arg[k] = v === true || v === "true";
    else arg[k] = v;
  });
  const selected = {};
  const notices = [];
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
    $persistentStore: { read: () => null, write: () => true },
    $done: () => {},
    console: { log: () => {} },
    setTimeout, clearTimeout, Date, JSON, Object, Array, String, Number, Math, parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "switch-multi.js" });
  return { selected, notices, arg };
}

const r1 = run(cronLines[0]); // ① 时间1 = Matrix
eq(r1.selected["综合利用EMBY4837"], "Matrix", "⑦ ①段时间1 切到 Matrix");
ok(r1.notices.length === 1 && r1.notices[0].t === "策略已切换", "⑦ 发出通知", JSON.stringify(r1.notices[0] && r1.notices[0].t));

const r1b = run(cronLines[1]); // ① 时间2 = 吹雪云观影组
eq(r1b.selected["综合利用EMBY4837"], "吹雪云观影组", "⑧ ①段时间2 切到 吹雪云观影组");

const r2 = run(cronLines[2]); // ② 默认组名空
eq(Object.keys(r2.selected).length, 0, "⑨ ②段组名为空时什么都不做");
eq(r2.notices.length, 0, "⑨ ②段不通知");

const r2x = run(cronLines[2], { g2: "吹雪云观影组", v2a: "吹雪云" });
eq(r2x.selected["吹雪云观影组"], "吹雪云", "⑩ 填了组名与目标就生效");

const r2y = run(cronLines[3], { g2: "吹雪云观影组", v2b: "" });
eq(r2y.notices.length, 0, "⑪ 目标留空时不切换、不通知");

// 策略工具
const g = scriptLines.find(l => l.startsWith("generic"));
const rt = run(g);
ok(/策略组一览（2）/.test(rt.notices[0].t), "⑫ 策略工具能列出策略组", rt.notices[0].t);

setTimeout(() => {
  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) { errs.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
  console.log("插件与脚本联调通过 ✅");
}, 50);
