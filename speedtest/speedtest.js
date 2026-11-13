/*
 * Loon 节点测速 / Loon Node Speedtest
 * 只测一个节点：优先用入口节点（从节点/策略组入口运行），否则用参数里的节点名，
 * 再否则测策略组中当前选中的节点。不修改任何选择。
 * 需要 Loon 3.5.1 (983)+
 */
(function () {
  "use strict";

  var VERSION = "1.0.0";
  var STORE_KEY = "loon_node_speedtest_last";
  var DEFAULT_TEST_URL = "https://speed.cloudflare.com/__down?bytes={bytes}";
  var DEFAULT_LATENCY_URL = "https://speed.cloudflare.com/__down?bytes=0";

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

  function fail(message, detail) {
    log("FAILED: " + message + (detail ? " | " + detail : ""));
    postNotify("节点测速", "❌ 无法开始", message + (detail ? "\n" + detail : ""));
    ldone({});
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
      test_url: "testURL",
      url: "testURL",
      latency_url: "latencyURL",
      ping_url: "latencyURL",
      size_mb: "sizeMB",
      size: "sizeMB",
      latency_samples: "latencySamples",
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

  function buildOptions(arg) {
    return {
      policyGroup: toStr(arg.policyGroup, ""),
      nodeName: toStr(arg.nodeName, ""),
      sizeMB: toNum(arg.sizeMB, 10, 1, 200),
      testURL: toStr(arg.testURL, DEFAULT_TEST_URL),
      latencyURL: toStr(arg.latencyURL, DEFAULT_LATENCY_URL),
      latencySamples: toNum(arg.latencySamples, 2, 0, 5),
      timeout: toNum(arg.timeout, 20, 3, 120),
      notify: toBool(arg.notify, true),
      enabled: toBool(arg.enabled, true)
    };
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

  // 找出「当前选中的是可测节点」的策略组，供未指定节点时回退
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

  function buildURL(bytes) {
    return OPT.testURL
      .replace(/\{bytes\}/g, String(bytes))
      .replace(/\{size\}/g, String(bytes))
      .replace(/\{mb\}/g, String(bytes / 1024 / 1024));
  }

  function buildTestURL() {
    return buildURL(Math.round(OPT.sizeMB * 1024 * 1024));
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
          headers: { "Cache-Control": "no-cache", "Accept": "*/*" }
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

  // 预热：先用小请求建立到测速主机的连接，避免把 TLS 握手算进下载耗时
  function warmup(node, callback) {
    var bytes = Math.min(256 * 1024, Math.round(OPT.sizeMB * 1024 * 1024));
    if (bytes < 32 * 1024) return callback();
    try {
      $httpClient.get({
        url: buildURL(bytes),
        node: node,
        timeout: OPT.timeout * 1000,
        "binary-mode": true,
        "auto-cookie": false,
        insecure: true,
        headers: { "Accept-Encoding": "identity", "Cache-Control": "no-cache" }
      }, function () {
        callback();
      });
    } catch (e) {
      callback();
    }
  }

  function download(node, callback) {
    var url = buildTestURL();
    var started = Date.now();
    try {
      $httpClient.get({
        url: url,
        node: node,
        timeout: OPT.timeout * 1000,
        "binary-mode": true,
        "auto-cookie": false,
        insecure: true,
        headers: {
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        }
      }, function (error, response, data) {
        var ms = Date.now() - started;
        if (error) return callback({ ok: false, error: String(error), ms: ms });

        var status = response && response.status ? Number(response.status) : 0;
        if (status && (status < 200 || status >= 400)) {
          return callback({ ok: false, error: "HTTP " + status, ms: ms });
        }

        var bytes = 0;
        if (data) {
          if (typeof data === "string") bytes = data.length;
          else bytes = data.byteLength || data.length || 0;
        }
        if (bytes < 1024) return callback({ ok: false, error: "响应为空", ms: ms });
        if (ms <= 0) return callback({ ok: false, error: "计时异常", ms: ms });

        callback({ ok: true, bytes: bytes, ms: ms });
      });
    } catch (e) {
      callback({ ok: false, error: "请求异常", ms: Date.now() - started });
    }
  }

  function testNode(node, group, callback) {
    var result = {
      node: node,
      group: group || "",
      latency: null,
      jitter: null,
      speed: null,
      bytes: 0,
      duration: 0,
      error: "",
      ok: false
    };
    var needLatency = OPT.latencySamples > 0;

    function done() {
      if (result.speed !== null || result.latency !== null) result.ok = true;
      log(
        node + " -> " +
        (result.speed !== null ? fmtSpeed(result.speed) : "speed n/a") + " / " +
        (result.latency !== null ? Math.round(result.latency) + "ms" : "latency n/a") +
        (result.error ? " / " + result.error : "")
      );
      callback(result);
    }

    function speedPhase() {
      warmup(node, function () {
        download(node, function (info) {
          if (!info.ok) {
            if (!result.error) result.error = info.error || "下载失败";
            return done();
          }
          result.bytes = info.bytes;
          result.duration = info.ms;
          result.speed = (info.bytes * 8) / info.ms / 1000;
          result.error = "";
          done();
        });
      });
    }

    if (needLatency) {
      ping(node, function (samples) {
        if (samples.length) {
          result.latency = Math.min.apply(null, samples);
          result.jitter = Math.max.apply(null, samples) - result.latency;
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
      lines.push("下载  " + fmtSpeed(result.speed));
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

    if (result.group) lines.push("策略组  " + result.group);
    lines.push("耗时  " + elapsed + "s");

    if (result.speed === null && result.latency === null) {
      lines.push("可检查测速地址是否可访问，或换一个节点再试");
    }

    var body = lines.join("\n");
    var head = result.node.length > 24 ? result.node.slice(0, 23) + "…" : result.node;
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

    if (OPT.notify) postNotify("节点测速", subtitle, body);
    ldone({});
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

    var config = readConfig();
    var groups = groupNames(config);

    var node = envNode || OPT.nodeName;
    var group = envGroup || OPT.policyGroup;

    if (!node) {
      if (!group || /^(auto|自动)$/i.test(group)) group = findGroupWithSelection(groups) || group;
      if (group) {
        var selected = selectedOf(group);
        // 选中的若是子策略组，它会返回自己的选择；真实节点则返回空
        var nested = selected ? selectedOf(selected) : "";
        if (nested) {
          group = selected;
          selected = nested;
        }
        node = selected;
      }
    }

    if (!node) {
      return fail("没有可测试的节点", "请先在策略组里选中一个节点，或填写节点名；也可从节点详情运行本脚本");
    }

    log("start: node=" + node + ", group=" + (group || "?") + ", size=" + OPT.sizeMB + "MB, url=" + buildTestURL());

    testNode(node, group, finish);
  }

  try {
    start();
  } catch (e) {
    fail("脚本运行出错", String(e && e.message ? e.message : e));
  }
})();
