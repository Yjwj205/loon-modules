/**
 * WorkBuddy 面板日报（公开版）本地测试：模拟 Loon 运行环境
 * 运行：node test-workbuddy-report.js
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

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

function pickRoute(routes, url) {
  return Object.keys(routes)
    .sort((a, b) => b.length - a.length)
    .find((p) => url.indexOf(p) >= 0);
}

function run(opts) {
  const code = fs.readFileSync(path.join(__dirname, "workbuddy-report.js"), "utf8");
  const notes = [];
  const logs = [];
  const calls = [];
  const posts = [];
  const doneCalls = [];
  const routes = opts.routes || {};
  const counters = {};
  const held = [];

  function respond(key, seq, cb, index) {
    if (!seq) return cb(null, { status: 404 }, "not found");
    const hit = seq[Math.min(index, seq.length - 1)];
    if (hit.error) return cb(hit.error, null, null);
    cb(null, { status: hit.status || 200 },
      typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body));
  }

  const ctx = {
    console: { log: (...a) => logs.push(a.join(" ")) },
    setTimeout: (fn) => fn(),
    $argument: opts.argument === undefined ? null : opts.argument,
    $environment: opts.env || undefined,
    $notification: { post: (t, s, c, o) => notes.push({ title: t, subtitle: s, content: c, options: o }) },
    $httpClient: {
      get: (o, cb) => {
        calls.push(o);
        const key = pickRoute(routes, o.url);
        const seq = routes[key];
        counters[key] = (counters[key] || 0) + 1;
        respond(key, seq, cb, counters[key] - 1);
      },
      post: (o, cb) => {
        posts.push(o);
        const key = pickRoute(routes, o.url);
        const seq = routes[key];
        const fire = () => respond(key, seq, cb, 0);
        if (opts.holdRefresh) held.push(fire);
        else fire();
      }
    },
    $done: (v) => doneCalls.push(v)
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return { notes, logs, calls, posts, doneCalls, held };
}

function note(r) {
  return r.notes[0] || { title: "", subtitle: "", content: "" };
}

/* ---------------- 数据夹具 ---------------- */

const summary = {
  today_requests: 72,
  today_tokens: 6228707,
  today_credit: 58.67000000000001,
  today_cost: 1.883418,
  week_credit: 2486.18,
  total_credit: 2597.8
};

const credits = { today: { income: 539, expense: 58.67, net: 480.33 }, daily: [] };

const snap = {
  count: 6,
  active_count: 6,
  accounts: [
    { uid: "a", credits: 3653, active: true },
    { uid: "b", credits: 2725, active: true },
    { uid: "c", credits: 2870, active: true },
    { uid: "d", credits: 3033, active: true },
    { uid: "e", credits: 520, active: true },
    { uid: "f", credits: 3458, active: true }
  ]
};

const NICKS = {
  a: "账号A",
  b: "账号B",
  c: "账号C",
  d: "账号D",
  e: "账号E",
  f: "账号F"
};

function poolFixture(signed, extra) {
  const accounts = Object.keys(NICKS).map((uid) => ({
    uid,
    nickname: NICKS[uid],
    credits: 1000,
    disabled: false,
    disabled_by_panel: false,
    checkin_supported: true,
    checkin_today: signed.indexOf(uid) >= 0 ? NOW : null
  }));
  if (extra) accounts.push(...extra);
  return { total: accounts.length, accounts };
}

function logsFixture(items) {
  return { total: items.length, items };
}

const ARGS = { baseURL: "http://1.2.3.4:7864/", token: "wbt_test", notify: true };

function routes(over) {
  return Object.assign({
    "/api/sysinfo": [{ body: { service: "workbuddy-manager", version: "2.11.23" } }],
    "/api/stats/summary": [{ body: summary }],
    "/api/stats/credits": [{ body: credits }],
    "/api/accounts/credits-snapshot": [{ body: snap }],
    "/api/checkin-logs": [{ body: logsFixture([]) }],
    "/api/accounts/refresh-credits": [{ body: { total: 0, succeeded: 0, failed: [] } }],
    "/api/accounts": [{ body: poolFixture([]) }]
  }, over || {});
}

