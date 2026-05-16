#!/bin/bash
# 分析 Electron .node 原生模块 (C++ Node Addon)
#
# 用法:
#   ./analyze-node-module.sh <module.node> [output_dir]
#   ./analyze-node-module.sh better-sqlite3.node ./analysis-output
#
# 对 .node 文件执行:
#   1. file       — 文件类型识别 (Mach-O/ELF/PE)
#   2. nm -gU     — 导出符号 → C++ 类结构重建
#   3. strings    — 嵌入字符串提取 → 功能推断
#   4. otool -L   — 动态库依赖 (macOS)
#   5. nm -a      — 所有符号 (含内部符号)

set -euo pipefail

if [ $# -lt 1 ]; then
    head -15 "$0"
    exit 1
fi

MODULE="$1"
OUTPUT="${2:-./node-module-analysis}"

if [ ! -f "$MODULE" ]; then
    echo "错误: 文件不存在: $MODULE"
    exit 1
fi

FILENAME=$(basename "$MODULE")
MODULE_OUT="$OUTPUT/$FILENAME"
mkdir -p "$MODULE_OUT"

echo "分析模块: $MODULE"
echo "输出目录: $MODULE_OUT"
echo "========================================"

# 1. 文件类型识别
echo ""
echo ">>> [1/5] 文件类型"
file "$MODULE" | tee "$MODULE_OUT/file-type.txt"

# 2. 导出符号 (仅外部可见符号)
echo ""
echo ">>> [2/5] 导出符号 (nm -gU)"
nm -gU "$MODULE" 2>/dev/null | sort | tee "$MODULE_OUT/exports-gU.txt" || {
    echo "  (nm -gU 不支持此平台, 尝试 nm -g)"
    nm -g "$MODULE" 2>/dev/null | sort | tee "$MODULE_OUT/exports-gU.txt"
}

# 3. 嵌入字符串
echo ""
echo ">>> [3/5] 嵌入字符串 (最小长度 4)"
strings -n 4 "$MODULE" | tee "$MODULE_OUT/strings-all.txt"

# 提取可能有意义的字符串 (过滤掉纯乱码)
echo ""
echo ">>> [3.5/5] 有意义字符串"
grep -iE \
    '(class|method|function|error|warn|info|debug|init|create|destroy|open|close|read|write|path|file|sql|query|spawn|pty|objc|swift|mac|app|node|electron|v8|napi|cpp|rust|std::|namespace|template)' \
    "$MODULE_OUT/strings-all.txt" | sort -u | tee "$MODULE_OUT/strings-filtered.txt" || true

# 4. 动态库依赖 (macOS)
echo ""
echo ">>> [4/5] 动态库依赖 (otool -L / ldd)"

OS=$(uname -s)
if [ "$OS" = "Darwin" ]; then
    otool -L "$MODULE" | tee "$MODULE_OUT/dependencies.txt"
elif [ "$OS" = "Linux" ]; then
    ldd "$MODULE" 2>/dev/null | tee "$MODULE_OUT/dependencies.txt" || {
        objdump -p "$MODULE" 2>/dev/null | grep NEEDED | tee "$MODULE_OUT/dependencies.txt"
    }
else
    echo "  (未知平台: $OS, 跳过)"
fi

# 5. 所有符号 (含内部符号, 用于深入分析)
echo ""
echo ">>> [5/5] 所有符号 (nm -a)"
nm -a "$MODULE" 2>/dev/null | sort | tee "$MODULE_OUT/symbols-all.txt" || {
    echo "  (nm -a 不支持, 跳过)"
}

# 汇总
echo ""
echo "========================================"
echo "分析完成! 结果保存在: $MODULE_OUT/"
echo ""
echo "文件清单:"
ls -la "$MODULE_OUT/"
echo ""
echo "# 快速查看关键信息:"
echo "  - 导出符号:   cat $MODULE_OUT/exports-gU.txt"
echo "  - 过滤字符串: cat $MODULE_OUT/strings-filtered.txt"
echo "  - 依赖库:     cat $MODULE_OUT/dependencies.txt"
