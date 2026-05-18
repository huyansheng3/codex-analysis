# 无 Sourcemap 的 JS 逆向重建：方法与实践

> 当生产构建不保留 sourcemap 时，如何从混淆 JS 中重建出语义等价的 TypeScript 代码。

---

## 1. 前提：为什么没有 sourcemap

Codex App 使用 Vite 8.0.3 生产构建，产物输出到 `app.asar` 中。生产模式下 Vite 默认不生成 sourcemap（`build.sourcemap` 默认为 `false`）。

### 证据

**Vite 生产构建的文件命名** —— 带内容哈希的标准产物：

```
.vite/build/
├── bootstrap.js                    ← 3.7 KB，无 hash（固定入口点）
├── app-session-tZw_L1R0.js         ← 4.3 MB，内容哈希后缀
├── main.js
└── worker.js                       ← 1.2 MB

webview/assets/
├── index-BCyxq2Zd.js               ← 入口 chunk
├── preload-helper-DDNUbuXK.js      ← modulepreload
├── chunk-Bj-mKKzh.js               ← 公共 chunk
├── src-CVmnixyG.js                 ← 应用核心
└── csharp-BinmIpfC.js              ← 语法高亮（~989 个延迟加载 chunk）
```

**ASAR 内无 `.map` 文件** —— 解压后的 1305 个文件中：

- 没有任何 `.js.map` 文件
- JS 文件末尾没有 `//# sourceMappingURL=...` 注释
- 如果有 inline sourcemap，文档中会有明确记载

**CSP 间接证明** —— `webview/index.html` 的策略：

```html
<meta http-equiv="Content-Security-Policy" content="
  script-src 'self' 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=' 'wasm-unsafe-eval';
">
```

`script-src` 使用具体 hash 白名单，没有 `'unsafe-eval'`（仅 WASM），说明是锁定的生产环境。

---

## 2. 为什么还能逆向：混淆的边界

理解混淆工具（Terser/esbuild）的实际行为是逆向的前提。生产构建的混淆不是加密，它有几个**不可消除的信息泄漏**：

### 2.1 字符串字面量不变

```javascript
// 原始 TypeScript
const servicePath = env["SKY_CUA_SERVICE_PATH"]?.trim() || "/tmp/cua";

// Terser 混淆后
const e=process.env;e["SKY_CUA_SERVICE_PATH"]?.trim()||"/tmp/cua"
```

变量名从 `servicePath` → `e`，但字符串 `"SKY_CUA_SERVICE_PATH"` 和 `"/tmp/cua"` 原样保留。**字符串是混淆后唯一可以直接搜索的语义锚点**。

### 2.2 控制流结构不变

```javascript
// 原始
if (!config) throw new Error("missing config");
return value ? value.trim() : "";

// 混淆后
if(!e)throw new Error("missing config")
return t?t.trim():""
```

`if`/`return`/`throw`/`try`/`await`/`for` 的结构完全保留。改变的是**命名**，不变的是**逻辑**。

### 2.3 操作符语义保留

```
?.  →  可选链，值可能为 null/undefined
??  →  空值合并，有默认值
||  →  逻辑或，falsy 时的 fallback
&&  →  逻辑与，短路保护
```

操作符直接告诉你类型信息和防御性编程的意图。

### 2.4 属性访问模式暴露类型

```javascript
// 混淆后
e.foo?.bar    →  e 是对象，foo 可能不存在，bar 是可选的
e.map(...)    →  e 是数组
e.trim()      →  e 是字符串
e.toFixed(1)  →  e 是数字
```

---

## 3. 六步重建法

### Step 1：字符串锚点定位

选择**有语义的、独特的**字符串作为入口。优先级：

1. IPC 通道名（如 `"codex:set-setting"`）— 最独特
2. 配置 key（如 `"SKY_CUA_SERVICE_PATH"`）— 几乎不会重复
3. 错误消息（如 `"missing config"`）— 关联异常处理逻辑
4. CSS class 名、HTML id、URL path — 关联 UI 和路由

避免选择：
- 常见单词（`"error"`、`"data"`）— 匹配太多
- 单字符或短字符串 — 噪声大

### Step 2：上下文窗口提取

用脚本提取匹配位置前后 200-500 字符：

```bash
python3 scripts/search-minified.py "SKY_CUA_SERVICE_PATH" app-session.js --context 400
```

输出：

```
偏移 1,423,891 (上下文 1,423,491-1,424,291):
...const e=process.env;e["SKY_CUA_SERVICE_PATH"]?.trim()||"/tmp/cua"...
```

上下文窗口大小的选择：
- 200 字符：足够看到赋值和一行内的逻辑
- 400 字符：可以看到周围的函数边界
- 800 字符：可能跨多个语句，适合理解完整函数

### Step 3：变量名反推

从赋值和调用模式推断每个变量的语义角色：

