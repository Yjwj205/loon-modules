/**
 * 生成「点选版」插件：把用户实际的策略组名写进 [Argument] 的 select 选项，
 * 于是插件设置界面里出现的是真正的下拉框（Loon 不支持运行时动态填充选项）。
 *
 * 用法：node gen-select.js groups.json [块数]
 *   groups.json = ["综合利用EMBY4837", "吹雪云观影组", ...]
 * 产物：policy-select.plugin
 */

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
const blocks = parseInt(process.argv[3] || "6", 10);
if (!file) {
  console.error("用法：node gen-select.js groups.json [块数]");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(file, "utf8"));
// 兼容三种输入：["A","B"] / {"groups":[...]} / "A\nB"
let names = Array.isArray(raw) ? raw : (raw.groups || String(raw).split(/[\n,，、;；]+/));
names = names.map(s => String(s).trim()).filter(Boolean);

// 去重
names = Array.from(new Set(names));

if (!names.length) {
  console.error("没有读到策略组名");
  process.exit(1);
}

const bad = names.filter(n => /[",]/.test(n));
if (bad.length) {
  console.error("⚠️ 这些组名含英文逗号或引号，放进 select 会破坏插件解析，请先改名：" + bad.join(" / "));
  process.exit(1);
}

const CN = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];

const scriptURL = "https://raw.githubusercontent.com/Yjwj205/loon-modules/main/switch-multi.js";

const opts = ['"（不用）"'].concat(names.map(n => `"${n}"`)).join(",");

let out = [];
out.push("#!name = 定时切换策略·点选");
out.push("#!desc = 每个策略组一段独立配置：下拉选组 + 早上/晚上各一个目标");
out.push("#!author = Yjwj205 / Minis");
out.push("#!homepage = https://github.com/Yjwj205");
out.push("#!icon = clock.badge.checkmark");
out.push("#!system = iOS");
out.push("#!loon_version = 3.5.1(983)");
out.push("#!date = " + new Date().toISOString().slice(0, 10));
out.push("#!tag = 策略");
out.push("#!type = normal");
out.push("");
out.push("[Argument]");
out.push('amTime = input,"0 9 * * *",tag=早上触发时间,desc=5 段 cron（分 时 日 月 周）');
out.push('pmTime = input,"0 19 * * *",tag=晚上触发时间,desc=5 段 cron（分 时 日 月 周）');

for (let i = 1; i <= blocks; i++) {
  const n = CN[i - 1] || String(i);
  out.push(`g${i} = select,${opts},tag=${n} 策略组,desc=从下拉里选一个策略组；选「（不用）」= 这一段不参与切换`);
  out.push(`g${i}am = input,"",tag=${n} 早上切到,desc=填该组的节点/子策略名，留空 = 早上不切这一组。也可写序号或唯一关键字`);
  out.push(`g${i}pm = input,"",tag=${n} 晚上切到,desc=同上，留空 = 晚上不切这一组`);
}

out.push('notify = switch,true,tag=切换时通知');
out.push('toolAction = select,"列出策略组","保存方案1","保存方案2","保存方案3","应用方案1","应用方案2","应用方案3",tag=策略工具（可选）,desc=需要看当前各组选了什么时手动运行');
out.push("");
out.push("[Script]");

const amArgs = [], pmArgs = [];
for (let i = 1; i <= blocks; i++) {
  amArgs.push(`\${g${i}}`, `\${g${i}am}`);
  pmArgs.push(`\${g${i}}`, `\${g${i}pm}`);
}
amArgs.push("${amTime}");
pmArgs.push("${pmTime}");

out.push(`cron \${amTime} then script("${scriptURL}", {${amArgs.join(", ")}}) with tag="早上切换", timeout=60`);
out.push(`cron \${pmTime} then script("${scriptURL}", {${pmArgs.join(", ")}}) with tag="晚上切换", timeout=60`);
out.push(`generic then script("${scriptURL}", {\${toolAction}, \${notify}}) with tag="策略工具", img_url="list.bullet", timeout=60`);
out.push("");

const dst = path.join(__dirname, "policy-select.plugin");
fs.writeFileSync(dst, out.join("\n"), "utf8");
console.log("已生成 " + dst + "（" + names.length + " 个可选策略组 × " + blocks + " 段）");
console.log("下拉选项：" + ["（不用）"].concat(names).join(" | "));
