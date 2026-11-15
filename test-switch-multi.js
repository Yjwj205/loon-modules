/**
 * switch-multi.js 单元测试（Node + vm 模拟 Loon 运行时）
 * 运行：node test-switch.js
 */

const fs = require("fs");
const vm = require("vm");

const SRC = fs.readFileSync(__dirname + "/switch-multi.js", "utf8");

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? "  → " + extra : "")); }
}

function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), name, "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a));
}

/**
 * 构造一次执行环境
 * opts.groups          策略组数组（模拟 all_policy_groups）
 * opts.subs            组 → 子策略数组
 * opts.selected        组 → 当前选择
 * opts.noGroupApi      getConfig 里没有 all_policy_groups
 * opts.batchUnsupported setSelectPolicy 只接受单组两个字符串
 */
function run(argument, opts) {
  opts = opts || {};
  const selected = Object.assign({}, opts.selected || {});
  const notices = [];
  const st = { done: 0 };
  const store = Object.assign({}, opts.store || {});
  const groups = opts.groups === undefined ? ["综合利用EMBY4837", "吹雪云观影组", "影视"] : opts.groups;
  const subs = opts.subs || {
    "综合利用EMBY4837": ["DIRECT", "Matrix", "香港01", "日本02"],
    "吹雪云观影组": ["DIRECT", "吹雪云", "Matrix"],
    "影视": ["DIRECT", "HK", "US"]
  };

  const config = {
    getConfig() {
      const cfg = { running_model: 1, global_proxy: "", final: "PROXY" };
      if (!opts.noGroupApi) cfg.all_policy_groups = groups;
      return JSON.stringify(cfg);
    },
    getSelectedPolicy(g) { return selected[g] || ""; },
    getSubPolicies(g, cb) {
      if (opts.syncSubs === false) {
        setTimeout(() => cb(JSON.stringify(subs[g] || [])), 1);
      } else {
        cb(JSON.stringify(subs[g] || []));
      }
    },
    setSelectPolicy(a, b) {
      if (opts.batchUnsupported && Array.isArray(a)) throw new Error("batch unsupported");
      if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        const before = Object.assign({}, selected);
        let all = true;
        for (let i = 0; i < a.length; i++) {
          if (!(subs[a[i]] || []).includes(b[i])) { all = false; continue; }
          selected[a[i]] = b[i];
        }
        if (!all) {
          Object.keys(selected).forEach(k => { if (before[k] === undefined) delete selected[k]; });
          return false;
        }
        return true;
      }
      if (!(subs[a] || []).includes(b)) return false;
      if (opts.rejectSetAll) return false;
      selected[a] = b;
      return true;
    }
  };

  const sandbox = {
    $argument: argument,
    $config: config,
    $notification: {
      post(title, subtitle, body, opt) { notices.push({ title, subtitle, body, opt }); }
    },
    $persistentStore: {
      read(k) { return store[k] === undefined ? null : store[k]; },
      write(v, k) { store[k] = String(v); return true; }
    },
    $done() { st.done++; },
    $loon: "Loon 3.5.4 (988)",
    console: { log() {} },
    setTimeout, clearTimeout, Date, JSON, Object, Array, String, Number, Math, parseInt, parseFloat
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: "switch-multi.js" });

  const out = { selected, notices, store, st };
  Object.defineProperty(out, "doneCount", { get() { return st.done; } });
  return out;
}

function titles(r) { return r.notices.map(n => n.title); }

