/**
 * 作者：Yjwj205 (思路) / Minis (实现)
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 */

/**
 * Loon 定时切换策略  ——  综合利用EMBY4837
 *   09:00 -> Matrix
 *   19:00 -> 吹雪云观影组
 *
 * 依赖 Loon 官方 Script API：
 *   $config.getSelectedPolicy(策略组) / $config.setSelectPolicy(策略组, 子策略)
 *
 * 幂等：目标与当前一致时不切换、不推送通知。
 * 逻辑：取「当前时间之前最近的一档」；未到当天第一档则沿用最后一档（昨晚那档）。
 */

(function () {
  var GROUP = "综合利用EMBY4837";
  var SCHEDULE = [
    { min: 9 * 60, text: "09:00", node: "Matrix" },
    { min: 19 * 60, text: "19:00", node: "吹雪云观影组" }
  ];
  var NOTIFY = true;
  var DEBUG = false;

  // ---- 允许插件参数覆盖 ----
  var arg = typeof $argument === "undefined" ? null : $argument;
  function parseArg(a) {
    var out = {};
    if (a && typeof a === "object") return a;
    var s = String(a == null ? "" : a).trim();
    if (!s) return out;
    if (s.charAt(0) === "{") { try { return JSON.parse(s); } catch (e) {} }
    s.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    return out;
  }
  var cfg = parseArg(arg);
  if (cfg.group) GROUP = String(cfg.group);
  if (cfg.notify !== undefined) NOTIFY = !(cfg.notify === false || cfg.notify === "false" || cfg.notify === "0");

  function log(m) { console.log("[PolicySwitch] " + m); }

  function finish(msg, ok) {
    log(msg);
    if (NOTIFY && ok === false) {
      $notification.post("Loon 定时切换失败", GROUP, msg, { openUrl: "loon://switch" });
    }
    $done();
  }

  if (typeof $config === "undefined" || typeof $config.setSelectPolicy !== "function") {
    return finish("当前 Loon 版本不支持 $config.setSelectPolicy，请升级 Loon", false);
  }

  var now = new Date();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var target = SCHEDULE[SCHEDULE.length - 1]; // 今天还没到 09:00 -> 沿用 19:00 那档
  for (var i = 0; i < SCHEDULE.length; i++) {
    if (SCHEDULE[i].min <= nowMin) target = SCHEDULE[i];
  }

  var current = "";
  try { current = String($config.getSelectedPolicy(GROUP) || ""); } catch (e) {}

  if (current === target.node) {
    log(GROUP + " 已是 " + target.node + "（" + target.text + " 档），无需切换");
    return $done();
  }

  var changed = false;
  try { changed = $config.setSelectPolicy(GROUP, target.node) === true; } catch (e) {
    return finish("setSelectPolicy 异常: " + e, false);
  }

  var after = "";
  try { after = String($config.getSelectedPolicy(GROUP) || ""); } catch (e) {}

  if (changed && after === target.node) {
    log(GROUP + " -> " + target.node + "（" + target.text + " 档）成功");
    if (NOTIFY) {
      $notification.post("策略已切换", GROUP, target.node + " · " + target.text + " 档", { openUrl: "loon://switch" });
    }
    $done();
  } else {
    finish("切换失败，返回 " + changed + "，当前=" + (after || current) + "，目标=" + target.node +
           "（请核对策略组/子策略名称是否完全一致）", false);
  }
})();
