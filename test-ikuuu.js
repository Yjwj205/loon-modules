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
  const calls = [];
  const held = { post: [], get: [] };
  const postErrors = opts.postErrors ? opts.postErrors.slice() : null;
  const store = Object.assign({}, opts.store || {});
  const ctx = {
    console: { log: (...a) => logs.push(a.join(" ")) },
    setTimeout: (fn) => fn(),
    $request: opts.request || undefined,
    $argument: opts.argument === undefined ? null : opts.argument,
    $persistentStore: {
      read: (k) => (k in store ? store[k] : null),
      write: (v, k) => { writeCalls++; if (v === undefined || v === null) delete store[k]; else store[k] = v; return true; },
      remove: () => { Object.keys(store).forEach((k) => delete store[k]); return true; }
    },
    $notification: { post: (t, s, c) => notes.push({ title: t, subtitle: s, content: c }) },
    $httpClient: {
      post: (o, cb) => {
        calls.push({ type: "post", opts: o });
        const fire = () => {
          let err = opts.postError || null;
          if (postErrors && postErrors.length) err = postErrors.shift();
          cb(err, opts.postResponse || { status: 200 }, opts.postData);
        };
        if (opts.holdPost) held.post.push(fire); else fire();
      },
      get: (o, cb) => {
        calls.push({ type: "get", opts: o });
        const fire = () => cb(opts.getError || null, opts.getResponse || { status: 200 }, opts.getData);
        if (opts.holdGet) held.get.push(fire); else fire();
      }
    },
    $done: (v) => doneCalls.push(v)
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { notes, logs, store, doneCalls, writeCalls, calls, held };
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
  ok("抓取后提示去关开关", r.notes.length === 1 && /关掉/.test(r.notes[0].content), JSON.stringify(r.notes));
  ok("通知标题固定", r.notes[0].title === "iKuuu Cookie 抓取");
}
{
  const r = run("ikuuu-cookie.js", {
    argument: { notify: false },
    request: { headers: { Cookie: "auth=brand-new" } }
  });
  ok("关掉通知后不推送", r.notes.length === 0);
  ok("关掉通知仍然保存", r.store.ikuuu_org_cookie === "auth=brand-new");
}
{
  const r = run("ikuuu-cookie.js", { request: { headers: { cookie: "__cf_bm=only-guest" } } });
  ok("游客 Cookie 不写入", r.store.ikuuu_org_cookie === undefined);
}
{
  const r = run("ikuuu-cookie.js", { request: { headers: { Cookie: "uid=12; key=abcdef; _ga=GA1.1" } } });
  ok("兼容 uid+key 面板 Cookie", r.store.ikuuu_org_cookie === "uid=12; key=abcdef; _ga=GA1.1");
}
{
  const r = run("ikuuu-cookie.js", { request: { headers: { Cookie: "_ga=GA1.1; __cf_bm=guest" } } });
  ok("纯统计/防护 Cookie 不写入", r.store.ikuuu_org_cookie === undefined);
}
{
  const same = "__cf_bm=abc; auth=eyJhbGciOi.payload.sig";
  const r = run("ikuuu-cookie.js", {
    request: { headers: { Cookie: same } },
    store: { ikuuu_org_cookie: same }
  });
  ok("Cookie 未变化时不重复写入", r.writeCalls === 0, "writeCalls=" + r.writeCalls);
  ok("未变化也放行", r.doneCalls.length === 1);
  ok("未变化不打扰", r.notes.length === 0);
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
  ok("不报今日已用", !/今日已用/.test(r.notes[0].content), r.notes[0].content);
  ok("不带时间戳", !/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.notes[0].content));
  ok("$done 只调用一次", r.doneCalls.length === 1);
  ok("签到请求带 insecure=true", r.calls[0].opts.insecure === true, JSON.stringify(r.calls[0].opts));
  ok("流量请求带 insecure=true", r.calls[1].opts.insecure === true);
}

console.log("  · TLS 证书校验失败");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true },
    postError: "HTTPClient request failed with error:Error Domain=LNGCDAsyncSocketTLSError Code=167772294 SSL handshake failed: certificate verify failed"
  });
  ok("单独提示 TLS 失败", r.notes[0].subtitle === "TLS 校验失败", r.notes[0].subtitle);
  ok("提示 MITM 排查", /MITM/.test(r.notes[0].content));
  ok("连续失败会重试到 3 次", r.calls.filter((c) => c.type === "post").length === 3);
}