```
观察:  e[ft]?.trim()
       │  │    └── 调用 trim() → 返回值是 string
       │  └── 方括号动态访问 → e 是 Record/Map/对象
       └── 来自 process.env → e 是环境变量对象

重建:  env["SKY_CUA_SERVICE_PATH"]?.trim()
```

**常见推断模式**：

| 混淆模式 | 推断 | 依据 |
|---------|------|------|
| `e = process.env` | `env: NodeJS.ProcessEnv` | 赋值源 |
| `e[ft]?.trim()` | `env[key]?.trim()` | 方括号 + 可选链 + trim |
| `e \|\| "default"` | `value \|\| "default"` | 有默认值的 string |
| `e ?? 30000` | `timeout ?? 30000` | 有默认值的 number |
| `Array.isArray(e)` | `Array.isArray(items)` | 类型守卫 |
| `typeof e == "string"` | 类型收窄分支 | typeof 守卫 |
| `e.map(t => ...)` | `items.map(item => ...)` | Array 方法 |
| `e.then(...).catch(...)` | `promise.then(...)` | Promise 链 |

### Step 4：控制流保留

混淆后不变的结构直接映射：

```javascript
// 混淆
if(!e)throw new Error("missing")
try{await n.stop()}catch(e){r.error(e)}
for(let e=0;e<t.length;e++){o.push(t[e].name)}

// 直接可读为
if (!config) throw new Error("missing")
try { await server.stop() } catch (err) { logger.error(err) }
for (let i = 0; i < items.length; i++) { names.push(items[i].name) }
```

**关键保留结构**：

| 结构 | 混淆后 | 推断信息 |
|------|--------|---------|
| `if/else` | 不变 | 条件分支逻辑 |
| `return` | 不变 | 函数出口 |
| `throw new Error("...")` | 字符串保留 | 异常类型和条件 |
| `try/catch/finally` | 不变 | 异常处理边界 |
| `for/while` | 不变 | 循环逻辑 |
| `switch/case` | 不变 | 多路分支 |
| `async/await` | 不变 | 异步操作点 |
| `?.` | 不变 | 可选链，值可能不存在 |
| `??` | 不变 | 空值合并，有默认值 |
| `...spread` | 不变 | 展开操作 |

### Step 5：跨文件关联

**核心原则**：同一个字符串出现在两个文件 = 它们之间有调用/引用关系。

```
main.js:
  ipcMain.on("codex:set-setting", handler)
     │
     │ IPC 通道名作为关联键
     │
preload.js:
  ipcRenderer.send("codex:set-setting", data)
```

通过这种方式可以重建：

| 字符串类型 | 关联的信息 |
|-----------|-----------|
| IPC channel 名 | 主进程 ↔ 渲染进程通信 |
| Event 类型名 (`"agent:turn-started"`) | 事件触发端 ↔ 事件处理端 |
| Settings key | 写入端 ↔ 读取端 |
| CSS class 名 | HTML 模板 ↔ CSS 样式 ↔ JS 组件 |
| i18n key | UI 组件 ↔ 国际化文案 |

**实例**：在 `main.js` 中搜索 `"avatar-overlay"` → 找到 `BrowserWindow` 配置；在 `preload.js` 中搜索同样的字符串 → 找到渲染进程侧的窗口控制消息。两端拼接 = 完整的桌面宠物窗口通信协议。

### Step 6：类型推断

TypeScript 编译后类型信息全部丢失，但从运行时行为反推：

**从默认值推断**：

```javascript
// 混淆: e || "prod"
// 推断: buildFlavor: string = "prod"

// 混淆: e ?? 30000
// 推断: timeout: number = 30000

// 混淆: e || []
// 推断: items: unknown[] = []
```

**从运算符推断可空性**：

```javascript
// 混淆: e?.trim()
// 推断: value: string | undefined

// 混淆: e ?? "default"
// 推断: value: string | null

// 混淆: e && e.foo
// 推断: e: SomeType | null | undefined
```

**从方法调用推断**：

```javascript
// 混淆: e.map(t => t.id)
// 推断: items: Array<{ id: unknown }>

// 混淆: e.toFixed(1)
// 推断: value: number

// 混淆: e.replace(/"/g, "")
// 推断: value: string
```

**从条件判断推断联合类型**：

```javascript
// 混淆
if (typeof e == "string") { e.trim() }
else { e.map(t => t.name) }

// 推断: input: string | Array<{ name: unknown }>
```

---

## 4. 完整重建示例

以 `src/pet/spritesheet-engine.ts:164-180` 的 `generateCSSKeyframes` 函数为例，展示从混淆代码到 TypeScript 的六步过程。

### 4.1 锚点定位

搜索 `"@keyframes"` 或 `"background-position"`（CSS 属性名在拼接字符串中出现）：

```bash
python3 scripts/search-minified.py "background-position" main.js --context 400
```