/* ---------------- 1. 正常播报 ---------------- */
console.log("\n[WorkBuddy] 正常播报");
{
  const items = [
    { ts: NOW - 60, uid: "a", nickname: "账号A", success: true, code: 0, message: "签到成功", auto: false },
    { ts: NOW - 120, uid: "b", nickname: "账号B", success: true, code: 10001, message: "今日已签到", auto: false },
    { ts: NOW - 180, uid: "c", nickname: "账号C", success: true, code: 0, message: "签到成功", auto: false },
    { ts: NOW - 240, uid: "d", nickname: "账号D", success: true, code: 10001, message: "今日已签到", auto: false },
    { ts: NOW - 300, uid: "e", nickname: "账号E", success: true, code: 0, message: "签到成功", auto: false },
    { ts: NOW - 400, uid: "a", nickname: "账号A", success: true, code: 0, message: "签到成功", auto: false },
    { ts: NOW - DAY - 500, uid: "z", nickname: "old", success: true, code: 0, message: "签到成功", auto: false },
    { ts: NOW - 600, uid: "", auto: true, success: true, message: "本轮签到完成：共 6 个，成功 2，已签到 0，失败 3，跳过 1" }
  ];
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/checkin-logs": [{ body: logsFixture(items) }],
      "/api/accounts": [{ body: poolFixture(["a", "b", "c", "d", "e"]) }]
    })
  });
  const n = note(r);
  ok("发出一条通知", r.notes.length === 1);
  ok("标题为 WorkBuddy 面板日报", n.title === "WorkBuddy 面板日报", n.title);
  ok("签到 5/6（按 uid 去重、过滤昨天）", n.content.indexOf("✅ 今日签到：5/6 个账号") >= 0, n.content);
  ok("没有副标题", n.subtitle === "", n.subtitle);
  ok("点名未签到账号 f", n.content.indexOf("🙈 未签：账号F") >= 0, n.content);
  ok("消耗与剩余合并成一行", n.content.indexOf("💸 消耗与剩余：58.67 积分 · 16,259 积分") >= 0, n.content);
  ok("今日入账 539", n.content.indexOf("今日入账：+539 积分（含签到）") >= 0, n.content);
  ok("顺序：签到→用量→入账→未签→消耗与剩余",
    n.content.indexOf("今日签到") < n.content.indexOf("今日用量") &&
    n.content.indexOf("今日用量") < n.content.indexOf("今日入账") &&
    n.content.indexOf("今日入账") < n.content.indexOf("未签：") &&
    n.content.indexOf("未签：") < n.content.indexOf("消耗与剩余"), n.content);
  ok("token 数格式 6.23M", n.content.indexOf("6.23M tokens") >= 0, n.content);
  ok("baseURL 末尾斜杠被去掉", r.calls[0].url === "http://1.2.3.4:7864/api/sysinfo", r.calls[0].url);
  ok("带上 Bearer Token", r.calls[0].headers.Authorization === "Bearer wbt_test");
  ok("6 个只读 GET 各请求一次", r.calls.length === 6, String(r.calls.length));
  ok("播报前先刷一次余额（POST，只读）",
    r.posts.length === 1 && /\/api\/accounts\/refresh-credits\?force=false$/.test(r.posts[0].url),
    r.posts[0] && r.posts[0].url);
  ok("$done 只调用一次", r.doneCalls.length === 1);
}

/* ---------------- 2. 全部签完 ---------------- */
console.log("\n[WorkBuddy] 全部签到");
{
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/accounts": [{ body: poolFixture(["a", "b", "c", "d", "e", "f"]) }] })
  });
  ok("签到 6/6", note(r).content.indexOf("✅ 今日签到：6/6 个账号") >= 0, note(r).content);
  ok("没有未签点名行", note(r).content.indexOf("未签") < 0, note(r).content);
}

