/**
 * iKuuu Cookie 抓取（Loon http-request 脚本）
 *
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 *
 * 作用：已登录状态下打开 ikuuu.org 时，把请求头里的 Cookie 存进 Loon 本地存储，
 *      供 ikuuu-checkin.js 定时签到使用。
 *
 * 参数（插件 [Argument] 传入）：
 *   notify  抓取成功后是否发通知，默认 true
 *
 * 注意：
 *   - 插件里的「抓取 Cookie」开关关闭后本脚本不再执行，已保存的 Cookie 仍然可用；
 *   - 只有登录后才会出现的会话 Cookie（auth / uid+key / session 等）才会保存，
 *     游客 Cookie（如 __cf_bm）不会覆盖已保存的值；
 *   - 需要 Loon 开启 MitM 且已安装/信任证书（插件已声明 hostname = ikuuu.org）；
 *   - 脚本只读 Cookie、不修改请求，最后 $done({}) 原样放行。
 */
(function () {
  "use strict";

  var COOKIE_KEY = "ikuuu_org_cookie";
  // 登录后才会出现的会话 Cookie：v2board 用 auth，兼容 uid+key / session / remember
  var LOGIN_COOKIE = /(?:^|;\s*)(?:auth|uid|key|session|remember_[^=;]*)=[^;]/i;

  var args = ($argument && typeof $argument === "object") ? $argument : {};
  var notifyEnabled = args.notify !== false;

  function notify(subtitle, content) {
    if (!notifyEnabled) return;
    try {
      $notification.post("iKuuu Cookie 抓取", subtitle, content);
    } catch (e) {
      console.log("[iKuuu] 通知发送失败：" + e);
    }
  }

  /** Cookie 里的 expire_in（Unix 秒）→ "7 天" 这种可读值；抓取发生在登录后不久，就是站点给的真实 TTL */
  function expireLeft(cookie) {
    var m = String(cookie || "").match(/expire_in=(\d{9,})/);
    if (!m) return "";
    var left = Number(m[1]) * 1000 - Date.now();
    if (!isFinite(left)) return "";
    if (left <= 0) return "已过期";
    if (left >= 86400000) return (Math.round(left / 86400000 * 10) / 10) + " 天";
    if (left >= 3600000) return Math.round(left / 3600000) + " 小时";
    return Math.max(1, Math.round(left / 60000)) + " 分钟";
  }

  function findCookie(headers) {
    if (!headers) return "";
    for (var key in headers) {
      if (key && key.toLowerCase() === "cookie" && headers[key]) {
        return String(headers[key]);
      }
    }
    return "";
  }

  var cookie = "";
  try {
    cookie = findCookie($request && $request.headers).trim();
  } catch (e) {
    console.log("[iKuuu] 读取请求头失败：" + e);
  }

  if (!cookie) {
    console.log("[iKuuu] 本次请求没有 Cookie，跳过");
    return $done({});
  }

  if (!LOGIN_COOKIE.test(cookie)) {
    console.log("[iKuuu] 当前是未登录状态，忽略本次 Cookie");
    return $done({});
  }

  var existing = "";
  try {
    existing = String($persistentStore.read(COOKIE_KEY) || "");
  } catch (e) {}

  if (existing === cookie) {
    console.log("[iKuuu] Cookie 没有变化，跳过写入");
    return $done({});
  }

  var saved = false;
  try {
    saved = $persistentStore.write(cookie, COOKIE_KEY);
  } catch (e) {
    console.log("[iKuuu] 保存 Cookie 失败：" + e);
  }

  if (saved) {
    var left = expireLeft(cookie);
    console.log("[iKuuu] 已保存登录 Cookie（" + cookie.length + " 字节）" +
      (left ? "，剩余有效 " + left : ""));
    notify("已获取登录 Cookie",
      (left ? "剩余有效：" + left + "\n" : "") +
      "可以在插件里把「抓取 Cookie」开关关掉了，签到会继续使用这份 Cookie。");
  } else {
    console.log("[iKuuu] 写入本地存储失败");
    notify("Cookie 保存失败", "写入 Loon 本地存储失败，请检查 Loon 的存储权限后重试。");
  }

  $done({});
})();
