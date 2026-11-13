"use strict";

/**
 * Loon 环境模拟器 + speedtest.js 用例
 * 运行: node test.js
 */

const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SCRIPT = fs.readFileSync(path.join(__dirname, "speedtest.js"), "utf8");

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

function makeRuntime(config) {
  const state = {
    logs: [],
    notifications: [],
    store: {},
    switches: [],
    doneCount: 0,
    donePayload: null,
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

  function parseBytes(url) {
    const m = /[?&]bytes=(\d+)/.exec(url);
    return m ? Number(m[1]) : 0;
  }

  const $httpClient = {
    get(options, cb) {
      const opts = typeof options === "string" ? { url: options } : options;
      state.requests.push(opts);
      const node = opts.node || "";
      const nodeCfg = (config.nodes && config.nodes[node]) || null;

      if (nodeCfg && nodeCfg.fail) {
        return setTimeout(() => cb(nodeCfg.fail), 2);
      }

      const delay = (nodeCfg && nodeCfg.latency) || 30;
      if (opts.url.indexOf("generate_204") >= 0) {
        return setTimeout(() => cb(null, { status: 204 }, ""), delay);
      }

      const bytes = parseBytes(opts.url) || 1024 * 1024;
      const speed = (nodeCfg && nodeCfg.speed) || 100; // Mbps
      const ms = Math.max(1, Math.round((bytes * 8) / (speed * 1e6) * 1000));
      const body = new Uint8Array(bytes);
      setTimeout(() => cb(null, { status: 200, headers: {} }, body), ms);
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
      state.donePayload = payload;
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
      if (runtime.state.doneCount > 0 || Date.now() - started > 8000) {
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

(async function main() {
  console.log("\n[1] 从节点入口运行：直接用 $environment.params.node");
  {
    const s = await runScript(baseConfig, {
      argument: { sizeMB: 1, latencySamples: 2 },
      environment: { params: { node: "新加坡03", policyGroup: "节点选择" } }
    });
    assert(s.doneCount === 1, "$done 只调用一次", "count=" + s.doneCount);
    const req = s.requests.filter((r) => (r.node || "") === "新加坡03");
    assert(req.length === 4, "发出 2 次延迟 + 1 次预热 + 1 次下载", "count=" + req.length);
    const downloads = req.filter((r) => /bytes=1048576/.test(r.url));
    assert(downloads.length === 1, "只有一次计入成绩的下载", "count=" + downloads.length);
    assert(s.requests.every((r) => r.node === "新加坡03"), "所有请求都指定该节点");
    const n = s.notifications[0];
    assert(!!n, "发送了通知");
    assert(/Mbps/.test(n.body), "通知含下载速度", n && n.body);
    assert(/延迟/.test(n.body), "通知含延迟");
    assert(!/切换/.test(n.body), "通知不含切换字样");
  }

  console.log("\n[2] 参数指定节点名");
  {
    const s = await runScript(baseConfig, { argument: { nodeName: "香港01", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "香港01"), "只测指定节点");
    assert(/香港01/.test(s.notifications[0].subtitle), "通知副标题含节点名", s.notifications[0].subtitle);
  }

  console.log("\n[3] 未指定节点：测策略组当前选中项");
  {
    const s = await runScript(baseConfig, { argument: { policyGroup: "节点选择", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "日本02"), "使用当前选中节点", JSON.stringify(s.requests.map(r=>r.node)));
  }

  console.log("\n[4] 未指定策略组：自动找到有选中项的策略组");
  {
    const s = await runScript(baseConfig, { argument: { sizeMB: 1 } });
    assert(s.requests.length > 0 && s.requests.every((r) => r.node === "日本02"), "自动定位到 节点选择", JSON.stringify(s.requests.map(r=>r.node)));
  }

  console.log("\n[5] latencySamples=0 → 只测下载");
  {
    const s = await runScript(baseConfig, { argument: { nodeName: "香港01", sizeMB: 1, latencySamples: 0 } });
    assert(s.requests.length === 2, "预热 + 下载共两次请求", "count=" + s.requests.length);
    assert(!s.requests[0].url.includes("bytes=1048576"), "第一次是预热小请求");
    assert(!/延迟/.test(s.notifications[0].body), "通知不显示延迟");
  }

  console.log("\n[6] 下载失败仍然出结果");
  {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.nodes["香港01"] = { speed: 100, latency: 20, fail: "timeout" };
    const s = await runScript(cfg, { argument: { nodeName: "香港01", sizeMB: 1 } });
    const body = s.notifications[0].body;
    assert(/❌/.test(body), "通知标出失败", body);
    assert(s.doneCount === 1, "$done 一次");
  }

  console.log("\n[7] 参数是 JSON 字符串 / query 字符串");
  {
    const a = await runScript(baseConfig, { argument: '{"nodeName":"香港01","sizeMB":1}' });
    assert(a.requests.every((r) => r.node === "香港01"), "JSON 字符串参数");
    const b = await runScript(baseConfig, { argument: "node=h%C3%A9%C3%A9&size=1" });
    assert(b.requests.length > 0, "query 字符串参数可运行（node 名称解码）", JSON.stringify(b.requests.map(r=>r.node)));
  }

  console.log("\n[8] notify=false 不发通知");
  {
    const s = await runScript(baseConfig, { argument: { nodeName: "香港01", sizeMB: 1, notify: false } });
    assert(s.notifications.length === 0, "没有通知");
    assert(s.logs.some((l) => /done in/.test(l)), "日志里仍有结果");
  }

  console.log("\n[9] 没有可用节点时给出提示");
  {
    const s = await runScript({ all_policy_groups: [], groups: {}, selected: {}, nodes: {} }, { argument: {} });
    assert(s.notifications.length === 1, "发送失败通知");
    assert(/没有可测试的节点/.test(s.notifications[0].body), "提示原因", s.notifications[0].body);
    assert(s.doneCount === 1, "$done 一次");
  }

  console.log("\n[10] 嵌套策略组：按下一层的选择取节点");
  {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.all_policy_groups = ["总开关"];
    cfg.groups = { "总开关": ["自动选择"] };
    cfg.selected = { "总开关": "自动选择", "自动选择": "香港01" };
    const s = await runScript(cfg, { argument: { policyGroup: "总开关", sizeMB: 1 } });
    assert(s.requests.every((r) => r.node === "香港01"), "跟随嵌套选中项", JSON.stringify(s.requests.map(r=>r.node)));
  }

  console.log("\n[11] 全程不切换策略组");
  {
    const s = await runScript(baseConfig, { argument: { sizeMB: 1 } });
    assert(s.switches.length === 0, "没有调用 setSelectPolicy", JSON.stringify(s.switches));
  }

  console.log("\n[12] 速度计算正确（200 Mbps 模拟）");
  {
    const s = await runScript(baseConfig, { argument: { nodeName: "香港01", sizeMB: 2, latencySamples: 1 } });
    const m = /下载\s+([\d.]+) Mbps/.exec(s.notifications[0].body);
    const got = m ? Number(m[1]) : 0;
    assert(Math.abs(got - 200) / 200 < 0.25, "速度接近 200 Mbps", "got " + got);
  }

  console.log("\n结果: " + passes + " passed, " + failures + " failed\n");
  process.exit(failures ? 1 : 0);
})();