/* ---------------- 3. 停用 / 不支持签到的号不算分母 ---------------- */
console.log("\n[WorkBuddy] 停用与不支持签到的账号不计入");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts": [{
        body: poolFixture(["a", "b", "c", "d", "e"], [
          { uid: "g", nickname: "停用号", disabled: true, checkin_supported: true },
          { uid: "h", nickname: "面板停用号", disabled_by_panel: true, checkin_supported: true },
          { uid: "i", nickname: "国际版", checkin_supported: false }
        ])
      }]
    })
  });
  ok("分母仍是 6", note(r).content.indexOf("✅ 今日签到：5/6 个账号") >= 0, note(r).content);
  ok("停用号不出现在未签名单", note(r).content.indexOf("停用号") < 0, note(r).content);
  ok("不支持签到的号不出现在未签名单", note(r).content.indexOf("国际版") < 0, note(r).content);
}

/* ---------------- 4. 只有自动签到汇总 ---------------- */
console.log("\n[WorkBuddy] 仅自动签到汇总");
{
  const items = [
    { ts: NOW - 600, uid: "", auto: true, success: true, message: "本轮签到完成：共 6 个，成功 3，已签到 3，失败 0，跳过 0" }
  ];
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/checkin-logs": [{ body: logsFixture(items) }], "/api/accounts": [{ body: poolFixture([]) }] })
  });
  const n = note(r);
  ok("从汇总行取到 6 个（成功 3 + 已签到 3）", n.content.indexOf("✅ 今日签到：6/6 个账号") >= 0, n.content);
  ok("标注按自动签到汇总", n.content.indexOf("按自动签到汇总") >= 0, n.content);
  ok("汇总给不出名字就不点名", n.content.indexOf("未签：") < 0, n.content);
}

/* ---------------- 5. 今日无签到 ---------------- */
console.log("\n[WorkBuddy] 今日还没签到");
{
  const items = [{ ts: NOW - DAY - 100, uid: "a", success: true, code: 0, message: "签到成功", auto: false }];
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/checkin-logs": [{ body: logsFixture(items) }], "/api/accounts": [{ body: poolFixture([]) }] })
  });
  const c = note(r).content;
  ok("签到 0/6 并给提示", c.indexOf("今日签到：0/6 个账号") >= 0, c);
  ok("6 个号全部点名", c.indexOf("未签：") >= 0 && (c.match(/、/g) || []).length >= 3, c);
}

/* ---------------- 6. 签到记录 500，账号列表正常 ---------------- */
console.log("\n[WorkBuddy] 签到记录接口 500");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/checkin-logs": [{ status: 500, body: "<html>500 Internal Server Error</html>" }],
      "/api/accounts": [{ body: poolFixture(["a", "b", "c", "d", "e"]) }]
    })
  });
  const n = note(r);
  ok("其余数据照常播报", n.content.indexOf("消耗与剩余：58.67 积分 · 16,259 积分") >= 0, n.content);
  ok("靠 checkin_today 仍报 5/6", n.content.indexOf("✅ 今日签到：5/6 个账号") >= 0, n.content);
  ok("账号列表正常时不提示签到记录缺失", n.content.indexOf("签到记录") < 0, n.content);
}

/* ---------------- 7. 账号列表挂了 ---------------- */
console.log("\n[WorkBuddy] 账号列表接口 500");
{
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/accounts": [{ status: 500, body: "boom" }] })
  });
  const n = note(r);
  ok("退回快照分母 6", n.content.indexOf("今日签到：0/6 个账号") >= 0, n.content);
  ok("不点名", n.content.indexOf("未签：") < 0, n.content);
  ok("提示账号列表缺失", n.content.indexOf("账号列表") >= 0, n.content);
}