### 4.2 提取的混淆代码

```javascript
function n(t,e,i){
  let s="";
  for(let r=0;r<t.frameCount;r++){
    let a=(r/(t.frameCount-1)*100).toFixed(1),
        o=r*e;
    s+=`  ${a}% { background-position: -${o}px -${t.rowIndex*i}px; }\n`
  }
  return s
}
```

### 4.3 分步分析

**变量反推**：

| 变量 | 使用方式 | 推断 |
|------|---------|------|
| `t` | `t.frameCount`, `t.rowIndex` | 配置对象，有 `frameCount` 和 `rowIndex` 属性 |
| `e` | `r * e` → 计算 x 偏移 | 数字，单元格宽度 |
| `i` | `t.rowIndex * i` → 计算 y 偏移 | 数字，单元格高度 |
| `s` | 字符串拼接，最终返回 | 返回类型 string |
| `r` | 从 0 到 `t.frameCount` | 帧索引（循环变量） |
| `a` | `toFixed(1)` + `%` | 关键帧百分比，string |
| `o` | 用于 background-position x | 像素偏移，number |

**控制流分析**：

```
for 循环 frameCount 次      → 每个动画帧生成一个关键帧
  toFixed(1) + "%"           → CSS 百分比关键帧位置
  background-position: -x -y  → CSS sprite 的背景位移
返回拼接后的字符串            → 完整的 @keyframes 规则
```

**类型推断**：

```typescript
// t: { frameCount: number; rowIndex: number }
// e: number (cellWidth)
// i: number (cellHeight)
// 返回: string (CSS @keyframes 规则)
```

### 4.4 语义重建

```typescript
function generateCSSKeyframes(
  rowConfig: AnimationRowConfig,
  cellWidth: number,
  cellHeight: number,
): string {
  const { rowIndex, frameCount } = rowConfig;
  const yOffset = rowIndex * cellHeight;

  let keyframes = "";
  for (let frame = 0; frame < frameCount; frame++) {
    const percent = ((frame / (frameCount - 1)) * 100).toFixed(1);
    const xOffset = frame * cellWidth;
    keyframes += `  ${percent}% { background-position: -${xOffset}px -${yOffset}px; }\n`;
  }
  return keyframes;
}
```

### 4.5 保真度评估

| 维度 | 保真度 | 说明 |
|------|--------|------|
| 逻辑 | 100% | 控制流完全保留，行为一致 |
| 变量名 | 推断 | `rowConfig` 而非原始的 `animationRow` |
| 类型 | 推断 | `AnimationRowConfig` 接口是重建的 |
| 注释 | 0% | 全部丢失，只能从逻辑反推意图 |
| 参数名 | 推断 | 顺序和语义正确，名称不保证 |

---

## 5. 工具支持

本仓库 `scripts/` 目录下的工具：

```bash
# 在混淆 JS 中搜索关键词，带上下文窗口
python3 scripts/search-minified.py "spritesheet" main.js --context 400
python3 scripts/search-minified.py "ipcMain.on" main.js --all --json

# 从 ASAR 解压全部文件
python3 scripts/extract-asar.py app.asar ./unpacked
python3 scripts/extract-asar.py --list app.asar

# 从二进制提取和过滤字符串
python3 scripts/extract-strings.py binary --preset objc,swift
python3 scripts/extract-strings.py binary --filter key,token,password

# 分析 .node 原生模块
./scripts/analyze-node-module.sh module.node ./output
```

---

## 6. 能力边界

六步重建法能做什么，不能做什么：

**能做到**：

- 恢复函数签名（参数个数、返回值类型、可空性）
- 恢复控制流逻辑（分支、循环、异常处理）
- 恢复对象属性访问模式（→ 接口推断）
- 恢复 IPC/事件/API 的调用关系（跨文件关联）
- 恢复配置常量（字符串、数字、布尔值）

**不能做到**：

- 恢复原始变量名和函数名（不可逆的信息损失）
- 恢复 TypeScript 类型别名和泛型参数
- 恢复注释和文档
- 恢复编译时优化的代码（死代码消除、内联）
- 区分原始代码和编译时注入的 polyfill/helper

---

## 7. 与有 Sourcemap 场景的对比

| 维度 | 有 Sourcemap | 无 Sourcemap |
|------|-------------|-------------|
| 变量名 | 原始命名 | 推断命名 |
| 类型 | 完整 TypeScript 类型 | 从运行时行为反推 |
| 注释 | 保留（如未 strip） | 全部丢失 |
| 文件结构 | 原始 src/ 目录 | 从 require/import 路径推断 |
| 调用链追踪 | 直接 | 字符串锚点 + 跨文件关联 |
| 准确性 | 100% | 逻辑 100%，命名 ~70-90% |
| 效率 | 即时可读 | 每个函数需要 5-30 分钟分析 |
