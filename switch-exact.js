/**
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 */

/**
 * Loon 准点切换策略（两条 cron 各触发一次）
 *
 * 插件对象参数: { group, amTarget, pmTarget, target, notify }
 * 字符串参数:   "group=综合利用EMBY4837&target=Matrix"
 *
 * 规则：
 *   - 明确传了 target / amTarget / pmTarget 就用它；
 *   - 都没传则按当前小时判断（12 点前用 amTarget，之后用 pmTarget）。
 * 幂等：已在目标上直接退出，不写配置、不通知。
 */

(function () {
  var cfg = {
    group: "综合利用EMBY4837",
    amTarget: "Matrix",
    pmTarget: "吹雪云观影组",
    notify: true
  };
  var given = {};

  var arg = typeof $argument === "undefined" ? null : $argument;
  if (arg && typeof arg === "object") {
    for (var k in arg) {
      if (arg[k] === undefined || arg[k] === null || arg[k] === "") continue;
      given[k] = arg[k];
      if (k === "targetAm") given.amTarget = arg[k];
      if (k === "targetPm") given.pmTarget = arg[k];
    }
  } else if (arg) {
    String(arg).split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i > 0) given[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
  }

  var GROUP = String(given.group || cfg.group);
  var NOTIFY = !(given.notify === false || given.notify === "false" || given.notify === "0");

  var target = "";
  if (given.target) target = String(given.target);
  else if (given.amTarget) target = String(given.amTarget);
  else if (given.pmTarget) target = String(given.pmTarget);
  else target = new Date().getHours() < 12 ? cfg.amTarget : cfg.pmTarget;
  target = target.trim();

  function log(m) { console.log("[PolicySwitch] " + m); }

  function fail(msg) {
    log(msg);
    if (NOTIFY) $notification.post("Loon 准点切换失败", GROUP, msg, { openUrl: "loon://switch" });
    $done();
  }

  if (!target) return fail("没有指定目标策略名");
  if (typeof $config === "undefined" || typeof $config.setSelectPolicy !== "function") {
    return fail("当前 Loon 版本不支持 $config.setSelectPolicy，请升级 Loon");
  }

  var current = "";
  try { current = String($config.getSelectedPolicy(GROUP) || ""); } catch (e) {}

  if (current === target) {
    log(GROUP + " 已是 " + target + "，无需切换");
    return $done();
  }

  var changed = false;
  try { changed = $config.setSelectPolicy(GROUP, target) === true; } catch (e) {
    return fail("setSelectPolicy 异常: " + e);
  }

  var after = "";
  try { after = String($config.getSelectedPolicy(GROUP) || ""); } catch (e) {}

  if (changed && after === target) {
    log(GROUP + " -> " + target + " 成功");
    if (NOTIFY) {
      $notification.post("策略已切换", GROUP, target + " · 准点 " + new Date().toTimeString().slice(0, 5), { openUrl: "loon://switch" });
    }
    $done();
  } else {
    fail("切换失败，返回 " + changed + "，当前=" + (after || current) + "，目标=" + target + "（核对策略组/子策略名称）");
  }
})();
