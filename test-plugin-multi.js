/**
 * 插件 ↔ 脚本联调测试：把 policy-multi.plugin 的默认参数代进 [Script] 行，
 * 再用模拟的 Loon 运行时跑一遍 switch-multi.js。
 * 运行：node test-plugin.js
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
    const kind = rest.slice(0, rest.indexOf(",")).trim();
    rest = rest.slice(rest.indexOf(",") + 1);
    // input/select 取第一个引号里的默认值（select 即第一个候选项）；switch 取裸值
    const m = rest.match(/"([^"]*)"/);
    const bare = rest.split(",")[0].trim();
    args[name] = { kind, def: kind === "switch" ? bare.replace(/"/g, "") : (m ? m[1] : "") };
  }
  if (sec === "[Script]") scriptLines.push(s);
});

console.log("参数:", Object.keys(args).join(", "));
ok(Object.keys(args).length === 10, "① 参数数量为 10", Object.keys(args).length);
ok(args.slot2Set.def === "off" && args.slot4Set.def === "off", "② 未启用时段默认为 off");

// ---- 代入 ${param} ----
function fill(line) {
  return line.replace(/\$\{(\w+)\}/g, (m, k) => (args[k] ? args[k].def : m));
}

const filled = scriptLines.map(fill);
filled.forEach(l => ok(!/\$\{/.test(l), "③ 占位符全部替换: " + l.slice(0, 40)));

// ---- 取出 script(...) 的参数并跑 ----
function argOf(line) {
  // Loon 把 ${name} 展开成 "name: 值"，所以这里按未替换的行取参数名
  const m = line.match(/script\("([^"]+)",?\s*\{(.*?)\}\)/);
  if (!m) return null;
  const keys = Array.from(m[2].matchAll(/\$\{(\w+)\}/g)).map(x => x[1]);
  const obj = {};
  keys.forEach(k => {
    const a = args[k];
    if (!a) return;
    obj[k] = a.kind === "switch" ? a.def === "true" : a.def;
  });
  return { url: m[1], obj };
}

function runOne(obj, selected) {
  const notices = [];
  const subs = {
    "综合利用EMBY4837": ["DIRECT", "Matrix", "吹雪云观影组"],
    "吹雪云观影组": ["DIRECT", "吹雪云"]
  };
  const sandbox = {
    $argument: obj,
    $config: {
      getConfig: () => JSON.stringify({ all_policy_groups: Object.keys(subs) }),
      getSelectedPolicy: g => selected[g] || "",
      getSubPolicies: (g, cb) => cb(JSON.stringify(subs[g] || [])),
      setSelectPolicy: (a, b) => {
        if (Array.isArray(a)) {
          let allOk = true;
          a.forEach((g, i) => {
            if (!(subs[g] || []).includes(b[i])) allOk = false;
            else selected[g] = b[i];
          });
          return allOk;
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
  return { selected, notices };
}

const timeLine = scriptLines.find(l => l.startsWith("cron") && l.includes("准点切换①"));
const t1 = argOf(timeLine);
ok(t1 && t1.url.includes("switch-multi.js"), "④ 时段① 能解析出脚本与参数");

const r1 = runOne(t1.obj, { "综合利用EMBY4837": "DIRECT", "吹雪云观影组": "DIRECT" });
eq(r1.selected["综合利用EMBY4837"], "Matrix", "⑤ 按时段① 默认值切到 Matrix");
ok(r1.notices.length === 1 && r1.notices[0].t === "策略已切换", "⑤ 发成功通知");

// 时段②（off）不应切换
const t2 = argOf(scriptLines.find(l => l.includes("准点切换②")));
const r2 = runOne(t2.obj, { "综合利用EMBY4837": "Matrix" });
eq(r2.selected["综合利用EMBY4837"], "Matrix", "⑥ 时段② off 不做任何切换");
eq(r2.notices.length, 0, "⑥ 时段② 不通知");

// 时段③ 默认切到 吹雪云观影组（同组内子策略）
const t3 = argOf(scriptLines.find(l => l.includes("准点切换③")));
const r3 = runOne(t3.obj, { "综合利用EMBY4837": "Matrix" });
eq(r3.selected["综合利用EMBY4837"], "吹雪云观影组", "⑦ 时段③ 默认切到 吹雪云观影组");

// 策略工具
const g = scriptLines.find(l => l.startsWith("generic"));
const gt = argOf(g);
ok(gt && gt.obj.toolAction === "列出策略组", "⑧ 策略工具默认动作是列出策略组");
const rt = runOne(gt.obj, { "综合利用EMBY4837": "Matrix" });
ok(/策略组一览（2）/.test(rt.notices[0].t), "⑧ 工具能列出策略组", rt.notices[0].t);

// 每条 cron 都必须是 5 段
filled.filter(l => l.startsWith("cron")).forEach(l => {
  const m = l.match(/\$\{[^}]+\}|^cron ([^ ]+)/);
  const cron = l.match(/^cron ([0-9*\/,\- ]+) then/);
  ok(cron && cron[1].trim().split(/\s+/).length === 5, "⑨ cron 为 5 段: " + (cron ? cron[1] : l));
});

setTimeout(() => {
  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) { errs.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
  console.log("插件与脚本联调通过 ✅");
}, 50);