/* ---------------- 8. Token 失效 ---------------- */
console.log("\n[WorkBuddy] Token 401");
{
  const r = run({
    argument: ARGS,
    routes: {
      "/api/sysinfo": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/stats/summary": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/stats/credits": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts/credits-snapshot": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/checkin-logs": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts/refresh-credits": [{ status: 401, body: '{"detail":"未登录"}' }]
    }
  });
  ok("播报获取失败", note(r).subtitle === "获取失败", note(r).subtitle);
  ok("提示 Token 无效", note(r).content.indexOf("Token 无效") >= 0, note(r).content);
  ok("给出 Token 排查建议", note(r).content.indexOf("API Tokens") >= 0, note(r).content);
  ok("读不到版本时不硬编版本行", note(r).content.indexOf("面板版本：") < 0, note(r).content);
}

/* ---------------- 9. 网络错误重试 ---------------- */
console.log("\n[WorkBuddy] 网络错误重试");
{
  const items = [{ ts: NOW - 60, uid: "a", success: true, code: 0, message: "签到成功", auto: false }];
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/stats/summary": [{ error: "timeout" }, { body: summary }],
      "/api/checkin-logs": [{ body: logsFixture(items) }],
      "/api/accounts": [{ body: poolFixture(["a"]) }]
    })
  });
  ok("第一次超时后重试用上了第二次", note(r).content.indexOf("消耗与剩余：58.67") >= 0, note(r).content);
  ok("没有报缺失", note(r).content.indexOf("部分数据缺失") < 0, note(r).content);
}

/* ---------------- 10. 参数缺失 ---------------- */
console.log("\n[WorkBuddy] 参数缺失");
{
  const a = run({ argument: {}, routes: {} });
  ok("缺 baseURL 时提示配置", note(a).subtitle === "未配置面板地址", note(a).subtitle);
  ok("告诉用户去哪里填", note(a).content.indexOf("插件") >= 0, note(a).content);
  const b = run({ argument: { baseURL: "http://x:7864" }, routes: {} });
  ok("缺 token 时提示配置", note(b).subtitle === "未配置 Token", note(b).subtitle);
  ok("告诉用户去哪里建 Token", note(b).content.indexOf("API Tokens") >= 0, note(b).content);
  const c = run({ argument: { baseURL: "http://x:7864", token: "wbt_x", notify: false }, routes: {} });
  ok("notify=false 时不发通知", c.notes.length === 0);
  ok("notify=false 仍写日志", c.logs.length > 0);
}

/* ---------------- 11. 老式字符串参数 ---------------- */
console.log("\n[WorkBuddy] 老式字符串参数");
{
  const r = run({
    argument: "baseURL=http://1.2.3.4:7864&token=wbt_str&notify=true",
    routes: routes()
  });
  ok("字符串参数也能解析出地址", r.calls[0].url === "http://1.2.3.4:7864/api/sysinfo", r.calls[0].url);
  ok("字符串里的 token 生效", r.calls[0].headers.Authorization === "Bearer wbt_str");
}

/* ---------------- 12. 空快照 / 空账号池 ---------------- */
console.log("\n[WorkBuddy] 快照与账号池都为空");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/stats/summary": [{ body: { today_requests: 0, today_tokens: 0, today_credit: 0, today_cost: 0 } }],
      "/api/stats/credits": [{ body: { today: { income: 0, expense: 0, net: 0 } } }],
      "/api/accounts/credits-snapshot": [{ body: { count: 0, active_count: 0, accounts: [] } }],
      "/api/accounts": [{ body: { total: 0, accounts: [] } }]
    })
  });
  const n = note(r);
  ok("没有合并行（缺剩余）", n.content.indexOf("消耗与剩余") < 0, n.content);
  ok("入账为 0 也显示", n.content.indexOf("🎁 今日入账：+0 积分（含签到）") >= 0, n.content);
  ok("消耗为 0 仍播报", n.content.indexOf("今日消耗：0 积分") >= 0, n.content);
  ok("空账号池给明确提示", n.content.indexOf("面板里还没有账号") >= 0, n.content);
}

