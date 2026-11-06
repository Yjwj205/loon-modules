/**
 * Loon 版「策略切换 + 打断已有连接」
 * 对应 Surge 模块：xream/scripts/surge/modules/kill-active-requests
 *
 * Surge 那边能做得彻底，是因为它有私有 HTTP API：
 *   /v1/requests/active  列出活跃请求
 *   /v1/requests/kill    按 id 逐个踢掉
 *   /v1/dns/flush        清 DNS
 *   /v1/outbound         切换出站模式（真正把已建立的连接全部打断的大招）
 * Loon 的脚本 API 里没有上面任何一个，只有 $config 的 4 个方法。
 * 所以这里用 Loon 唯一可脚本化的等价物：$config.setRunningModel() 反复切换运行模式，
 * 借引擎重新决策路由来丢弃已建立的连接，最后必须切回原模式。
 *
 * 触发方式（插件里配置）：
 *   cron            → TYPE=CRON
 *   network-changed → TYPE=NETWORK
 *   generic         → TYPE=GENERIC（手动点）
 *   http-request    → 无 TYPE，直接读 URL 参数（捷径用）
 *
 * 参数（对象或 a=1&b=2 字符串都支持）：
 *   group     策略组名（留空则不切换，只打断）
 *   policy    目标策略名（也接受 target）
 *   kill      1/0 是否打断已有连接，默认 1
 *   killMode  mode|none，默认 mode
 *   repeat    模式翻转轮数 1-5，默认 2
 *   gap       每步间隔毫秒 200-3000，默认 600
 *   notify    1/0 是否通知，默认 1
 *   debug     1/0 打印配置详情
 */

