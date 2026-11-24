/**
 * iKuuu 自动签到（Loon cron / generic 脚本）
 *
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 *
 * 参数（插件 [Argument] 传入的对象）：
 *   cookie       可选，手动填写的 Cookie；留空则用 ikuuu-cookie.js 自动抓取的值
 *   notify       可选，是否发系统通知，默认 true
 *   requestNode  可选，节点名 / 策略组名 / DIRECT；留空跟随规则
 *   parallel     可选，true 时签到和读流量同时发出（省一次往返）；
 *                真签到成功时用「流量页读数 + 签到赠送」算剩余流量（约值）
 *
 * 流程：POST https://ikuuu.org/user/checkin → 解析 {ret, msg} → 再 GET /user 读剩余流量
 * 并行模式：两个请求同时发，剩余流量 = 页面读数 + 签到赠送（≈）；串行模式仍取签到后的准确值
 * 日志里分段打点（签到返回 / 流量页 / 解码 / 总耗时），方便判断耗时花在哪一段。
 * 通知内容只保留：服务器 msg + 剩余流量（不加时间、不报今日已用）
 * 请求失败（含偶发证书错误）自动重试，最多 3 次。
 * Cookie 里带 expire_in（Unix 秒），剩余 ≤ 2 天时单独提醒一次（每张票每天最多一次）。
 */
