/**
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 */

/**
 * Loon 定时切换策略 · 多组多目标
 *
 * 一个脚本同时承担两种角色（由传入参数自动判断）：
 *   1) 定时切换（cron 触发）：arg.slotNSet / arg.setN / arg.sets
 *   2) 策略工具（generic 手动触发）：arg.toolAction
 *
 * 切换目标串写法（多个用 ; 分隔）：
 *   "综合利用EMBY4837=Matrix; 影视=HK01"
 *   组 / 目标 都可以写：完整名、序号（从 1 开始）、唯一关键字
 *   整串写 "方案1" ~ "方案6" 表示套用之前保存的方案快照
 *
 * 策略组列表来自 $config.getConfig().all_policy_groups，
 * 所以用户不必手打完整名字，也能先跑「策略工具 → 列出策略组」看序号。
 */

(function () {
  "use strict";

  var SCHEME_KEY = "LoonPolicySwitch.scheme.";
  var MAX_SCHEME = 6;
  var GROUPS_FALLBACK_LIMIT = 8;

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

  function post(title, subtitle, content, extra) {
    if (!NOTIFY) return;
    var attach = { openUrl: "loon://switch" };
    if (extra) { for (var k in extra) { if (extra[k] != null) attach[k] = extra[k]; } }
    try {
      $notification.post(title, String(subtitle || ""), String(content || ""), attach);
    } catch (e) { log("通知失败: " + e); }
  }

  function finish() { try { $done(); } catch (e) {} }

  // ------------------------------------------------------------ 存储

  function readStore(key) {
    try { return String($persistentStore.read(key) || ""); } catch (e) { return ""; }
  }

  function writeStore(key, val) {
    try { return $persistentStore.write(String(val), key) === true; } catch (e) { return false; }
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
        else if (it && typeof it === "object") push(it.name || it.title || it.group || it.policy || it.policy_name);
        else if (it != null) push(it);
      });
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach(function (key) { push(key); });
    }
    return out;
  }

  // 读取当前配置里的所有策略组名（Loon 3.5.1+ 提供 all_policy_groups）
  function allGroups() {
    var cfg = null;
    try { cfg = JSON.parse($config.getConfig() || "{}"); } catch (e) { log("getConfig 解析失败: " + e); }
    if (!cfg) return [];
    var candidates = [
      cfg.all_policy_groups,
      cfg.policy_groups,
      cfg.policyGroups,
      cfg.allPolicyGroups,
      cfg.proxy_groups
    ];
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

  // 完整名 → 序号(1 起) → 唯一关键字
  function findName(list, spec, label) {
    var s = clean(spec);
    var tag = label || "名称";
    if (!s) return { error: tag + "为空" };
    for (var i = 0; i < list.length; i++) {
      if (String(list[i]) === s) return { name: String(list[i]), how: "全名" };
    }
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      if (n >= 1 && n <= list.length) return { name: String(list[n - 1]), how: "序号" };
      return { error: tag + "序号 " + n + " 超出范围（共 " + list.length + " 个，填 1-" + list.length + "）" };
    }
    var lower = s.toLowerCase(), hits = [];
    for (var j = 0; j < list.length; j++) {
      if (String(list[j]).toLowerCase().indexOf(lower) >= 0) hits.push(String(list[j]));
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

  function suggestGroups(groups, limit) {
    if (!groups.length) return "";
    var n = Math.min(limit || GROUPS_FALLBACK_LIMIT, groups.length);
    var parts = [];
    for (var i = 0; i < n; i++) parts.push((i + 1) + "." + groups[i]);
    return "现有：" + parts.join(" ") + (groups.length > n ? " …（共 " + groups.length + " 组）" : "");
  }

  // ------------------------------------------------------ 目标串解析

  function parseSets(str) {
    var items = [];
    String(str == null ? "" : str).split(/[;；\n]+/).forEach(function (piece) {
      var p = piece.trim();
      if (!p || /^[#/]/.test(p)) return;
      var m = p.match(/^(.+?)\s*(?:=>|->|→|➜|=|＝)\s*(.+)$/);
      if (!m) {
        items.push({ raw: p, error: "格式应为「组=目标」" });
        return;
      }
      items.push({ raw: p, group: clean(m[1]), target: clean(m[2]) });
    });
    return items;
  }

  function cnNum(ch) {
    var map = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6 };
    return map[ch] || 0;
  }

  // "方案2" / "方案二" / "#2" → 2；不是方案引用返回 0
  function schemeIndex(spec) {
    var s = clean(spec);
    var m = s.match(/^(?:方案|scheme|plan)\s*([0-9]+|[一二三四五六])$/i);
    if (!m) return 0;
    var v = /^[0-9]+$/.test(m[1]) ? parseInt(m[1], 10) : cnNum(m[1]);
    return v >= 1 && v <= MAX_SCHEME ? v : 0;
  }

  // ---------------------------------------------------------- 应用核心

  /**
   * @param items  [{group,target}] 或 [{raw,error}]
   * @param label  通知里用的来源标签，如 "时段①"
   */
  function applyItems(items, label) {
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
        var gs = plan.map(function (r) { return r.group; });
        var ts = plan.map(function (r) { return r.target; });
        try { $config.setSelectPolicy(gs, ts); } catch (e) { log("批量切换异常: " + e); }

        var retry = [];
        plan.forEach(function (r) {
          var after = currentOf(r.group);
          if (after === r.target) { r.ok = true; changed.push(r); }
          else retry.push(r);
        });
        // 批量不被支持 / 部分失败时逐个再试一次
        retry.forEach(function (r) {
          try { $config.setSelectPolicy(r.group, r.target); } catch (e) {}
          var after = currentOf(r.group);
          r.after = after;
          if (after === r.target) { r.ok = true; changed.push(r); }
          else { r.ok = false; fails.push(r); }
        });
      }

      log("changed=" + changed.length + " skipped=" + (results.length - plan.length - errors.length) +
        " fails=" + fails.length + " errors=" + errors.length);
      if (changed.length) log("changes: " + changed.map(function (r) { return r.group + "->" + r.target; }).join(", "));

      if (!changed.length && !fails.length && !errors.length) {
        log("全部已是目标，静默退出");
        return finish();
      }

      var lines = [];
      changed.forEach(function (r) { lines.push("✓ " + r.group + " → " + r.target); });
      results.forEach(function (r) {
        if (r.skipped) lines.push("· " + r.group + " 已是 " + r.target);
      });
      fails.forEach(function (r) {
        lines.push("✗ " + r.group + " → " + r.target + "（当前 " + (r.after || "未知") + "）");
      });
      errors.forEach(function (r) {
        var line = "✗ " + (r.raw || r.group || "") + "：" + r.error;
        if (r.kind === "target" && r.subs && r.subs.length) {
          line += "（可选：" + r.subs.slice(0, 6).join(" / ") + (r.subs.length > 6 ? " …" : "") + "）";
        }
        lines.push(line);
      });

      var groupErr = errors.filter(function (r) { return r.kind === "group"; }).length;
      if (groupErr && groups.length) lines.push(suggestGroups(groups));

      var title, subtitle;
      if (fails.length || errors.length) {
        title = changed.length ? "策略切换部分失败" : "策略切换失败";
        subtitle = label + " · " + nowHM();
      } else {
        title = "策略已切换";
        subtitle = label + " · " + changed.length + " 组 · " + nowHM();
      }
      var body = lines.join("\n");
      if (body.length > 900) body = body.slice(0, 900) + "…";
      post(title, subtitle, body);
      finish();
    }

    if (!items || !items.length) {
      log("没有可执行的切换项");
      return finish();
    }

    // 第一遍：语法与策略组名（同步）
    var waitSubs = [];
    items.forEach(function (it) {
      var rec = { raw: it.raw, group: it.group, target: it.target };

      if (it.error) {
        rec.error = it.error;
        rec.kind = "syntax";
        results.push(rec);
        return;
      }
      var byGroup = findName(groups, it.group, "策略组");
      if (byGroup.error) {
        if (!groups.length) {
          rec.group = clean(it.group);   // 读不到列表时按原样尝试
        } else {
          rec.error = byGroup.error;
          rec.kind = "group";
          results.push(rec);
          return;
        }
      } else {
        rec.group = byGroup.name;
      }

      results.push(rec);
      waitSubs.push(rec);
    });

    // 第二遍：子策略匹配（异步）
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

  // -------------------------------------------------------- 方案快照

  function loadScheme(n) {
    var raw = readStore(SCHEME_KEY + n);
    if (!raw) return null;
    try {
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items) || !data.items.length) return null;
      return data;
    } catch (e) { return null; }
  }

  function saveScheme(n) {
    var groups = allGroups();
    if (!groups.length) {
      post("保存方案" + n + " 失败", "读不到策略组列表", "请确认 Loon ≥ 3.5.1，或改用「组=目标」手写");
      return finish();
    }
    var items = [];
    groups.forEach(function (g) {
      var cur = currentOf(g);
      if (!cur) return;
      var selectable = false;
      try { selectable = $config.setSelectPolicy(g, cur) === true; } catch (e) {}
      if (selectable) items.push({ group: g, target: cur });
    });
    if (!items.length) {
      post("保存方案" + n + " 失败", "没有可切换的策略组", "只有手动选择型策略组能被保存");
      return finish();
    }
    writeStore(SCHEME_KEY + n, JSON.stringify({ ts: Date.now(), items: items }));
    var body = items.map(function (i) { return i.group + " = " + i.target; }).join("\n");
    if (body.length > 900) body = body.slice(0, 900) + "…";
    post("已保存方案" + n, items.length + " 组 · " + nowHM(), body);
    finish();
  }

  function applyScheme(n, label) {
    var data = loadScheme(n);
    if (!data) {
      post("方案" + n + " 为空", label, "先运行「策略工具 → 保存方案" + n + "」");
      return finish();
    }
    applyItems(data.items.map(function (it) {
      return { group: it.group, target: it.target, raw: it.group + "=" + it.target };
    }), label + " · 方案" + n);
  }

  // ------------------------------------------------------------ 工具

  function listGroups() {
    var groups = allGroups();
    if (!groups.length) {
      post("读不到策略组", "请确认 Loon 3.5.1(983)+", "也可以在插件里直接填完整组名");
      return finish();
    }
    var lines = groups.map(function (g, i) {
      return (i + 1) + ". " + g + " ▸ " + (currentOf(g) || "未知");
    });
    log("策略组: " + lines.join(" | "));
    var body = lines.join("\n");
    if (body.length > 900) body = body.slice(0, 900) + "…";
    post("策略组一览（" + groups.length + "）", "点通知复制清单 · 插件里填序号或关键字",
      body, { clipboard: lines.join("\n") });
    finish();
  }

  var toolAction = String(arg.toolAction || arg.action || "").trim();
  if (toolAction) {
    var n = 0;
    var got = toolAction.match(/([1-9])/);
    if (got) n = parseInt(got[1], 10);
    else {
      var cn = toolAction.match(/[一二三四五六]/);
      if (cn) n = cnNum(cn[0]);
    }
    if (/保存|save/i.test(toolAction)) return saveScheme(n || 1);
    if (/应用|切换|apply|switch/i.test(toolAction)) return applyScheme(n || 1, "手动");
    return listGroups();
  }

  // -------------------------------------------------------- 定时切换

  // 收集本次要执行的切换目标串（cron 每条只传自己那一个参数）
  var setKeys = [];
  Object.keys(arg).forEach(function (key) {
    if (/^(slot\d*(set|target)|set\d*)$/i.test(key) && String(arg[key]).trim() !== "") setKeys.push(key);
  });
  setKeys.sort();

  var setStr = "";
  if (setKeys.length) {
    setStr = String(arg[setKeys[0]]).trim();
  } else if (arg.group && (arg.target || arg.amTarget || arg.pmTarget)) {
    // 兼容旧版插件参数：显式 target 优先，否则按当前小时挑早/晚目标
    var legacyTarget = arg.target;
    if (!legacyTarget) {
      var morning = new Date().getHours() < 12;
      legacyTarget = (morning ? arg.amTarget : arg.pmTarget) || arg.amTarget || arg.pmTarget;
    }
    if (legacyTarget) setStr = arg.group + "=" + legacyTarget;
  }

  if (!setStr || /^(off|none|null|-|无|不启用)$/i.test(setStr)) {
    log("本时段没有配置切换目标，跳过");
    return finish();
  }

  var schemeNo = schemeIndex(setStr);
  if (schemeNo) return applyScheme(schemeNo, "准点");

  applyItems(parseSets(setStr), "准点");
})();
