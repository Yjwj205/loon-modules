/**
 * iKuuu 自动签到（Loon cron / generic 脚本）
 *
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 *
 * 参数（插件 [Argument] 传入的对象）：
 *   cookie  可选，手动填写的 Cookie；留空则用 ikuuu-cookie.js 自动抓取的值
 *   notify  可选，是否发系统通知，默认 true
 *
 * 流程：POST https://ikuuu.org/user/checkin → 解析 {ret, msg} → 再 GET /user 读剩余流量
 */
(function () {
  "use strict";

  var HOST = "https://ikuuu.org";
  var COOKIE_KEY = "ikuuu_org_cookie";
  var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  var args = ($argument && typeof $argument === "object") ? $argument : {};
  var manualCookie = (args.cookie === null || args.cookie === undefined)
    ? "" : String(args.cookie);
  var notifyEnabled = args.notify !== false;

  // 允许直接粘贴 "Cookie: xxx" 或换行粘贴
  manualCookie = manualCookie
    .replace(/^\s*cookie\s*:\s*/i, "")
    .replace(/[\r\n]+/g, " ")
    .trim();

  var savedCookie = "";
  try {
    savedCookie = String($persistentStore.read(COOKIE_KEY) || "").trim();
  } catch (e) {
    console.log("[iKuuu] 读取本地 Cookie 失败：" + e);
  }

  var cookie = manualCookie || savedCookie;

  function stamp() {
    var d = new Date();
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function finish(subtitle, content) {
    if (notifyEnabled) {
      try {
        $notification.post("iKuuu 签到", subtitle, content);
      } catch (e) {
        console.log("[iKuuu] 通知发送失败：" + e);
      }
    }
    console.log("[iKuuu] " + subtitle + " | " + String(content).replace(/\n/g, " / "));
    $done();
  }

  /* ---------- Base64 / UTF-8（站点页面被 base64 包在 var originBody 里） ---------- */

  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function utf8Decode(bytes) {
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i++];
      if (b < 0x80) {
        out += String.fromCharCode(b);
      } else if (b >= 0xC0 && b < 0xE0) {
        out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i++] & 0x3F));
      } else if (b >= 0xE0 && b < 0xF0) {
        out += String.fromCharCode(((b & 0x0F) << 12) |
          ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) |
          ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }

  function base64Decode(str) {
    str = String(str).replace(/[^A-Za-z0-9+/=]/g, "");
    var bytes = [], buf = 0, bits = 0, i, v;
    for (i = 0; i < str.length; i++) {
      if (str.charAt(i) === "=") break;
      v = B64_CHARS.indexOf(str.charAt(i));
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes.push((buf >> bits) & 0xFF);
      }
    }
    return utf8Decode(bytes);
  }

  function extractHtml(data) {
    var text = String(data || "");
    var m = text.match(/var\s+originBody\s*=\s*["']([^"']+)["']/);
    if (!m) return text;
    try {
      return base64Decode(m[1]);
    } catch (e) {
      return text;
    }
  }

  function pick(html, label) {
    var re = new RegExp(
      label + "[\\s\\S]{0,400}?<span[^>]*class=\"[^\"]*counter[^\"]*\"[^>]*>" +
      "\\s*([\\d.]+)\\s*<\\/span>\\s*([KMGTP]?B)", "i");
    var m = html.match(re);
    if (m) return m[1] + " " + m[2].toUpperCase();
    // 兜底：去掉标签后直接找「剩余流量：1.5 GB」这类文本
    var plain = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    var m2 = plain.match(new RegExp(label + "\\s*[:：]?\\s*([\\d.]+)\\s*([KMGTP]?B)", "i"));
    return m2 ? m2[1] + " " + m2[2].toUpperCase() : null;
  }

  /* ---------- 签到后的流量播报（失败不影响签到结果） ---------- */

  function fetchTraffic(callback) {
    $httpClient.get({
      url: HOST + "/user",
      timeout: 15000,
      headers: {
        "Cookie": cookie,
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": HOST + "/user"
      }
    }, function (error, response, data) {
      if (error || !data) return callback(null);
      var result = [];
      try {
        var html = extractHtml(data);
        var rest = pick(html, "剩余流量");
        var today = pick(html, "今日已用");
        if (rest) result.push("剩余流量：" + rest);
        if (today) result.push("今日已用：" + today);
      } catch (e) {
        console.log("[iKuuu] 解析流量失败：" + e);
      }
      callback(result.length ? result.join("\n") : null);
    });
  }

  /* ---------- 主流程 ---------- */

  if (!cookie) {
    return finish("没有 Cookie", [
      "还没拿到登录 Cookie。",
      "① 在 Safari 打开 https://ikuuu.org 登录一次（插件会自动抓取）；",
      "② 或在插件设置里手动填写 Cookie。"
    ].join("\n"));
  }

  $httpClient.post({
    url: HOST + "/user/checkin",
    timeout: 15000,
    headers: {
      "Cookie": cookie,
      "User-Agent": UA,
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Referer": HOST + "/user",
      "Origin": HOST,
      "X-Requested-With": "XMLHttpRequest"
    }
  }, function (error, response, data) {
    if (error) {
      return finish("请求失败", "签到接口请求出错：" + error);
    }

    var status = (response && response.status) ? response.status : 0;
    var text = String(data === null || data === undefined ? "" : data).trim();
    var json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}

    if (!json || typeof json !== "object") {
      if (status === 302 || /<html|<script/i.test(text)) {
        return finish("Cookie 已失效",
          "服务器返回的是登录页，请在 Safari 重新登录 ikuuu.org（插件会自动更新 Cookie）。");
      }
      return finish("签到失败",
        "返回内容无法解析（HTTP " + status + "）：" + text.slice(0, 120));
    }

    var ret = Number(json.ret);
    var msg = String(json.msg || "").trim() || "服务器没有返回说明";
    var already = /已经?签到|重复签到|明天再来/.test(msg) ||
      (ret === 0 && /签到/.test(msg));
    var subtitle = ret === 1 ? "签到成功" : (already ? "今日已签到" : "签到失败");

    fetchTraffic(function (traffic) {
      var content = msg;
      if (traffic) content += "\n" + traffic;
      content += "\n" + stamp();
      finish(subtitle, content);
    });
  });
})();
