/**
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 */

/**
 * Loon 定时切换策略脚本  v1.0
 * 依赖: $config.getSelectedPolicy / $config.setSelectPolicy（Loon 官方 Script API）
 *
 * $argument 支持两种写法:
 *   1) 插件对象参数: { group, schedule, notify, debug }
 *   2) 字符串: "group=策略组&schedule=10:00=A;19:00=B&notify=1"
 *
 * schedule 格式: "HH:mm=节点或子策略名" 多条用 ; 或换行分隔
 * 例如: "10:00=Matrix-美西-4837🇺🇸AnyTLS1;19:00=HKS-🇭🇰CDT优化"
 *
 * 逻辑: 取「当前时间之前最近的一个时间点」对应的目标；
 *      若今天还没到第一个时间点，则沿用最后一条(即昨晚那档)；
 *      目标与当前选择一致则跳过（幂等，可放心高频轮询）。
 */

(function () {
  var arg = typeof $argument === "undefined" ? null : $argument;

  function log(msg) { console.log("[PolicySwitch] " + msg); }

  function parseArgument(a) {
    var out = {};
    if (a && typeof a === "object") {
      for (var k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k]; }
      return out;
    }
    var s = String(a == null ? "" : a).trim();
    if (!s) return out;
    if (s.charAt(0) === "{") {
      try { return JSON.parse(s); } catch (e) { /* fallthrough */ }
    }
    s.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i <= 0) return;
      var key = kv.slice(0, i).trim(), val = kv.slice(i + 1).trim();
      try { key = decodeURIComponent(key); } catch (e) {}
      try { val = decodeURIComponent(val); } catch (e) {}
      out[key] = val;
    });
    return out;
  }

  function toBool(v, dft) {
    if (v === undefined || v === null || v === "") return dft;
    if (typeof v === "boolean") return v;
    var s = String(v).toLowerCase();
    if (["1", "true", "yes", "on"].indexOf(s) >= 0) return true;
    if (["0", "false", "no", "off"].indexOf(s) >= 0) return false;
    return dft;
  }

  function parseSchedule(str) {
    var items = [];
    String(str || "").split(/[;\n]+/).forEach(function (line) {
      line = line.trim();
      if (!line) return;
      var m = line.match(/^(\d{1,2}):(\d{2})\s*[=:>\-]+\s*(.+)$/);
      if (!m) { log("忽略无法解析的时间项: " + line); return; }
      var h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
      if (h > 23 || mi > 59) { log("时间越界: " + line); return; }
      items.push({ min: h * 60 + mi, text: ("0" + h).slice(-2) + ":" + ("0" + mi).slice(-2), node: m[3].trim() });
    });
    items.sort(function (a, b) { return a.min - b.min; });
    return items;
  }

  function pick(items, now) {
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var target = items[items.length - 1]; // 今天还没到第一个点 -> 沿用最后一档
    for (var i = 0; i < items.length; i++) {
      if (items[i].min <= nowMin) target = items[i];
    }
    return target;
  }

  var cfg = parseArgument(arg);
  var group = String(cfg.group || "").trim();
  var notify = toBool(cfg.notify, true);
  var items = parseSchedule(cfg.schedule);

  function finish(msg, ok) {
    log(msg);
    if (notify && ok === false) {
      $notification.post("Loon 定时切换失败", group || "-", msg, { openUrl: "loon://switch" });
    }
    $done();
  }

  if (!group) return finish("未配置策略组名称(group)", false);
  if (!items.length) return finish("时间表为空或格式错误(schedule)", false);

  if (typeof $config === "undefined" || typeof $config.setSelectPolicy !== "function") {
    return finish("当前 Loon 版本不支持 $config.setSelectPolicy，请升级 Loon", false);
  }

  var t = pick(items, new Date());
  var current = "";
  try { current = String($config.getSelectedPolicy(group) || ""); } catch (e) { current = ""; }

  if (current === t.node) {
    log(group + " 已是 " + t.node + "（" + t.text + " 档），无需切换");
    return $done();
  }

  var changed = false;
  try { changed = $config.setSelectPolicy(group, t.node) === true; } catch (e) {
    return finish("setSelectPolicy 抛异常: " + e, false);
  }

  var after = "";
  try { after = String($config.getSelectedPolicy(group) || ""); } catch (e) {}

  if (changed && after === t.node) {
    log(group + " -> " + t.node + " (" + t.text + " 档) 成功");
    if (notify) {
      $notification.post("策略已切换", group, t.node + " · " + t.text + " 档", { openUrl: "loon://switch" });
    }
    $done();
  } else {
    finish("切换失败: 返回 " + changed + "，当前=" + (after || current) + "，目标=" + t.node +
             "（请检查策略组/子策略名称是否完全一致，含 emoji 与空格）", false);
  }
})();
