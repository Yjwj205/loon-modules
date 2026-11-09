/**
 * iKuuu 插件脚本本地测试（模拟 Loon 运行环境）
 * 运行：node test-ikuuu.js
 */
"use strict";

const fs = require("fs");
const vm = require("vm");
const path = require("path");

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra ? " -> " + extra : ""));
  }
}

function run(file, opts) {
  const code = fs.readFileSync(path.join(__dirname, file), "utf8");
  const doneCalls = [];
  let writeCalls = 0;
  const notes = [];
  const logs = [];
  const store = Object.assign({}, opts.store || {});
  const ctx = {
    console: { log: (...a) => logs.push(a.join(" ")) },
    $request: opts.request || undefined,
    $argument: opts.argument === undefined ? null : opts.argument,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { writeCalls++; if (v === undefined || v === null) delete store[k]; else store[k] = v; return true; },
      remove: () => { Object.keys(store).forEach((k) => delete store[k]); return true; }
    },
    $notification: { post: (t, s, c) => notes.push({ title: t, subtitle: s, content: c }) },
    $httpClient: {
      post: (o, cb) => cb(opts.postError || null, opts.postResponse || { status: 200 }, opts.postData),
      get: (o, cb) => cb(opts.getError || null, opts.getResponse || { status: 200 }, opts.getData)
    },
    $done: (v) => doneCalls.push(v)
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { notes, logs, store, doneCalls, writeCalls };
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

function wrap(html) {
  return 'var originBody = "' + b64(html) + '";\ndocument.write(decodeBase64(originBody));';
}

const userPage = wrap(
  '<html><body><div>剩余流量 <span class="counter">12.34</span> GB</div>' +
  '<div>今日已用 <span class="counter">0.50</span> GB</div></body></html>'
);

/* ---------------- Cookie 抓取脚本 ---------------- */
console.log("\n[iKuuu] ikuuu-cookie.js");
{
  const r = run("ikuuu-cookie.js", {
    request: { headers: { Host: "ikuuu.org", Cookie: "__cf_bm=abc; auth=eyJhbGciOi.payload.sig" } }
  });
  ok("带 auth 时写入 Cookie", r.store.ikuuu_org_cookie === "__cf_bm=abc; auth=eyJhbGciOi.payload.sig");
  ok("请求原样放行 $done({})", r.doneCalls.length === 1 && JSON.stringify(r.doneCalls[0]) === "{}");
}
{
  const r = run("ikuuu-cookie.js", { request: { headers: { cookie: "__cf_bm=only-guest" } } });
  ok("游客 Cookie 不写入", r.store.ikuuu_org_cookie === undefined);
}
{
  const same = "__cf_bm=abc; auth=eyJhbGciOi.payload.sig";
  const r = run("ikuuu-cookie.js", {
    request: { headers: { Cookie: same } },
    store: { ikuuu_org_cookie: same }
  });
  ok("Cookie 未变化时不重复写入", r.writeCalls === 0, "writeCalls=" + r.writeCalls);
  ok("未变化也放行", r.doneCalls.length === 1);
}
{
  const r = run("ikuuu-cookie.js", { request: { headers: {} } });
  ok("无 Cookie 不写入", r.store.ikuuu_org_cookie === undefined);
  ok("无 Cookie 也放行", r.doneCalls.length === 1);
}

/* ---------------- 签到脚本 ---------------- */
console.log("\n[iKuuu] ikuuu-checkin.js");

console.log("  · 没有 Cookie");
{
  const r = run("ikuuu-checkin.js", { argument: { cookie: null, notify: true } });
  ok("提示没有 Cookie", /没有 Cookie/.test(r.notes[0].subtitle));
  ok("引导去登录", /ikuuu\.org/.test(r.notes[0].content));
  ok("$done 只调用一次", r.doneCalls.length === 1);
}

console.log("  · 签到成功 + 流量");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: null, notify: true },
    store: { ikuuu_org_cookie: "auth=eyJhbGciOi.payload.sig" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功，获得了 1024 MB 流量" }),
    getData: userPage
  });
  ok("副标题为签到成功", r.notes[0].subtitle === "签到成功", r.notes[0].subtitle);
  ok("包含服务器返回的 msg", /1024 MB/.test(r.notes[0].content));
  ok("解析出剩余流量", /剩余流量：12\.34 GB/.test(r.notes[0].content), r.notes[0].content);
  ok("解析出今日已用", /今日已用：0\.50 GB/.test(r.notes[0].content), r.notes[0].content);
  ok("附带时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.notes[0].content));
  ok("$done 只调用一次", r.doneCalls.length === 1);
}

console.log("  · 今天已经签过");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: null, notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 0, msg: "您似乎已经签到过了" }),
    getData: userPage
  });
  ok("副标题为今日已签到", r.notes[0].subtitle === "今日已签到", r.notes[0].subtitle);
}

console.log("  · ret 为字符串 1");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=manual", notify: true },
    postData: JSON.stringify({ ret: "1", msg: "签到成功" }),
    getData: userPage
  });
  ok("字符串 ret 也识别为成功", r.notes[0].subtitle === "签到成功", r.notes[0].subtitle);
}

console.log("  · Cookie 失效（返回登录页）");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=expired", notify: true },
    postData: '<!DOCTYPE html><html><script>var originBody = "x";</script></html>'
  });
  ok("提示 Cookie 失效", r.notes[0].subtitle === "Cookie 已失效", r.notes[0].subtitle);
  ok("不误报流量", !/剩余流量/.test(r.notes[0].content));
}

console.log("  · 网络错误");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true },
    postError: "The request timed out"
  });
  ok("提示请求失败", r.notes[0].subtitle === "请求失败", r.notes[0].subtitle);
  ok("带错误原因", /timed out/.test(r.notes[0].content));
}

console.log("  · 关闭通知");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: false },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("不发通知", r.notes.length === 0);
  ok("仍然正常结束", r.doneCalls.length === 1);
}

console.log("  · 手动 Cookie 优先于已保存的");
{
  const seen = [];
  const code = fs.readFileSync(path.join(__dirname, "ikuuu-checkin.js"), "utf8");
  const ctx = {
    console: { log: () => {} },
    $argument: { cookie: "  Cookie: auth=fromarg\n", notify: true },
    $persistentStore: { read: () => "auth=fromstore" },
    $notification: { post: () => {} },
    $httpClient: {
      post: (o, cb) => { seen.push(o.headers.Cookie); cb(null, { status: 200 }, '{"ret":1,"msg":"ok"}'); },
      get: (o, cb) => cb(null, { status: 200 }, userPage)
    },
    $done: () => {}
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  ok("使用手动 Cookie 并去掉前缀/换行", seen[0] === "auth=fromarg", seen[0]);
}

console.log("  · 流量页解析失败时不影响签到");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: "<html>维护中</html>"
  });
  ok("仍然播报签到成功", r.notes[0].subtitle === "签到成功");
  ok("没有流量行", !/剩余流量/.test(r.notes[0].content));
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
