/*
 * Loon 带宽 / 节点测速
 * 默认测「本地直连」带宽（不走代理，测自家宽带）；也可改测指定节点或当前节点。
 * 绝不切换策略组。需要 Loon 3.5.1 (983)+
 */
(function () {
  "use strict";

  var VERSION = "1.1.0";
  var STORE_KEY = "loon_bandwidth_speedtest_last";

  var TENCENT_TEST_URL = "https://dlied4.myapp.com/myapp/1104466820/cos.release-40109/10040714_com.tencent.tmgp.sgame_a2480356_8.2.1.9_F0BvnI.apk";
  var CLOUDFLARE_TEST_URL = "https://speed.cloudflare.com/__down?bytes={bytes}";
  var CLOUDFLARE_LATENCY_URL = "https://speed.cloudflare.com/__down?bytes=0";
  // Surge 内置测速用的就是 speed.cloudflare.com（二进制里只有 __up/__down 这一处域名）
  var LOCAL_TEST_URL = TENCENT_TEST_URL;
  var LOCAL_LATENCY_URL = CLOUDFLARE_LATENCY_URL;
  var LOCAL_FALLBACK_URL = "https://mirrors.tuna.tsinghua.edu.cn/speedtest/100mb.bin";
  var NODE_FALLBACK_URL = "https://hkg.download.datapacket.com/100mb.bin";
  // 清华源等镜像会拦截浏览器/Loon 的 UA（403），用 curl 的 UA 放行
  var USER_AGENT = "curl/8.5.0";

  var DONE = false;
  var START_TS = Date.now();
  var OPT = null;

  /* ---------------------------------------------------------------- 基础工具 */

  function ldone(payload) {
    if (DONE) return;
    DONE = true;
    try {
      if (typeof $done === "function") $done(payload || {});
    } catch (e) {
      // ignore
    }
  }

  function log(text) {
    try {
      console.log("[speedtest] " + text);
    } catch (e) {
      // ignore
    }
  }

  function postNotify(title, subtitle, body) {
    try {
      if (typeof $notification !== "undefined" && $notification && $notification.post) {
        $notification.post(title, subtitle, body);
      }
    } catch (e) {
      log("notification failed: " + e);
    }
  }

  function panelPayload(title, message) {
    try {
      if (typeof $loon !== "undefined") return { title: title, message: message };
    } catch (e) {
      // ignore
    }
    return {};
  }

  function fail(message, detail) {
    log("FAILED: " + message + (detail ? " | " + detail : ""));
    postNotify("测速", "❌ 无法开始", message + (detail ? "\n" + detail : ""));
    ldone(panelPayload("带宽测速", message + (detail ? "\n" + detail : "")));
  }

  function toStr(value, fallback) {
    if (value === undefined || value === null) return fallback;
    var text = String(value).trim();
    return text === "" ? fallback : text;
  }

  function toNum(value, fallback, min, max) {
    var n = (value === undefined || value === null || value === "") ? NaN : Number(value);
    if (!isFinite(n)) n = fallback;
    if (typeof min === "number" && n < min) n = min;
    if (typeof max === "number" && n > max) n = max;
    return n;
  }

  function toBool(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    var text = String(value).trim().toLowerCase();
    if (text === "true" || text === "1" || text === "yes" || text === "on") return true;
    if (text === "false" || text === "0" || text === "no" || text === "off") return false;
    return fallback;
  }

  function fmtSpeed(mbps) {
    if (typeof mbps !== "number" || !isFinite(mbps)) return "--";
    if (mbps >= 100) return mbps.toFixed(0) + " Mbps";
    if (mbps >= 10) return mbps.toFixed(1) + " Mbps";
    return mbps.toFixed(2) + " Mbps";
  }

  function fmtMB(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "--";
    return (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  }

  function bytesOf(data) {
    if (!data) return 0;
    if (typeof data === "string") return data.length;
    return data.byteLength || data.length || 0;
  }

  /* ---------------------------------------------------------------- 参数解析 */

  function normalizeArgument(raw) {
    var src = raw;

    if (typeof src === "string") {
      var text = src.trim();
      if (!text) {
        src = {};
      } else if (text.charAt(0) === "{") {
        try {
          src = JSON.parse(text);
        } catch (e) {
          src = {};
        }
      } else {
        var obj = {};
        text.split("&").forEach(function (pair) {
          if (!pair) return;
          var idx = pair.indexOf("=");
          var key = idx < 0 ? pair : pair.slice(0, idx);
          var value = idx < 0 ? "" : pair.slice(idx + 1);
          try {
            key = decodeURIComponent(key);
            value = decodeURIComponent(value);
          } catch (e) {
            // keep raw
          }
          if (key) obj[key] = value;
        });
        src = obj;
      }
    }

    if (!src || typeof src !== "object") src = {};

    var alias = {
      policy_group: "policyGroup",
      group: "policyGroup",
      node: "nodeName",
      node_name: "nodeName",
      mode: "target",
      test_url: "testURL",
      url: "testURL",
      fallback_url: "fallbackURL",
      backup_url: "fallbackURL",
      latency_url: "latencyURL",
      ping_url: "latencyURL",
      size_mb: "sizeMB",
      size: "sizeMB",
      latency_samples: "latencySamples",
      concurrency: "threads",
      connections: "threads",
      ping_times: "latencySamples"
    };

    var out = {};
    Object.keys(src).forEach(function (key) {
      var value = src[key];
      out[key] = value;
      if (alias[key]) out[alias[key]] = value;
    });
    return out;
  }

  function normalizeTarget(value) {
    var text = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
    if (!text) return "auto";
    if (text.indexOf("自动") >= 0 || text === "auto") return "auto";
    if (text.indexOf("本地") >= 0 || text.indexOf("直连") >= 0 || text === "direct" || text === "local") return "direct";
    if (text.indexOf("当前") >= 0 || text === "current") return "current";
    if (text.indexOf("指定") >= 0 || text.indexOf("节点") >= 0 || text === "node") return "node";
    return "auto";
  }

  function buildOptions(arg) {
    return {
      target: normalizeTarget(arg.target),
      policyGroup: toStr(arg.policyGroup, ""),
      nodeName: toStr(arg.nodeName, ""),
      sizeMB: toNum(arg.sizeMB, 10, 1, 1000),
      testURL: toStr(arg.testURL, ""),
      fallbackURL: toStr(arg.fallbackURL, ""),
      latencyURL: toStr(arg.latencyURL, ""),
      latencySamples: toNum(arg.latencySamples, 2, 0, 5),
      threads: toNum(arg.threads, 1, 1, 8),
      chunkBytes: toNum(arg.chunkBytes, 95000000, 65536, 95000000),
      timeout: toNum(arg.timeout, 20, 3, 120),
      notify: toBool(arg.notify, true),
      enabled: toBool(arg.enabled, true)
    };
  }

  function resolveURLs() {
    var direct = OPT.target === "direct";
    if (!OPT.testURL) OPT.testURL = direct ? LOCAL_TEST_URL : TENCENT_TEST_URL;
    if (!OPT.latencyURL) OPT.latencyURL = direct ? LOCAL_LATENCY_URL : CLOUDFLARE_LATENCY_URL;
  }

  /* ---------------------------------------------------------------- 配置读取 */

  function readConfig() {
    try {
      if (typeof $config !== "undefined" && $config && typeof $config.getConfig === "function") {
        var text = $config.getConfig();
        if (text) return JSON.parse(text);
      }
    } catch (e) {
      log("getConfig failed: " + e);
    }
    return {};
  }

  function groupNames(config) {
    var raw = config.all_policy_groups || config.policy_groups || [];
    var out = [];
    if (!raw || typeof raw.length !== "number") return out;
    for (var i = 0; i < raw.length; i++) {
      var item = raw[i];
      if (typeof item === "string" && item) {
        out.push(item);
      } else if (item && typeof item === "object") {
        var name = item.name || item.tag || item.group || item.policy || "";
        if (name) out.push(name);
      }
    }
    return out;
  }

  function selectedOf(group) {
    try {
      if (typeof $config !== "undefined" && $config && typeof $config.getSelectedPolicy === "function") {
        return toStr($config.getSelectedPolicy(group), "");
      }
    } catch (e) {
      log("getSelectedPolicy failed: " + e);
    }
    return "";
  }

  // 找出「当前选中的是可测节点」的策略组
  function findGroupWithSelection(groups) {
    var fallback = "";
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var selected = selectedOf(group);
      if (!selected) continue;
      if (groups.indexOf(selected) >= 0) {
        if (!fallback) fallback = group;
        continue;
      }
      return group;
    }
    return fallback;
  }

  /* ---------------------------------------------------------------- 测速动作 */

  function buildURL(bytes, url) {
    return url
      .replace(/\{bytes\}/g, String(bytes))
      .replace(/\{size\}/g, String(bytes))
      .replace(/\{mb\}/g, String(bytes / 1024 / 1024));
  }

  function hasPlaceholder(url) {
    return /\{bytes\}|\{size\}/.test(url);
  }

  function baseHeaders(extra) {
    var headers = {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
    };
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) headers[key] = extra[key];
      }
    }
    return headers;
  }

  function ping(node, callback) {
    var attempts = Math.max(1, Math.round(OPT.latencySamples));
    var samples = [];
    var i = 0;

    function one() {
      if (i >= attempts) return callback(samples);
      i++;
      var started = Date.now();
      try {
        $httpClient.get({
          url: OPT.latencyURL,
          node: node,
          timeout: OPT.timeout * 1000,
          "auto-cookie": false,
          insecure: true,
          headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache", "Accept": "*/*" }
        }, function (error) {
          if (error) {
            log("ping error: " + error);
          } else {
            samples.push(Date.now() - started);
          }
          one();
        });
      } catch (e) {
        log("ping exception: " + e);
        one();
      }
    }

    one();
  }

  // 固定大小地址：先 HEAD 看是否支持 Range，决定能否切片/多线程
  function probe(node, url, callback) {
    try {
      $httpClient.head({
        url: url,
        node: node,
        timeout: Math.min(OPT.timeout, 15) * 1000,
        "auto-cookie": false,
        insecure: true,
        headers: { "User-Agent": USER_AGENT, "Cache-Control": "no-cache" }
      }, function (error, response) {
        if (error) return callback(null);
        var headers = (response && response.headers) || {};
        var length = Number(headers["Content-Length"] || headers["content-length"] || 0);
        var accept = String(headers["Accept-Ranges"] || headers["accept-ranges"] || "").toLowerCase();
        callback({
          length: isFinite(length) && length > 0 ? length : 0,
          ranges: accept.indexOf("bytes") >= 0
        });
      });
    } catch (e) {
      callback(null);
    }
  }

  // 预热：小请求建连，避免把握手算进下载耗时
  function warmup(node, meta, url, callback) {
    var bytes = Math.min(256 * 1024, Math.round(OPT.sizeMB * 1024 * 1024));
    if (bytes < 32 * 1024) return callback();

    var target = "";
    var headers = null;
    if (hasPlaceholder(url)) {
      target = buildURL(bytes, url);
    } else if (meta && meta.ranges) {
      target = url;
      headers = { "Range": "bytes=0-" + (bytes - 1) };
    } else {
      return callback();
    }

    try {
      $httpClient.get({
        url: target,
        node: node,
        timeout: OPT.timeout * 1000,
        "binary-mode": true,
        "auto-cookie": false,
        insecure: true,
        headers: baseHeaders(headers)
      }, function () {
        callback();
      });
    } catch (e) {
      callback();
    }
  }

  function runSlices(node, url, totalBytes, threads, useRange, maxChunk, fileLength, callback) {
    var started = Date.now();
    var received = 0;
    var active = Math.max(1, threads);
    var firstError = "";
    var firstStatus = 0;
    var finished = false;

    function complete() {
      if (finished) return;
      finished = true;
      var ms = Date.now() - started;
      if (received < 1024) {
        return callback({
          ok: false,
          error: firstError || "响应为空",
          status: firstStatus,
          ms: ms,
          threads: threads
        });
      }
      callback({
        ok: true,
        bytes: received,
        ms: ms,
        threads: threads,
        range: !!useRange,
        partial: !!firstError,
        error: firstError
      });
    }

    function request(chunk, offset, next) {
      var target;
      var headers = null;
      if (useRange) {
        target = url;
        headers = { "Range": "bytes=" + offset + "-" + (offset + chunk - 1) };
      } else {
        target = buildURL(chunk, url);
      }

      try {
        $httpClient.get({
          url: target,
          node: node,
          timeout: Math.max(OPT.timeout, 90) * 1000,
          "binary-mode": true,
          "auto-cookie": false,
          insecure: true,
          headers: baseHeaders(headers)
        }, function (error, response, data) {
          if (error) return next(0, String(error), 0);
          var status = response && response.status ? Number(response.status) : 0;
          if (status && (status < 200 || status >= 400)) {
            return next(0, "HTTP " + status, status);
          }
          var n = bytesOf(data);
          if (n < 1024) return next(0, "响应为空", status);
          next(n, "", status);
        });
      } catch (e) {
        next(0, "请求异常", 0);
      }
    }

    function pull(remaining, offset) {
      if (remaining <= 0) {
        active--;
        if (active <= 0) complete();
        return;
      }

      var start = 0;
      var chunk = Math.min(remaining, maxChunk);
      if (useRange && fileLength > 0) {
        // 顺序读文件不同区间，避免重复请求同一段被 CDN 缓存放大
        start = offset % fileLength;
        chunk = Math.min(chunk, fileLength - start);
      }

      request(chunk, start, function (n, err, status) {
        if (err) {
          if (!firstError) {
            firstError = err;
            firstStatus = status;
          }
          active--;
          if (active <= 0) complete();
          return;
        }
        received += n;
        pull(remaining - chunk, start + chunk);
      });
    }

    var per = Math.floor(totalBytes / threads);
    for (var i = 0; i < threads; i++) {
      var slice = i === threads - 1 ? totalBytes - per * (threads - 1) : per;
      pull(slice, 0);
    }
  }

  // 腾讯 CDN 的固定地址会 302 到带签名的临时地址；先解析出来，再用它发 Range 请求
  function resolveRedirect(node, url, callback) {
    try {
      $httpClient.get({
        url: url,
        node: node,
        timeout: Math.min(OPT.timeout, 20) * 1000,
        "auto-redirect": false,
        "binary-mode": true,
        "auto-cookie": false,
        insecure: true,
        headers: baseHeaders({ "Range": "bytes=0-1023" })
      }, function (error, response) {
        if (error) return callback(url);
        var status = response && response.status ? Number(response.status) : 0;
        if (status >= 300 && status < 400) {
          var headers = (response && response.headers) || {};
          var location = headers["Location"] || headers["location"] || "";
          if (location) return callback(location);
          return callback("");
        }
        callback(url);
      });
    } catch (e) {
      callback(url);
    }
  }

  function downloadOnce(url, node, callback) {
    var totalBytes = Math.round(OPT.sizeMB * 1024 * 1024);
    var threads = Math.max(1, Math.min(8, Math.round(OPT.threads)));
    // Cloudflare 单请求 >= 100,000,000 字节会 403，按块续传
    var MAX_CHUNK = OPT.chunkBytes;

    if (hasPlaceholder(url)) {
      warmup(node, null, url, function () {
        runSlices(node, url, totalBytes, threads, false, MAX_CHUNK, 0, callback);
      });
      return;
    }

    probe(node, url, function (meta) {
      var ranges = !!(meta && meta.ranges);
      var maxChunk = MAX_CHUNK;
      var fileLength = 0;
      if (ranges && meta.length > 0) {
        maxChunk = Math.min(MAX_CHUNK, meta.length);
        fileLength = meta.length;
      }

      if (!ranges) {
        return runSlices(node, url, totalBytes, 1, false, maxChunk, 0, callback);
      }

      resolveRedirect(node, url, function (target) {
        if (target === "") {
          return callback({ ok: false, error: "跳转地址为空", ms: 0, threads: threads });
        }
        warmup(node, meta, target, function () {
          runSlices(node, target, totalBytes, threads, true, maxChunk, fileLength, callback);
        });
      });
    });
  }

  function retryable(info) {
    if (!info) return false;
    if (info.status === 429 || info.status === 503 || info.status === 403) return true;
    return /timeout|超时|SSL|TLS|连接|refused|reset/i.test(info.error || "");
  }

  function download(node, callback) {
    downloadOnce(OPT.testURL, node, function (first) {
      if (first.ok) {
        first.source = OPT.target === "direct" ? "本地直连" : "主源";
        return callback(first);
      }

      // 429/503 多半是共享节点 IP 被限流，等一秒再试一次
      setTimeout(function () {
        downloadOnce(OPT.testURL, node, function (second) {
          if (second.ok) {
            second.source = OPT.target === "direct" ? "本地直连" : "主源（重试）";
            return callback(second);
          }

          if (!OPT.fallbackURL || OPT.fallbackURL === OPT.testURL) return callback(second);
          log("primary failed (" + second.error + "), fallback to " + OPT.fallbackURL);

          downloadOnce(OPT.fallbackURL, node, function (third) {
            if (third.ok) third.source = "备用源";
            else third.error = (third.error || "失败") + "（主源 " + (second.error || "失败") + "）";
            callback(third);
          });
        });
      }, 1200);
    });
  }

  function testNode(node, group, label, callback) {
    var result = {
      node: node,
      group: group || "",
      label: label || "",
      latency: null,
      jitter: null,
      speed: null,
      bytes: 0,
      duration: 0,
      threads: 1,
      source: "",
      error: "",
      ok: false
    };
    var needLatency = OPT.latencySamples > 0;

    function done() {
      if (result.speed !== null || result.latency !== null) result.ok = true;
      log(
        (result.label || result.node) + " -> " +
        (result.speed !== null ? fmtSpeed(result.speed) : "speed n/a") + " / " +
        (result.latency !== null ? Math.round(result.latency) + "ms" : "latency n/a") +
        (result.error ? " / " + result.error : "")
      );
      callback(result);
    }

    function speedPhase() {
      download(node, function (info) {
        if (!info.ok) {
          if (!result.error) result.error = info.error || "下载失败";
          return done();
        }
        result.bytes = info.bytes;
        result.duration = info.ms;
        result.threads = info.threads || 1;
        result.source = info.source || "";
        result.speed = (info.bytes * 8) / info.ms / 1000;
        result.error = info.partial && info.error ? info.error + "（部分连接失败）" : "";
        done();
      });
    }

    if (needLatency) {
      ping(node, function (samples) {
        if (samples.length) {
          // 首个样本含建连/TLS，抖动会被放大，有第二个样本时只用后面的
          var usable = samples.length > 1 ? samples.slice(1) : samples;
          result.latency = Math.min.apply(null, usable);
          result.jitter = Math.max.apply(null, usable) - result.latency;
        }
        speedPhase();
      });
    } else {
      speedPhase();
    }
  }

  /* ---------------------------------------------------------------- 结果输出 */

  function finish(result) {
    var elapsed = Math.round((Date.now() - START_TS) / 1000);
    var lines = [];

    if (result.speed !== null) {
      lines.push("下载  " + fmtSpeed(result.speed) + (result.threads > 1 ? "（" + result.threads + " 线程）" : ""));
      lines.push("数据  " + fmtMB(result.bytes) + " / " + (result.duration / 1000).toFixed(2) + "s");
    } else {
      lines.push("下载  ❌ " + (result.error || "失败"));
    }

    if (result.latency !== null) {
      var latencyLine = "延迟  " + Math.round(result.latency) + " ms";
      if (result.jitter !== null && result.jitter > 0) {
        latencyLine += "（抖动 " + Math.round(result.jitter) + " ms）";
      }
      lines.push(latencyLine);
    } else if (OPT.latencySamples > 0) {
      lines.push("延迟  ❌ 超时");
    }

    if (result.source && result.source !== "本地直连" && result.source !== "主源") {
      lines.push("来源  " + result.source);
    }
    if (result.group) lines.push("策略组  " + result.group);
    lines.push("耗时  " + elapsed + "s");

    if (result.speed === null && result.latency === null) {
      lines.push("检查测速地址能否访问，或换个测速对象再试");
    }

    var body = lines.join("\n");
    var head = result.label || result.node;
    if (head.length > 24) head = head.slice(0, 23) + "…";
    var tail = result.speed !== null ? fmtSpeed(result.speed) : (result.latency !== null ? Math.round(result.latency) + " ms" : "失败");
    var subtitle = head + " · " + tail;

    log("done in " + elapsed + "s\n" + body);

    try {
      if (typeof $persistentStore !== "undefined" && $persistentStore && $persistentStore.write) {
        $persistentStore.write(JSON.stringify({
          version: VERSION,
          time: new Date().toISOString(),
          result: result
        }), STORE_KEY);
      }
    } catch (e) {
      log("persist failed: " + e);
    }

    if (OPT.notify) postNotify("测速", subtitle, body);
    ldone(panelPayload("带宽测速 · " + head, body));
  }

  /* ---------------------------------------------------------------- 流程编排 */

  function start() {
    var raw = typeof $argument !== "undefined" ? $argument : null;
    OPT = buildOptions(normalizeArgument(raw));

    if (!OPT.enabled) {
      log("disabled, exit");
      return ldone({});
    }

    var envNode = "";
    var envGroup = "";
    try {
      if (typeof $environment !== "undefined" && $environment && $environment.params) {
        var params = $environment.params;
        if (typeof params.node === "string") envNode = params.node.trim();
        if (typeof params.policyGroup === "string") envGroup = params.policyGroup.trim();
        if (!envNode && params.nodeInfo) {
          if (typeof params.nodeInfo === "string") {
            envNode = params.nodeInfo;
          } else {
            envNode = toStr(params.nodeInfo.name || params.nodeInfo.remark || params.nodeInfo.tag, "");
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // 自动：从节点入口进来（或填了节点名）就测节点，否则测本地直连
    if (OPT.target === "auto") {
      OPT.target = (envNode || OPT.nodeName) ? "node" : "direct";
    }
    resolveURLs();

    var config = readConfig();
    var groups = groupNames(config);

    var node = "";
    var group = "";
    var label = "";

    if (OPT.target === "direct") {
      node = "DIRECT";
      label = "本地直连";
    } else {
      node = OPT.target === "node" ? (envNode || OPT.nodeName) : "";
      group = OPT.policyGroup || envGroup;

      if (!node) {
        if (!group || /^(auto|自动)$/i.test(group)) group = findGroupWithSelection(groups) || group;
        if (group) {
          var selected = selectedOf(group);
          var nested = selected ? selectedOf(selected) : "";
          if (nested) {
            group = selected;
            selected = nested;
          }
          node = selected;
        }
      }
      label = node;
    }

    if (!node) {
      return fail("没有可测试的节点", "请在策略组里选中节点、填写节点名，或把测速对象改成「本地直连」");
    }

    log(
      "start: target=" + OPT.target + ", node=" + node + ", group=" + (group || "?") +
      ", size=" + OPT.sizeMB + "MB, threads=" + OPT.threads +
      ", url=" + OPT.testURL + ", latency=" + OPT.latencyURL
    );

    testNode(node, group, label, finish);
  }

  try {
    start();
  } catch (e) {
    fail("脚本运行出错", String(e && e.message ? e.message : e));
  }
})();