console.log("  · 偶发失败自动重试");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true },
    postErrors: ["HTTPClient request failed ... certificate verify failed", null],
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("重试后签到成功", r.notes[0].subtitle === "签到成功", r.notes[0].subtitle);
  ok("一共请求 2 次", r.calls.filter((c) => c.type === "post").length === 2);
}

console.log("  · 指定请求节点");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true, requestNode: "节点选择" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("签到请求带 node", r.calls[0].opts.node === "节点选择", JSON.stringify(r.calls[0].opts));
  ok("流量请求带 node", r.calls[1].opts.node === "节点选择");
}
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true, requestNode: "" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("留空时不带 node", r.calls[0].opts.node === undefined);
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

console.log("  · ret 0 且是失败信息");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=x", notify: true },
    postData: JSON.stringify({ ret: 0, msg: "签到失败，请稍后再试" }),
    getData: userPage
  });
  ok("不误判成已签到", r.notes[0].subtitle === "签到失败", r.notes[0].subtitle);
}

console.log("  · 登录态过期（JSON 提示）");
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=stale", notify: true },
    postData: JSON.stringify({ ret: 0, msg: "登录已过期，请重新登录" }),
    getData: userPage
  });
  ok("提示 Cookie 已失效", r.notes[0].subtitle === "Cookie 已失效", r.notes[0].subtitle);
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

