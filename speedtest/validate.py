#!/usr/bin/env python3
"""校验 .plugin 结构：参数声明、占位符、脚本引用。"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PLUGIN = ROOT / "NodeSpeedtest.plugin"

CONTROLS = {"input", "select", "switch"}
TYPES = {None, "string", "number", "boolean"}
TRIGGERS = re.compile(r"^(generic|cron|request|response|network-changed)\b")


def parse_arguments(lines):
    args = {}
    errors = []
    warnings = []

    for no, line in lines:
        if "=" not in line:
            errors.append(f"L{no}: 参数行缺少 '='：{line}")
            continue
        name, rest = line.split("=", 1)
        name = name.strip()
        if not re.fullmatch(r"[A-Za-z0-9_]+", name):
            errors.append(f"L{no}: 参数名不合法：{name}")
        if name in args:
            errors.append(f"L{no}: 参数重复：{name}")

        parts = [p.strip() for p in rest.split(",")]
        control = parts[0]
        if control not in CONTROLS:
            errors.append(f"L{no}: 未知控件 {control}")

        keys, default = {}, None
        for part in parts[1:]:
            if "=" in part:
                key, value = part.split("=", 1)
                keys[key.strip()] = value.strip()
            elif default is None:
                default = part.strip('"')

        if rest.count("tag=") > 1:
            errors.append(f"L{no}: tag= 重复")
        if "tag" not in keys:
            warnings.append(f"L{no}: {name} 没有 tag（界面显示参数名）")

        typ = keys.get("type")
        if typ not in TYPES:
            errors.append(f"L{no}: 非法 type={typ}")
        if typ == "number" or control == "switch":
            if default is None:
                warnings.append(f"L{no}: {name} 没有默认值")
            elif typ == "number":
                try:
                    float(default)
                except ValueError:
                    errors.append(f"L{no}: {name} 默认值不是数字：{default}")
            elif default not in ("true", "false"):
                errors.append(f"L{no}: {name} 开关默认值不是 true/false：{default}")

        if "desc" in keys and "," in keys["desc"]:
            errors.append(f"L{no}: {name} 的 desc 含英文逗号，会被截断")

        args[name] = {"control": control, "line": no}

    return args, errors, warnings


def main():
    text = PLUGIN.read_text(encoding="utf-8")
    lines = [(no, l.strip()) for no, l in enumerate(text.splitlines(), 1) if l.strip() and not l.strip().startswith("#!")]

    section = None
    arg_lines, script_lines = [], []
    for no, line in lines:
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if section == "Argument":
            arg_lines.append((no, line))
        elif section == "Script":
            script_lines.append((no, line))

    args, errors, warnings = parse_arguments(arg_lines)
    if not args:
        errors.append("没有 [Argument] 参数")
    if not script_lines:
        errors.append("没有 [Script] 条目")

    used = set()
    for no, line in script_lines:
        if not TRIGGERS.match(line):
            errors.append(f"L{no}: 未知 Script 触发类型")
        for name in re.findall(r"\$\{([^}]+)\}", line):
            used.add(name)
        for target in re.findall(r'script\("([^"]+)"', line):
            if not (ROOT / target).exists():
                errors.append(f"L{no}: 脚本文件不存在：{target}")
        if line.count("{") != line.count("}"):
            errors.append(f"L{no}: 大括号不配对")

    missing = used - set(args)
    if missing:
        errors.append("引用了未声明的参数：" + ", ".join(sorted(missing)))
    unused = set(args) - used
    if unused:
        warnings.append("声明但未使用：" + ", ".join(sorted(unused)))

    print(f"参数 {len(args)} 个，Script {len(script_lines)} 条")
    for w in warnings:
        print("WARN  " + w)
    for e in errors:
        print("ERROR " + e)
    print("OK" if not errors else f"FAILED ({len(errors)})")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
