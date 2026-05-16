#!/usr/bin/env python3
"""
从二进制文件中提取和过滤有意义的字符串。

支持 Mach-O、ELF、PE 和任意二进制格式。内置关键词过滤和模式匹配，
帮助从大量噪音字符串中筛选出有分析价值的信息。

用法:
  python3 extract-strings.py <binary_path> [options]
  python3 extract-strings.py SkyComputerUseService --min 4
  python3 extract-strings.py binary --filter objc,method,class
  python3 extract-strings.py binary --pattern 'TtC\d+Codex'  # Swift mangling
  python3 extract-strings.py binary --dump-all                 # 输出全部字符串

选项:
  --min N         最小字符串长度 (默认 4)
  --filter KEYWORDS  逗号分隔的关键词 (不区分大小写)
  --pattern REGEX    正则表达式过滤
  --preset OBJC|SWIFT|CPP|NODE|SECURITY  预设过滤方案
  --dump-all      输出所有字符串 (不过滤)
  --output FILE   输出到文件
"""

import os
import re
import sys
import subprocess


# 预设过滤方案
PRESETS = {
    "objc": [
        "NS", "CF", "CG", "OBJC", "objc", "class", "method", "selector",
        "alloc", "init", "dealloc", "property", "protocol", "category",
        "NSString", "NSArray", "NSDictionary", "NSObject", "NSBundle",
        "NSUserDefaults", "NSWorkspace", "NSRunningApplication",
        "AXUIElement", "CGWindow", "CGEvent", "CGImage",
    ],
    "swift": [
        "_T0", "_Tt", "Codex", "Swift", "Manager", "Service", "Client",
        "Delegate", "Observer", "Handler", "Provider", "Controller",
        "async", "await", "actor", "struct", "enum", "protocol",
    ],
    "cpp": [
        "std::", "boost::", "v8::", "node::", "napi_", "Napi::",
        "Napi", "NODE_", "v8_", "napi_", "::", "template",
        "constructor", "destructor", "operator", "virtual",
        "better_sqlite3", "node_pty",
    ],
    "node": [
        "node_", "napi_", "Napi", "NODE_", "v8::", "libuv",
        "require", "module", "exports", "process", "Buffer",
        "NODE_MODULE", "napi_value", "napi_env",
    ],
    "security": [
        "Keychain", "SecKey", "SecItem", "SecAccess", "SSL", "TLS",
        "encrypt", "decrypt", "hash", "sign", "verify", "certificate",
        "entitlement", "sandbox", "permission", "TCC", "Accessibility",
        "Screen Recording", "AppleEvent", "Authorization",
        "key", "token", "password", "secret", "credential",
        "apiKey", "API_KEY", "openai-api-key",
    ],
}


def extract_strings(binary_path: str, min_len: int = 4) -> list[str]:
    """使用系统 strings 命令提取字符串"""
    try:
        result = subprocess.run(
            ["strings", "-n", str(min_len), binary_path],
            capture_output=True,
            text=True,
        )
        return result.stdout.split("\n")
    except FileNotFoundError:
        # 纯 Python fallback
        with open(binary_path, "rb") as f:
            data = f.read()
        strings = []
        current = []
        for byte in data:
            if 32 <= byte < 127:
                current.append(chr(byte))
            else:
                if len(current) >= min_len:
                    strings.append("".join(current))
                current = []
        if len(current) >= min_len:
            strings.append("".join(current))
        return strings


def filter_strings(strings: list[str], keywords: list[str] = None,
                  pattern: str = None, presets: list[str] = None) -> list[str]:
    """多级过滤"""
    results = set()

    for s in strings:
        if not s.strip():
            continue

        matched = False

        if presets:
            for preset_name in presets:
                if preset_name in PRESETS:
                    for kw in PRESETS[preset_name]:
                        if kw.lower() in s.lower():
                            results.add(s)
                            matched = True
                            break
                if matched:
                    break
            continue

        if keywords:
            for kw in keywords:
                if kw.lower() in s.lower():
                    results.add(s)
                    matched = True
                    break

        if pattern:
            if re.search(pattern, s):
                results.add(s)
                matched = True

        if not keywords and not pattern:
            # 无过滤条件时输出所有
            results.add(s)

    return sorted(results)


def main():
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(1)

    binary_path = args[0]
    if not os.path.exists(binary_path):
        print(f"错误: 文件不存在: {binary_path}")
        sys.exit(1)

    min_len = 4
    keywords = None
    pattern = None
    presets = None
    dump_all = False
    output_file = None

    i = 1
    while i < len(args):
        arg = args[i]
        if arg == "--min" and i + 1 < len(args):
            min_len = int(args[i + 1])
            i += 2
        elif arg == "--filter" and i + 1 < len(args):
            keywords = [k.strip() for k in args[i + 1].split(",")]
            i += 2
        elif arg == "--pattern" and i + 1 < len(args):
            pattern = args[i + 1]
            i += 2
        elif arg == "--preset" and i + 1 < len(args):
            presets = [p.strip() for p in args[i + 1].split(",")]
            # 验证预设名称
            for p in presets:
                if p not in PRESETS:
                    print(f"错误: 未知预设 '{p}'. 可用: {', '.join(PRESETS.keys())}")
                    sys.exit(1)
            i += 2
        elif arg == "--dump-all":
            dump_all = True
            i += 1
        elif arg == "--output" and i + 1 < len(args):
            output_file = args[i + 1]
            i += 2
        else:
            print(f"未知选项: {arg}")
            sys.exit(1)

    print(f"提取字符串: {binary_path} (最小长度 {min_len})")
    strings = extract_strings(binary_path, min_len)
    print(f"原始字符串: {len(strings)} 条")

    if dump_all:
        results = sorted(set(s for s in strings if s.strip()))
    elif presets:
        results = filter_strings(strings, presets=presets)
    elif keywords or pattern:
        results = filter_strings(strings, keywords=keywords, pattern=pattern)
    else:
        # 默认: 输出所有有意义的字符串
        results = sorted(set(s for s in strings if s.strip()))

    print(f"过滤后: {len(results)} 条")

    out = "\n".join(results)

    if output_file:
        with open(output_file, "w") as f:
            f.write(out)
        print(f"已保存到: {output_file}")
    else:
        print(out)


if __name__ == "__main__":
    main()
