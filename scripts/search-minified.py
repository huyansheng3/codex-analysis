#!/usr/bin/env python3
"""
在混淆/压缩的 JavaScript 文件中搜索关键词，提取上下文。

用于绕过 minified code 无法 grep 的问题 —— 因为整个文件可能只有一行，
直接 grep 会输出整个文件。本脚本按匹配位置截取前后 N 个字符的上下文。

用法:
  python3 search-minified.py <keyword> <file.js> [--context 200] [--all]
  python3 search-minified.py "SKY_CUA_SERVICE_PATH" app.js
  python3 search-minified.py "SKY_CUA_SERVICE_PATH" app.js --context 400 --all

选项:
  --context N   截取匹配前后 N 个字符 (默认 200)
  --all         显示所有匹配 (默认只显示前 5 个)
  --line        按行显示 (如果文件有换行, 按行号显示)
  --json        输出 JSON 格式
"""

import json
import re
import sys


def search_minified(
    keyword: str,
    filepath: str,
    context: int = 200,
    max_matches: int = 5,
    line_mode: bool = False,
    json_output: bool = False,
):
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        code = f.read()

    file_size = len(code)

    if line_mode and "\n" in code:
        # 按行搜索
        lines = code.split("\n")
        results = []
        for i, line in enumerate(lines, 1):
            if keyword in line:
                results.append(
                    {
                        "line": i,
                        "match_start": line.index(keyword),
                        "content": line.strip(),
                    }
                )
                if len(results) >= max_matches:
                    break
    else:
        # 按 offset 搜索
        results = []
        for m in re.finditer(re.escape(keyword), code):
            offset = m.start()
            start = max(0, offset - context)
            end = min(len(code), offset + context)

            snippet = code[start:end]
            match_start = offset - start
            match_end = match_start + len(keyword)

            results.append(
                {
                    "offset": offset,
                    "context_start": start,
                    "context_end": end,
                    "match_start_in_context": match_start,
                    "snippet": snippet,
                }
            )

            if len(results) >= max_matches:
                break

    if json_output:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    if not results:
        print(f"未找到匹配: '{keyword}'")
        return

    print(f"文件: {filepath} ({file_size:,} chars)")
    print(f"搜索: '{keyword}'")
    print(f"找到 {len(results)} 个匹配" + (f" (共 {max_matches} 个显示)" if max_matches else ""))
    print("=" * 80)

    for i, r in enumerate(results, 1):
        print(f"\n--- 匹配 #{i} ---")

        if "line" in r:
            print(f"第 {r['line']} 行, 位置 {r['match_start']}:")
            print(r["content"])
        else:
            print(f"偏移 {r['offset']:,} (上下文 {r['context_start']:,}-{r['context_end']:,}):")
            print("-" * 40)
            snippet = r["snippet"]
            # 高亮匹配位置的上下文
            ms = r["match_start_in_context"]
            before = snippet[:ms]
            match_text = snippet[ms : ms + len(keyword)]
            after = snippet[ms + len(keyword) :]
            print(f"{before}\033[1;33m{match_text}\033[0m{after}")
            print("-" * 40)


def main():
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(1)

    keyword = args[0]
    filepath = ""
    context = 200
    max_matches = 5
    line_mode = False
    json_output = False

    i = 1
    while i < len(args):
        arg = args[i]
        if arg == "--context" and i + 1 < len(args):
            context = int(args[i + 1])
            i += 2
        elif arg == "--all":
            max_matches = 0  # 0 = unlimited
            i += 1
        elif arg == "--line":
            line_mode = True
            i += 1
        elif arg == "--json":
            json_output = True
            i += 1
        elif not arg.startswith("-"):
            filepath = arg
            i += 1
        else:
            print(f"未知选项: {arg}")
            sys.exit(1)

    if not filepath:
        print("错误: 未指定文件路径")
        sys.exit(1)

    import os

    if not os.path.exists(filepath):
        print(f"错误: 文件不存在: {filepath}")
        sys.exit(1)

    search_minified(
        keyword=keyword,
        filepath=filepath,
        context=context,
        max_matches=max_matches if max_matches > 0 else 0,
        line_mode=line_mode,
        json_output=json_output,
    )


if __name__ == "__main__":
    main()
