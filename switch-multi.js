/**
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 */

/**
 * Loon 定时切换策略 · 每段一个策略组，各自两个时间点
 *
 * 插件每条 cron 只传本段的参数：
 *   { g1, v1a }  → ① 策略组在「时间 1」切到 v1a
 *   { g2, v2b }  → ② 策略组在「时间 2」切到 v2b
 * 组名与目标都支持：完整名 → 序号（1 起）→ 唯一关键字。
 * 组名为空 / 目标为空 → 静默，不切换也不通知。
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------- 参数

  function decode(v) {
    var s = String(v == null ? "" : v).trim();
    if (!s) return s;
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  var arg = {};
  var rawArg = typeof $argument === "undefined" ? null : $argument;
  if (rawArg && typeof rawArg === "object") {
    for (var k in rawArg) {
      if (rawArg[k] === undefined || rawArg[k] === null) continue;
      arg[k] = rawArg[k];
    }
  } else if (typeof rawArg === "string" && rawArg) {
    rawArg.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) arg[kv.slice(0, i).trim()] = decode(kv.slice(i + 1));
    });
  }

  var NOTIFY = !(arg.notify === false ||
    String(arg.notify).toLowerCase() === "false" ||
    String(arg.notify) === "0");

  function log(msg) { try { console.log("[PolicySwitch] " + msg); } catch (e) {} }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function nowHM() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function finish() { try { $done(); } catch (e) {} }

  function post(title, subtitle, content) {
    if (!NOTIFY) return;
    try {
      $notification.post(title, String(subtitle || ""), String(content || ""), { openUrl: "loon://switch" });
    } catch (e) { log("通知失败: " + e); }
  }

  // -------------------------------------------------------- 策略组读取

  function normalizeList(raw) {
    var out = [], seen = {};
    function push(n) {
      var s = String(n == null ? "" : n).trim();
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    }
    if (Array.isArray(raw)) {
      raw.forEach(function (it) {
        if (typeof it === "string") push(it);
        else if (it && typeof it === "object") push(it.name || it.title || it.group || it.policy);
        else if (it != null) push(it);
      });
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (key) { push(key); });
    }
    return out;
  }

  function allGroups() {
    var cfg = null;
    try { cfg = JSON.parse($config.getConfig() || "{}"); } catch (e) { log("getConfig 解析失败: " + e); }
    if (!cfg) return [];
    var candidates = [cfg.all_policy_groups, cfg.policy_groups, cfg.policyGroups, cfg.proxy_groups];
    for (var i = 0; i < candidates.length; i++) {
      var list = normalizeList(candidates[i]);
      if (list.length) return list;
    }
    return [];
  }

  function currentOf(group) {
    try { return String($config.getSelectedPolicy(group) || ""); } catch (e) { return ""; }
  }

  function getSubs(group, cb) {
    var settled = false;
    function done(arr) {
      if (settled) return;
      settled = true;
      cb(arr || []);
    }
    try {
      if (typeof $config.getSubPolicies !== "function") return done([]);
      $config.getSubPolicies(group, function (text) {
        var arr = [];
        try { arr = JSON.parse(text || "[]"); } catch (e) { arr = []; }
        done(normalizeList(arr));
      });
    } catch (e) {
      return done([]);
    }
    setTimeout(function () { done([]); }, 4000);
  }

  // ---------------------------------------------------------- 名称匹配

  function clean(s) {
    return String(s == null ? "" : s)
      .replace(/^[#＃]\s*/, "")
      .replace(/^[\s"'“”‘’]+/, "")
      .replace(/[\s"'“”‘’]+$/, "")
      .trim();
  }

  // 比较用归一化：去掉空白（含全角）与引号，统一小写
  function normKey(s) {
    return String(s == null ? "" : s)
      .replace(/[\s\u3000]+/g, "")
      .replace(/["'“”‘’]/g, "")
      .toLowerCase();
  }

  // 完整名 → 序号(1 起) → 唯一关键字
  function findName(list, spec, label) {
    var s = clean(spec);
    var tag = label || "名称";
    if (!s) return { error: tag + "为空" };

    for (var i = 0; i < list.length; i++) {
      if (String(list[i]) === s) return { name: String(list[i]), how: "全名" };
    }
    var ns = normKey(s);
    for (var i2 = 0; i2 < list.length; i2++) {
      if (normKey(list[i2]) === ns) return { name: String(list[i2]), how: "全名" };
    }

    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      if (n >= 1 && n <= list.length) return { name: String(list[n - 1]), how: "序号" };
      return { error: tag + "序号 " + n + " 超出范围（共 " + list.length + " 个，填 1-" + list.length + "）" };
    }

    var hits = [];
    for (var j = 0; j < list.length; j++) {
      if (normKey(list[j]).indexOf(ns) >= 0) hits.push(String(list[j]));
    }
    if (hits.length === 1) return { name: hits[0], how: "关键字" };
    if (hits.length > 1) {
      return {
        error: tag + "关键字「" + s + "」匹配到 " + hits.length + " 个：" +
          hits.slice(0, 4).join(" / ") + (hits.length > 4 ? " …" : "")
      };
    }
    return { error: tag + "「" + s + "」没找到" };
  }

  function suggestGroups(groups) {
    if (!groups.length) return "";
    var n = Math.min(8, groups.length);
    var parts = [];
    for (var i = 0; i < n; i++) parts.push((i + 1) + "." + groups[i]);
    return "现有：" + parts.join(" ") + (groups.length > n ? " …（共 " + groups.length + " 组）" : "");
  }

  // ---------------------------------------------------------- 应用核心

  function applyItems(items) {
    var groups = allGroups();
    var results = [];
    var asyncLeft = 0, finalized = false;
    var timer = null;

    function finalize() {
      if (finalized) return;
      finalized = true;
      if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }

      var errors = [], plan = [];
      results.forEach(function (r) {
        if (r.error) { errors.push(r); return; }
        var cur = currentOf(r.group);
        r.before = cur;
        if (cur && cur === r.target) { r.skipped = true; return; }
        plan.push(r);
      });

      var changed = [], fails = [];
      if (plan.length) {
        try {
          $config.setSelectPolicy(
            plan.map(function (r) { return r.group; }),
            plan.map(function (r) { return r.target; })
          );
        } catch (e) { log("批量切换异常: " + e); }

        var retry = [];
        plan.forEach(function (r) {
          if (currentOf(r.group) === r.target) { r.ok = true; changed.push(r); }
          else retry.push(r);
        });
        // 批量不被支持或部分失败时，逐个再试一次
        retry.forEach(function (r) {
          try { $config.setSelectPolicy(r.group, r.target); } catch (e) {}
          r.after = currentOf(r.group);
          if (r.after === r.target) { r.ok = true; changed.push(r); }
          else { r.ok = false; fails.push(r); }
        });
      }

      log("changed=" + changed.length + " fails=" + fails.length + " errors=" + errors.length);

      if (!changed.length && !fails.length && !errors.length) {
        log("已是目标或没有需要切换的组，静默退出");
        return finish();
      }

      // 正文：从哪个策略 → 切到哪个策略
      var lines = [];
      changed.forEach(function (r) {
        lines.push("✓ " + r.group + "：" + (r.before || "未知") + " → " + r.target);
      });
      results.forEach(function (r) {
        if (r.skipped) lines.push("· " + r.group + "：已经是 " + r.target);
      });
      fails.forEach(function (r) {
        lines.push("✗ " + r.group + "：" + (r.before || "未知") + " → " + r.target +
          " 未生效（当前 " + (r.after || "未知") + "）");
      });
      errors.forEach(function (r) {
        var line = "✗ " + (r.group || "") + "：" + r.error;
        if (r.kind === "target" && r.subs && r.subs.length) {
          line += "（可选：" + r.subs.slice(0, 6).join(" / ") + (r.subs.length > 6 ? " …" : "") + "）";
        }
        lines.push(line);
      });

      if (errors.some(function (r) { return r.kind === "group"; }) && groups.length) {
        lines.push(suggestGroups(groups));
      }

      var title;
      if (fails.length || errors.length) title = changed.length ? "策略切换部分失败" : "策略切换失败";
      else title = "策略已切换";

      // 副标题：用策略组名，而不是「N 组」
      var touched = changed.map(function (r) { return r.group; });
      var subtitle;
      if (touched.length === 1) subtitle = touched[0];
      else if (touched.length > 1) subtitle = touched[0] + " 等 " + touched.length + " 个组";
      else {
        var firstErr = errors.length ? errors[0].group : (fails.length ? fails[0].group : "");
        subtitle = firstErr || "无变化";
      }
      subtitle += " · " + nowHM();

      var body = lines.join("\n");
      if (body.length > 900) body = body.slice(0, 900) + "…";
      post(title, subtitle, body);
      finish();
    }

    if (!items.length) {
      log("没有配置要切换的组，跳过");
      return finish();
    }

    // 第一遍：组名（同步）
    var waitSubs = [];
    items.forEach(function (it) {
      var rec = { group: it.group, target: it.target };
      var byGroup = findName(groups, it.group, "策略组");

      if (byGroup.error) {
        if (groups.length) {
          rec.error = byGroup.error;
          rec.kind = "group";
          results.push(rec);
          return;
        }
        rec.group = clean(it.group);   // 读不到策略组列表时按原样尝试
      } else {
        rec.group = byGroup.name;
      }

      results.push(rec);
      waitSubs.push(rec);
    });

    // 第二遍：目标（异步）
    if (!waitSubs.length) return finalize();

    asyncLeft = waitSubs.length;
    timer = setTimeout(finalize, 6000);
    waitSubs.forEach(function (rec) {
      getSubs(rec.group, function (subs) {
        if (!subs.length) {
          rec.target = clean(rec.target);   // 读不到子策略：按原样交给 setSelectPolicy 校验
        } else {
          var byTarget = findName(subs, rec.target, "目标");
          if (byTarget.error) {
            rec.error = byTarget.error;
            rec.kind = "target";
            rec.subs = subs;
          } else {
            rec.target = byTarget.name;
          }
        }
        asyncLeft--;
        if (asyncLeft <= 0) finalize();
      });
    });
  }

  // ------------------------------------------------------------ 执行

  // 插件每条 cron 只传本段的 gN 与 vNa / vNb
  var items = [];
  Object.keys(arg).forEach(function (key) {
    var m = key.match(/^g(\d+)$/);
    if (!m) return;
    var i = m[1];
    var group = clean(arg[key]);
    if (!group || /^(off|none|-|无|不启用)$/i.test(group)) return;
    ["a", "b"].forEach(function (tag) {
      var raw = arg["v" + i + tag];
      if (raw === undefined || raw === null) return;
      var target = clean(raw);
      if (!target) return;
      items.push({ group: group, target: target });
    });
  });

  applyItems(items);
})();
