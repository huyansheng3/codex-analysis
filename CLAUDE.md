# Codex App 逆向工程

本仓库包含对 OpenAI Codex macOS 桌面应用的完整安全架构逆向分析。

## 项目结构

```
codex-ana/
├── README.md                              ← 项目概览和文档索引
├── codex-app-architecture-report.md       ← 整体架构分析
├── docs/                                  ← 深度分析文档 (16 篇)
│   ├── codex-ipc-communication-layer.md
│   ├── codex-main-process-architecture.md
│   ├── codex-native-modules-deep-dive.md
│   ├── codex-plugin-system.md
│   ├── codex-renderer-wasm-layer.md
│   ├── codex-security-attack-surface.md
│   ├── codex-computer-use-implementation.md
│   ├── codex-goal-mode-implementation.md
│   ├── codex-goal-agent-layer.md
│   ├── codex-remote-control-system.md
│   ├── codex-hotkey-window-system.md
│   ├── codex-dictation-system.md
│   ├── codex-browser-sidebar-system.md
│   ├── codex-plan-multi-agent-system.md
│   ├── codex-agent-core-process-architecture.md
│   └── codex-desktop-pet-implementation.md
├── src/                                   ← 反编译重建的源代码
│   ├── preload/         electron-bridge.ts, sandbox-preload.ts
│   ├── ipc/             channels.ts, message-types.ts
│   ├── main/            bootstrap.ts, computer-use-path.ts
│   ├── native/          objc-js-api.ts
│   ├── plugins/         manifest.ts
│   ├── computer-use/    mcp-tools.ts, permission-system.ts
│   ├── goal/            automation-template.md, heartbeat.xml, thread-follower.ts
│   ├── remote-control/  enrollment.ts, ssh-connections.ts
│   └── pet/             spritesheet-engine.ts, avatar-overlay.ts,
│                        state-machine.ts, hotkey-window.ts
└── CLAUDE.md                              ← 本文件
```

## 分析方法论

详细方法论见以下文档：

| 文档 | 内容 |
|------|------|
| [docs/reverse-engineering-methodology.md](docs/reverse-engineering-methodology.md) | 通用逆向方法论：五阶段流程、不同目标技术矩阵、工具集 |
| [docs/no-sourcemap-js-reconstruction.md](docs/no-sourcemap-js-reconstruction.md) | **无 sourcemap 的 JS 六步重建法**：字符串锚点、上下文提取、变量反推、控制流保留、跨文件关联、类型推断 |

### 快速参考

**ASAR 解压**：格式为 `[4B header_size][4B reserved][JSON header][file blobs]`。
```bash
find /Applications/Codex.app -name "*.asar" -not -path "*/node_modules/*"
python3 scripts/extract-asar.py app.asar ./unpacked
```

**混淆 JS 分析**：核心是**字符串锚点法**——字符串在混淆后不变，每个有意义的字符串都是进入代码的入口。

**.node 模块**：`nm -gU` 导出符号、`strings` 嵌入字符串、`otool -L` 动态库依赖。

**Swift 二进制**：通过 `strings` 提取 Swift mangling（`_TtC...`）→ demangle 恢复类名/方法名。

**i18n 数据**：35MB `comment-preload.js` 包含完整 UI 标签，提取 i18n key 可重建组件结构和功能枚举。

## 关键发现

### 目标 App 信息
- App: /Applications/Codex.app
- 版本: 26.506.31421 (Build 2620)
- asar: /Applications/Codex.app/Contents/Resources/app.asar (137MB)
- 解压后 1305 个文件，约 175MB

### 技术栈
- Electron 41.2.0 + Vite 8.0.3 + TypeScript 5.9.3
- React SPA 渲染进程
- .NET/WASM 运行时（31 个 WASM 模块，用于 Office 文档渲染）
- Swift 原生进程（Computer Use 的双进程架构）
- C++ Node Addons（better-sqlite3, node-pty, objc-js）

### 安全关注点
- API Key 明文存储于 Electron Settings
- objc-js 提供无限制的系统访问（任意 dlopen/objc_msgSend/libffi）
- Computer Use 的双层权限（Accessibility + Screen Recording）
- IPC 通信无调用者上下文验证

## 逆向工具脚本 (scripts/)

```bash
# 从 ASAR 中解压文件
python3 scripts/extract-asar.py app.asar ./unpacked
python3 scripts/extract-asar.py --list app.asar   # 仅列出文件

# 在 minified JS 中搜索关键词 (带上下文)
python3 scripts/search-minified.py "SKY_CUA_SERVICE_PATH" app.js
python3 scripts/search-minified.py "keyword" file.js --context 400 --all

# 分析 .node 原生模块
./scripts/analyze-node-module.sh module.node ./analysis-output

# 从二进制提取并过滤字符串
python3 scripts/extract-strings.py binary --preset objc,swift
python3 scripts/extract-strings.py binary --filter key,token,password
python3 scripts/extract-strings.py binary --pattern 'TtC\d+Codex'  # Swift mangling

# 读取 Mach-O 信息
file binary
plutil -p Info.plist
```
