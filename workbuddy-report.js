/**
 * WorkBuddy 面板日报（Loon cron / generic 脚本 · 公开版）
 *
 * 作者：Yjwj205 / Minis
 * 主页：https://github.com/Yjwj205
 * 仓库：https://github.com/Yjwj205/loon-modules
 *
 * 面向 WorkBuddy Manager（https://github.com/ithtelab/workbuddy-manager）的只读播报：
 * 今日签到账号数、今日用量、今日入账、消耗与剩余额度。
 * 不签到、不改任何设置；播报前只会调一次面板自己的「刷新余额（缓存版）」，
 * 让「今日入账」及时记账（只读 Token 就能调）。
 *
 * 参数（Loon 插件 [Argument] 传对象；也兼容 "k=v&k2=v2" 字符串）：
 *   baseURL     WorkBuddy Manager 地址，如 https://wb.example.com
 *   token       只读 API Token（wbt_ 开头），面板 → API Tokens 创建
 *   group       可选：面板多上游分组的数字 ID（不是 Loon 策略组）；留空 = 默认上游
 *   requestNode 可选：节点名 / 策略组名 / DIRECT；留空跟随规则
 *   notify      可选：是否发通知，默认 true
 *   showNames   可选：是否点名未签账号，默认 true
 *
 * 数据来源（全部是只读 GET，外加一个只读的缓存刷新 POST）：
 *   /api/sysinfo                     面板版本（仅日志/排错用）
 *   /api/stats/summary               今日消耗积分 / 请求次数 / token 数
 *   /api/stats/credits?days=2        今日入账（刷新响应里算不出时的兜底）
 *   /api/accounts/credits-snapshot   各账号剩余积分快照（刷新失败时的兜底）
 *   /api/checkin-logs?days=2&limit=500  签到记录（本端触发 + 上游自动）
 *   /api/accounts                    账号列表（分母、昵称、今日是否已签）
 *   POST /api/accounts/refresh-credits?force=false
 *        返回里带各账号最新积分（credits）和积分包明细（meta.*.expiries），
 *        所以「剩余额度」和「今日入账」优先从它算，不再多读一轮。
 *
 * 任一接口失败只影响对应那一行；全部失败才播「获取失败」，并给出排查方向。
 */
