/**
 * 点选版联调：读取生成的 policy-select.plugin，把参数代进 cron 行，用模拟 Loon 跑一次
 * 运行：node test-select.js
 */

const fs = require("fs");
const vm = require("vm");

const plugin = fs.readFileSync(__dirname + "/policy-select.plugin", "utf8");
const SRC = fs.readFileSync(__dirname + "/switch-multi.js", "utf8");

let pass = 0, fail = 0;
const errs = [];
function ok(c, n, x) { if (c) pass++; else { fail++; errs.push(n + (x ? "  → " + x : "")); } }
function eq(a, b, n) { ok(JSON.stringify(a) === JSON.stringify(b), n, "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); }

// 解析参数与脚本行
const args = {}, lines = [];
let sec = null;
plugin.split("\n").forEach(l => {
  const s = l.trim();
  if (!s || s.startsWith("#!")) return;
  if (/^\[.+\]$/.test(s)) { sec = s; return; }
  if (sec === "[Argument]") {
    const name = s.split("=")[0].trim();
    let rest = s.slice(s.indexOf("=") + 1).trim();
    const kind = rest.slice(0, Math.max(rest.indexOf(","), 0)).trim();
    args[name] = { kind, line: s };
  }
  if (sec === "[Script]") lines.push(s);
});

const amLine = lines.find(l => l.includes("早上切换"));
const pmLine = lines.find(l => l.includes("晚上切换"));
ok(!!amLine && !!pmLine, "① 生成早上/晚上两条 cron");

function keysOf(line) {
  const m = line.match(/script\("([^"]+)",?\s*\{(.*?)\}\)/);
  return m ? Array.from(m[2].matchAll(/\$\{(\w+)\}/g)).map(x => x[1]) : [];
}

// 模拟：①组选 A 组，早上切 Matrix；②组选 B 组，早上切 HK
const subs = { "综合利用EMBY4837": ["DIRECT", "Matrix"], "吹雪云观影组": ["DIRECT", "HK", "吹雪云"] };

function run(line, values) {
  const keys = keysOf(line);
  const arg = {};
  keys.forEach(k => { if (values[k] !== undefined) arg[k] = values[k]; else if (k === "amTime") arg[k] = "0 9 * * *"; else if (k === "pmTime") arg[k] = "0 19 * * *"; });
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
    $notification: { post: (t, s, b) => notices.push(t) },
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

const am = run(amLine, { g1: "综合利用EMBY4837", g1am: "Matrix", g2: "吹雪云观影组", g2am: "HK", g3: "（不用）", g3am: "x" });
eq(am.selected["综合利用EMBY4837"], "Matrix", "② ①组早上切到 Matrix");
eq(am.selected["吹雪云观影组"], "HK", "③ ②组早上切到 HK");
ok(!("x" in am.selected), "④ 「（不用）」的段被跳过");
ok(am.notices[0] === "策略已切换", "⑤ 发出成功通知", am.notices[0]);

const pm = run(pmLine, { g1: "综合利用EMBY4837", g1pm: "DIRECT", g2: "吹雪云观影组", g2pm: "吹雪云", g3: "（不用）", g3pm: "" });
eq(pm.selected["综合利用EMBY4837"], "DIRECT", "⑥ 晚上用 gNpm 而不是 gNam");
eq(pm.selected["吹雪云观影组"], "吹雪云", "⑦ 晚上第二段生效");

// 空格/全角差异也能匹配（截图 OCR 或手输多空格）
const sp = run(amLine, { g1: "综合利用 EMBY4837", g1am: "Matrix", g2: "HKS 组", g2am: "HK", g3: "（不用）" });
eq(sp.selected["综合利用EMBY4837"], "Matrix", "⑨ 组名带空格也能对上");

const empty = run(amLine, { g1: "（不用）", g1am: "", g2: "（不用）", g2am: "", g3: "（不用）", g3am: "" });
eq(empty.notices.length, 0, "⑧ 全空时不发通知");

console.log("\n通过 " + pass + " / 失败 " + fail);
if (fail) { errs.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
console.log("点选版联调通过 ✅");