/* ---------------- 13. 未签太多时截断 ---------------- */
console.log("\n[WorkBuddy] 未签名单截断");
{
  const many = ["a", "b", "c", "d", "e", "f"].map((uid, i) => ({
    uid, nickname: "号" + (i + 1), credits: 1, disabled: false,
    disabled_by_panel: false, checkin_supported: true, checkin_today: null
  }));
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/accounts": [{ body: { total: many.length, accounts: many } }] })
  });
  ok("最多点 4 个名字再加等 N 个", note(r).content.indexOf("未签：号1、号2、号3、号4 等 6 个") >= 0, note(r).content);
}

/* ---------------- 14. 余额刷新失败 ---------------- */
console.log("\n[WorkBuddy] 余额刷新失败");
{
  const r = run({
    argument: ARGS,
    routes: routes({ "/api/accounts/refresh-credits": [{ error: "timeout" }] })
  });
  const n = note(r);
  ok("刷新失败不阻塞播报", r.calls.length === 6, String(r.calls.length));
  ok("剩余额度退回快照", n.content.indexOf("消耗与剩余：58.67 积分 · 16,259 积分") >= 0, n.content);
  ok("入账退回积分收支", n.content.indexOf("今日入账：+539 积分") >= 0, n.content);
  ok("纯刷新失败不提示数据缺失", n.content.indexOf("部分数据缺失") < 0, n.content);
}

/* ---------------- 15. 冷缓存：刷新响应直接算剩余与入账 ---------------- */
console.log("\n[WorkBuddy] 刷新响应直接出数");
{
  const todaySec = Math.floor(Date.now() / 1000);
  const yesterdaySec = todaySec - DAY - 60;
  const refreshBody = {
    total: 7, succeeded: 7, failed: [],
    credits: { a: 1000, b: 1000, c: 1000, d: 1000, e: 1000, f: 1000, g: 777 },
    meta: {
      a: { cached: false, expiries: [
        { at: todaySec + 30 * DAY, amount: 100, created: todaySec - 600 },
        { at: yesterdaySec + 30 * DAY, amount: 999, created: yesterdaySec }] },
      b: { cached: false, expiries: [{ at: todaySec + 30 * DAY, amount: 50, created: todaySec - 1200 }] },
      c: { cached: true, expiries: [] },
      d: { cached: true, expiries: [] },
      e: { cached: true, expiries: [] },
      f: { cached: true, expiries: [] },
      g: { cached: true, expiries: [{ at: todaySec + 30 * DAY, amount: 7, created: todaySec - 300 }] }
    }
  };
  const snapWithDisabled = JSON.parse(JSON.stringify(snap));
  snapWithDisabled.accounts.push({ uid: "g", credits: 700, active: false });
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts/credits-snapshot": [{ body: snapWithDisabled }],
      "/api/accounts/refresh-credits": [{ body: refreshBody }]
    })
  });
  const n = note(r);
  ok("今日入账按积分包创建时间算（跳过昨天/停用号的包）",
    n.content.indexOf("今日入账：+150 积分（含签到）") >= 0, n.content);
  ok("剩余额度用刷新返回的 credits（不含停用号）",
    n.content.indexOf("消耗与剩余：58.67 积分 · 6,000 积分") >= 0, n.content);
  ok("只发 6 个 GET + 1 次刷新", r.calls.length === 6 && r.posts.length === 1,
    "calls=" + r.calls.length + " posts=" + r.posts.length);
  ok("仍然只发一条通知", r.notes.length === 1, String(r.notes.length));
  ok("日志里带了回源与入账", r.logs.some((l) => l.indexOf("回源=true") >= 0), r.logs.join("\n"));
}

/* ---------------- 16. 刷新部分失败：保留快照旧值 ---------------- */
console.log("\n[WorkBuddy] 刷新部分失败");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts/refresh-credits": [{ body: {
        total: 6, succeeded: 5, failed: ["a: 请求超时"],
        credits: { a: null, b: 1, c: 1, d: 1, e: 1, f: 1 },
        meta: { a: { cached: false, message: "请求超时", expiries: [] }, b: { cached: true } }
      } }]
    })
  });
  const n = note(r);
  ok("刷新失败的号保留快照旧值",
    n.content.indexOf("消耗与剩余：58.67 积分 · 3,658 积分") >= 0, n.content);
  ok("缺 expiries 时入账退回账本", n.content.indexOf("今日入账：+539 积分") >= 0, n.content);
  ok("不提示数据缺失", n.content.indexOf("部分数据缺失") < 0, n.content);
}

