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
 * 注意：
 *   - 只有 Cookie 里带 auth= 才算登录态，游客 Cookie（如 __cf_bm）不会覆盖已保存的值；
 *   - 需要 Loon 开启 MitM 且已安装/信任证书（插件已声明 hostname = ikuuu.org）；
 *   - 脚本只读 Cookie、不修改请求，最后 $done({}) 原样放行。
 */
(function () {
  "use strict";

  var COOKIE_KEY = "ikuuu_org_cookie";

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

  // 只有登录后才有的 auth Cookie 才值得保存
  if (/(?:^|;\s*)auth=[^;]/.test(cookie)) {
    var saved = false;
    try {
      saved = $persistentStore.write(cookie, COOKIE_KEY);
    } catch (e) {
      console.log("[iKuuu] 保存 Cookie 失败：" + e);
    }
    console.log("[iKuuu] 已抓取登录 Cookie（" + cookie.length + " 字节，写入" +
      (saved ? "成功" : "失败") + "）");
  } else {
    console.log("[iKuuu] 当前是未登录状态，忽略本次 Cookie");
  }

  $done({});
})();
