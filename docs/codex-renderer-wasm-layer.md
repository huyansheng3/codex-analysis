# Codex 渲染进程与 WASM 运行时分析

> 来源：`webview/` 目录、993 个 Vite 代码分割的 JS 文件、31 个 WASM 模块
> 版本：26.506.31421 (Build 2620)

---

## 1. 渲染进程入口

### 1.1 HTML Shell

**文件**：`webview/index.html` (9,353 bytes)

```html
<!doctype html>
<html lang="en">
<head>
  <!-- PROD_BASE_TAG_HERE -->      <!-- 生产环境 base href 注入点 -->
  <!-- PROD_CSP_TAG_HERE -->       <!-- 生产环境 CSP 注入点 -->
  <meta charset="UTF-8" />
  <title>Codex</title>

  <!-- React SPA 入口（Vite 产物） -->
  <script type="module" crossorigin src="./assets/index-BCyxq2Zd.js"></script>
  <link rel="modulepreload" crossorigin href="./assets/preload-helper-DDNUbuXK.js">
  <link rel="modulepreload" crossorigin href="./assets/chunk-Bj-mKKzh.js">
  <link rel="modulepreload" crossorigin href="./assets/path-browserify-fgDTXxoN.js">
  <link rel="modulepreload" crossorigin href="./assets/src-CVmnixyG.js">

  <!-- CSP 安全策略 -->
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    img-src 'self' app: blob: data: https:;
    child-src 'self' blob: https://*.web-sandbox.oaiusercontent.com;
    frame-src 'self' blob: https://*.web-sandbox.oaiusercontent.com;
    worker-src 'self' blob:;
    script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=' 'wasm-unsafe-eval';
    style-src 'self' 'unsafe-inline';
    font-src 'self' data:;
    media-src 'self' app: blob: data:;
    connect-src 'self' https://ab.chatgpt.com https://cdn.openai.com;
  ">
</head>
<body tabindex="0">
  <div id="root">
    <!-- 启动加载动画 -->
    <div class="startup-loader" aria-hidden="true">
      <div class="startup-loader__logo">
        <svg class="startup-loader__base">...</svg>   <!-- Codex Logo SVG -->
        <div class="startup-loader__overlay"></div>    <!-- Shimmer 动画叠加 -->
      </div>
    </div>
  </div>
</body>
</html>
```

### 1.2 启动动画

CSS 定义的 Codex Logo Shimmer 效果：

```css
:root {
  --startup-background: transparent;
  --startup-logo-base: #adadad;
  --startup-logo-shimmer-soft: rgb(255 255 255 / 0.02);
  --startup-logo-shimmer-peak: rgb(255 255 255 / 0.46);
  --startup-logo-shimmer-tail: rgb(255 255 255 / 0.06);
}

/* Shimmer 动画：从左到右的光泽扫过 Logo */
@keyframes startup-codex-logo-shimmer {
  0%   { background-position: 140% 0; }
  100% { background-position: -120% 0; }
}
/* 周期: 2200ms, cubic-bezier(0.4, 0, 0.2, 1) */
/* Logo fade-in: 180ms ease-out, 60ms delay */
```

### 1.3 CSP 详细分析

```typescript
const CSP_POLICY = {
  "default-src": ["'none'"],
  "img-src": ["'self'", "app:", "blob:", "data:", "https:"],
  // ⚠️ img-src 允许 https: — 可以从任何 HTTPS 源加载图片

  "child-src": ["'self'", "blob:", "https://*.web-sandbox.oaiusercontent.com"],
  "frame-src": ["'self'", "blob:", "https://*.web-sandbox.oaiusercontent.com"],
  // MCP Sandbox 框架限制在 OpenAI 的沙箱域名

  "worker-src": ["'self'", "blob:"],
  "script-src": ["'self'", "'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='", "'wasm-unsafe-eval'"],
  // ⚠️ 'wasm-unsafe-eval': 允许 WASM 执行（.NET 运行时需要）
  // 内联脚本仅允许特定 SHA-256 hash

  "style-src": ["'self'", "'unsafe-inline'"],
  // ⚠️ 'unsafe-inline': 允许内联样式

  "font-src": ["'self'", "data:"],
  "media-src": ["'self'", "app:", "blob:", "data:"],
  "connect-src": ["'self'", "https://ab.chatgpt.com", "https://cdn.openai.com"],
  // ⚠️ connect-src 限制在 ab.chatgpt.com 和 cdn.openai.com
  // 注意：API 请求可能走主进程的 Node.js HTTP，不受 CSP 限制
};
```

