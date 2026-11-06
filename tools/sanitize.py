"""脱敏工具：把本机路径与内网 IP 替换为占位符。

用法: python tools/sanitize.py <目标目录>
"""
import re
import sys
import pathlib

# 顺序重要：先匹配更具体的 .workbuddy，再匹配通用家目录
RULES = [
    # Windows：家目录 + .workbuddy
    (re.compile(r'[Cc]:[\\/]+Users[\\/]+[A-Za-z0-9_.\-]+[\\/]*\.workbuddy'), '<WORKBUDDY_HOME>'),
    # Windows / Unix：通用家目录
    (re.compile(r'[Cc]:[\\/]+Users[\\/]+[A-Za-z0-9_.\-]+'), '<USER_HOME>'),
    (re.compile(r'/home/[A-Za-z0-9_.\-]+'), '<USER_HOME>'),
    (re.compile(r'/Users/[A-Za-z0-9_.\-]+'), '<USER_HOME>'),
    # 内网 IP（RFC1918）
    (re.compile(r'\b192\.168\.\d{1,3}\.\d{1,3}\b'), '<INTERNAL_IP>'),
    (re.compile(r'\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'), '<INTERNAL_IP>'),
    (re.compile(r'\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b'), '<INTERNAL_IP>'),
    # 常见敏感键值
    (re.compile(r'(?i)(x-api-key|api[_-]?key|secret|token)\s*[:=]\s*["\']?[A-Za-z0-9_\-]{16,}'), r'\1=<REDACTED>'),
]


def sanitize_text(text: str) -> str:
    for pattern, repl in RULES:
        text = pattern.sub(repl, text)
    return text


def main() -> int:
    if len(sys.argv) < 2:
        print('用法: python tools/sanitize.py <目标目录>', file=sys.stderr)
        return 1

    root = pathlib.Path(sys.argv[1])
    changed = []
    for p in root.rglob('*'):
        if not p.is_file():
            continue
        try:
            original = p.read_text(encoding='utf-8')
        except (UnicodeDecodeError, OSError):
            continue
        cleaned = sanitize_text(original)
        if cleaned != original:
            p.write_text(cleaned, encoding='utf-8', newline='')
            changed.append(str(p.relative_to(root)))

    print(f'  脱敏完成，改动 {len(changed)} 个文件')
    for c in changed:
        print('   -', c)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
