#!/usr/bin/env python3
"""同步技能清单 —— 把 skills/ 目录下的实际技能同步进 dsh-plugins.json。

为什么要单独一个脚本：
    上传技能时最容易漏的一步就是更新清单。
    清单不更新 → DSH Skills Manager 扫不到该技能 → 员工订阅后看不到。
    本脚本以 skills/ 目录为唯一事实来源，反向生成清单，杜绝脱节。

用法：
    python tools/sync-manifest.py            # 写入清单并打印变更
    python tools/sync-manifest.py --check    # 只检查不写入，有不一致则退出码 1
"""
import json
import pathlib
import re
import sys
from datetime import datetime, timezone, timedelta

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKILLS_DIR = ROOT / "skills"
MANIFEST = ROOT / "dsh-plugins.json"
TZ = timezone(timedelta(hours=8))

KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def read_frontmatter(skill_md: pathlib.Path) -> dict:
    """解析 SKILL.md 的 YAML frontmatter。

    只取顶层 key: value，够用。特殊处理 description 的块标量（| / >）：
    取其第一行实际内容，而不是 '|' 这个标记本身。
    """
    try:
        text = skill_md.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    block = text[3:end]

    out = {}
    lines = block.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line or line.startswith((" ", "\t", "#")):
            continue
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip()

        # 空值：name: 后面没有内容，记为空串，不吞下一行
        if not value:
            out[key] = ""
            continue

        # 块标量：description: |  /  description: >
        if value in ("|", ">", "|-", ">-", "|+", ">+"):
            collected = []
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                collected.append(lines[i].strip())
                i += 1
            # 取第一个非空行作为摘要
            summary = next((c for c in collected if c), "")
            out[key] = summary
            continue

        out[key] = value.strip("\"'")
    return out


def collect() -> tuple[list[dict], list[str]]:
    """扫描 skills/ 目录，返回 (技能条目列表, 问题列表)。"""
    entries: list[dict] = []
    problems: list[str] = []

    if not SKILLS_DIR.is_dir():
        return entries, [f"目录不存在：{SKILLS_DIR}"]

    for d in sorted(SKILLS_DIR.iterdir()):
        if not d.is_dir():
            continue
        skill_md = d / "SKILL.md"
        if not skill_md.is_file():
            problems.append(f"{d.name}/ 缺少 SKILL.md")
            continue

        fm = read_frontmatter(skill_md)
        name = fm.get("name", "")
        if not name:
            problems.append(f"{d.name}/ SKILL.md 没有 frontmatter 的 name 字段")
            continue
        if not KEBAB.match(name):
            problems.append(f"{d.name}/ name='{name}' 不是 kebab-case，DSH 无法加载")
            continue

        entries.append({
            "name": name,
            "path": f"skills/{d.name}",
            "description": fm.get("description", "").split("\n")[0][:200],
            "version": fm.get("version", "1.0.0"),
            "category": fm.get("category", "capability"),
            "updatedAt": datetime.now(TZ).isoformat(timespec="seconds"),
        })
    return entries, problems


def main() -> int:
    check_only = "--check" in sys.argv

    entries, problems = collect()
    if problems:
        print("✗ 以下技能不合规：", file=sys.stderr)
        for p in problems:
            print(f"   {p}", file=sys.stderr)
        if check_only:
            return 1

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    old = manifest.get("skills", [])

    old_map = {s.get("name"): s for s in old if isinstance(s, dict)}
    new_map = {e["name"]: e for e in entries}

    added = [n for n in new_map if n not in old_map]
    removed = [n for n in old_map if n not in new_map]
    changed = [
        n for n in new_map
        if n in old_map and old_map[n].get("path") != new_map[n]["path"]
    ]

    if check_only:
        if added or removed or changed:
            print("✗ 清单与 skills/ 目录不一致：")
            for n in added:   print(f"   + 未登记: {n}")
            for n in removed: print(f"   - 目录已删但清单仍在: {n}")
            for n in changed: print(f"   ~ 路径变了: {n}")
            return 1
        print(f"✓ 清单一致，共 {len(entries)} 个技能。")
        return 0

    manifest["skills"] = entries
    manifest["updatedAt"] = datetime.now(TZ).isoformat(timespec="seconds")
    MANIFEST.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    print(f"✓ 清单已同步，共 {len(entries)} 个技能")
    for n in added:   print(f"   + 新增: {n}")
    for n in removed: print(f"   - 移除: {n}")
    for n in changed: print(f"   ~ 变更: {n}")
    if not (added or removed or changed):
        print("   （无变化）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