---

## 2. 代码分割结构

从 993 个 JS 文件和 modulepreload hints 分析：

```
入口: index-BCyxq2Zd.js
  │
  ├── preload-helper-DDNUbuXK.js     (modulepreload)
  ├── chunk-Bj-mKKzh.js               (modulepreload)
  ├── path-browserify-fgDTXxoN.js     (modulepreload, browser polyfill)
  ├── src-CVmnixyG.js                 (modulepreload, 应用核心)
  │
  ├── 延迟加载 chunks (~989 files):
  │   ├── 语法高亮 (Monaco Editor / CodeMirror)
  │   │   ├── csharp-BinmIpfC.js (87 KB)
  │   │   ├── swift-bVYzFvhg.js (86 KB)
  │   │   └── ... (~50+ 语言)
  │   │
  │   ├── 主题 (编辑器颜色方案)
  │   │   ├── light-plus-YpbR3fCy.js
  │   │   ├── rose-pine-COMuwUGR.js
  │   │   └── ... (~20+ 主题)
  │   │
  │   ├── 图表/可视化
  │   │   ├── dagre-6UL2VRFP-DmJaosXk.js (DAG 布局)
  │   │   └── cue-DHLbtnJj.js (Cue 语言支持)
  │   │
  │   ├── PDF 渲染
  │   │   ├── pdf-preview-panel-BHPFKiOr.css
  │   │   └── pdf.worker.min-qwK7q_zL.mjs (1 MB, PDF.js Worker)
  │   │
  │   └── 用户消息附件
  │       └── user-message-attachments-BaLUg36V.js
```

---

## 3. .NET/WASM 运行时

### 3.1 架构

Codex 在渲染进程（WebView）中运行完整的 .NET 运行时（通过 WASM）：

```
JavaScript/React
  │
  ├── dotnet.native.wasm (1.5 MB)
  │   └── .NET Native Runtime: GC, JIT 编译到 WASM, 类型系统
  │
  ├── System.Private.CoreLib.wasm (1.5 MB)
  │   └── .NET Core Library: Collections, IO, Threading, Text
  │
  └── Application WASM Modules (28 modules, ~6.4 MB total)
```

### 3.2 完整 WASM 模块清单

#### .NET Runtime Core

| 模块 | 大小 | 用途 |
|------|------|------|
| `dotnet.native.wfd2lrj4w6.wasm` | 1,489 KB | .NET 原生运行时（托管 GC） |
| `System.Private.CoreLib.5knuccmsyn.wasm` | 1,516 KB | CoreLib（基础类型系统） |

#### 应用级模块

| 模块 | 大小 | 用途 |
|------|------|------|
| **`Walnut.nvqhqmqbjk.wasm`** | **1,735 KB** | **最大的应用模块** — 推测为文档解析引擎 |
| `DocumentFormat.OpenXml.ie8f746kzt.wasm` | 4,229 KB | Office OpenXML 格式处理 |
| `DocumentFormat.OpenXml.Framework.kpj7t3qucf.wasm` | 273 KB | OpenXML Framework |
| `Google.Protobuf.ze35jf5cfr.wasm` | 308 KB | Protocol Buffers 序列化 |

#### .NET Framework 类库