(function () {
  "use strict";

  var HOST = "https://ikuuu.org";
  var COOKIE_KEY = "ikuuu_org_cookie";
  var EXPIRE_WARN_KEY = "ikuuu_expire_warn";
  var EXPIRE_WARN_DAYS = 2;
  var MAX_ATTEMPTS = 3;
  // 版本 + 总耗时：Loon 日志只给一行结果，这个用来量「签到」和「读流量」各占多少
  var VERSION = "2026-11-24 叠加版";
  var T0 = Date.now();
  var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  var args = ($argument && typeof $argument === "object") ? $argument : {};
  var manualCookie = (args.cookie === null || args.cookie === undefined)
    ? "" : String(args.cookie);
  var notifyEnabled = args.notify !== false;
  var expireInfo = args.expireInfo !== false;
  var requestNode = (args.requestNode === null || args.requestNode === undefined)
    ? "" : String(args.requestNode).trim();
  // 并行读流量：签到和流量同时请求，省掉一次串行往返；
  // 代价是流量可能读到签到落库前的值（真签到成功时通知里会标注「签到前」）
  var parallel = args.parallel === true ||
    String(args.parallel === null || args.parallel === undefined ? "" : args.parallel) === "true";

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

  /* ---------- Cookie 剩余有效期（站点在 Cookie 里带 expire_in，Unix 秒） ---------- */

  function parseExpireTs(cookieStr) {
    var m = String(cookieStr || "").match(/(?:^|;\s*)expire_in=([\d.]+)/);
    if (!m) return 0;
    var ts = Math.floor(parseFloat(m[1]));
    if (ts > 1e12) ts = Math.floor(ts / 1000); // 万一站点改成毫秒
    return ts > 0 ? ts : 0;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function formatTs(ts) {
    var d = new Date(ts * 1000);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function todayStamp() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /**
   * 剩余 ≤ 2 天时单独提醒一次（每张票每天最多提醒一次，重新登录换了 expire_in 会重新计）。
   * 已过期不在这里提醒：签到请求会失败，由「Cookie 已失效」通知兜底。
   */
  function checkCookieExpire() {
    var ts = parseExpireTs(cookie);
    if (!ts) return;
    var leftMs = ts * 1000 - Date.now();
    if (leftMs <= 0) {
      console.log("[iKuuu] Cookie 已在 " + formatTs(ts) + " 过期");
      return;
    }
    var days = Math.ceil(leftMs / 86400000);
    if (days > EXPIRE_WARN_DAYS) return;

    var stamp = todayStamp() + "|" + ts;
    var last = "";
    try {
      last = String($persistentStore.read(EXPIRE_WARN_KEY) || "");
    } catch (e) {}
    if (last === stamp) {
      console.log("[iKuuu] 今天已经提醒过 Cookie 即将过期");
      return;
    }
    if (!notifyEnabled) {
      console.log("[iKuuu] Cookie 即将过期（" + formatTs(ts) + "），通知已关闭");
      return;
    }

    try {
      $persistentStore.write(stamp, EXPIRE_WARN_KEY);
    } catch (e) {}
    try {
      $notification.post("iKuuu Cookie 即将过期", "还剩约 " + days + " 天",
        "到期时间：" + formatTs(ts) + "\n" +
        "请在 Safari 打开 https://ikuuu.org 重新登录一次；" +
        "抓取 Cookie 开着会自动覆盖旧值，关着的话把新 Cookie 填到插件参数里。");
    } catch (e) {
      console.log("[iKuuu] 过期提醒发送失败：" + e);
    }
    console.log("[iKuuu] 已提醒 Cookie 即将过期：" + formatTs(ts));
  }

  /**
   * 请求参数。
   * insecure：Loon 对 ikuuu.org 的 MITM 会让脚本请求拿到 Loon CA 签的证书，必须跳过校验。
   * node：可把请求固定到某个节点/策略组，用来排除线路或节点证书问题。
   */
  function requestOptions(url, headers) {
    var options = {
      url: url,
      timeout: 15000,
      insecure: true,
      headers: headers
    };
    if (requestNode) options.node = requestNode;
    return options;
  }

  /**
   * 通知里显示 CK 剩余天数（插件里「CK 剩余天数」开关控制）。
   * 没有 expire_in 或开关关闭时返回空串。
   */
  function expireText() {
    if (!expireInfo) return "";
    var ts = parseExpireTs(cookie);
    if (!ts) return "";
    var leftMs = ts * 1000 - Date.now();
    if (leftMs <= 0) return "CK：已过期（" + formatTs(ts) + "）";
    return "CK 剩余：" + Math.ceil(leftMs / 86400000) + " 天（" + formatTs(ts) + " 到期）";
  }

  function finish(subtitle, content) {
    var text = String(content);
    var info = expireText();
    if (info) text += "\n" + info;
    if (notifyEnabled) {
      try {
        $notification.post("iKuuu 签到", subtitle, text);
      } catch (e) {
        console.log("[iKuuu] 通知发送失败：" + e);
      }
    }
    console.log("[iKuuu] " + subtitle + " | " + text.replace(/\n/g, " / "));
    console.log("[iKuuu] " + VERSION + " 总耗时 " + (Date.now() - T0) + "ms" +
      (parallel ? "（并行读流量）" : ""));
    $done();
  }

  /* ---------- Base64 / UTF-8（站点页面被 base64 包在 var originBody 里） ---------- */

  var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // 字符码 → base64 值（-1 = 非法）。比每个字符都 B64_CHARS.indexOf() 快得多：
  // 用户页整页 base64 包在 originBody 里，按字符线性找值曾是几十毫秒。
  var B64_TABLE = (function () {
    var t = [];
    for (var i = 0; i < 256; i++) t[i] = -1;
    for (var j = 0; j < 64; j++) t[B64_CHARS.charCodeAt(j)] = j;
    return t;
  })();

  /**
   * UTF-8 解码。HTML 里 ASCII 占大头，连续 ASCII 用 String.fromCharCode.apply
   * 整段拼（一次 2048 个），比逐字符 += 快一个数量级；中文等多字节再单独处理。
   */
  function utf8Decode(bytes) {
    var out = "";
    var run = [];
    var CHUNK = 2048;
    var i = 0;
    var n = bytes.length;
    while (i < n) {
      var b = bytes[i];
      if (b < 0x80) {
        run.push(b);
        i++;
        if (run.length >= CHUNK) {
          out += String.fromCharCode.apply(null, run);
          run.length = 0;
        }
        continue;
      }
      if (run.length) {
        out += String.fromCharCode.apply(null, run);
        run.length = 0;
      }
      if (b < 0xC0) {
        i++; // 孤立的续字节，跳过
      } else if (b < 0xE0) {
        out += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1] & 0x3F));
        i += 2;
      } else if (b < 0xF0) {
        out += String.fromCharCode(((b & 0x0F) << 12) |
          ((bytes[i + 1] & 0x3F) << 6) | (bytes[i + 2] & 0x3F));
        i += 3;
      } else {
        var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3F) << 12) |
          ((bytes[i + 2] & 0x3F) << 6) | (bytes[i + 3] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
        i += 4;
      }
    }
    if (run.length) out += String.fromCharCode.apply(null, run);
    return out;
  }

  /** base64 → 字节。4 个字符一组写 Uint8Array，比逐字符 push 进普通数组快约 40% */
  function base64ToBytes(str) {
    var s = String(str);
    var n = s.length;
    var out = new Uint8Array((n >> 2) * 3 + 3);
    var k = 0;
    for (var i = 0; i + 3 < n; i += 4) {
      var v0 = B64_TABLE[s.charCodeAt(i) & 0xFF];
      var v1 = B64_TABLE[s.charCodeAt(i + 1) & 0xFF];
      var v2 = B64_TABLE[s.charCodeAt(i + 2) & 0xFF];
      var v3 = B64_TABLE[s.charCodeAt(i + 3) & 0xFF];
      if (v0 < 0) break;
      out[k++] = (v0 << 2) | (v1 >> 4);
      if (v2 < 0) break;
      out[k++] = ((v1 & 15) << 4) | (v2 >> 2);
      if (v3 < 0) break;
      out[k++] = ((v2 & 3) << 6) | v3;
    }
    return out.subarray(0, k);
  }

  /** 整页 base64 → 字符串（兜底路径才用，整页解码要几十毫秒） */
  function base64Decode(str) {
    return utf8Decode(base64ToBytes(str));
  }

  /** 字符串 → UTF-8 字节（只用来在页面里搜中文标签） */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      } else if (c >= 0xD800 && c < 0xDC00) {
        var cp = 0x10000 + ((c - 0xD800) << 10) + (s.charCodeAt(++i) - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F),
          0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else {
        out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      }
    }
    return out;
  }

  function indexOfBytes(bytes, pat, from) {
    var n = bytes.length;
    var m = pat.length;
    if (!m) return -1;
    var first = pat[0];
    for (var i = from || 0; i <= n - m; i++) {
      if (bytes[i] !== first) continue;
      var j = 1;
      while (j < m && bytes[i + j] === pat[j]) j++;
      if (j === m) return i;
    }
    return -1;
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

  /**
   * 从页面里取「剩余流量」的值。
   * 用户页正文是 base64 包在 var originBody 里的，整页解码要几十毫秒；
   * 这里只把 base64 解成字节，在字节里定位标签的 UTF-8，再只解码标签附近一小段。
   * 找不到标签（或附近没有数字）时退回整页解码，行为与原来一致。
   */
  function extractTraffic(data, label) {
    var text = String(data || "");
    var m = text.match(/var\s+originBody\s*=\s*["']([^"']+)["']/);
    if (!m) return pick(text, label);

    try {
      var bytes = base64ToBytes(m[1]);
      var pat = utf8Bytes(label);
      var counter = [99, 111, 117, 110, 116, 101, 114]; // "counter"
      var at = -1;
      var tries = 0;
      while ((at = indexOfBytes(bytes, pat, at + 1)) >= 0) {
        // 标签后面 500 字节内没有 counter 的，不是流量卡片（菜单、说明文字），直接跳过
        var probe = bytes.subarray(at, Math.min(bytes.length, at + 500));
        if (indexOfBytes(probe, counter, 0) < 0) continue;
        if (++tries > 8) break;
        var from = Math.max(0, at - 200);
        var to = Math.min(bytes.length, at + 1200);
        var hit = pick(utf8Decode(bytes.subarray(from, to)), label);
        if (hit) return hit;
      }
    } catch (e) {
      console.log("[iKuuu] 字节定位失败，退回整页解码：" + e);
    }
    return pick(extractHtml(data), label);
  }

  /* ---------- 容量换算（并行模式要用签到赠送量做加法） ---------- */

  var SIZE_MULT = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
    PB: 1024 * 1024 * 1024 * 1024 * 1024
  };

  /** "12.34 GB" / "1767 MB流量" → 字节数；解析不出来返回 null */
  function sizeToBytes(text) {
    var m = String(text || "").match(/([\d,]+(?:\.\d+)?)\s*([KMGTP]?B|[KMGTP])(?![A-Za-z])/i);
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, ""));
    if (!isFinite(n) || n < 0) return null;
    var unit = m[2].toUpperCase();
    if (unit.length === 1) unit += "B"; // 兼容 "500M" / "1.5G"
    var mult = SIZE_MULT[unit];
    return mult ? n * mult : null;
  }

  /** 字节数 → 通知里的显示值（≥1 GB 保留两位小数，与页面口径一致） */
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !isFinite(bytes)) return "";
    if (bytes >= SIZE_MULT.GB) return (Math.round(bytes / SIZE_MULT.GB * 100) / 100).toFixed(2) + " GB";
    if (bytes >= SIZE_MULT.MB) {
      var mb = bytes / SIZE_MULT.MB;
      return (mb >= 100 ? Math.round(mb) : Math.round(mb * 10) / 10) + " MB";
    }
    if (bytes >= SIZE_MULT.KB) {
      var kb = bytes / SIZE_MULT.KB;
      return (kb >= 100 ? Math.round(kb) : Math.round(kb * 10) / 10) + " KB";
    }
    return Math.round(bytes) + " B";
  }

  /** "232.95 GB" → "232.95GB"：加数行里去掉单位前的空格，紧凑一点 */
  function compactSize(text) {
    return String(text || "").replace(/\s+/g, "");
  }

  /**
   * 从签到响应里取当天赠送的流量。
   * 站点实际返回形如 {"ret":1,"msg":"你获得了 1767 MB流量"}；
   * 消息里没有「流量」二字（比如「获得 1 次抽奖机会」）时一律不认，避免误加。
   */
  function parseBonus(msg) {
    var s = String(msg || "");
    if (!s || !/流量/.test(s)) return null;
    var m = s.match(/(?:获得|獲得|赠送|贈送)\s*了?\s*([\d,]+(?:\.\d+)?)\s*([KMGTP]?B|[KMGTP])(?![A-Za-z])/i);
    // 兜底只认「数字+单位」后面紧跟「流量」的写法（"1767 MB流量"），
    // 避免把消息里别的容量（比如今日已用）当赠送量
    if (!m) m = s.match(/([\d,]+(?:\.\d+)?)\s*([KMGTP]?B|[KMGTP])(?=\s*流量)/i);
    if (!m) return null;
    var bytes = sizeToBytes(m[0]);
    if (bytes === null) return null;
    var unit = m[2].toUpperCase();
    if (unit.length === 1) unit += "B";
    return { bytes: bytes, text: m[1].replace(/,/g, "") + " " + unit };
  }

  /* ---------- 流量播报（失败不影响签到结果） ---------- */

  function fetchTraffic(callback, attempt) {
    attempt = attempt || 1;
    var started = Date.now();
    $httpClient.get(requestOptions(HOST + "/user", {
      "Cookie": cookie,
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": HOST + "/user"
    }), function (error, response, data) {
      if (error && attempt < 2) {
        return setTimeout(function () {
          fetchTraffic(callback, attempt + 1);
        }, 1000);
      }
      if (error || !data) {
        console.log("[iKuuu] 读流量失败 t=" + (Date.now() - T0) + "ms：" + (error || "空响应"));
        return callback(null);
      }
      var result = null;
      try {
        var t = Date.now();
        var rest = extractTraffic(data, "剩余流量");
        var decodeMs = Date.now() - t;
        if (rest) result = { line: "剩余流量：" + rest, value: rest, bytes: sizeToBytes(rest) };
        console.log("[iKuuu] 流量页 t=" + (Date.now() - T0) + "ms 请求 " + (t - started) +
          "ms 解码 " + decodeMs + "ms 大小 " + String(data).length + "B");
      } catch (e) {
        console.log("[iKuuu] 解析流量失败：" + e);
      }
      callback(result);
    });
  }

  /* ---------- 主流程 ---------- */

  /**
   * 解析签到响应，返回 { subtitle, body, checked, fail }：
   *   checked=true 表示这一次真的签到成功（可能有流量赠送）
   *   fail=true    表示请求/响应异常，按原逻辑不再去读流量
   */
  function handleCheckin(error, response, data, attempts) {
    if (error) {
      var errText = String(error);
      if (/certificate|SSL|TLS/i.test(errText)) {
        return {
          fail: true,
          subtitle: "TLS 校验失败",
          body: [
            "签到请求连续 " + attempts + " 次没通过证书校验（insecure=true 已开启）。",
            "① 在插件「请求节点」里指定一个节点/策略组，排除线路或节点证书问题；",
            "② 检查 Loon 的 MITM 证书是否安装并在系统里信任；",
            "③ 不需要自动抓 Cookie 的话，删掉插件源码里的 [Mitm] 段、改用手动 Cookie。",
            "",
            errText.slice(0, 160)
          ].join("\n")
        };
      }
      return {
        fail: true,
        subtitle: "请求失败",
        body: "签到接口请求出错（已试 " + attempts + " 次）：" + errText
      };
    }

    var status = (response && response.status) ? response.status : 0;
    var text = String(data === null || data === undefined ? "" : data).trim();
    var json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {}

    if (!json || typeof json !== "object") {
      if (status === 302 || /<html|<script/i.test(text)) {
        return {
          fail: true,
          subtitle: "Cookie 已失效",
          body: "服务器返回的是登录页，请在 Safari 重新登录 ikuuu.org（插件会自动更新 Cookie）。"
        };
      }
      return {
        fail: true,
        subtitle: "签到失败",
        body: "返回内容无法解析（HTTP " + status + "）：" + text.slice(0, 120)
      };
    }

    var ret = Number(json.ret);
    var msg = String(json.msg || "").trim() || "服务器没有返回说明";
    var already = /已经?签到|重复签到|签到过了|明天再来/.test(msg);
    var subtitle;
    if (ret === 1) {
      subtitle = "签到成功";
    } else if (already) {
      subtitle = "今日已签到";
    } else if (/未登录|登录.*(?:失效|过期)|请重新登录|请先登录/.test(msg)) {
      subtitle = "Cookie 已失效";
    } else {
      subtitle = "签到失败";
    }

    // 赠送量优先用响应里的 traffic 字段（部分面板直接给 "1.73 GB"），
    // 没有就回到消息里解析（站点实际返回：「你获得了 1767 MB流量」）
    var bonus = null;
    var trafficField = json.traffic || json.trafficInfo;
    if (trafficField) {
      var fieldBytes = sizeToBytes(String(trafficField));
      if (fieldBytes !== null) bonus = { bytes: fieldBytes, text: String(trafficField).trim() };
    }
    if (!bonus) bonus = parseBonus(msg);

    return { subtitle: subtitle, body: msg, checked: ret === 1, bonus: bonus };
  }

  function attemptCheckin(attempt, callback) {
    $httpClient.post(requestOptions(HOST + "/user/checkin", {
      "Cookie": cookie,
      "User-Agent": UA,
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Referer": HOST + "/user",
      "Origin": HOST,
      "X-Requested-With": "XMLHttpRequest"
    }), function (error, response, data) {
      if (error && attempt < MAX_ATTEMPTS) {
        console.log("[iKuuu] 第 " + attempt + " 次请求失败：" + error + "，1.5 秒后重试");
        return setTimeout(function () {
          attemptCheckin(attempt + 1, callback);
        }, 1500);
      }
      console.log("[iKuuu] 签到返回 t=" + (Date.now() - T0) + "ms 第 " + attempt + " 次");
      callback(handleCheckin(error, response, data, attempt));
    });
  }

  if (!cookie) {
    return finish("没有 Cookie", [
      "还没拿到登录 Cookie。",
      "① 把插件的「抓取 Cookie」开关打开，再在 Safari 打开 https://ikuuu.org 登录一次；",
      "② 或在插件设置的 Cookie 里手动粘贴。"
    ].join("\n"));
  }

  checkCookieExpire();

  if (!parallel) {
    // 默认串行：签到落库之后才读流量，数字是签到后的准确值（多一次往返）
    attemptCheckin(1, function (r) {
      if (r.fail) return finish(r.subtitle, r.body);
      fetchTraffic(function (traffic) {
        finish(r.subtitle, r.body + (traffic ? "\n" + traffic.line : ""));
      });
    });
    return;
  }

  // 并行：流量和签到同时发出，省掉一次串行往返。
  // 流量页在签到落库前生成时只是个「签到前」的读数，所以真签到成功时
  // 用签到消息里的赠送量做一次加法，把当天赠送补回来（约值）。
  // 发送顺序上让流量请求先走，尽量让页面落在签到落库之前，加法才成立。
  var left = 2;
  var checkinResult = null;
  var traffic = null;
  var bonus = null;
  function merge() {
    if (--left > 0) return;
    var body = checkinResult ? checkinResult.body : "";
    var line = traffic ? traffic.line : "";
    if (traffic && bonus && traffic.bytes !== null) {
      var total = traffic.bytes + bonus.bytes;
      // 加数单独一行：页面读数 || 签到赠送（去掉单位前的空格，方便一眼对账）
      body += (body ? "\n" : "") + "页面·签到 " + compactSize(traffic.value) +
        "||" + compactSize(bonus.text);
      line = "剩余流量：≈ " + formatBytes(total);
      console.log("[iKuuu] 剩余流量 页面=" + traffic.value + " 签到=" + bonus.text +
        " 合计=" + formatBytes(total));
    } else if (traffic && checkinResult && checkinResult.checked) {
      line = "剩余流量：" + traffic.value + "（签到前）";
    }
    if (line) body += (body ? "\n" : "") + line;
    finish(checkinResult ? checkinResult.subtitle : "签到失败", body);
  }
  fetchTraffic(function (t) {
    traffic = t;
    merge();
  });
  attemptCheckin(1, function (r) {
    checkinResult = r;
    bonus = r && r.checked ? r.bonus : null;
    merge();
  });
})();