console.log("  · Cookie 即将过期提醒");
{
  const ts = Math.floor(Date.now() / 1000) + 86400; // 1 天后到期
  const cookie = "uid=1; key=abc; expire_in=" + ts;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: cookie, notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("先发一条过期提醒", r.notes.length === 2 && r.notes[0].title === "iKuuu Cookie 即将过期",
    JSON.stringify(r.notes.map((n) => n.title)));
  ok("提醒写剩余天数", /还剩约 1 天/.test(r.notes[0].subtitle), r.notes[0].subtitle);
  ok("提醒带到期时间", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(r.notes[0].content), r.notes[0].content);
  ok("签到通知照常发", r.notes[1].subtitle === "签到成功", r.notes[1].subtitle);
  ok("记录了当天提醒戳", String(r.store.ikuuu_expire_warn || "").indexOf("|" + ts) > 0,
    r.store.ikuuu_expire_warn);

  const again = run("ikuuu-checkin.js", {
    argument: { cookie: cookie, notify: true },
    store: r.store,
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("同一天不重复提醒", again.notes.length === 1 && again.notes[0].subtitle === "签到成功",
    JSON.stringify(again.notes.map((n) => n.title)));
}
{
  const ts = Math.floor(Date.now() / 1000) + 5 * 86400;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("剩 5 天不提醒", r.notes.length === 1 && r.notes[0].subtitle === "签到成功");
}
{
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "auth=noexpire", notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("没有 expire_in 不提醒", r.notes.length === 1);
}
{
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("已过期不额外提醒", r.notes.length === 1 && r.notes[0].subtitle === "签到成功");
}
{
  const ts = Math.floor(Date.now() / 1000) + 86400;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts + "000", notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("毫秒时间戳也能识别", r.notes.length === 2 && /还剩约 1 天/.test(r.notes[0].subtitle),
    JSON.stringify(r.notes.map((n) => n.title)));
}
{
  const ts = Math.floor(Date.now() / 1000) + 86400;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: false },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("关闭通知时不发过期提醒", r.notes.length === 0);
}

console.log("  · CK 剩余天数（开关）");
{
  const ts = Math.floor(Date.now() / 1000) + 10 * 86400;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("默认显示 CK 剩余天数", /CK 剩余：10 天（\d{4}-\d{2}-\d{2} \d{2}:\d{2} 到期）/.test(r.notes[0].content),
    r.notes[0].content);
}
{
  const ts = Math.floor(Date.now() / 1000) + 10 * 86400;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: true, expireInfo: false },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("关掉开关后不显示", !/CK 剩余/.test(r.notes[0].content), r.notes[0].content);
}
{
  const ts = Math.floor(Date.now() / 1000) - 3600;
  const r = run("ikuuu-checkin.js", {
    argument: { cookie: "uid=1; key=abc; expire_in=" + ts, notify: true },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("已过期显示「CK：已过期」", /CK：已过期（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）/.test(r.notes[0].content),
    r.notes[0].content);
}

console.log("\n[iKuuu] 并行读流量（可选开关）");
{
  const r = run("ikuuu-checkin.js", {
    argument: { parallel: true, notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功，获得 1.00 GB 流量" }),
    getData: userPage,
    holdPost: true,
    holdGet: true
  });
  ok("并行时两个请求先同时发出",
    r.calls.length === 2 && r.calls[0].type === "post" && r.calls[1].type === "get",
    JSON.stringify(r.calls.map((c) => c.type)));
  ok("两边都没返回前不播报", r.notes.length === 0, String(r.notes.length));
  r.held.get[0]();
  ok("只回来流量也不播报", r.notes.length === 0, String(r.notes.length));
  r.held.post[0]();
  ok("两边都回来只播一条", r.notes.length === 1, String(r.notes.length));
  ok("签到成功时流量标注「签到前」",
    /剩余流量：12\.34 GB（签到前）/.test(r.notes[0].content), r.notes[0].content);
}
{
  const r = run("ikuuu-checkin.js", {
    argument: { parallel: true, notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 0, msg: "今天已经签到过了" }),
    getData: userPage,
    holdPost: true,
    holdGet: true
  });
  r.held.get[0]();
  r.held.post[0]();
  ok("今日已签到（没有赠送）时不标注签到前",
    r.notes.length === 1 && r.notes[0].content.indexOf("（签到前）") < 0, r.notes[0].content);
}
{
  const r = run("ikuuu-checkin.js", {
    argument: { parallel: true, notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postResponse: { status: 302 },
    postData: "<html><body>login</body></html>",
    getData: userPage,
    holdPost: true,
    holdGet: true
  });
  r.held.get[0]();
  r.held.post[0]();
  ok("签到失败但流量取到也播报", r.notes.length === 1, String(r.notes.length));
  ok("失败原因仍是 Cookie 已失效", /Cookie 已失效/.test(r.notes[0].subtitle || ""), r.notes[0].subtitle);
  ok("签到失败时不标注签到前", r.notes[0].content.indexOf("（签到前）") < 0, r.notes[0].content);
}
{
  // 默认（不传 parallel）仍然是串行：签到返回后才发流量请求
  const r = run("ikuuu-checkin.js", {
    argument: { notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage,
    holdPost: true
  });
  ok("默认串行：签到没返回前不发流量请求", r.calls.length === 1, JSON.stringify(r.calls.map((c) => c.type)));
  r.held.post[0]();
  ok("签到返回后才读流量", r.calls.length === 2 && r.calls[1].type === "get");
  ok("串行模式不标注签到前", r.notes[0].content.indexOf("（签到前）") < 0, r.notes[0].content);
}

console.log("\n[iKuuu] 流量解析");
{
  // 标签在导航里也出现一次（没有 counter），不能被它骗到
  const html = '<html><body><nav><a>剩余流量</a><a>节点</a></nav>' +
    '<div class="card">剩余流量 <span class="counter">7.77</span> GB</div></body></html>';
  const r = run("ikuuu-checkin.js", {
    argument: { notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: wrap(html)
  });
  ok("跳过没有 counter 的菜单项", /剩余流量：7\.77 GB/.test(r.notes[0].content), r.notes[0].content);
}
{
  // 没有 originBody（页面没被 base64 包装）时直接解析
  const r = run("ikuuu-checkin.js", {
    argument: { notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: '<html><body>剩余流量 <span class="counter">3.21</span> GB</body></html>'
  });
  ok("纯 HTML 页面也能解析", /剩余流量：3\.21 GB/.test(r.notes[0].content), r.notes[0].content);
}
{
  // 解析不到就不加流量行，不影响签到结果
  const r = run("ikuuu-checkin.js", {
    argument: { notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: wrap('<html><body>nothing here</body></html>')
  });
  ok("没有剩余流量时不显示该行",
    r.notes.length === 1 && r.notes[0].content.indexOf("剩余流量") < 0, r.notes[0].content);
}

console.log("\n[iKuuu] 计时日志");
{
  const r = run("ikuuu-checkin.js", {
    argument: { notify: true },
    store: { ikuuu_org_cookie: "auth=x" },
    postData: JSON.stringify({ ret: 1, msg: "签到成功" }),
    getData: userPage
  });
  ok("记录签到返回耗时", r.logs.some((l) => /签到返回 t=\d+ms/.test(l)), JSON.stringify(r.logs));
  ok("记录流量页耗时与解码", r.logs.some((l) => /流量页 t=\d+ms 请求 \d+ms 解码 \d+ms 大小 \d+B/.test(l)));
  ok("记录总耗时", r.logs.some((l) => /总耗时 \d+ms/.test(l)));
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