(function () {
  "use strict";

  var VERSION = "2026-11-24 公开版";
  var TITLE = "WorkBuddy 面板日报";
  var T0 = Date.now();

  var TIMEOUT = 12000;
  var RETRY = 1;

  /* ---------- 参数 ---------- */

  var isSurge = typeof $environment !== "undefined" && $environment && !!$environment["surge-version"];

  function parseArgs(raw) {
    var out = {};
    if (raw === null || raw === undefined) return out;
    if (typeof raw === "object") {
      for (var k in raw) {
        if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
      }
      return out;
    }
    String(raw).split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      if (i <= 0) return;
      var key = kv.slice(0, i).trim();
      var val = kv.slice(i + 1).trim();
      try { val = decodeURIComponent(val); } catch (e) {}
      out[key] = val;
    });
    return out;
  }

  function isFalse(v) {
    if (v === false) return true;
    var s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
    return s === "false" || s === "0" || s === "off" || s === "no";
  }

  function flag(v, def) {
    if (v === undefined || v === null || String(v).trim() === "" || String(v) === "none") return def;
    return !isFalse(v);
  }

  /** 兼容 JSON 里把布尔写成字符串（"false" / "0"）的面板版本 */
  function truthy(v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toLowerCase();
    return !(s === "" || s === "false" || s === "0" || s === "no" || s === "off");
  }

  /** 去掉引号 / 末尾斜杠；没写协议时补 http://；"none" 视为空 */
  function normalizeBase(raw) {
    var s = String(raw === undefined || raw === null ? "" : raw).trim();
    if (s === "none") return "";
    s = s.replace(/^["'`\s]+|["'`\s]+$/g, "");
    if (!s) return "";
    if (/^\/\//.test(s)) s = "http:" + s;
    else if (!/^https?:\/\//i.test(s)) {
      if (/^[^\s/]+(\/|$)/.test(s)) s = "http://" + s;
    }
    return s.replace(/\/+$/, "");
  }

  /** 允许用户直接粘贴 "Bearer wbt_xxx" */
  function normalizeToken(raw) {
    var s = String(raw === undefined || raw === null ? "" : raw).trim();
    if (s === "none") return "";
    s = s.replace(/^["'`\s]+|["'`\s]+$/g, "");
    s = s.replace(/^Bearer\s+/i, "");
    return s.trim();
  }

  var params = parseArgs(typeof $argument === "undefined" ? null : $argument);

  var baseURL = normalizeBase(params.baseURL);
  var token = normalizeToken(params.token);
  var group = String(params.group || "").trim();
  if (group === "none" || group === "0") group = "";
  var requestNode = String(params.requestNode || "").trim();
  if (requestNode === "none") requestNode = "";
  var notifyOn = flag(params.notify, true);
  var showNames = flag(params.showNames, true);

  // 用户把面板地址填成 ".../api" 时不要再拼一次 /api
  var apiSuffix = /\/api$/i.test(baseURL);

  function apiURL(path) {
    var p = path;
    if (apiSuffix && p.indexOf("/api/") === 0) p = p.slice(4);
    if (group) {
      p += (p.indexOf("?") >= 0 ? "&" : "?") + "upstream_id=" + encodeURIComponent(group);
    }
    return baseURL + p;
  }

  /* ---------- 小工具 ---------- */

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** 数字或可解析的时间 → 秒；兼容毫秒时间戳 */
  function toSec(v) {
    if (v === null || v === undefined || v === "") return 0;
    var n = Number(v);
    if (isFinite(n) && n > 0) {
      if (n > 1e11) n /= 1000;
      return Math.floor(n);
    }
    var t = Date.parse(String(v));
    return isFinite(t) ? Math.floor(t / 1000) : 0;
  }

  function trimZero(s) {
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s;
  }

  /** 保留两位小数并去掉多余的 0：58.670 -> "58.67"，3653.00 -> "3653" */
  function fmtCredit(v) {
    return trimZero(toNum(v).toFixed(2));
  }

  /** 整数千分位：16259 -> "16,259" */
  function fmtInt(v) {
    var n = Math.round(toNum(v));
    var s = String(Math.abs(n));
    var out = "";
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ",";
      out += s.charAt(i);
    }
    return (n < 0 ? "-" : "") + out;
  }

  /** token 数：6228707 -> "6.23M" */
  function fmtTokens(v) {
    var n = toNum(v);
    if (n >= 1e9) return trimZero((n / 1e9).toFixed(2)) + "B";
    if (n >= 1e6) return trimZero((n / 1e6).toFixed(2)) + "M";
    if (n >= 1e3) return trimZero((n / 1e3).toFixed(1)) + "K";
    return String(Math.round(n));
  }

  /** 本地时区的 YYYY-MM-DD（面板按自己的时区统计，播报按手机的今天算） */
  function localDay(sec) {
    var d = new Date((sec || 0) * 1000);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function todayKey() {
    return localDay(Math.floor(Date.now() / 1000));
  }

  /** 从对象里取第一个有值的字段（老版本面板字段名可能不同） */
  function pick(obj, names) {
    if (!obj || typeof obj !== "object") return undefined;
    for (var i = 0; i < names.length; i++) {
      var v = obj[names[i]];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  }

  function pickNum(obj, names) {
    var v = pick(obj, names);
    if (v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /** 接口返回的数组字段名可能是 accounts / items / data */
  function asArray(v) {
    if (!v) return [];
    if (Object.prototype.toString.call(v) === "[object Array]") return v;
    if (typeof v !== "object") return [];
    var keys = ["accounts", "items", "data", "logs", "list"];
    for (var i = 0; i < keys.length; i++) {
      if (Object.prototype.toString.call(v[keys[i]]) === "[object Array]") return v[keys[i]];
    }
    return [];
  }

  function finish(subtitle, content) {
    var body = String(content);

    if (notifyOn) {
      try {
        $notification.post(TITLE, subtitle, body);
      } catch (e) {
        console.log("[WorkBuddy] 通知发送失败：" + e);
      }
    }

    console.log("[WorkBuddy] " + VERSION + " 总耗时 " + (Date.now() - T0) + "ms" +
      (subtitle ? " | " + subtitle : "") + " | " + body.replace(/\n/g, " / "));
    $done();
  }

  /* ---------- 请求 ---------- */

  function detailText(json) {
    var d = json && json.detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object") {
      if (Object.prototype.toString.call(d) === "[object Array]") {
        return d.map(function (x) {
          return x && (x.msg || x.message) ? String(x.msg || x.message) : "";
        }).filter(Boolean).join("；");
      }
      return String(d.message || d.msg || "");
    }
    return "";
  }

  function httpError(status, json) {
    var s = detailText(json).replace(/\s+/g, " ").slice(0, 80);
    return "HTTP " + status + (s ? "：" + s : "");
  }

  function req(path, method, cb) {
    var attempt = 1;

    function send() {
      var opts = {
        url: apiURL(path),
        timeout: isSurge ? 12 : TIMEOUT,
        headers: {
          "Authorization": "Bearer " + token,
          "Accept": "application/json"
        }
      };
      if (isSurge) {
        opts["auto-cookie"] = false;
        if (requestNode) opts.policy = requestNode;
      } else if (requestNode) {
        opts.node = requestNode;
      }

      var call = method === "POST" ? $httpClient.post : $httpClient.get;

      call(opts, function (error, response, data) {
        if (error) {
          if (attempt <= RETRY) {
            attempt++;
            return setTimeout(send, 800);
          }
          return cb({ error: "网络错误：" + String(error), kind: "network" });
        }

        var status = Number((response && response.status) || 0);
        var text = String(data === null || data === undefined ? "" : data);

        if (status === 401) return cb({ error: "Token 无效或已停用", kind: "auth" });
        if (status === 403) return cb({ error: "Token 权限不足（只读权限即可）", kind: "forbidden" });
        if (status === 404) {
          return cb(group
            ? { error: "分组不存在（面板分组 ID 可能不对）", kind: "group" }
            : { error: "接口不存在（面板版本过旧或地址不对）", kind: "missing" });
        }

        var json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {}

        if (!json || typeof json !== "object") {
          return cb({
            error: "返回的不是 JSON（HTTP " + status + "），地址可能指到了面板网页或被登录页拦截",
            kind: "nonjson"
          });
        }
        if (status >= 400) return cb({ error: httpError(status, json), kind: "http", status: status });

        cb(null, json);
      });
    }

    send();
  }

  /* ---------- 解析 ---------- */

  /** 今日签到：优先按账号行去重计数，只有自动签到汇总行时退回汇总 */
  function parseCheckin(logs) {
    var out = { signed: 0, fromSummary: false, uids: {} };
    var items = asArray(logs);
    if (!items.length) return out;

    var today = todayKey();
    var seen = {};
    var signed = 0;
    var summaryOk = 0;
    var hasSummary = false;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it !== "object") continue;

      var ts = toSec(pick(it, ["ts", "time", "created_at", "createdAt"]));
      if (!ts || localDay(ts) !== today) continue;

      var okFlag = it.success !== undefined ? truthy(it.success)
        : (it.ok !== undefined ? truthy(it.ok) : true);
      if (!okFlag) continue;

      var isAuto = it.auto === true || it.source === "auto";
      if (isAuto) {
        // 上游自动签到只留一行「本轮签到完成：共 6 个，成功 2，已签到 0，失败 3，跳过 1」
        var m = String(it.message || "").match(/成功\s*(\d+)[，,、\s]*已签到\s*(\d+)/);
        if (m) {
          var n = Number(m[1]) + Number(m[2]);
          if (isFinite(n) && n > summaryOk) summaryOk = n;
          hasSummary = true;
        }
        continue;
      }

      var uid = String(pick(it, ["uid", "account_uid", "accountUid"]) || "");
      if (!uid || seen[uid]) continue;
      seen[uid] = 1;
      out.uids[uid] = 1;
      signed++;
    }

    if (signed > 0) {
      out.signed = signed;
    } else if (hasSummary) {
      out.signed = summaryOk;
      out.fromSummary = true;
    }
    return out;
  }

  /** 剩余额度：快照里还能被调度的账号积分合计 */
  function parseRemaining(snap) {
    var out = { credits: 0, accounts: 0, known: false };
    var rows = asArray(snap);
    if (!rows.length) return out;

    var sum = 0;
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== "object") continue;
      if (isFalse(row.active) || row.known === false) continue;
      if (truthy(row.disabled) || truthy(row.disabled_by_panel)) continue;

      var v = pickNum(row, ["credits", "credit", "balance", "remain", "remaining"]);
      if (v === null) continue;
      sum += v;
      n++;
    }
    if (n > 0) {
      out.credits = sum;
      out.accounts = n;
      out.known = true;
    }
    return out;
  }

  /**
   * 账号池点名：谁签了、谁没签。
   * 已签到 = 签到记录里的 uid ∪ 账号自带 checkin_today（同一份数据）。
   * 停用 / 面板禁用 / 缺 accessToken / 不支持签到（国际版、企业号）的号不算分母。
   */
  function accountRoll(pool, checkinUids) {
    var out = { total: 0, signed: 0, unsigned: [], unsupported: 0, disabled: 0 };
    var rows = asArray(pool);
    if (!rows.length) return out;

    var today = todayKey();
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      if (!a || typeof a !== "object") continue;
      if (truthy(a.disabled) || truthy(a.disabled_by_panel) || a.invalid_reason) {
        out.disabled++;
        continue;
      }
      if (a.checkin_supported === false) {
        out.unsupported++;
        continue;
      }

      out.total++;
      var uid = String(pick(a, ["uid", "account_uid", "accountUid"]) || "");
      var doneAt = toSec(a.checkin_today);
      var signed = (uid && checkinUids && checkinUids[uid]) ||
        (doneAt && localDay(doneAt) === today);
      if (signed) {
        out.signed++;
      } else {
        out.unsigned.push(String(a.nickname || a.note || a.domain || uid.slice(0, 8) || "未命名"));
      }
    }
    return out;
  }

  /* ---------- 从刷新响应里直接取数 ---------- */

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /**
   * 余额刷新（POST /accounts/refresh-credits）的响应里已经包含：
   *   credits: { uid: 最新积分 }             → 剩余额度，不用再读快照
   *   meta:    { uid: { cached, expiries } } → 各账号的积分包明细
   *
   * 面板账本按积分包的创建时间记账（server/services/credits.py 里
   * deliver_at = created），所以「今天新建的包金额之和」就等于今天的入账。
   * 老版本面板没有这些字段时返回 null，调用方退回快照 / 积分收支接口。
   *
   * 与私有版的区别：这里同时用账号列表和快照判断「哪些号不算」，
   * 刷新失败的号保留快照旧值；积分包金额 / 创建时间的字段名也做了兼容。
   */
  function deriveFromRefresh(refresh, snap, pool) {
    if (!refresh || typeof refresh !== "object") return null;

    var excluded = {};
    var poolRows = asArray(pool);
    var i, row, uid;

    for (i = 0; i < poolRows.length; i++) {
      row = poolRows[i];
      if (!row || typeof row !== "object") continue;
      uid = String(pick(row, ["uid", "account_uid", "accountUid"]) || "");
      if (!uid) continue;
      if (truthy(row.disabled) || truthy(row.disabled_by_panel) || row.invalid_reason) excluded[uid] = true;
    }

    var snapRows = asArray(snap);
    for (i = 0; i < snapRows.length; i++) {
      row = snapRows[i];
      if (!row || typeof row !== "object") continue;
      uid = String(row.uid || "");
      if (!uid) continue;
      if (isFalse(row.active) || row.known === false) excluded[uid] = true;
    }

    var credits = refresh.credits;
    var creditsOk = credits && typeof credits === "object";
    var remain = null;

    if (creditsOk) {
      var sum = 0;
      var n = 0;
      var covered = {};

      // 以快照的账号表为基准：刷新成功的用新值，刷新失败 / 没返回的保留快照旧值。
      if (snapRows.length) {
        for (i = 0; i < snapRows.length; i++) {
          row = snapRows[i];
          if (!row || typeof row !== "object") continue;
          if (isFalse(row.active) || row.known === false) continue;
          if (truthy(row.disabled) || truthy(row.disabled_by_panel)) continue;

          var key = String(row.uid || "");
          if (!key) continue;
          covered[key] = true;

          var fresh = hasOwn(credits, key) ? credits[key] : null;
          if (fresh !== null && fresh !== undefined) {
            sum += toNum(fresh);
            n++;
          } else {
            var old = pickNum(row, ["credits", "credit", "balance", "remain", "remaining"]);
            if (old !== null) {
              sum += old;
              n++;
            }
          }
        }
      }

      // 快照里没有的账号（刚加的号、或快照没取到）直接补上
      for (var cid in credits) {
        if (!hasOwn(credits, cid)) continue;
        if (covered[cid] || excluded[cid]) continue;
        if (credits[cid] === null || credits[cid] === undefined) continue;
        sum += toNum(credits[cid]);
        n++;
      }

      if (n > 0) remain = { credits: sum, accounts: n, known: true };
    }

    var income = null;
    var packs = 0;
    var meta = refresh.meta;
    if (meta && typeof meta === "object" && Object.prototype.toString.call(meta) !== "[object Array]") {
      var today = todayKey();
      var total = 0;
      var known = false;

      for (var k in meta) {
        if (!hasOwn(meta, k)) continue;
        if (excluded[k]) continue;
        // 这个号本次刷新失败（credits 为 null）时，expiries 不可信，跳过
        if (creditsOk && hasOwn(credits, k) && credits[k] === null) continue;

        var list = meta[k] && meta[k].expiries;
        if (Object.prototype.toString.call(list) !== "[object Array]") continue;
        known = true;

        for (var j = 0; j < list.length; j++) {
          var e = list[j];
          if (!e || typeof e !== "object") continue;
          var created = toSec(pick(e, ["created", "created_at", "createTime", "ts"]));
          if (!created) continue;
          packs++;
          if (localDay(created) === today) {
            total += toNum(pick(e, ["amount", "credits", "credit", "value"]));
          }
        }
      }

      if (known) income = total;
    }

    if (!remain && income === null) return null;
    return {
      remain: remain,
      income: income,
      packs: packs,
      failed: (refresh.failed && refresh.failed.length) || 0
    };
  }

  /* ---------- 汇总与播报 ---------- */

  function render(state, errs, derived) {
    var checkin = parseCheckin(state.logs);
    var remain = (derived && derived.remain) || parseRemaining(state.snap);
    var roll = accountRoll(state.pool, checkin.uids);

    // 账号列表可用时以它为准（分母 = 能签到的号，能点名），否则退回快照计数
    var signedCount = checkin.signed;
    var totalAccounts = 0;
    var unsigned = [];
    var summaryOnly = false;

    if (roll.total > 0) {
      signedCount = roll.signed;
      totalAccounts = roll.total;
      unsigned = roll.unsigned;
      // 面板只有「上游自动签到」汇总行时，本端逐账号记录是空的：
      // 这时用汇总数字，但点不出名字，就别点名
      if (signedCount === 0 && checkin.fromSummary && checkin.signed > 0) {
        signedCount = checkin.signed;
        unsigned = [];
        summaryOnly = true;
      }
    } else if (state.snap && (state.snap.active_count || state.snap.count)) {
      totalAccounts = toNum(state.snap.active_count || state.snap.count);
      summaryOnly = checkin.fromSummary;
    }

    var emptyPool = !!(state.pool && asArray(state.pool).length === 0);

    var requests = state.summary ? toNum(pick(state.summary, ["today_requests", "requests"])) : 0;
    var tokens = state.summary ? toNum(pick(state.summary, ["today_tokens", "tokens"])) : 0;
    var used = state.summary ? toNum(pick(state.summary, ["today_credit", "today_credits", "credit"])) : 0;

    var income = 0;
    var incomeKnown = false;
    if (state.credits) {
      var inc = pickNum(state.credits, ["income", "today_income"]);
      if (inc !== null) {
        income = inc;
        incomeKnown = true;
      }
    }
    // 刷新响应里能算出今天的积分包入账 → 用它（刚刷新的数据，含本次记账）
    if (derived && derived.income !== null && derived.income !== undefined &&
        (derived.income > 0 || !incomeKnown || income === 0)) {
      income = derived.income;
      incomeKnown = true;
    }

    var lines = [];

    // 1) 今日签到账号数
    if (state.logs || state.pool ||
        (state.snap && (state.snap.active_count || state.snap.count))) {
      if (totalAccounts > 0) {
        var signLine = (signedCount === 0 ? "⚠️ 今日签到：" : "✅ 今日签到：") +
          signedCount + "/" + totalAccounts + " 个账号";
        if (summaryOnly) signLine += "（按自动签到汇总）";
        if (signedCount === 0 && !unsigned.length) signLine += "（可能还没跑）";
        lines.push(signLine);
      } else if (emptyPool) {
        lines.push("⚠️ 今日签到：面板里还没有账号");
      } else {
        var skipped = [];
        if (roll.disabled > 0) skipped.push(roll.disabled + " 个已停用/异常");
        if (roll.unsupported > 0) skipped.push(roll.unsupported + " 个不支持签到");
        lines.push("⚠️ 今日签到：没有可签到的账号" +
          (skipped.length ? "（" + skipped.join("、") + "）" : ""));
      }
    }

    // 2) 今日用量（请求数 / token）
    if (state.summary) {
      lines.push("📈 今日用量：" + fmtInt(requests) + " 次 · " + fmtTokens(tokens) + " tokens");
    }

    // 3) 今日入账（签到 / 猫猫旅行 / 活跃任务，面板无法拆分）
    if (incomeKnown) {
      lines.push("🎁 今日入账：+" + fmtCredit(income) + " 积分（含签到）");
    }

    // 4) 没签到的号
    if (showNames && unsigned.length) {
      var names = unsigned.slice(0, 4).join("、");
      if (unsigned.length > 4) names += " 等 " + unsigned.length + " 个";
      lines.push("🙈 未签：" + names);
    }

    // 5) 消耗与剩余合成一行：花掉的在前、还剩的在后
    if (state.summary && remain.known) {
      lines.push("💸 消耗与剩余：" + fmtCredit(used) + " 积分 · " + fmtInt(remain.credits) + " 积分");
    } else if (state.summary) {
      lines.push("💸 今日消耗：" + fmtCredit(used) + " 积分");
    } else if (remain.known) {
      lines.push("🏦 剩余额度：" + fmtInt(remain.credits) + " 积分");
    }

    // 只提示真正影响播报的缺失项
    var missing = [];
    if (!state.summary && errs.summary) missing.push("用量统计");
    if (!incomeKnown && errs.credits) missing.push("积分收支");
    if (!remain.known && (errs.snap || errs.refresh)) missing.push("剩余额度");
    if (errs.pool) missing.push("账号列表");
    if (errs.logs && errs.pool) missing.push("签到记录");

    if (missing.length) {
      lines.push("⚠️ 部分数据缺失：" + missing.join("、") + "（可稍后重试）");
    }

    finish("", lines.join("\n"));
  }

  /* ---------- 入口 ---------- */

  if (!baseURL) {
    finish("未配置面板地址",
      "请打开 Loon → 插件 → WorkBuddy 面板日报 → 参数，把「面板地址」填成 WorkBuddy Manager 的根地址。\n\n" +
      "例如：https://wb.example.com\n\n" +
      "末尾不用带 /；如果面板挂在子路径下，填到子路径为止。");
    return;
  }
  if (!token) {
    finish("未配置 Token",
      "请到面板 → 设置 → API Tokens → 新建，权限选「只读 / readonly」，复制 wbt_ 开头的令牌，填到插件参数「只读 Token」。\n\n" +
      "只读令牌就能读取日报需要的数据，不需要管理员权限；泄露时在面板里禁用即可。\n\n" +
      "填完点插件里的「WorkBuddy 面板日报（手动）」测试一次。");
    return;
  }

  var state = {
    version: "",
    summary: null,
    credits: null,
    snap: null,
    logs: null,
    pool: null,
    refresh: null
  };
  var errs = { version: "", summary: "", credits: "", snap: "", logs: "", pool: "", refresh: "" };
  var pending = 7;

  function step() {
    if (--pending > 0) return;
    afterAll();
  }

  function afterAll() {
    var derived = deriveFromRefresh(state.refresh, state.snap, state.pool);
    if (state.refresh) {
      var meta = state.refresh.meta || {};
      var cold = Object.keys(meta).some(function (uid) {
        return meta[uid] && !meta[uid].cached;
      });
      console.log("[WorkBuddy] 刷新返回 t=" + (Date.now() - T0) + "ms 回源=" + cold +
        " 账号=" + Object.keys(meta).length +
        (derived && derived.income !== null ? " 今日入账=" + derived.income : "") +
        (derived && derived.remain ? " 剩余=" + derived.remain.credits : "") +
        (derived && derived.failed ? " 失败号=" + derived.failed : ""));
    }

    var errors = [];
    for (var k in errs) {
      if (!hasOwn(errs, k)) continue;
      if (errs[k]) errors.push(errs[k]);
    }

    var haveAny = !!(state.summary || state.credits || state.snap || state.logs || state.pool ||
      (derived && (derived.remain || derived.income !== null)));

    if (!haveAny) {
      var seen = {};
      var lines = ["接口都没能读到数据："];
      for (var i = 0; i < errors.length; i++) {
        if (seen[errors[i]]) continue;
        seen[errors[i]] = 1;
        lines.push("· " + errors[i]);
      }
      if (state.version) lines.push("面板版本：" + state.version);
      var hint = failureHint(errors);
      if (hint) lines.push("\n建议：" + hint);
      finish("获取失败", lines.join("\n"));
      return;
    }

    render(state, errs, derived);
  }

  function failureHint(errors) {
    var all = errors.join(" | ");
    if (/Token 无效/.test(all)) {
      return "到面板 → 设置 → API Tokens 确认令牌仍然启用，并确认类型是「只读 / readonly」。";
    }
    if (/分组不存在/.test(all) || /HTTP 422/.test(all)) {
      return "「面板分组 ID」可能不对：留空使用默认上游，或填面板「设置 → 上游」里实际存在的数字 ID。";
    }
    if (/接口不存在/.test(all)) {
      return "面板地址可能填错，或面板版本过旧。建议升级到最新版 WorkBuddy Manager，地址填面板根地址。";
    }
    if (/不是 JSON/.test(all)) {
      return "地址应填面板根地址（例如 https://wb.example.com），不要填网页里的具体页面；如果套了 Cloudflare Access 等登录页，脚本取不到 API。";
    }
    if (/网络错误/.test(all)) {
      return "手机到面板的网络不通：可在「请求节点」里固定一个节点，或确认面板能从公网访问。";
    }
    return "检查面板地址、Token 和网络后重试；面板版本建议保持最新。";
  }

  req("/api/sysinfo", "GET", function (err, data) {
    if (err) {
      errs.version = err.error;
    } else {
      state.version = String((data && data.version) || "");
    }
    step();
  });

  req("/api/stats/summary", "GET", function (err, data) {
    if (err) errs.summary = "用量统计（" + err.error + "）";
    else state.summary = data;
    step();
  });

  req("/api/stats/credits?days=2", "GET", function (err, data) {
    if (err) errs.credits = "积分收支（" + err.error + "）";
    else state.credits = data && data.today ? data.today : null;
    step();
  });

  req("/api/accounts/credits-snapshot", "GET", function (err, data) {
    if (err) errs.snap = "剩余额度（" + err.error + "）";
    else state.snap = data;
    step();
  });

  req("/api/checkin-logs?days=2&limit=500", "GET", function (err, data) {
    if (err) errs.logs = "签到记录（" + err.error + "）";
    else state.logs = data;
    step();
  });

  req("/api/accounts", "GET", function (err, data) {
    if (err) errs.pool = "账号列表（" + err.error + "）";
    else state.pool = data;
    step();
  });

  // 播报前先让面板刷一次余额（POST /accounts/refresh-credits?force=false，只读可调、
  // 60 秒内走缓存）。面板的「今日入账」靠余额快照里出现新积分包时记账，不刷就还是 0。
  req("/api/accounts/refresh-credits?force=false", "POST", function (err, data) {
    if (err) {
      errs.refresh = "余额刷新（" + err.error + "）";
      console.log("[WorkBuddy] 余额刷新失败，直接用面板现有数据：" + err.error);
    } else {
      state.refresh = data;
    }
    step();
  });

  console.log("[WorkBuddy] " + VERSION + " 启动，7 个请求已发出 t=" + (Date.now() - T0) + "ms");
})();
