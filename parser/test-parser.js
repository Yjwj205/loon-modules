// 资源解析器筛选功能测试（模拟 Loon 运行环境）
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SRC = path.join(__dirname, "loon_resource_parser.js");
const code = fs.readFileSync(SRC, "utf8");

function run(resource, arg, type = 1) {
  const logs = [];
  let output = Symbol("no-done");
  const sandbox = {
    console: { log: (...a) => logs.push(a.join(" ")) },
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    TextDecoder, TextEncoder,
    setTimeout, clearTimeout,
    $resource: resource,
    $resourceType: type,
    $argument: arg,
    $done: (r) => { output = r; },
  };
  sandbox.unescape = global.unescape;
  sandbox.escape = global.escape;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "parser.js" });
  return { output, logs };
}

const plain = [
  "[Proxy]",
  "香港01 = Shadowsocks,1.2.3.4,8388,aes-128-gcm,pass,udp=true",
  "日本02 = Shadowsocks,1.2.3.5,8388,aes-128-gcm,pass,udp=true",
  "新加坡03 = Shadowsocks,1.2.3.6,8388,aes-128-gcm,pass,udp=true",
  "香港-试用 = Shadowsocks,1.2.3.7,8388,aes-128-gcm,pass,udp=true",
  "",
].join("\n");

function namesOf(out) {
  return String(out)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && l.indexOf(" = ") > 0)
    .map((l) => l.slice(0, l.indexOf(" = ")).trim());
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

const uriPlain = [
  "trojan://pass@1.2.3.4:443?sni=a.com#香港A",
  "trojan://pass@1.2.3.5:443?sni=b.com#日本B",
  "trojan://pass@1.2.3.6:443?sni=c.com#新加坡C",
].join("\n");

const yaml = [
  "proxies:",
  '  - name: "香港A"',
  "    type: ss",
  "    server: 1.2.3.4",
  "    port: 8388",
  "    cipher: aes-128-gcm",
  '    password: "pass"',
  '  - name: "日本B"',
  "    type: ss",
  "    server: 1.2.3.5",
  "    port: 8388",
  "    cipher: aes-128-gcm",
  '    password: "pass"',
  '  - name: "试用C"',
  "    type: ss",
  "    server: 1.2.3.6",
  "    port: 8388",
  "    cipher: aes-128-gcm",
  '    password: "pass"',
  "",
].join("\n");

const A = (extra) => Object.assign(
  { pre: "", suf: "", emoji: false, rename: "", sort: "", exc: "", keep: "", regex: "", ua: false, userAgent: "", noCache: false, importNodes: "", tlsProfile: "不处理" },
  extra
);

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("PASS " + name);
  } catch (e) {
    fail++;
    console.log("FAIL " + name + " -> " + e.message);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg ? msg + " " : "") + "期望 " + b + " 实际 " + a);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || "断言失败"); }

// 1 基线：无参数 → 原样透传
t("无参数透传（除尾部空行外不变）", () => {
  const { output } = run(plain, A({}));
  eq(output, plain.replace(/\n$/, ""));
});

// 2 关键词保留
t("keep 关键词保留（Loon 文本）", () => {
  const { output } = run(plain, A({ keep: "香港,日本" }));
  eq(namesOf(output), ["香港01", "日本02", "香港-试用"]);
});

// 3 正则保留
t("regex 正则保留（Loon 文本）", () => {
  const { output } = run(plain, A({ regex: "香港|日本" }));
  eq(namesOf(output), ["香港01", "日本02", "香港-试用"]);
});

// 4 正则排除
t("regex 行首 ! 表示排除", () => {
  const { output } = run(plain, A({ regex: "!试用" }));
  eq(namesOf(output), ["香港01", "日本02", "新加坡03"]);
});

// 5 keep 与 regex 同时 → AND
t("keep + regex 同时满足", () => {
  const { output } = run(plain, A({ keep: "香港", regex: "01$" }));
  eq(namesOf(output), ["香港01"]);
});

// 6 旧 exc 参数不回归
t("exc 排除关键词仍有效", () => {
  const { output } = run(plain, A({ exc: "试用" }));
  eq(namesOf(output), ["香港01", "日本02", "新加坡03"]);
});

// 7 非法正则被忽略且不中断
t("非法正则忽略 + 警告日志", () => {
  const { output, logs } = run(plain, A({ regex: "([", keep: "香港" }));
  eq(namesOf(output), ["香港01", "香港-试用"]);
  ok(logs.some((l) => l.includes("正则无效")), "应输出正则无效日志");
});

// 8 (?i) 内联忽略大小写
t("(?i) 忽略大小写", () => {
  const src = "[Proxy]\nHK01 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\nJP02 = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  eq(namesOf(run(src, A({ regex: "(?i)hk" })).output), ["HK01"]);
});

// 9 /表达式/标志 写法
t("/re/i 写法", () => {
  const src = "[Proxy]\nHK01 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\nJP02 = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  eq(namesOf(run(src, A({ regex: "/hk/i" })).output), ["HK01"]);
});

// 10 Base64 订阅
t("Base64 订阅筛选", () => {
  const { output } = run(b64(uriPlain), A({ regex: "香港|日本" }));
  eq(namesOf(output), ["香港A", "日本B"]);
});

// 11 Base64 + keep
t("Base64 订阅 keep", () => {
  const { output } = run(b64(uriPlain), A({ keep: "新加坡" }));
  eq(namesOf(output), ["新加坡C"]);
});

// 12 YAML 订阅
t("YAML 订阅 正则排除", () => {
  const { output } = run(yaml, A({ regex: "!试用" }));
  eq(namesOf(output), ["香港A", "日本B"]);
});

