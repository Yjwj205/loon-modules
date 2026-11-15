/**
 * switch-multi.js 单元测试（Node + vm 模拟 Loon 运行时）
 * 运行：node test-switch-multi.js
 */

const fs = require("fs");
const vm = require("vm");

const SRC = fs.readFileSync(__dirname + "/switch-multi.js", "utf8");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? "  → " + extra : "")); }
}
function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), name,
    "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a));
}

const DEFAULT_GROUPS = ["综合利用EMBY4837", "吹雪云观影组", "影视"];
const DEFAULT_SUBS = {
  "综合利用EMBY4837": ["DIRECT", "Matrix", "香港01", "日本02"],
  "吹雪云观影组": ["DIRECT", "吹雪云", "Matrix"],
  "影视": ["DIRECT", "HK", "US"]
};

function run(argument, opts) {
  opts = opts || {};
  const selected = Object.assign({}, opts.selected || {});
  const notices = [];
  const st = { done: 0 };
  const groups = opts.groups === undefined ? DEFAULT_GROUPS : opts.groups;
  const subs = opts.subs || DEFAULT_SUBS;

  const sandbox = {
    $argument: argument,
    $config: {
      getConfig() {
        const cfg = { running_model: 1 };
        if (!opts.noGroupApi) cfg.all_policy_groups = groups;
        return JSON.stringify(cfg);
      },
      getSelectedPolicy(g) { return selected[g] || ""; },
      getSubPolicies(g, cb) {
        const payload = JSON.stringify(subs[g] || []);
        if (opts.syncSubs === false) setTimeout(() => cb(payload), 1);
        else cb(payload);
      },
      setSelectPolicy(a, b) {
        if (opts.batchUnsupported && Array.isArray(a)) throw new Error("batch unsupported");
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
    $notification: { post(t, s, b) { notices.push({ t, s, b }); } },
    $done() { st.done++; },
    $loon: "Loon 3.5.4 (988)",
    console: { log() {} },
    setTimeout, clearTimeout, Date, JSON, Object, Array, String, Number, Math, parseInt
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "switch-multi.js" });

  const out = { selected, notices, st };
  Object.defineProperty(out, "doneCount", { get() { return st.done; } });
  return out;
}

// ------------------------------------------------------ ① 关键字
(() => {
  const r = run({ g1: "EMBY", v1a: "Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "① 组与目标都可用关键字");
  eq(r.notices.length, 1, "① 发一条通知");
  eq(r.notices[0].t, "策略已切换", "① 标题正确");
  eq(r.doneCount, 1, "① $done 一次");
})();

// ------------------------------------------------------ ② 序号
(() => {
  const r = run({ g1: "3", v1a: "2", notify: true }, { selected: { "影视": "DIRECT" } });
  eq(r.selected["影视"], "HK", "② 组序号 3 + 目标序号 2");
})();

// ------------------------------------------------------ ③ 幂等
(() => {
  const r = run({ g1: "EMBY", v1a: "Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "Matrix" } });
  eq(r.notices.length, 0, "③ 已是目标不通知");
  eq(r.doneCount, 1, "③ 正常结束");
})();

// ------------------------------------------------------ ④ 组不存在
(() => {
  const r = run({ g1: "不存在的组", v1a: "Matrix", notify: true }, {});
  eq(r.notices[0].t, "策略切换失败", "④ 报失败");
  ok(/现有：/.test(r.notices[0].b), "④ 给出可选组", r.notices[0].b);
})();

// ------------------------------------------------------ ⑤ 目标不存在
(() => {
  const r = run({ g1: "EMBY", v1a: "没有这个节点", notify: true }, {});
  eq(r.notices[0].t, "策略切换失败", "⑤ 报失败");
  ok(/可选：/.test(r.notices[0].b), "⑤ 列出该组可选节点", r.notices[0].b);
})();

// ------------------------------------------------------ ⑥ 组名歧义
(() => {
  const r = run({ g1: "影", v1a: "HK", notify: true },
    { groups: ["影视1", "影视2"], subs: { "影视1": ["HK"], "影视2": ["HK"] } });
  eq(r.notices[0].t, "策略切换失败", "⑥ 报失败");
  ok(/匹配到 2 个/.test(r.notices[0].b), "⑥ 列出候选", r.notices[0].b);
})();

// ---------------------------------------------- ⑦ 组名为空 / 目标为空
(() => {
  const a = run({ g1: "", v1a: "Matrix", notify: true }, {});
  eq(a.notices.length, 0, "⑦ 组名为空 → 静默");
  eq(a.doneCount, 1, "⑦ 组名为空仍正常结束");

  const b = run({ g1: "EMBY", v1a: "", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(b.notices.length, 0, "⑦ 目标为空 → 静默");
  eq(b.selected["综合利用EMBY4837"], "DIRECT", "⑦ 目标为空不改动");
})();

// ------------------------------------------------------ ⑧ 关闭通知
(() => {
  const r = run({ g1: "EMBY", v1a: "Matrix", notify: false },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑧ 关闭通知仍然切换");
  eq(r.notices.length, 0, "⑧ 不发通知");
})();

// -------------------------------------- ⑨ 读不到组列表时按原样尝试
(() => {
  const r = run({ g1: "综合利用EMBY4837", v1a: "Matrix", notify: true },
    { noGroupApi: true, selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑨ 无 all_policy_groups 也能切");
})();

// ------------------------------------------------ ⑩ 引号/空格容错
(() => {
  const r = run({ g1: ' “综合利用 EMBY4837” ', v1a: ' "Matrix" ', notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑩ 多余引号与空格自动清理");
})();

// ------------------------------------------ ⑪ 批量 API 不可用时回退
(() => {
  const r = run({ g1: "EMBY", v1a: "Matrix", notify: true },
    { batchUnsupported: true, selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑪ 批量不支持时逐个重试");
})();

// -------------------------------------------- ⑫ 异步 getSubPolicies
let asyncCase = null;
(() => {
  asyncCase = run({ g1: "EMBY", v1a: "Matrix", notify: true },
    { syncSubs: false, selected: { "综合利用EMBY4837": "DIRECT" } });
})();

setTimeout(() => {
  eq(asyncCase && asyncCase.selected["综合利用EMBY4837"], "Matrix", "⑫ 异步回调也能完成切换");
  ok(asyncCase && asyncCase.doneCount === 1, "⑫ 异步场景 $done 一次");
  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) {
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log("全部通过 ✅");
}, 100);