/* ---------------- 17. 地址填成 .../api ---------------- */
console.log("\n[WorkBuddy] 地址末尾带 /api");
{
  const r = run({
    argument: { baseURL: "https://wb.example.com/api/", token: "wbt_x" },
    routes: routes()
  });
  ok("不会拼成 /api/api", r.calls[0].url === "https://wb.example.com/api/sysinfo", r.calls[0].url);
}

/* ---------------- 18. Token 带 Bearer 前缀 ---------------- */
console.log("\n[WorkBuddy] Token 带 Bearer");
{
  const r = run({
    argument: { baseURL: "https://wb.example.com", token: "Bearer wbt_x" },
    routes: routes()
  });
  ok("自动去掉 Bearer", r.calls[0].headers.Authorization === "Bearer wbt_x", r.calls[0].headers.Authorization);
}

/* ---------------- 19. 多分组 ---------------- */
console.log("\n[WorkBuddy] 多分组");
{
  const r = run({
    argument: { baseURL: "https://wb.example.com", token: "wbt_x", group: "3" },
    routes: routes()
  });
  ok("GET 带 upstream_id", r.calls[0].url === "https://wb.example.com/api/sysinfo?upstream_id=3", r.calls[0].url);
  ok("POST 也带 upstream_id", /refresh-credits\?force=false&upstream_id=3$/.test(r.posts[0].url), r.posts[0].url);
}

/* ---------------- 20. 关闭点名 ---------------- */
console.log("\n[WorkBuddy] 关闭点名");
{
  const r = run({
    argument: { baseURL: "https://wb.example.com", token: "wbt_x", showNames: false },
    routes: routes()
  });
  ok("仍显示 0/6", note(r).content.indexOf("今日签到：0/6 个账号") >= 0, note(r).content);
  ok("不显示未签名单", note(r).content.indexOf("未签") < 0, note(r).content);
}

/* ---------------- 21-23. 失败提示 ---------------- */
console.log("\n[WorkBuddy] 失败提示");
{
  const all = {
    "/api/sysinfo": [{ body: "<html>login</html>" }],
    "/api/stats/summary": [{ body: "<html>login</html>" }],
    "/api/stats/credits": [{ body: "<html>login</html>" }],
    "/api/accounts/credits-snapshot": [{ body: "<html>login</html>" }],
    "/api/checkin-logs": [{ body: "<html>login</html>" }],
    "/api/accounts": [{ body: "<html>login</html>" }],
    "/api/accounts/refresh-credits": [{ body: "<html>login</html>" }]
  };
  const r1 = run({ argument: ARGS, routes: all });
  ok("登录页 HTML 被识别", note(r1).content.indexOf("不是 JSON") >= 0, note(r1).content);
  ok("提示改填根地址", note(r1).content.indexOf("根地址") >= 0, note(r1).content);

  const notFound = {
    "/api/sysinfo": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/stats/summary": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/stats/credits": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/accounts/credits-snapshot": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/checkin-logs": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/accounts": [{ status: 404, body: '{"detail":"Not Found"}' }],
    "/api/accounts/refresh-credits": [{ status: 404, body: '{"detail":"Not Found"}' }]
  };
  const r2 = run({ argument: ARGS, routes: notFound });
  ok("404 提示地址或版本", note(r2).content.indexOf("面板地址") >= 0, note(r2).content);

  const invalid = {
    "/api/sysinfo": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/stats/summary": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/stats/credits": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/accounts/credits-snapshot": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/checkin-logs": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/accounts": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }],
    "/api/accounts/refresh-credits": [{ status: 422, body: { detail: [{ msg: "Input should be a valid integer" }] } }]
  };
  const r3 = run({ argument: ARGS, routes: invalid });
  ok("422 提示分组 ID", note(r3).content.indexOf("分组 ID") >= 0, note(r3).content);
}

