#!/usr/bin/env python3
"""
从 Electron ASAR 归档中解压文件。

ASAR 格式:
  - 前 4 字节: 文件头长度 (uint32)
  - 接下来 4 字节: 保留 (通常 0)
  - 接下来 N 字节: JSON header (文件索引)
  - 随后: 各文件数据 (按 JSON header 中的 offset/size 定位)

用法:
  python3 extract-asar.py <asar_path> [output_dir]
  python3 extract-asar.py app.asar ./unpacked
  python3 extract-asar.py --list app.asar        # 仅列出文件,不解压
"""

import json
import os
import struct
import sys
from pathlib import Path


def read_asar(asar_path: str):
    """读取 ASAR 文件,返回 (header, file_data)"""
    with open(asar_path, "rb") as f:
        data = f.read()

    # 前 8 字节: header size + reserved
    header_size = struct.unpack_from("<I", data, 0)[0]
    # reserved = struct.unpack_from("<I", data, 4)[0]  # 未使用

    # JSON header 从 offset 8 开始
    json_start = 8
    json_end = json_start + header_size

    # 定位 JSON 结束 (brace matching, 处理嵌套)
    json_bytes = data[json_start:json_end]
    try:
        header = json.loads(json_bytes)
    except json.JSONDecodeError:
        # brace matching fallback
        depth = 0
        real_end = json_start
        for i in range(json_start, len(data)):
            ch = data[i : i + 1]
            if ch == b"{":
                depth += 1
            elif ch == b"}":
                depth -= 1
                if depth == 0:
                    real_end = i + 1
                    break
        header_bytes = data[json_start:real_end]
        header = json.loads(header_bytes)

    return header, data


def extract_files(header: dict, data: bytes, output_dir: str, list_only: bool = False):
    """递归遍历 ASAR header 并解压文件"""
    files = header.get("files", {})

    def walk(files: dict, base: str):
        for name, info in files.items():
            full_path = os.path.join(base, name)
            if "files" in info:
                # 目录节点
                if not list_only:
                    os.makedirs(os.path.join(output_dir, full_path), exist_ok=True)
                walk(info["files"], full_path)
            else:
                # 文件节点
                offset = int(info["offset"])
                size = info["size"]
                executable = info.get("executable", False)

                if list_only:
                    mode = " (x)" if executable else ""
                    print(f"  {full_path}  [{size:,} bytes]{mode}")
                else:
                    file_path = os.path.join(output_dir, full_path)
                    os.makedirs(os.path.dirname(file_path), exist_ok=True)

                    # ASAR 文件数据从 JSON header 之后的 offset 开始
                    # 实际偏移需要加上 header 部分
                    # header 结束位置需要动态计算
                    json_start = 8
                    json_bytes = data[json_start:]
                    brace_depth = 0
                    json_end_offset = json_start
                    for i, ch in enumerate(json_bytes):
                        byte = ch.to_bytes(1, "big") if isinstance(ch, int) else ch
                        if byte == b"{":
                            brace_depth += 1
                        elif byte == b"}":
                            brace_depth -= 1
                            if brace_depth == 0:
                                json_end_offset = json_start + i + 1
                                break

                    # ASAR 中文件可能有 padding
                    # offset 表示的是相对于 data 起始的绝对偏移
                    end = offset + size
                    file_content = data[offset:end]
                    with open(file_path, "wb") as f:
                        f.write(file_content)

                    if executable:
                        os.chmod(file_path, 0o755)

    # 使用更简单的方式: 直接按 JSON header 中的 offset 读取
    # ASAR offset 是相对于 ASAR 文件起始的绝对偏移
    json_start = 8
    json_bytes = data[json_start:]
    brace_depth = 0
    json_end_offset = json_start
    for i, b in enumerate(json_bytes):
        byte = b.to_bytes(1, "big") if isinstance(b, int) else bytes([b])
        if byte == b"{":
            brace_depth += 1
        elif byte == b"}":
            brace_depth -= 1
            if brace_depth == 0:
                json_end_offset = json_start + i + 1
                break

    if list_only:
        total_size = 0
        for name, info in sorted(files.items()):
            if "files" in info:
                print(f"\n[{name}/]")
                _list_dir(info["files"], name)
            else:
                size = info["size"]
                total_size += size
                print(f"  {name}  [{size:,} bytes]")
        print(f"\n共 {_count_files(files)} 个文件, {total_size:,} bytes")
    else:
        _extract_dir(files, "", output_dir, data)


def _list_dir(files: dict, prefix: str):
    total = 0
    for name, info in sorted(files.items()):
        path = f"{prefix}/{name}"
        if "files" in info:
            print(f"\n[{path}/]")
            _list_dir(info["files"], path)
        else:
            size = info["size"]
            total += size
            print(f"  {name}  [{size:,} bytes]")


def _extract_dir(files: dict, prefix: str, output_dir: str, data: bytes):
    for name, info in files.items():
        path = os.path.join(prefix, name) if prefix else name
        if "files" in info:
            os.makedirs(os.path.join(output_dir, path), exist_ok=True)
            _extract_dir(info["files"], path, output_dir, data)
        else:
            offset = int(info["offset"])
            size = info["size"]
            executable = info.get("executable", False)
            size_int = info.get("size", 0)
            if isinstance(size_int, dict):
                # ASAR 某些情况下 size 是对象
                size_int = 0

            file_path = os.path.join(output_dir, path)
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            with open(file_path, "wb") as f:
                f.write(data[offset : offset + size])
            if executable:
                os.chmod(file_path, 0o755)


def _count_files(files: dict) -> int:
    count = 0
    for info in files.values():
        if "files" in info:
            count += _count_files(info["files"])
        else:
            count += 1
    return count


def main():
    list_only = False
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        sys.exit(1)

    if "--list" in args:
        list_only = True
        args.remove("--list")

    if not args:
        print(__doc__)
        sys.exit(1)

    asar_path = args[0]
    output_dir = args[1] if len(args) > 1 else os.path.splitext(asar_path)[0] + "_unpacked"

    if not os.path.exists(asar_path):
        print(f"错误: 文件不存在: {asar_path}")
        sys.exit(1)

    print(f"读取 ASAR: {asar_path}")
    header, data = read_asar(asar_path)

    if list_only:
        print(f"\n文件列表:")
    else:
        print(f"解压到: {output_dir}")

    extract_files(header, data, output_dir, list_only)

    if not list_only:
        print("完成.")


if __name__ == "__main__":
    main()