| 模块 | 大小 | 用途 |
|------|------|------|
| `System.dqfxtvioy0.wasm` | 4 KB | System 基础 |
| `System.Collections.53wkt3rjnm.wasm` | 23 KB | 集合 |
| `System.Collections.Concurrent.ifkyiyawwo.wasm` | 19 KB | 并发集合 |
| `System.Collections.NonGeneric.7lsghwy4oa.wasm` | 7 KB | 非泛型集合 |
| `System.Collections.Specialized.4ycmsxi9r1.wasm` | 9 KB | 专用集合 |
| `System.ComponentModel.5keg7c7hvo.wasm` | 5 KB | 组件模型 |
| `System.ComponentModel.Primitives.755z3qfw43.wasm` | 7 KB | 组件原语 |
| `System.ComponentModel.TypeConverter.yj8s8mxecj.wasm` | 44 KB | 类型转换 |
| `System.Console.wafck6z1ot.wasm` | 14 KB | 控制台 |
| `System.Diagnostics.DiagnosticSource.qcda27aixf.wasm` | 18 KB | 诊断源 |
| `System.IO.Compression.tcn9zdeat6.wasm` | 72 KB | 压缩 |
| `System.IO.Packaging.ejb20qp7p2.wasm` | 73 KB | 打包（Zip） |
| `System.Linq.5ehom0dfm3.wasm` | 35 KB | LINQ |
| `System.Linq.Expressions.z7qevklcuo.wasm` | 74 KB | 表达式树 |
| `System.Memory.282wmwiloz.wasm` | 12 KB | Memory/Span |
| `System.Net.Http.ubki69uxiv.wasm` | 133 KB | HTTP 客户端 |
| `System.Net.Primitives.6xdadyjvop.wasm` | 7 KB | 网络原语 |
| `System.ObjectModel.t3toc9pme6.wasm` | 12 KB | 对象模型 |
| `System.Private.Uri.ai39t9vkqf.wasm` | 65 KB | URI 解析 |
| `System.Private.Xml.hdgz58vruv.wasm` | 484 KB | XML 核心 |
| `System.Private.Xml.Linq.6s0uf1018j.wasm` | 39 KB | LINQ to XML |
| `System.Runtime.InteropServices.JavaScript.gfj68pelgx.wasm` | 41 KB | JS互操作 |
| `System.Security.Cryptography.olbng0qvbw.wasm` | 20 KB | 加密 |
| `System.Text.RegularExpressions.g9hkuzbacr.wasm` | 224 KB | 正则表达式 |
| `System.Xml.Linq.53liyo777g.wasm` | 4 KB | XML LINQ |

### 3.3 推测：.NET/WASM 的用途

基于包含的模块分析，.NET/WASM 运行时主要用于：

1. **Office 文档处理**（Word/Excel/PowerPoint）
   - `DocumentFormat.OpenXml` → 解析 .docx, .xlsx, .pptx
   - `System.IO.Packaging` → ZIP 格式（Office 文件本质是 ZIP）
   - `System.IO.Compression` → 解压缩
   - `System.Private.Xml` → XML 解析（Office 文件内部结构）

2. **Protocol Buffers 处理**
   - `Google.Protobuf` → 与后端 API 的数据交换格式

3. **Walnut 模块**
   - 最大的应用模块（1.7 MB），推测为内部文档解析/渲染引擎
   - "Walnut" 可能是 OpenAI 内部的项目代号

---

## 4. 精灵表动画系统

8 个 WebP 精灵表文件，用于角色动画：

| 精灵表 | 大小 | 推测角色 |
|---------|------|----------|
| `codex-spritesheet.webp` | 868 KB | Codex 主角色 |
| `bsod-spritesheet.webp` | 931 KB | BSOD（蓝屏）角色 |
| `dewey-spritesheet.webp` | 764 KB | Dewey 角色 |
| `fireball-spritesheet.webp` | 1,035 KB | Fireball 角色 |
| `null-signal-spritesheet.webp` | 477 KB | Null Signal 角色 |
| `rocky-spritesheet.webp` | 644 KB | Rocky 角色 |
| `seedy-spritesheet.webp` | 893 KB | Seedy 角色 |
| `stacky-spritesheet.webp` | 732 KB | Stacky 角色 |