/* ---------------- 24. 只有不支持签到的号 ---------------- */
console.log("\n[WorkBuddy] 只有不支持签到的号");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts/credits-snapshot": [{ body: { count: 0, active_count: 0, accounts: [] } }],
      "/api/accounts": [{ body: { total: 2, accounts: [
        { uid: "x", nickname: "国际版1", checkin_supported: false },
        { uid: "y", nickname: "国际版2", checkin_supported: false }
      ] } }]
    })
  });
  ok("提示没有可签到的账号", note(r).content.indexOf("没有可签到的账号") >= 0, note(r).content);
  ok("说明有几个不支持签到", note(r).content.indexOf("2 个不支持签到") >= 0, note(r).content);
}

/* ---------------- 25. 全是停用号 ---------------- */
console.log("\n[WorkBuddy] 全是停用号");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts/credits-snapshot": [{ body: { count: 0, active_count: 0, accounts: [] } }],
      "/api/accounts": [{ body: { total: 2, accounts: [
        { uid: "x", nickname: "停用1", disabled_by_panel: true, checkin_supported: true },
        { uid: "y", nickname: "停用2", disabled: true, checkin_supported: true }
      ] } }]
    })
  });
  ok("提示没有可签到的账号", note(r).content.indexOf("没有可签到的账号") >= 0, note(r).content);
  ok("说明有几个已停用", note(r).content.indexOf("2 个已停用") >= 0, note(r).content);
}

/* ---------------- 26. Surge 运行时 ---------------- */
console.log("\n[WorkBuddy] Surge 运行时");
{
  const arg = "baseURL=" + encodeURIComponent("https://wb.example.com") +
    "&token=wbt_surge&requestNode=none&notify=true";
  const r = run({
    env: { "surge-version": "5.11.0" },
    argument: arg,
    routes: routes({ "/api/accounts": [{ body: poolFixture(["a", "b", "c", "d", "e", "f"]) }] })
  });
  ok("字符串参数也能播报", note(r).content.indexOf("✅ 今日签到：6/6 个账号") >= 0, note(r).content);
  ok("baseURL 解码正确", r.calls[0].url === "https://wb.example.com/api/sysinfo", r.calls[0].url);
  ok("Surge 超时用秒", r.calls[0].timeout === 12, String(r.calls[0].timeout));
  ok("关掉 auto-cookie", r.calls[0]["auto-cookie"] === false);
  ok("requestNode=none 不带 policy", !("policy" in r.calls[0]));
}

/* ---------------- 27. 失败时显示面板版本 ---------------- */
console.log("\n[WorkBuddy] 失败时带面板版本");
{
  const r = run({
    argument: ARGS,
    routes: {
      "/api/sysinfo": [{ body: { service: "workbuddy-manager", version: "2.11.23" } }],
      "/api/stats/summary": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/stats/credits": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts/credits-snapshot": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/checkin-logs": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts": [{ status: 401, body: '{"detail":"未登录"}' }],
      "/api/accounts/refresh-credits": [{ status: 401, body: '{"detail":"未登录"}' }]
    }
  });
  ok("内容里有面板版本", note(r).content.indexOf("面板版本：2.11.23") >= 0, note(r).content);
}

/* ---------------- 28. 请求并行 ---------------- */
console.log("\n[WorkBuddy] 请求并行");
{
  const r = run({ argument: ARGS, routes: routes(), holdRefresh: true });
  ok("刷新未返回前 6 个读取已全部发出", r.calls.length === 6 && r.posts.length === 1,
    "calls=" + r.calls.length + " posts=" + r.posts.length);
  ok("还没渲染（在等刷新结果）", r.notes.length === 0, String(r.notes.length));
  r.held[0]();
  ok("刷新返回后播报", r.notes.length === 1, String(r.notes.length));
}

