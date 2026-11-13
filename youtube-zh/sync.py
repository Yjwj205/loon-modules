#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 devchristian1337/loon-plugins 的 YouTube.lpx 同步成本仓库里的中文版。

流程：
  1. 抓上游 Plugins/YouTube.lpx
  2. 把里面引用的 Scripts/YouTube/*.js 镜像到 youtube-zh/scripts/
  3. 脚本地址改成本仓库 raw 地址（自包含，不依赖上游存活）
  4. 套 i18n.json 翻译元数据 / 参数 tag+desc / 注释 / 脚本 tag / 脚本内文案
  5. 写出 YouTube-zh.lpx + report.md + upstream.json

只依赖标准库；在 GitHub Actions 和本地 iSH 里都能跑。
"""

import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date

ROOT = os.path.dirname(os.path.abspath(__file__))
UPSTREAM = "https://raw.githubusercontent.com/devchristian1337/loon-plugins/refs/heads/main"
PLUGIN_PATH = "Plugins/YouTube.lpx"
REPO_RAW = "https://raw.githubusercontent.com/Yjwj205/loon-modules/main/youtube-zh"
UA = "loon-modules-sync/1.0 (+https://github.com/Yjwj205/loon-modules)"

SECTION_RE = re.compile(r"^\[([A-Za-z]+)\]\s*$")
ARG_RE = re.compile(r"^([A-Za-z0-9_]+)\s*=\s*(.*)$")
SCRIPT_URL_RE = re.compile(
    r"https://raw\.githubusercontent\.com/devchristian1337/loon-plugins/(?:refs/heads/)?main/(Scripts/YouTube/[A-Za-z0-9._-]+\.js)"
    r"|https://github\.com/devchristian1337/loon-plugins/raw/(?:refs/heads/)?main/(Scripts/YouTube/[A-Za-z0-9._-]+\.js)"
)
SCRIPT_TAG_RE = re.compile(r",\s*tag=(?:\"([^\"]*)\"|([^,]*?))\s*$")


def fetch(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError("fetch failed %s: %s" % (url, last))


def load_i18n():
    with open(os.path.join(ROOT, "i18n.json"), encoding="utf-8") as f:
        data = json.load(f)
    return data


def split_arg(rest):
    """把 `switch,false,tag=X,desc=Y` 拆成 (head, tag, desc)。"""
    ti = rest.find(",tag=")
    di = rest.find(",desc=")
    if ti < 0 and di < 0:
        return rest, None, None
    if di < 0:
        return rest[:ti], rest[ti + 5:], None
    if ti < 0 or ti > di:
        return rest[:di], None, rest[di + 6:]
    return rest[:ti], rest[ti + 5:di], rest[di + 6:]


def main():
    i18n = load_i18n()
    text_map = i18n["text"]
    meta_map = i18n["meta"]
    script_text = [tuple(p) for p in i18n["script_text"]]

    raw = fetch(UPSTREAM + "/" + PLUGIN_PATH).decode("utf-8")
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    if not raw.endswith("\n"):
        raw += "\n"
    src_sha = hashlib.sha256(raw.encode("utf-8")).hexdigest()

    # ---------- 1. 镜像脚本 ----------
    script_dir = os.path.join(ROOT, "scripts")
    os.makedirs(script_dir, exist_ok=True)
    mirrored = {}
    missing = []
    for m in SCRIPT_URL_RE.finditer(raw):
        rel = m.group(1) or m.group(2)
        if rel in mirrored or rel in [x[0] for x in missing]:
            continue
        try:
            blob = fetch(UPSTREAM + "/" + rel)
        except RuntimeError as e:
            missing.append((rel, str(e)))
            continue
        # 脚本内文案汉化（精确字符串替换，命中次数记录在报告里）
        body = blob.decode("utf-8")
        hits = []
        for en, zh in script_text:
            n = body.count(en)
            if n:
                body = body.replace(en, zh)
            hits.append((en, n))
        name = os.path.basename(rel)
        with open(os.path.join(script_dir, name), "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        mirrored[rel] = (name, hits)

    def rewrite_url(m):
        rel = m.group(1) or m.group(2)
        info = mirrored.get(rel)
        if not info:
            return m.group(0)  # 镜像失败就保留上游地址，至少插件能用
        return "%s/scripts/%s" % (REPO_RAW, info[0])

    raw = SCRIPT_URL_RE.sub(rewrite_url, raw)

    # ---------- 2. 逐行汉化 ----------
    out = []
    section = ""
    untranslated = []
    for no, line in enumerate(raw.split("\n"), 1):
        stripped = line.strip()
        if not stripped:
            out.append("")
            continue
        sm = SECTION_RE.match(stripped)
        if sm:
            section = sm.group(1)
            out.append(stripped)
            continue

        if stripped.startswith("#!"):
            key, _, val = stripped[2:].partition("=")
            key, val = key.strip(), val.strip()
            if key in meta_map:
                out.append("#!%s = %s" % (key, meta_map[key]))
            else:
                out.append("#!%s = %s" % (key, val))
            continue

        if stripped.startswith("#"):
            body = stripped[1:].strip()
            zh = text_map.get(body)
            if zh is None:
                untranslated.append((no, "comment", body))
                out.append("# " + body)
            else:
                out.append("# " + zh)
            continue

        if section == "Argument":
            am = ARG_RE.match(stripped)
            if am:
                name, rest = am.group(1), am.group(2)
                head, tag, desc = split_arg(rest)
                if tag is not None:
                    t2 = text_map.get(tag)
                    if t2 is None:
                        untranslated.append((no, "arg-tag:" + name, tag))
                    else:
                        tag = t2
                if desc is not None:
                    d2 = text_map.get(desc)
                    if d2 is None:
                        untranslated.append((no, "arg-desc:" + name, desc))
                    else:
                        desc = d2
                rebuilt = "%s = %s" % (name, head)
                if tag is not None:
                    rebuilt += ",tag=" + tag
                if desc is not None:
                    rebuilt += ",desc=" + desc
                out.append(rebuilt)
                continue

        if section == "Script":
            tm = SCRIPT_TAG_RE.search(stripped)
            if tm:
                quoted = tm.group(1) is not None
                tag = tm.group(1) if quoted else tm.group(2)
                zh = text_map.get(tag)
                if zh is None:
                    untranslated.append((no, "script-tag", tag))
                else:
                    new = ',tag="%s"' % zh if quoted else ",tag=" + zh
                    stripped = stripped[: tm.start()] + new
            out.append(stripped)
            continue

        out.append(stripped)

    result = "\n".join(out)
    if not result.endswith("\n"):
        result += "\n"

    # ---------- 3. 静态自检 ----------
    problems = []
    args = set()
    sec = ""
    for line in result.split("\n"):
        sm = SECTION_RE.match(line.strip())
        if sm:
            sec = sm.group(1)
            continue
        if sec == "Argument":
            am = ARG_RE.match(line.strip())
            if am:
                args.add(am.group(1))
                _, tag, desc = split_arg(am.group(2))
                for label, val in (("tag", tag), ("desc", desc)):
                    if val and "," in val:
                        problems.append("参数 %s 的 %s 含英文逗号，可能被截断" % (am.group(1), label))
                if tag and "," in tag:
                    problems.append("参数 %s 的 tag 含英文逗号" % am.group(1))
    for m in re.finditer(r"(?<!\$)\{([A-Za-z0-9_]+)\}", result):
        if m.group(1) not in args:
            problems.append("占位符 {%s} 在 [Argument] 里没有定义" % m.group(1))
    if result.count("[Argument]") != 1:
        problems.append("[Argument] 段数量异常")

    # ---------- 4. 落盘 ----------
    with open(os.path.join(ROOT, "YouTube-zh.lpx"), "w", encoding="utf-8", newline="\n") as f:
        f.write(result)

    up_date = ""
    dm = re.search(r"^#!date\s*=\s*(.+)$", raw, re.M)
    if dm:
        up_date = dm.group(1).strip()

    state = {
        "upstream_url": UPSTREAM + "/" + PLUGIN_PATH,
        "upstream_date": up_date,
        "upstream_sha256": src_sha,
        "last_sync": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "scripts": {k: v[0] for k, v in mirrored.items()},
    }
    state_path = os.path.join(ROOT, "upstream.json")
    old_state = {}
    if os.path.exists(state_path):
        try:
            with open(state_path, encoding="utf-8") as f:
                old_state = json.load(f)
        except Exception:  # noqa: BLE001
            old_state = {}

    # 内容没变就不动时间戳，避免每天空提交
    same = old_state.get("upstream_sha256") == src_sha and old_state.get("upstream_date") == up_date
    if same and old_state.get("last_sync"):
        state["last_sync"] = old_state["last_sync"]
    with open(state_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    # ---------- 5. 报告 ----------
    rep = ["# YouTube 插件同步报告", ""]
    rep.append("- 上游：`%s`" % (UPSTREAM + "/" + PLUGIN_PATH))
    rep.append("- 上游日期：`%s`" % (up_date or "未知"))
    rep.append("- 上游 SHA-256：`%s`" % src_sha)
    rep.append("- 本次同步：%s" % state["last_sync"])
    rep.append("- 已镜像脚本：" + ("、".join("`%s`" % v[0] for v in mirrored.values()) or "无"))
    rep.append("")
    rep.append("## 脚本内文案替换")
    rep.append("")
    rep.append("| 原文开头 | 命中次数 |")
    rep.append("| --- | --- |")
    for rel, (name, hits) in mirrored.items():
        for en, n in hits:
            rep.append("| `%s` | %d |" % (en[:48].replace("|", "\\|"), n))
    rep.append("")
    if missing:
        rep.append("## ⚠️ 镜像失败（暂时仍指向上游）")
        rep.append("")
        for rel, err in missing:
            rep.append("- `%s`：%s" % (rel, err))
        rep.append("")
    if problems:
        rep.append("## ⚠️ 自检问题")
        rep.append("")
        for p in problems:
            rep.append("- " + p)
        rep.append("")
    rep.append("## 未翻译的英文（上游新增或改写了文案）")
    rep.append("")
    if untranslated:
        rep.append("> 这些内容原样保留英文。要汉化请在 `i18n.json` 的 `text` 里补上对应条目。")
        rep.append("")
        rep.append("| 行 | 类型 | 原文 |")
        rep.append("| --- | --- | --- |")
        for no, kind, body in untranslated:
            rep.append("| %d | %s | %s |" % (no, kind, body.replace("|", "\\|")))
    else:
        rep.append("无，全部条目都已汉化。")
    rep.append("")
    with open(os.path.join(ROOT, "report.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(rep))

    # ---------- 6. 心跳（防止 GitHub 60 天无提交后停掉定时任务） ----------
    hb = os.path.join(ROOT, "last-check.txt")
    today = date.today()
    write_hb = True
    if os.path.exists(hb):
        try:
            prev = date.fromisoformat(open(hb, encoding="utf-8").read().strip())
            write_hb = (today - prev).days >= 25
        except Exception:  # noqa: BLE001
            write_hb = True
    if not same:
        write_hb = True
    if write_hb:
        with open(hb, "w", encoding="utf-8", newline="\n") as f:
            f.write(today.isoformat() + "\n")

    print("upstream date: %s" % (up_date or "?"))
    print("changed: %s" % ("no" if same else "yes"))
    print("untranslated: %d" % len(untranslated))
    print("problems: %d" % len(problems))
    for p in problems:
        print("  - " + p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