// 13 YAML keep + regex
t("YAML 订阅 keep + regex", () => {
  const { output } = run(yaml, A({ keep: "香港,日本", regex: "(?i)b$" }));
  eq(namesOf(output), ["日本B"]);
});

// 14 前缀/后缀与筛选用最终名
t("pre/suf 后名称仍可筛选", () => {
  const { output } = run(plain, A({ pre: "A-", keep: "香港" }));
  eq(namesOf(output), ["A-香港01", "A-香港-试用"]);
});

// 15 全部被过滤 → 空输出 + 提示
t("全部过滤时空输出并提示", () => {
  const { output, logs } = run(plain, A({ keep: "韩国" }));
  eq(namesOf(output), []);
  ok(logs.some((l) => l.includes("保留条件未命中")), "应输出未命中提示");
});

// 16 排序 + 保留共存
t("sort + keep 排序仍生效", () => {
  const { output } = run(plain, A({ keep: "香港,日本,新加坡", sort: "日本,香港,新加坡" }));
  eq(namesOf(output), ["日本02", "香港01", "香港-试用", "新加坡03"]);
});

// 17 导入节点同样被筛选
t("importNodes 也受 keep 约束", () => {
  const imports = [
    "trojan://p@1.2.3.4:443?sni=a#香港X",
    "trojan://p@1.2.3.5:443?sni=b#美国Y",
  ].join("\n");
  const { output } = run(plain, A({ pre: "", keep: "香港", importNodes: imports }));
  const ns = namesOf(output);
  ok(ns.includes("香港X"), "应保留导入的香港X");
  ok(!ns.includes("美国Y"), "应过滤导入的美国Y");
  ok(!ns.includes("日本02"), "订阅里的日本应被过滤");
});

// 18 正则含逗号不被切分（filter 不按逗号拆分）
t("正则内逗号不被拆分", () => {
  const src = "[Proxy]\n香港01 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\n香港02 = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  const { output } = run(src, A({ regex: "香港0[12]" }));
  eq(namesOf(output), ["香港01", "香港02"]);
});

// 19 转义逗号关键词
t("keep 支持 \\, 转义", () => {
  const src = "[Proxy]\nA，B = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\nC = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  // 名称中的英文逗号会被规范化成中文逗号，这里验证转义后不会拆成两个关键词
  eq(namesOf(run(src, A({ keep: "A\\,B" })).output), ["A，B"]);
});

// 20 自定义 UA 关闭时不影响
t("ua=false 走同步路径", () => {
  const { output } = run(plain, A({ ua: false, keep: "日本" }));
  eq(namesOf(output), ["日本02"]);
});

// 21 单字段多行：保留 + 排除 同时生效
t("regex 多行 保留+排除", () => {
  const src = "[Proxy]\n香港01 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\n香港-官网 = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n日本02 = Shadowsocks,1.1.1.3,80,aes-128-gcm,p\n";
  const { output } = run(src, A({ regex: "香港|日本\n!官网" }));
  eq(namesOf(output), ["香港01", "日本02"]);
});

// 22 \! 字面量感叹号
t("regex \\! 视为字面感叹号", () => {
  const src = "[Proxy]\n!备用 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\n普通 = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  eq(namesOf(run(src, A({ regex: "\\!备用" })).output), ["!备用"]);
});

// 23 排除模式支持 (?i)
t("排除模式 + (?i)", () => {
  const src = "[Proxy]\nHK官网 = Shadowsocks,1.1.1.1,80,aes-128-gcm,p\nJP = Shadowsocks,1.1.1.2,80,aes-128-gcm,p\n";
  eq(namesOf(run(src, A({ regex: "!(?i)hk" })).output), ["JP"]);
});

// 24 只写 ! 视为空表达式，忽略
t("单独的 ! 被忽略", () => {
  eq(namesOf(run(plain, A({ regex: "!" })).output), ["香港01", "日本02", "新加坡03", "香港-试用"]);
});

// 25 节点名带空格 + REMARKS/STATUS 头的 Base64 订阅（anytls）
t("节点名含空格的 Base64 订阅可处理", () => {
  const body = [
    "REMARKS=测试机场",
    "STATUS=Traffic: 43.97 GiB/100.00 GiB | Expires: 2027-06-17 11:58:00 +0800 CST",
    "# Generated at: 2026-11-10 19:01:17",
    "",
    "anytls://uuid-1@1.2.3.4:443?security=tls&sni=a.example.com&fp=firefox&udp=1#[A]HK PrivateNET 01",
    "anytls://uuid-1@1.2.3.5:443?security=tls&sni=b.example.com&udp=1#[A]TW PrivateNET 02",
  ].join("\n");
  const { output } = run(b64(body), A({ pre: "【T】" }));
  const names = namesOf(output);
  eq(names, ["【T】[A]HK PrivateNET 01", "【T】[A]TW PrivateNET 02"]);
  ok(String(output).includes("REMARKS="), "应保留 REMARKS 头");
});

// 26 该格式也能被正则筛选
t("带空格节点名的订阅支持 regex", () => {
  const body = [
    "anytls://uuid-1@1.2.3.4:443?sni=a#[A]HK PrivateNET 01",
    "anytls://uuid-1@1.2.3.5:443?sni=b#[A]TW PrivateNET 02",
    "anytls://uuid-1@1.2.3.6:443?sni=c#[A]JP PrivateNET 03",
  ].join("\n");
  eq(namesOf(run(b64(body), A({ regex: "^(?=.*\\[A\\])(?=.*(?:HK|TW))" })).output), ["[A]HK PrivateNET 01", "[A]TW PrivateNET 02"]);
});

console.log("\n结果: " + pass + " 通过, " + fail + " 失败");
process.exit(fail ? 1 : 0);