(function () {
  "use strict";

  var isRequest = typeof $request !== "undefined" && $request && $request.url;
  var MODEL_NAME = { 0: "全局直连", 1: "分流", 2: "全局代理" };

  /* ---------------- 参数解析 ---------------- */

  function mergeQs(dst, qs) {
    if (!qs) return dst;
    String(qs).split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i <= 0) return;
      var k = kv.slice(0, i).trim();
      var v = kv.slice(i + 1).trim();
      try { k = decodeURIComponent(k); v = decodeURIComponent(v); } catch (e) {}
      if (k) dst[k] = v;
    });
    return dst;
  }

  function boolOf(v, def) {
    if (v === undefined || v === null || v === "") return def;
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    var s = String(v).toLowerCase();
    return !(s === "0" || s === "false" || s === "off" || s === "no" || s === "#");
  }

  function intOf(v, min, max, def) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function collect() {
    var out = {};
    var arg = typeof $argument === "undefined" ? null : $argument;
    if (arg && typeof arg === "object") {
      for (var k in arg) {
        if (arg[k] !== undefined && arg[k] !== null && arg[k] !== "") out[k] = arg[k];
      }
    } else if (arg && typeof arg === "string") {
      mergeQs(out, arg);
    }
    if (isRequest) {
      var url = String($request.url || "");
      var q = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";
      mergeQs(out, q);
    }
    return out;
  }

  var P = collect();
  var CFG = {
    type: String(P.type || P.TYPE || "").toUpperCase(),
    group: String(P.group || "").trim(),
    policy: String(P.policy || P.target || "").trim(),
    kill: boolOf(P.kill, true),
    killMode: String(P.killMode || P.killmode || "mode").toLowerCase(),
    repeat: intOf(P.repeat, 1, 5, 2),
    gap: intOf(P.gap, 200, 3000, 600),
    notify: boolOf(P.notify, true),
    debug: boolOf(P.debug, false)
  };

  var report = { app: "loon", group: CFG.group, policy: CFG.policy, switched: "skip", killed: "skip" };

  function log(m) { console.log("[kill-switch] " + m); }

  /* ---------------- 配置读取 ---------------- */

  function readConfig() {
    try {
      return JSON.parse($config.getConfig() || "{}") || {};
    } catch (e) {
      return {};
    }
  }

  function readModel() {
    var c = readConfig();
    var m = c.running_model;
    if (m === undefined || m === null) m = c.runningModel;
    var n = typeof m === "number" ? m : parseInt(m, 10);
    return isNaN(n) ? -1 : n;
  }

  /* ---------------- 策略切换 ---------------- */

  function switchPolicy(next) {
    if (!CFG.group || !CFG.policy) {
      log("未指定 group/policy，跳过切换");
      return next(null);
    }
    if (typeof $config === "undefined" || typeof $config.setSelectPolicy !== "function") {
      return next("当前 Loon 不支持 $config.setSelectPolicy，请升级");
    }
    var cur = "";
    try { cur = String($config.getSelectedPolicy(CFG.group) || ""); } catch (e) {}
    if (cur === CFG.policy) {
      log(CFG.group + " 已是 " + CFG.policy + "，无需切换");
      report.switched = "already";
      return next(null);
    }
    var ok = false;
    try { ok = $config.setSelectPolicy(CFG.group, CFG.policy) === true; } catch (e) {
      return next("setSelectPolicy 异常: " + e);
    }
    var after = "";
    try { after = String($config.getSelectedPolicy(CFG.group) || ""); } catch (e) {}
    if (ok && after === CFG.policy) {
      log(CFG.group + " -> " + CFG.policy + " 成功");
      report.switched = "ok";
      return next(null);
    }
    report.switched = "fail";
    return next("切换失败：返回 " + ok + "，当前 " + (after || cur || "?") + "，目标 " + CFG.policy);
  }

  /* ---------------- 打断连接 ---------------- */

  function killConnections(next) {
    if (!CFG.kill || CFG.killMode === "none") {
      log("kill=0 / killMode=none，跳过打断");
      report.killed = "skip";
      return next(null);
    }
    if (typeof $config === "undefined" || typeof $config.setRunningModel !== "function") {
      return next("当前 Loon 不支持 $config.setRunningModel，请升级");
    }

    var orig = readModel();
    if (orig !== 0 && orig !== 1 && orig !== 2) orig = 1;
    var other = orig === 1 ? 2 : 1;

    var seq = [];
    for (var i = 0; i < CFG.repeat; i++) {
      seq.push(other);
      seq.push(orig);
    }

    report.killed = {
      mode: CFG.killMode,
      from: MODEL_NAME[orig],
      to: MODEL_NAME[other],
      repeat: CFG.repeat
    };
    log("打断连接：原模式 " + MODEL_NAME[orig] + "，翻转 " + CFG.repeat + " 轮（间隔 " + CFG.gap + "ms）");

    var idx = 0;
    (function step() {
      if (idx >= seq.length) {
        if (readModel() !== orig) {
          try { $config.setRunningModel(orig); } catch (e) {}
        }
        return next(null);
      }
      var m = seq[idx++];
      try {
        $config.setRunningModel(m);
      } catch (e) {
        try { $config.setRunningModel(orig); } catch (e2) {}
        report.killed = "error: " + e;
        return next("setRunningModel 异常: " + e);
      }
      setTimeout(step, CFG.gap);
    })();
  }

  /* ---------------- 收尾 ---------------- */

  function finish(err) {
    if (CFG.debug) {
      try { log("config=" + JSON.stringify(readConfig())); } catch (e) {}
    }
    if (err) log("失败：" + err);
    log("结果 " + JSON.stringify(report));

    if (CFG.notify) {
      var title = err ? "打断连接 · 失败" : "策略切换 · 已打断连接";
      var sub = CFG.group ? CFG.group + (CFG.policy ? " → " + CFG.policy : "") : "Loon";
      var body;
      if (err) {
        body = String(err);
      } else {
        var s = report.switched === "ok" ? "已切换" :
                report.switched === "already" ? "本来就在目标上" :
                report.switched === "skip" ? "未切换" : "切换失败";
        var k = report.killed === "skip" ? "未打断" :
                report.killed && report.killed.mode ?
                  ("已打断 " + report.killed.repeat + " 轮 · " + report.killed.from + "↔" + report.killed.to) :
                  String(report.killed);
        body = s + " ｜ " + k;
      }
      try {
        $notification.post(title, sub, body, { openUrl: "loon://switch" });
      } catch (e) {}
    }

    if (isRequest) {
      var payload = {
        ok: !err,
        error: err ? String(err) : null,
        switched: report.switched,
        killed: report.killed,
        group: CFG.group || null,
        policy: CFG.policy || null
      };
      $done({
        response: {
          status: err ? 500 : 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload)
        }
      });
    } else {
      $done();
    }
  }

  /* ---------------- 入口 ---------------- */

  if (CFG.debug) {
    log("type=" + (CFG.type || (isRequest ? "REQUEST" : "?")));
    log("cfg=" + JSON.stringify(CFG));
  }

  switchPolicy(function (err) {
    if (err) return finish(err);
    killConnections(function (err2) {
      finish(err2);
    });
  });
})();
