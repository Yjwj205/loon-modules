"use strict";

/**
 * Loon 环境模拟器 + speedtest.js 用例
 * 运行: node test.js
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SCRIPT = fs.readFileSync(path.join(__dirname, "speedtest.js"), "utf8");

const TUNA = "https://mirrors.tuna.tsinghua.edu.cn/speedtest/100mb.bin";
const FIXED = "https://example.com/10mb.bin";
const FILES = {
  [TUNA]: 100 * 1024 * 1024,
  [FIXED]: 10 * 1024 * 1024
};

let failures = 0;
let passes = 0;

function assert(cond, name, extra) {
  if (cond) {
    passes++;
    console.log("  ✓ " + name);
  } else {
    failures++;
    console.log("  ✗ " + name + (extra ? "  -> " + extra : ""));
  }
}

function isFixed(url) {
  return !/[?&]bytes=/.test(url);
}

function fileSize(url) {
  if (FILES[url]) return FILES[url];
  const m = /[?&]bytes=(\d+)/.exec(url);
  return m ? Number(m[1]) : 1024 * 1024;
}

function makeRuntime(config) {
  const state = {
    logs: [],
    notifications: [],
    store: {},
    switches: [],
    doneCount: 0,
    requests: []
  };

  const $config = {
    getConfig() {
      return JSON.stringify(config);
    },
    getSelectedPolicy(group) {
      return (config.selected && config.selected[group]) || "";
    },
    getSubPolicies(group, cb) {
      const list = (config.groups && config.groups[group]) || [];
      setTimeout(() => cb(JSON.stringify(list)), 0);
    },
    setSelectPolicy(group, name) {
      state.switches.push([group, name]);
      return true;
    }
  };

  let active = 0;

  function nodeOf(opts) {
    return (config.nodes && config.nodes[opts.node || ""]) || null;
  }

  const $httpClient = {
    head(options, cb) {
      options.method = "HEAD";
      state.requests.push(options);
      const url = options.url;
      const nodeCfg = nodeOf(options) || {};
      if (isFixed(url) && !nodeCfg.noRange) {
        return setTimeout(
          () =>
            cb(null, {
              status: 200,
              headers: {
                "Content-Length": String(fileSize(url)),
                "Accept-Ranges": "bytes"
              }
            }),
          2
        );
      }
      setTimeout(() => cb(null, { status: 200, headers: { "Content-Length": String(fileSize(url)) } }), 2);
    },

    get(options, cb) {
      const opts = typeof options === "string" ? { url: options } : options;
      state.requests.push(opts);

      const nodeCfg = nodeOf(opts) || {};
      const speed = nodeCfg.speed || 100;

      if (nodeCfg.fail) {
        return setTimeout(() => cb(nodeCfg.fail), 2);
      }

      if (opts.url.indexOf("generate_204") >= 0) {
        return setTimeout(() => cb(null, { status: 204 }, ""), nodeCfg.latency || 30);
      }

      const range = opts.headers && (opts.headers.Range || opts.headers.range);
      let bytes;
      let status = 200;
      if (range) {
        const m = /bytes=(\d+)-(\d+)/.exec(range);
        bytes = m ? Number(m[2]) - Number(m[1]) + 1 : fileSize(opts.url);
        status = 206;
      } else {
        bytes = fileSize(opts.url);
      }
      if (bytes > 5 * 1024 * 1024) bytes = 5 * 1024 * 1024; // 控制测试内存

      const body = new Uint8Array(bytes);
      active++;
      setTimeout(() => {
        const share = Math.max(1, active);
        const perSpeed = Math.max(1, speed / share);
        const ms = Math.max(1, Math.round((bytes * 8) / (perSpeed * 1e6) * 1000));
        setTimeout(() => {
          active--;
          cb(null, { status, headers: {} }, body);
        }, ms);
      }, 0);
    }
  };

  const $notification = {
    post(title, subtitle, body) {
      state.notifications.push({ title, subtitle, body });
    }
  };

  const $persistentStore = {
    write(value, key) {
      state.store[key] = value;
      return true;
    },
    read(key) {
      return state.store[key] || "";
    }
  };

  const sandbox = {
    console: { log: (msg) => state.logs.push(typeof msg === "string" ? msg : JSON.stringify(msg)) },
    setTimeout,
    clearTimeout,
    $config,
    $httpClient,
    $notification,
    $persistentStore,
    $done(payload) {
      state.doneCount++;
    }
  };

  return { state, sandbox };
}

function runScript(config, opts) {
  const runtime = makeRuntime(config);
  const sandbox = Object.assign({}, runtime.sandbox);
  sandbox.$argument = opts.argument;
  if (opts.environment) sandbox.$environment = opts.environment;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox, { filename: "speedtest.js" });

  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (runtime.state.doneCount > 0 || Date.now() - started > 10000) {
        clearInterval(timer);
        setTimeout(() => resolve(runtime.state), 30);
      }
    }, 10);
  });
}

const baseConfig = {
  all_policy_groups: ["节点选择", "自动选择", "媒体"],
  groups: {
    "节点选择": ["香港01", "日本02", "新加坡03", "自动选择", "DIRECT"],
    "自动选择": ["香港01", "日本02"],
    "媒体": ["新加坡03"]
  },
  selected: { "节点选择": "日本02", "自动选择": "香港01", "媒体": "新加坡03" },
  nodes: {
    "香港01": { speed: 200, latency: 25 },
    "日本02": { speed: 120, latency: 60 },
    "新加坡03": { speed: 60, latency: 90 }
  }
};

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

(async function main() {
  console.log("\n[1] 默认：本地直连（不走代理）");
  {
    const s = await runScript(baseConfig, { argument: { sizeMB: 1 } });
    assert(s.doneCount === 1, "$done 只调用一次");
    assert(s.requests.length > 0 && s.requests.every((r) => r.node === "DIRECT"), "全部用 DIRECT", JSON.stringify([...new Set(s.requests.map(r => r.node))]));
    assert(s.requests.some((r) => r.url.indexOf("speed.cloudflare.com/__down?bytes=") >= 0), "用 Cloudflare 测速源");
    assert(s.requests.some((r) => r.url.indexOf("__down?bytes=0") >= 0), "同源 0 字节延迟探测");
    const n = s.notifications[0];
    assert(/本地直连/.test(n.subtitle + n.body), "结果标注本地直连", n.subtitle);
    assert(s.switches.length === 0, "没有切换策略组");
  }

  console.log("\n[2] 从节点入口运行（指定节点）");
  {
    const s = await runScript(baseConfig, {
      argument: { sizeMB: 1, latencySamples: 2 },
      environment: { params: { node: "新加坡03", policyGroup: "节点选择" } }
    });
    const req = s.requests.filter((r) => (r.node || "") === "新加坡03");
    assert(req.length === 4, "2 次延迟 + 预热 + 下载", "count=" + req.length);
    assert(/新加坡03/.test(s.notifications[0].subtitle), "副标题含节点名");
    assert(!/切换/.test(s.notifications[0].body), "通知不含切换");
  }

  console.log("\n[3] 参数指定节点名（自动识别）");
  {
    const s = await runScript(baseConfig, { argument: { nodeName: "香港01", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "香港01"), "只测指定节点");
  }

  console.log("\n[4] 当前节点：测策略组选中项");
  {
    const s = await runScript(baseConfig, { argument: { target: "当前节点", policyGroup: "节点选择", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "日本02"), "使用当前选中节点");
  }

  console.log("\n[5] 当前节点：自动找有选中项的策略组");
  {
    const s = await runScript(baseConfig, { argument: { target: "当前节点", sizeMB: 1 } });
    assert(s.requests.length > 0 && s.requests.every((r) => r.node === "日本02"), "自动定位到 节点选择");
  }

  console.log("\n[6] latencySamples=0 → 只测下载");
  {
    const s = await runScript(baseConfig, { argument: { target: "指定节点", nodeName: "香港01", sizeMB: 1, latencySamples: 0 } });
    const downloads = s.requests.filter((r) => /bytes=1048576/.test(r.url));
    assert(downloads.length === 1, "只有一次计分下载", "count=" + downloads.length);
    assert(!/延迟/.test(s.notifications[0].body), "通知不显示延迟");
  }

  console.log("\n[7] 下载失败仍然出结果");
  {
    const cfg = clone(baseConfig);
    cfg.nodes["香港01"] = { speed: 100, latency: 20, fail: "timeout" };
    const s = await runScript(cfg, { argument: { target: "指定节点", nodeName: "香港01", sizeMB: 1 } });
    assert(/❌/.test(s.notifications[0].body), "通知标出失败");
    assert(s.doneCount === 1, "$done 一次");
  }

  console.log("\n[8] 参数是 JSON 字符串 / query 字符串");
  {
    const a = await runScript(baseConfig, { argument: '{"target":"指定节点","nodeName":"香港01","sizeMB":1}' });
    assert(a.requests.every((r) => r.node === "香港01"), "JSON 字符串参数");
    const b = await runScript(baseConfig, { argument: "target=node&node=h%C3%A9%C3%A9&size=1" });
    assert(b.requests.length > 0, "query 字符串参数可运行");
  }

  console.log("\n[9] notify=false 不发通知");
  {
    const s = await runScript(baseConfig, { argument: { target: "指定节点", nodeName: "香港01", sizeMB: 1, notify: false } });
    assert(s.notifications.length === 0, "没有通知");
    assert(s.logs.some((l) => /done in/.test(l)), "日志里仍有结果");
  }

  console.log("\n[10] 没有可用节点时给出提示");
  {
    const s = await runScript({ all_policy_groups: [], groups: {}, selected: {}, nodes: {} }, { argument: { target: "当前节点" } });
    assert(s.notifications.length === 1, "发送失败通知");
    assert(/没有可测试的节点/.test(s.notifications[0].body), "提示原因");
    assert(s.doneCount === 1, "$done 一次");
  }

  console.log("\n[11] 嵌套策略组：按下一层选择取节点");
  {
    const cfg = clone(baseConfig);
    cfg.all_policy_groups = ["总开关", "自动选择"];
    cfg.groups = { "总开关": ["自动选择"] };
    cfg.selected = { "总开关": "自动选择", "自动选择": "香港01" };
    const s = await runScript(cfg, { argument: { target: "当前节点", policyGroup: "总开关", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "香港01"), "跟随嵌套选中项");
  }

  console.log("\n[12] threads=4：四个并发下载，速度取总和");
  {
    const s = await runScript(baseConfig, {
      argument: { target: "指定节点", nodeName: "香港01", sizeMB: 2, threads: 4, latencySamples: 0 }
    });
    const downloads = s.requests.filter((r) => /bytes=524288/.test(r.url));
    assert(downloads.length === 4, "发出 4 个分片请求", "count=" + downloads.length);
    assert(/4 线程/.test(s.notifications[0].body), "通知标注线程数");
    const m = /下载\s+([\d.]+) Mbps/.exec(s.notifications[0].body);
    const got = m ? Number(m[1]) : 0;
    assert(Math.abs(got - 200) / 200 < 0.3, "并发速度接近 200 Mbps", "got " + got);
  }

  console.log("\n[13] 固定大小地址 + Range：可切片多线程");
  {
    const s = await runScript(baseConfig, {
      argument: { target: "指定节点", nodeName: "香港01", sizeMB: 2, threads: 4, latencySamples: 0, testURL: FIXED }
    });
    const slices = s.requests.filter((r) => r.headers && /bytes=\d+-\d+/.test(r.headers.Range || ""));
    const big = slices.filter((r) => {
      const m = /bytes=(\d+)-(\d+)/.exec(r.headers.Range);
      return m && Number(m[2]) - Number(m[1]) + 1 === 524288;
    });
    assert(big.length === 4, "4 个 512KB Range 请求", "count=" + big.length);
    assert(/4 线程/.test(s.notifications[0].body), "通知标注线程数");
  }

  console.log("\n[14] 固定大小地址不支持 Range → 单线程整包");
  {
    const cfg = clone(baseConfig);
    cfg.nodes["香港01"] = { speed: 200, latency: 20, noRange: true };
    const s = await runScript(cfg, {
      argument: { target: "指定节点", nodeName: "香港01", sizeMB: 1, threads: 4, latencySamples: 0, testURL: "https://example.com/norange.bin" }
    });
    const gets = s.requests.filter((r) => r.url === "https://example.com/norange.bin" && r.method !== "HEAD");
    assert(gets.length === 1, "只下载一次", "count=" + gets.length);
    assert(!/线程/.test(s.notifications[0].body), "不显示线程数");
  }

  console.log("\n[15] 速度计算正确（200 Mbps 模拟）");
  {
    const s = await runScript(baseConfig, { argument: { target: "指定节点", nodeName: "香港01", sizeMB: 2, latencySamples: 1 } });
    const m = /下载\s+([\d.]+) Mbps/.exec(s.notifications[0].body);
    const got = m ? Number(m[1]) : 0;
    assert(Math.abs(got - 200) / 200 < 0.25, "速度接近 200 Mbps", "got " + got);
  }

  console.log("\n结果: " + passes + " passed, " + failures + " failed\n");
  process.exit(failures ? 1 : 0);
})();