/* ---------------- 29. 毫秒时间戳 / logs 字段 ---------------- */
console.log("\n[WorkBuddy] 毫秒时间戳与字段兼容");
{
  const items = [{ ts: (NOW - 60) * 1000, uid: "a", success: true, message: "签到成功", auto: false }];
  const pool = poolFixture(["a", "b", "c", "d", "e", "f"]);
  pool.accounts[0].checkin_today = NOW * 1000;
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/checkin-logs": [{ body: { total: 1, logs: items } }],
      "/api/accounts": [{ body: pool }]
    })
  });
  ok("毫秒 ts 也能归到今天", note(r).content.indexOf("✅ 今日签到：6/6 个账号") >= 0, note(r).content);
}

/* ---------------- 30. 老字段名 ---------------- */
console.log("\n[WorkBuddy] 老版本字段名");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/stats/summary": [{ body: { requests: 10, tokens: 1200, credit: 5 } }]
    })
  });
  const n = note(r);
  ok("用量字段兼容 requests/tokens", n.content.indexOf("10 次 · 1.2K tokens") >= 0, n.content);
  ok("消耗字段兼容 credit", n.content.indexOf("消耗与剩余：5 积分") >= 0, n.content);
}

/* ---------------- 31. 只有快照时的签到行 ---------------- */
console.log("\n[WorkBuddy] 只有快照时的签到行");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/checkin-logs": [{ status: 500, body: "boom" }],
      "/api/accounts": [{ status: 500, body: "boom" }]
    })
  });
  const n = note(r);
  ok("用快照分母报 0/6", n.content.indexOf("今日签到：0/6 个账号") >= 0, n.content);
  ok("提示账号列表与签到记录缺失",
    n.content.indexOf("账号列表") >= 0 && n.content.indexOf("签到记录") >= 0, n.content);
}

/* ---------------- 32. 刷新入账为 0 时不覆盖账本 ---------------- */
console.log("\n[WorkBuddy] 刷新入账为 0 时保留账本");
{
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts/refresh-credits": [{ body: {
        total: 6, succeeded: 6, failed: [],
        credits: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
        meta: { a: { cached: true, expiries: [] }, b: { cached: true, expiries: [] } }
      } }]
    })
  });
  ok("账本有 539 时不被 0 覆盖", note(r).content.indexOf("今日入账：+539 积分") >= 0, note(r).content);
}

/* ---------------- 33. 字符串布尔 ---------------- */
console.log("\n[WorkBuddy] 字符串布尔兼容");
{
  const pool = poolFixture(["a", "b", "c", "d", "e", "f"]);
  pool.accounts[0].disabled = "false";
  pool.accounts[1].disabled_by_panel = "false";
  const r = run({
    argument: ARGS,
    routes: routes({
      "/api/accounts": [{ body: pool }]
    })
  });
  ok("disabled=\"false\" 不当作停用", note(r).content.indexOf("✅ 今日签到：6/6 个账号") >= 0, note(r).content);
}

/* ---------------- 34. 分组 ID 不存在 ---------------- */
console.log("\n[WorkBuddy] 分组 ID 不存在");
{
  const all404 = {};
  for (const p of ["/api/sysinfo", "/api/stats/summary", "/api/stats/credits",
    "/api/accounts/credits-snapshot", "/api/checkin-logs", "/api/accounts",
    "/api/accounts/refresh-credits"]) {
    all404[p] = [{ status: 404, body: '{"detail":"Not Found"}' }];
  }
  const r = run({
    argument: { baseURL: "https://wb.example.com", token: "wbt_x", group: "9" },
    routes: all404
  });
  ok("404 且带分组时提示分组不存在", note(r).content.indexOf("分组不存在") >= 0, note(r).content);
  ok("给出留空分组的建议", note(r).content.indexOf("分组 ID") >= 0 && note(r).content.indexOf("留空") >= 0, note(r).content);
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail > 0) process.exit(1);