// ---------------------------------------------------------------- 1 关键字
(() => {
  const r = run({ slot1Set: "EMBY=Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "① 组与目标都可用关键字匹配");
  ok(titles(r).includes("策略已切换"), "① 发切换成功通知");
  eq(r.doneCount, 1, "① $done 只调用一次");
})();

// ------------------------------------------------------------------ 2 序号
(() => {
  const r = run({ set1: "3=2", notify: true }, { selected: { "影视": "DIRECT" } });
  eq(r.selected["影视"], "HK", "② 组序号 3 + 目标序号 2 解析正确");
})();

// -------------------------------------------------------------- 3 多组多目标
(() => {
  const r = run({ slot1Set: "EMBY=Matrix; 2=Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT", "吹雪云观影组": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "③ a 组切换");
  eq(r.selected["吹雪云观影组"], "Matrix", "③ b 组切换");
  ok(/2 组/.test(r.notices[0].subtitle), "③ 通知写明 2 组", r.notices[0].subtitle);
})();

// ------------------------------------------------------------------ 4 幂等
(() => {
  const r = run({ slot1Set: "EMBY=Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "Matrix" } });
  eq(r.notices.length, 0, "④ 已是目标时不通知");
  eq(r.doneCount, 1, "④ 仍然正常结束");
})();

// -------------------------------------------------------------- 5 组不存在
(() => {
  const r = run({ slot1Set: "不存在的组=Matrix", notify: true }, {});
  ok(titles(r).includes("策略切换失败"), "⑤ 组找不到时报失败");
  ok(/现有：/.test(r.notices[0].body), "⑤ 通知里给出可选组", r.notices[0].body);
})();

// -------------------------------------------------------------- 6 目标不存在
(() => {
  const r = run({ slot1Set: "EMBY=不存在的节点", notify: true }, {});
  ok(titles(r).includes("策略切换失败"), "⑥ 目标不存在时报失败");
  ok(/目标「不存在的节点」没找到/.test(r.notices[0].body), "⑥ 说明是目标名错误", r.notices[0].body);
})();

// -------------------------------------------------------------- 7 关键字歧义
(() => {
  const r = run({ slot1Set: "影视=H", notify: true }, {});
  // "H" 同时命中 HK（组内），这里构造为子策略重复更合适，用组名歧义验证
  const r2 = run({ slot1Set: "影=HK", notify: true },
    { groups: ["影视1", "影视2"], subs: { "影视1": ["HK"], "影视2": ["HK"] } });
  ok(titles(r2).includes("策略切换失败"), "⑦ 组关键字命中多个时报错");
  ok(/匹配到 2 个/.test(r2.notices[0].body), "⑦ 列出候选", r2.notices[0].body);
})();

// ------------------------------------------------------------ 8 方案保存/应用
(() => {
  const r1 = run({ toolAction: "保存方案1", notify: true },
    { selected: { "综合利用EMBY4837": "Matrix", "影视": "HK" } });
  ok(/已保存方案1/.test(titles(r1)[0]), "⑧ 保存方案成功", titles(r1)[0]);
  ok(r1.store["LoonPolicySwitch.scheme.1"], "⑧ 方案写入 persistentStore");

  const r2 = run({ slot1Set: "方案1", notify: true },
    { store: r1.store, selected: { "综合利用EMBY4837": "DIRECT", "影视": "DIRECT" } });
  eq(r2.selected["综合利用EMBY4837"], "Matrix", "⑧ 应用方案 a 组");
  eq(r2.selected["影视"], "HK", "⑧ 应用方案 b 组");

  const r3 = run({ toolAction: "应用方案2", notify: true }, {});
  ok(/方案2 为空/.test(titles(r3)[0]), "⑧ 空方案有提示", titles(r3)[0]);
  eq(r3.doneCount, 1, "⑧ 空方案分支也调用 $done");
})();

// -------------------------------------------------------------- 9 列出策略组
(() => {
  const r = run({ toolAction: "列出策略组", notify: true },
    { selected: { "综合利用EMBY4837": "Matrix" } });
  ok(/策略组一览（3）/.test(titles(r)[0]), "⑨ 列出 3 个组", titles(r)[0]);
  ok(/1\. 综合利用EMBY4837 ▸ Matrix/.test(r.notices[0].body), "⑨ 显示序号与当前选择", r.notices[0].body);
  ok(/1\. 综合利用EMBY4837/.test(r.notices[0].opt.clipboard || ""), "⑨ 附带可复制的清单", String(r.notices[0].opt.clipboard));
  eq(r.doneCount, 1, "⑨ 正常结束");
})();

// -------------------------------------------------------- 10 空目标串静默退出
(() => {
  const r = run({ slot2Set: "", notify: true }, {});
  eq(r.notices.length, 0, "⑩ 空目标串不通知");
  eq(r.doneCount, 1, "⑩ 正常结束");
})();

// ------------------------------------------------ 11 批量 API 不可用时逐个回退
(() => {
  const r = run({ slot1Set: "EMBY=Matrix; 2=Matrix", notify: true },
    { batchUnsupported: true, selected: { "综合利用EMBY4837": "DIRECT", "吹雪云观影组": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑪ 回退单组 a");
  eq(r.selected["吹雪云观影组"], "Matrix", "⑪ 回退单组 b");
  ok(titles(r).includes("策略已切换"), "⑪ 仍报成功");
})();

// -------------------------------------------------- 12 读不到组列表时按原样尝试
(() => {
  const r = run({ slot1Set: "综合利用EMBY4837=Matrix", notify: true },
    { noGroupApi: true, selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑫ 无 all_policy_groups 也能切");
})();

// ---------------------------------------------------- 13 旧版插件参数兼容
(() => {
  const r = run({ group: "综合利用EMBY4837", target: "Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑬ 旧参数 group/target 可用");

  const r2 = run({ group: "综合利用EMBY4837", amTarget: "Matrix", pmTarget: "香港01", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  ok(["Matrix", "香港01"].includes(r2.selected["综合利用EMBY4837"]),
    "⑬ 旧参数 am/pm 可用", r2.selected["综合利用EMBY4837"]);
})();

// ---------------------------------------------------------------- 14 语法错误
(() => {
  const r = run({ slot1Set: "随便写点啥", notify: true }, {});
  ok(titles(r).includes("策略切换失败"), "⑭ 缺少 = 时报错");
  ok(/格式应为/.test(r.notices[0].body), "⑭ 提示正确格式", r.notices[0].body);
})();

// ------------------------------------------------------ 15 notify=false 静默
(() => {
  const r = run({ slot1Set: "EMBY=Matrix", notify: false },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑮ 关闭通知仍然切换");
  eq(r.notices.length, 0, "⑮ 不发通知");
})();

// ------------------------------------------- 16 组名带前后空格 / 引号 也能匹配
(() => {
  const r = run({ slot1Set: ' “EMBY” = "Matrix" ', notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑯ 自动去掉引号与空格");
})();

// ------------------------------------------------ 17 部分成功部分失败
(() => {
  const r = run({ slot1Set: "EMBY=Matrix; 影视=US; 不存在的组=HK", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT", "影视": "DIRECT" } });
  ok(titles(r).includes("策略切换部分失败"), "⑰ 部分失败标题", titles(r)[0]);
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑰ 成功的仍然生效");
  ok(/✓ 综合利用EMBY4837/.test(r.notices[0].body), "⑰ 正文列出成功项", r.notices[0].body);
})();

// ------------------------------------------------ 18 异步 getSubPolicies
let asyncCase = null;
(() => {
  asyncCase = run({ slot1Set: "EMBY=Matrix", notify: true },
    { syncSubs: false, selected: { "综合利用EMBY4837": "DIRECT" } });
})();

// -------------------------------------------------- 19 分段模式（每段自带时间）
(() => {
  const r = run({ g1: "EMBY", v1a: "Matrix", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(r.selected["综合利用EMBY4837"], "Matrix", "⑲ 分段①时间1 生效");

  const rb = run({ g1: "EMBY", v1b: "香港01", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(rb.selected["综合利用EMBY4837"], "香港01", "⑲ 分段①时间2 用 v1b");

  const empty = run({ g1: "", v1a: "Matrix", notify: true }, {});
  eq(empty.notices.length, 0, "⑲ 组名为空时静默");
  eq(empty.doneCount, 1, "⑲ 组名为空也正常结束");

  const noTarget = run({ g1: "EMBY", v1a: "", notify: true },
    { selected: { "综合利用EMBY4837": "DIRECT" } });
  eq(noTarget.notices.length, 0, "⑲ 目标为空时静默");

  const two = run({ g2: "影视", v2a: "HK", notify: true },
    { groups: ["综合利用EMBY4837", "影视"], subs: { "影视": ["DIRECT", "HK"] },
      selected: { "影视": "DIRECT" } });
  eq(two.selected["影视"], "HK", "⑲ 第②段用 g2/v2a 也能生效");
})();

// ------------------------------------------------------------------ 汇总
setTimeout(() => {
  eq(asyncCase && asyncCase.selected["综合利用EMBY4837"], "Matrix", "⑱ getSubPolicies 异步回调也能完成切换");
  ok(asyncCase && asyncCase.doneCount === 1, "⑱ 异步场景 $done 一次", "doneCount=" + (asyncCase && asyncCase.doneCount));
  console.log("\n通过 " + pass + " / 失败 " + fail);
  if (fail) {
    failures.forEach(f => console.log("  ✗ " + f));
    process.exit(1);
  }
  console.log("全部通过 ✅");
}, 100);