这些是 Codex 的可选桌面宠物（类似 Clippy），通过精灵表实现动画。每个文件包含多行动画帧（走动、空闲、交互等）。

---

## 5. 字体系统

### 5.1 KaTeX 数学字体

用于数学公式渲染（20 TTF + 34 WOFF + 33 WOFF2 = 87 个字体文件）：

```
KaTeX_AMS-Regular       (AMS 数学符号)
KaTeX_Caligraphic-Bold/Regular  (书法体)
KaTeX_Fraktur-Bold/Regular     (德文尖角体)
KaTeX_Main-Bold/BoldItalic/Italic/Regular  (主字体)
KaTeX_Math-BoldItalic/Italic   (数学斜体)
KaTeX_SansSerif-Bold/Italic/Regular  (无衬线体)
KaTeX_Script-Regular     (手写体)
KaTeX_Size1/Size2/Size3/Size4  (尺寸变体)
KaTeX_Typewriter-Regular (等宽)
```

### 5.2 Carlito 字体

Google 的 Carlito 字体（Calibri 的开源替代），用于正文显示：
- Carlito-Bold/Italic/BoldItalic/Regular

---

## 6. 应用图标（"Open In..." 菜单）

`webview/apps/` 目录包含 27 个编辑器/终端的品牌图标 PNG：

```typescript
// 终端
["terminal.png", "iterm2.png", "warp.png", "ghostty.png", "cmder.png",
 "microsoft-terminal.png"]

// 编辑器
["vscode.png", "vscode-insiders.png", "cursor.png", "windsurf.png",
 "zed.png", "sublime-text.png", "textmate.png", "bbedit.png",
 "emacs.png", "xcode.png", "antigravity.png"]

// JetBrains IDEs
["intellij.png", "pycharm.png", "goland.png", "phpstorm.png",
 "rustrover.png", "rider.png", "webstorm.svg"]

// 其他
["finder.png", "file-explorer.png", "android-studio.png"]
```

---

## 7. PDF 渲染

PDF.js Worker 集成：

```
pdf.worker.min-qwK7q_zL.mjs (1 MB) — PDF.js v4.x Worker
pdf-preview-panel-BHPFKiOr.css (1.6 KB) — PDF 预览面板样式
```

### PDF 渲染流程

```typescript
// 推测的 PDF 渲染流程
class PdfPreviewPanel {
  // 1. 获取 PDF 文件（blob: URL 或 file: URL）
  // 2. 创建 PDF.js Worker（pdf.worker.min.mjs）
  // 3. 渲染到 <canvas>
  // 4. 提供缩放、翻页、搜索功能
}
```

---

## 8. 安全分析

### 8.1 WASM 攻击面

| 风险 | 说明 |
|------|------|
| WASM 逃逸 | .NET 运行时 bug 可能导致 WASM 沙箱逃逸 |
| 内存安全 | .NET GC 在 WASM 堆中的实现可能有漏洞 |
| JS Interop | `System.Runtime.InteropServices.JavaScript` 模块提供 JS↔WASM 桥接 |

### 8.2 CSP 绕过路径

| 向量 | 严重度 | 说明 |
|------|--------|------|
| `img-src: https:` | Medium | 可加载任意外部图片（SSRF/tracking pixel） |
| `style-src: 'unsafe-inline'` | Low | 允许内联样式，但有限风险 |
| `script-src: 'wasm-unsafe-eval'` | Medium | WASM 模块可执行任意计算 |
| `connect-src` 仅限两个域名 | Low | 但主进程的 Node.js HTTP 不受 CSP 限制 |

### 8.3 精灵表注入

如果用户可以通过 prompt 控制精灵表路径（不太可能），或存在路径遍历，可能加载恶意图像。
