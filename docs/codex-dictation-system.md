# Codex 语音输入（Dictation）系统深度分析

## 1. 系统架构概览

Codex 的语音输入系统是一个独立于主对话系统的完整子系统，允许用户通过全局快捷键在任何应用中启动语音输入，将语音实时转录为文本后自动粘贴到当前焦点应用。

### 1.1 核心组件

```
┌─────────────────────────────────────────────────────────────┐
│                    Codex App (Electron)                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Main Process (main-kSlb32Yb.js)             │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  GlobalDictationHotkeyController (CW class)  │     │   │
│  │  │  - 热键注册/注销                              │     │   │
│  │  │  - 生命周期管理 (lifecycleLock)               │     │   │
│  │  │  - 会话状态机 (activeSession)                 │     │   │
│  │  │  - 转录历史管理                               │     │   │
│  │  │  - Gate 开关控制                              │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                         │                             │   │
│  │  ┌──────────────────────┴──────────────────────┐     │   │
│  │  │  RecorderWindowController (bW class)         │     │   │
│  │  │  - 浮动录音窗口管理                          │     │   │
│  │  │  - 窗口布局切换 (compact/error)              │     │   │
│  │  │  - 窗口显示/隐藏/关闭                        │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                         │                             │   │
│  │  ┌──────────────────────┴──────────────────────┐     │   │
│  │  │  bare-modifier-monitor (Native Swift Binary) │     │   │
│  │  │  - macOS 底层按键事件监控                    │     │   │
│  │  │  - Fn/Option/Command 等修饰键捕获            │     │   │
│  │  │  - 热键释放监听                              │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  Transcription History                       │     │   │
│  │  │  - transcription-history.jsonl               │     │   │
│  │  │  - 最近 10 条记录                             │     │   │
│  │  │  - 剪贴板复制支持                             │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  Global Dictation Paste (fW function)        │     │   │
│  │  │  - macOS: osascript keystroke Cmd+V          │     │   │
│  │  │  - Windows: PowerShell SendKeys ^v           │     │   │
│  │  │  - 剪贴板保护/恢复机制                       │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         │ IPC Messages                       │
│                         ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         Renderer Process (app-session-O7kcZj7R.js)    │   │
│  │                                                       │   │
│  │  ┌─────────────────────────────────────────────┐     │   │
│  │  │  /global-dictation Route (ly variable)       │     │   │
│  │  │  - React 页面组件                             │     │   │
│  │  │  - 音频录制 UI                                │     │   │
│  │  │  - 波形显示                                    │     │   │
│  │  │  - 错误状态处理                               │     │   │
│  │  └─────────────────────────────────────────────┘     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 平台支持

- **macOS**: 完整支持，使用 `bare-modifier-monitor` 原生二进制 + `globalShortcut` API
- **Windows**: 支持标准快捷键，使用 PowerShell 脚本监听热键释放
- **Linux**: 不支持（代码中显式抛出错误）

平台检测函数：
```javascript
function TW() {
  return process.platform === 'darwin' || process.platform === 'win32'
}
```

---

## 2. bare-modifier-monitor 原生二进制集成

### 2.1 二进制文件信息

- **路径**: `/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor`
- **类型**: Mach-O 64-bit executable arm64
- **大小**: 154,400 字节
- **语言**: Swift (基于 `Swift/arm64e-apple-macos.swiftinterface` 符号)
- **框架依赖**: AppKit

### 2.2 使用方式

通过 `strings` 提取的帮助信息：
```
Usage: bare-modifier-monitor --key <key> [--immediate | --trigger-on-release]
       | --release-modifiers <modifiers>
```

两种运行模式：

#### 模式 1: 按键监控 (BareModifierMonitorSession)
```bash
bare-modifier-monitor --key <key> [--immediate | --trigger-on-release]
```
- 监控单个修饰键的按下/释放
- 输出: `ready`, `down`, `up`, `permission-denied`
- `--immediate`: 修饰键单独按下即触发（不等其他键）
- `--trigger-on-release`: 在释放时触发

#### 模式 2: 释放监控 (ReleaseModifierMonitor)
```bash
bare-modifier-monitor --release-modifiers <modifiers>
```
- 监控一组修饰键的组合释放
- `modifiers`: 逗号分隔的修饰键列表

### 2.3 支持的修饰键映射

从 Swift 二进制和 JS 代码中提取的完整修饰键映射表 (`tC` map)：

| 用户输入键名 | BareModifier 内部名称 | 说明 |
|------------|---------------------|------|
| `fn` | `Fn` | 功能键 |
| `leftoption`, `leftalt` | `LeftOption` | 左 Option/Alt |
| `rightoption`, `rightalt` | `RightOption` | 右 Option/Alt |
| `leftcommand`, `leftcmd`, `leftmeta` | `LeftCommand` | 左 Command |
| `rightcommand`, `rightcmd`, `rightmeta` | `RightCommand` | 右 Command |
| `leftcontrol`, `leftctrl` | `LeftControl` | 左 Control |
| `doublecommand`, `leftcommand+rightcommand`, `leftcmd+rightcmd`, `leftmeta+rightmeta` | `DoubleCommand` | 双 Command 组合 |

**不支持修饰键**（`nC` set）: `rightcontrol`, `rightctrl`, `leftshift`, `rightshift`

### 2.4 二进制生命周期管理

```javascript
// 二进制路径查找
var $S = 'bare-modifier-monitor'
var eC = new Set  // 活跃 monitor 集合

// 查找二进制路径 (优先级)
function vC() {
  // 1. process.resourcesPath/native/$S
  // 2. app.getAppPath()/native/$S/build/Release-{arch}/$S
}

// 启动按键监控
function mC(binaryPath, key, options) {
  let args = ['--key', key]
  if (options?.immediate || options?.trigger === 'immediatePress')
    args.push('--immediate')
  else if (options?.trigger === 'release')
    args.push('--trigger-on-release')
  return spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'ignore'] })
}

// 启动释放监控
function hC(binaryPath, modifiers) {
  return spawn(binaryPath, 
    ['--release-modifiers', modifiers.join(',')],
    { stdio: ['pipe', 'pipe', 'ignore'] })
}

// 行读取(stdout 逐行解析)
function _C(process, callback) {
  let buffer = ''
  process.stdout?.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newlineIdx = buffer.indexOf('\n')
    while (newlineIdx !== -1) {
      callback(buffer.slice(0, newlineIdx).trim())
      buffer = buffer.slice(newlineIdx + 1)
      newlineIdx = buffer.indexOf('\n')
    }
  })
}
```

### 2.5 权限请求

```javascript
function oC() {
  // macOS: 通过 spawnSync 请求 Input Monitoring 权限
  spawnSync(binaryPath, ['--request-permission'], 
    { stdio: 'ignore', timeout: 10000 })
}
```

二进制输出 `permission-denied` 时记录警告。

---

## 3. 全局快捷键系统

### 3.1 两种热键模式

Codex 支持两种互斥的全局听写热键模式：

#### Hold 模式（按住说话，PTT）
- 命令 ID: `globalDictationHold`
- 按住热键开始录音，松开停止
- 对应传统 PTT (Push-to-Talk) 模式

#### Toggle 模式（切换开关）
- 命令 ID: `globalDictationToggle`
- 按一次开始，再按一次停止
- 适合长时间听写

约束：两个热键不能相同（`wW` 函数校验）。

### 3.2 热键注册流程

```javascript
function TC(hotkey, callbacks, options) {
  // 1. 如果是 bare modifier (Fn/Option/Command 等)
  if (isBareModifier(hotkey)) {
    return registerBareModifier(hotkey, callbacks, options?.bareModifierTrigger)
  }

  // 2. 标准 Electron globalShortcut 注册
  let registrationHotkey = toElectronAccelerator(hotkey)
  let onPressed = () => {
    logger.debug('global_hotkey_pressed', { hotkey })
    callbacks.onPressed()
  }
  let registered = electron.globalShortcut.register(registrationHotkey, onPressed)

  // 3. macOS 上额外处理键盘布局更新
  if (process.platform === 'darwin') {
    return createMacHotkeyWrapper({ hotkey, onPressed, registrationHotkey })
  }

  return { handlesRelease: false, unregister: () => { ... } }
}
```

### 3.3 热键释放监听（Windows）

Windows 平台不支持 Electron 的按键释放事件，需要通过 PowerShell 脚本轮询按键状态：

```javascript
function RC(hotkey, onReleased) {
  let keyGroups = getWin32KeyGroups(hotkey)
  let child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', createReleaseWatcherScript(keyGroups)
  ], { stdio: 'ignore', windowsHide: true })

  let disposed = false
  let handleError = (error) => {
    if (!disposed) {
      disposed = true
      onReleased()
    }
  }
  child.once('error', handleError)
  child.once('exit', () => handleError())
  return { dispose: () => { disposed = true; child.kill() } }
}
```

### 3.4 bareModifier 触发模式

在 `TC` 函数的 `options.bareModifierTrigger` 中定义了三种触发时机：

| 触发模式 | 值 | 说明 | 使用场景 |
|---------|------|------|---------|
| 按下触发 | `'press'` (默认) | 修饰键按下时触发 | Hold 热键 |
| 释放触发 | `'release'` | 修饰键释放时触发 | Toggle 热键 |
| 立即触发 | `'immediatePress'` | 修饰键单独按下立即触发 | Native Window Context 热键 |

### 3.5 macOS 键盘布局感知

```javascript
var wC = null  // macOS 键盘布局映射缓存

function EC(keyboardLayoutMap) {
  // 更新 macOS 键盘布局映射
  wC = keyboardLayoutMap
  // 触发已注册热键的重新评估
  NC()
}
```

当用户切换 macOS 键盘布局时，系统会更新映射表，确保热键正确匹配。

### 3.6 全局热键校验

```javascript
function LC(accelerator) {
  // 针对 globalDictation 的热键校验
  let result = DC(accelerator)  // 通用校验
  if (result) return result     // 通用错误
  
  // bare modifier 检查
  if (isBareModifierCombo(accelerator)) {
    return null  // bare modifier 有效
  }
  
  if (!isPlatformSupported(accelerator, process.platform)) {
    return 'Shortcut key is not supported for global dictation.'
  }
  
  return null  // 有效
}
```

### 3.7 应用内快捷键绑定

应用菜单中注册的快捷键命令：

```javascript
// 在 set-codex-command-keybinding 处理中
if (commandId === 'globalDictationHold' || commandId === 'globalDictationToggle') {
  this.globalDictationHotkeyController.syncCommandKeybindings({
    holdHotkey: getConfiguredHotkey('globalDictationHold'),
    toggleHotkey: getConfiguredHotkey('globalDictationToggle')
  })
}

// 在 codex-command-keymap-state 处理中
await updateKeymapEntry({ commandId: 'globalDictationHold', ... })
await updateKeymapEntry({ commandId: 'globalDictationToggle', ... })
```

### 3.8 Fn 键捕获

```javascript
// 主进程 IPC handler
"global-dictation-capture-fn-hotkey": async () => ({
  hotkey: await captureFnHotkey('Fn')
})

function captureFnHotkey(key, timeoutMs = 30000) {
  // 仅 macOS
  // 启动 bare-modifier-monitor --key Fn --immediate
  // 等待 'down' 事件，30 秒超时
  // 用于让用户按下 Fn 键来配置热键
}
```

---

## 4. 音频录制与转录管道

### 4.1 管道概览

音频录制完全在渲染进程（WebView）中进行，主进程仅负责：
1. 创建/管理浮动录音窗口
2. 发送 start/stop 消息
3. 接收转录结果
4. 执行粘贴操作

```
用户按下热键
    │
    ▼
Main Process: CW.handleHoldHotkeyPressed()
    │
    ├─ 检测当前焦点窗口是否是 Codex 自身
    │
    ├─ 是 → In-App 模式
    │   └─ 发送 global-dictation-in-app-start 到 app webContents
    │       └─ 等待 global-dictation-in-app-started 确认
    │
    └─ 否 → Overlay 模式
        └─ bW.showAndStart(sessionId)
            ├─ 创建/获取浮动窗口 (72x40px, alwaysOnTop)
            ├─ 发送 global-dictation-start 到浮动窗口 webContents
            └─ 如果是 hold 模式 → 启动热键释放监听
    │
    ▼
Renderer Process: 音频录制 + 实时传输
    │
    ├─ Web Audio API 捕获麦克风
    ├─ 音频数据 → 后端语音识别服务
    │
    ▼
转录完成
    │
    ▼
Renderer → Main: global-dictation-completed { sessionId, text }
    │
    ▼
Main: CW.handleTranscript(sessionId, text)
    ├─ 清除活跃会话
    ├─ 隐藏浮动窗口
    ├─ 记录到历史
    └─ 执行粘贴 (fW function)
```

### 4.2 会话模式

#### Overlay 模式（浮动窗口）
流程：热键按下 → 创建/显示浮动窗口 → 录音开始 → 转录完成 → 粘贴文本 → 隐藏窗口

```javascript
async startSession(mode) {
  let sessionId = randomUUID()
  this.activeSession = { type: 'overlay', id: sessionId, mode }

  if (!await this.windowController.showAndStart(sessionId)) {
    this.clearHotkeyReleaseWatcher()
    this.clearActiveSession()
    return
  }

  if (mode === 'hold') {
    this.watchHoldHotkeyRelease(sessionId)
  }
}
```

#### In-App 模式（应用内）
流程：热键按下 → 检测到 Codex 窗口获得焦点 → 发送消息到应用 webContents → 等待应用确认启动 → 录音在应用内进行

```javascript
async tryStartInAppSession(window, mode) {
  let sessionId = randomUUID()
  this.activeSession = {
    type: 'inApp',
    id: sessionId,
    webContentsId: window.webContents.id,
    mode
  }

  this.options.windowManager.sendMessageToWebContents(
    window.webContents,
    { type: 'global-dictation-in-app-start', sessionId }
  )

  // 等待应用确认 (150ms 超时)
  if (await this.waitForInAppDictationStart(sessionId)) {
    if (mode === 'hold') {
      this.watchHoldHotkeyRelease(sessionId)
    }
    return true
  }
  return false
}
```

### 4.3 停止录音

```javascript
stopRecording(sessionId) {
  this.clearHotkeyReleaseWatcher()
  let session = this.activeSession

  if (session?.type === 'inApp') {
    // In-App: 发送停止消息到应用 webContents
    this.options.windowManager.sendMessageToWebContentsId(
      session.webContentsId,
      { type: 'global-dictation-in-app-stop', sessionId }
    )
    this.clearActiveSession()
    return
  }

  // Overlay: 发送停止消息到浮动窗口
  this.windowController.sendStop(sessionId)
}
```

---

## 5. 浮动录音窗口

### 5.1 窗口规格

```javascript
var _W = 16    // 底部边距
var vW = 40    // 窗口高度
var yW = {
  compact: 72,  // 默认紧凑模式宽度
  error: 312    // 错误状态宽度
}
```

### 5.2 窗口配置

```javascript
// 创建窗口
await this.windowManager.createWindow({
  title: 'Dictation',
  width: yW.compact,    // 72px
  height: vW,            // 40px
  appearance: 'globalDictation',
  show: false,
  initialRoute: '/global-dictation',
  focusable: false       // 不可获取焦点
})

// 窗口属性
window.setAlwaysOnTop(true, 'floating')  // 始终置顶
```

### 5.3 窗口定位

窗口位于当前屏幕的水平居中、底部上方 16px 处：

```javascript
setLayout(layout) {
  let width = yW[layout]
  let display = screen.getDisplayNearestPoint(
    screen.getCursorScreenPoint()
  ).workArea

  window.setBounds({
    width: width,
    height: vW,
    x: Math.round(display.x + (display.width - width) / 2),
    y: Math.max(display.y, display.y + display.height - vW - _W)
  }, false)
}
```

### 5.4 窗口布局

| 布局模式 | 宽度 | 用途 |
|---------|-----|------|
| `compact` | 72px | 录音中（默认 - 显示波形/状态） |
| `error` | 312px | 错误状态（显示错误信息和操作按钮） |

### 5.5 窗口生命周期

```javascript
class RecorderWindowController {
  recorderWindowId = null
  recorderWindowPromise = null

  prewarm()     // 预创建窗口（应用启动时）
  showAndStart(sessionId)  // 显示窗口并发送 start 消息
  sendStop(sessionId)      // 发送 stop 消息
  setLayout(layout)        // 切换布局 (compact/error)
  hide()                   // 隐藏窗口
  close()                  // 关闭窗口
  ensureWindow()           // 确保窗口存在（懒创建）
  createWindow()           // 实际创建窗口
  getWindow()              // 获取窗口实例
  getFocusedInAppWindow()  // 检测 Codex 自身窗口是否焦点
}
```

窗口中运行的 React 页面路由为 `/global-dictation`（变量名 `ly`）。

---

## 6. 全局粘贴系统

### 6.1 粘贴流程

转录完成后，系统需要将文本粘贴到用户当前焦点的应用中。这通过模拟键盘粘贴实现：

```javascript
async function fW(text) {
  // 1. 保存当前剪贴板内容
  let saved = saveClipboard()

  // 2. 写入转录文本到剪贴板
  electron.clipboard.writeText(text)

  try {
    // 3. 短暂延迟确保剪贴板写入
    await setTimeout(150)  // lW

    // 4. 执行模拟粘贴
    await simulatePaste()

    // 5. 等待粘贴完成
    await setTimeout(700)  // uW
  } finally {
    // 6. 恢复原始剪贴板内容
    restoreClipboard(saved, text)
  }
}
```

### 6.2 剪贴板保存/恢复

系统会完整保存剪贴板的所有格式：

```javascript
function saveClipboard() {
  return {
    data: {
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: clipboard.readImage(),
      bookmark: clipboard.readBookmark().title
    },
    formats: clipboard.availableFormats().map(format => ({
      format,
      data: clipboard.readBuffer(format)
    }))
  }
}

function restoreClipboard(saved, expectedText) {
  // 检查粘贴是否成功（剪贴板文本已改变）
  if (clipboard.readText() === expectedText) {
    // 恢复所有格式
    clipboard.write(saved.data)
    let currentFormats = new Set(clipboard.availableFormats())
    for (let { format, data } of saved.formats) {
      if (!currentFormats.has(format)) {
        clipboard.writeBuffer(format, data)
      }
    }
    return true
  }
  return false
}
```

### 6.3 平台特定粘贴实现

#### macOS
```javascript
// 使用 AppleScript 模拟 Cmd+V
await execFile('/usr/bin/osascript', [
  '-e',
  'tell application "System Events" to keystroke "v" using command down'
])
```
需要 Accessibility 权限。

#### Windows
```javascript
// 使用 PowerShell SendKeys
await execFile('powershell.exe', [
  '-STA', '-NoProfile', '-NonInteractive', 
  '-ExecutionPolicy', 'Bypass',
  '-Command',
  'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')'
])
```

#### Linux 及其他
```javascript
throw Error('Global dictation paste is not supported on this OS.')
```

---

## 7. 转录历史管理

### 7.1 存储格式

历史记录存储在用户数据目录下的 `transcription-history.jsonl` 文件中：

```javascript
var BU = 'transcription-history.jsonl'
// 路径: {userData}/transcription-history.jsonl

// 数据格式 (Zod schema)
var VU = z.object({
  id: z.string(),           // UUID
  createdAtMs: z.number(),  // 时间戳 (毫秒)
  text: z.string()          // 转录文本
})
```

### 7.2 读取历史

```javascript
function HU() {
  let filePath = WU()  // 获取文件路径
  if (!existsSync(filePath)) return []

  let items = []
  for (let line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    let trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      let parsed = VU.safeParse(JSON.parse(trimmed))
      if (parsed.success) items.push(parsed.data)
    } catch {}
  }

  // 返回最近 10 条，时间倒序
  return items.slice(-10).reverse()
}
```

### 7.3 写入历史

```javascript
function UU(entry) {
  let filePath = WU()
  mkdirSync(dirname(filePath), { recursive: true })
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8')
}

function recordHistoryText(sessionId, text) {
  let trimmed = text.trim()
  if (!trimmed) return null

  let entry = {
    id: sessionId,
    createdAtMs: Date.now(),
    text: trimmed
  }
  this.recordHistory(entry)  // 写入内存 + 持久化
  return trimmed
}

function recordHistory(entry) {
  this.history.unshift(entry)  // 插入到数组头部
  this.history.splice(10)      // 只保留最近 10 条
  UU(entry)                    // 持久化
}
```

### 7.4 复制历史条目

```javascript
function copyHistoryItem(id) {
  let item = this.history.find(t => t.id === id)
  if (!item || item.text.length === 0) return false

  electron.clipboard.writeText(item.text)
  return true
}
```

---

## 8. 进程互斥锁

为防止多个 Codex 实例同时使用全局听写，系统使用文件锁：

```javascript
var GU = 1000   // 健康检查间隔 (1s)
var KU = 'codex-global-dictation-window.lock'  // 锁目录名
var qU = 'owner.json'  // 锁文件
var JU = 5000   // 锁过期时间 (5s)

function XU({ force, lockPath, onLost }) {
  let owner = {
    pid: process.pid,
    token: randomUUID()
  }

  // 1. 尝试创建锁目录
  if (!acquireLock(lockPath, force)) return null

  // 2. 写入 owner.json
  writeOwnerFile(lockPath, owner)

  // 3. 定期健康检查
  let timer = setInterval(() => {
    if (!isLockValid(lockPath, owner.token)) {
      clearInterval(timer)
      onLost()  // 锁丢失回调 → 停用全局听写
    }
  }, GU)

  timer.unref?.()

  return {
    dispose: () => {
      clearInterval(timer)
      releaseLock(lockPath, owner.token)
    }
  }
}
```

锁逻辑：
- 锁目录位于系统临时目录: `{tmpdir}/codex-global-dictation-window.lock`
- 目录内包含 `owner.json` 记录 PID 和 Token
- 每 1 秒检查一次锁有效性（Token 匹配 + 进程存活）
- 5 秒未更新的锁视为过期
- `force` 模式用于调试: 强制获取锁

---

## 9. 主控制器状态机

### 9.1 CW 类完整状态

```javascript
class GlobalDictationHotkeyController {
  // Gate 控制
  isGateEnabled = false
  
  // 强制锁（调试用）
  forceGlobalDictationLock
  
  // 配置的热键
  configuredHotkey          // Hold 热键
  configuredToggleHotkey    // Toggle 热键
  
  // 注册状态
  registeredHotkey = null
  registeredHotkeyRegistration = null
  registeredToggleHotkey = null
  registeredToggleHotkeyRegistration = null
  
  // 活跃会话
  activeSession = null      
  /*
    Session 类型:
    { type: 'overlay', id: string, mode: 'hold'|'toggle' }
    { type: 'inApp', id: string, webContentsId: number, mode: 'hold'|'toggle' }
  */
  
  // 热键释放监听器
  activeHotkeyReleaseWatcher = null
  
  // 等待 In-App 启动确认
  pendingInAppDictationStart = null
  
  // 生命周期锁
  lifecycleLock = null
  
  // 窗口控制器
  windowController
  
  // 转录历史
  history = []
  
  // 对外暴露的热键控制器接口
  hotkeyController = {
    getState: () => this.getHotkeyState(),
    setHotkey: (e) => this.setHotkey(e),
    setToggleHotkey: (e) => this.setToggleHotkey(e),
    syncCommandKeybindings: (e) => { ... },
    getHistory: () => [...this.history],
    copyHistoryItem: (e) => this.copyHistoryItem(e)
  }
}
```

### 9.2 生命周期管理

```javascript
applyLifecycleOrThrow() {
  // 1. Gate 未开启或平台不支持 → 停用
  if (!this.isGateEnabled || !TW()) {
    this.deactivateLifecycle()
    return
  }

  // 2. 没有配置热键 → 停用
  if (this.configuredHotkey == null && this.configuredToggleHotkey == null) {
    this.deactivateLifecycle()
    return
  }

  // 3. 获取进程互斥锁
  if (!this.ensureLifecycleLock()) {
    throw Error('Global dictation is already active in another Codex app.')
  }

  // 4. 注册热键
  if (this.configuredHotkey != null) {
    this.registerHotkeyOrThrow(this.configuredHotkey)
  } else {
    this.unregisterHotkey()
  }

  if (this.configuredToggleHotkey != null) {
    this.registerToggleHotkeyOrThrow(this.configuredToggleHotkey)
  } else {
    this.unregisterToggleHotkey()
  }

  // 5. 预创建浮动窗口
  this.windowController.prewarm()
}

deactivateLifecycle() {
  this.unregisterHotkey()
  this.unregisterToggleHotkey()
  if (this.activeSession != null) {
    this.stopRecording(this.activeSession.id)
  }
  this.clearHotkeyReleaseWatcher()
  this.pendingInAppDictationStart?.complete(false)
  this.clearActiveSession()
  this.windowController.close()
  this.releaseLifecycleLock()
}
```

### 9.3 Gate 开关

系统支持运行时开关听写功能：

```javascript
setGateEnabled(enabled) {
  if (this.isGateEnabled !== enabled) {
    this.isGateEnabled = enabled
    this.applyLifecycleWithWarning('gate-change')
  }
}
```

对应 IPC 消息: `global-dictation-enabled-changed`

---

## 10. IPC 消息协议

### 10.1 Renderer → Main (主进程 IPC Handler)

| 消息类型 | 参数 | 返回值 | 说明 |
|---------|------|--------|------|
| `global-dictation-hotkey-state` | 无 | `GetHotkeyStateResult` | 获取当前热键状态 |
| `global-dictation-set-hotkey` | `{ hotkey: string \| null }` | `SetHotkeyResult` | 设置 Hold 热键 |
| `global-dictation-set-toggle-hotkey` | `{ hotkey: string \| null }` | `SetHotkeyResult` | 设置 Toggle 热键 |
| `global-dictation-capture-fn-hotkey` | 无 | `{ hotkey: string \| null }` | 捕获 Fn 键 |
| `global-dictation-history` | 无 | `{ items: HistoryItem[] }` | 获取历史 |
| `global-dictation-copy-history-item` | `{ id: string }` | `{ success: boolean }` | 复制历史条目 |

### 10.2 Main → Renderer（窗口消息）

| 消息类型 | 参数 | 说明 |
|---------|------|------|
| `global-dictation-start` | `{ sessionId: string }` | 开始录音 |
| `global-dictation-stop` | `{ sessionId: string }` | 停止录音 |
| `global-dictation-in-app-start` | `{ sessionId: string }` | 应用内开始 |
| `global-dictation-in-app-stop` | `{ sessionId: string }` | 应用内停止 |

### 10.3 Renderer → Main（事件消息，通过 handleMessage）

所有事件消息类型定义在 `xW` 对象中：

```javascript
var xW = {
  "global-dictation-enabled-changed": true,
  "global-dictation-force-lock-changed": true,
  "global-dictation-window-layout": true,
  "global-dictation-recording-stopped": true,
  "global-dictation-dismiss": true,
  "global-dictation-completed": true,
  "global-dictation-record-history-item": true,
  "global-dictation-failed": true,
  "global-dictation-in-app-started": true,
}
```

| 事件类型 | 参数 | 处理逻辑 |
|---------|------|---------|
| `global-dictation-enabled-changed` | `{ enabled: boolean }` | 开关听写 Gate |
| `global-dictation-force-lock-changed` | `{ enabled: boolean }` | 设置强制锁（调试） |
| `global-dictation-window-layout` | `{ sessionId, layout }` | 切换窗口布局 (compact/error) |
| `global-dictation-recording-stopped` | `{ sessionId }` | 清除热键释放监听 |
| `global-dictation-dismiss` | `{ sessionId }` | 用户关闭 → 清除会话 + 隐藏窗口 |
| `global-dictation-completed` | `{ sessionId, text }` | 转录完成 → 粘贴文本 |
| `global-dictation-record-history-item` | `{ text }` | 记录到历史（不粘贴） |
| `global-dictation-failed` | `{ sessionId, stage }` | 错误处理; stage=`transcription` 显示错误 UI |
| `global-dictation-in-app-started` | `{ sessionId }` | In-App 启动确认 |

### 10.4 事件处理流程（handleMessage）

```javascript
async handleMessage(source, message) {
  if (!isDictationMessage(message)) return false

  // 优先级最高的两个消息 - 不受 isGateEnabled 限制
  if (message.type === 'global-dictation-enabled-changed') {
    this.setGateEnabled(message.enabled)
    return true
  }
  if (message.type === 'global-dictation-force-lock-changed') {
    this.setForceGlobalDictationLock(message.enabled)
    return true
  }

  // 以下消息需要 isGateEnabled
  if (!this.isGateEnabled) return true

  let sessionId = this.activeSession?.id

  switch (message.type) {
    case 'global-dictation-window-layout':
      // 仅当前会话可控制窗口布局
      return message.sessionId === sessionId && 
        this.windowController.setLayout(message.layout)

    case 'global-dictation-recording-stopped':
      return message.sessionId === sessionId && 
        this.clearHotkeyReleaseWatcher()

    case 'global-dictation-dismiss':
      return message.sessionId === sessionId && (
        this.clearActiveSession(),
        this.clearHotkeyReleaseWatcher(),
        this.windowController.setLayout('compact'),
        this.windowController.hide()
      )

    case 'global-dictation-completed':
      return message.sessionId === sessionId && 
        await this.handleTranscript(message.sessionId, message.text)

    case 'global-dictation-record-history-item':
      return this.recordHistoryText(randomUUID(), message.text)

    case 'global-dictation-failed':
      if (message.sessionId !== sessionId) return true
      this.clearHotkeyReleaseWatcher()
      if (message.stage === 'transcription') {
        // 转录阶段失败 → 显示错误 UI
        this.windowController.setLayout('error')
      } else {
        // 其他阶段失败 → 直接关闭
        this.clearActiveSession()
        this.windowController.hide()
      }
      return true

    case 'global-dictation-in-app-started':
      // 确认 In-App 启动
      return message.sessionId === this.pendingInAppDictationStart?.sessionId &&
        this.pendingInAppDictationStart.complete(true)
  }
}
```

---

## 11. 设置持久化

### 11.1 持久化键名

在 app-session 中的 `Nr` 枚举（settings store key）:

| 枚举键 | 持久化 Key | 说明 |
|--------|-----------|------|
| `GLOBAL_DICTATION_HOTKEY` | `globalDictationHotkey` | Hold 热键 |
| `GLOBAL_DICTATION_TOGGLE_HOTKEY` | `globalDictationToggleHotkey` | Toggle 热键 |
| `DICTATION_DICTIONARY` | `dictationDictionary` | 自定义听写词典 |
| `GLOBAL_DICTATION_FORCE_LOCK_DEBUG_ENABLED` | `global-dictation-force-lock-debug-enabled` | 调试强制锁 |

### 11.2 热键配置的存储层级

热键有两个存储位置，通过 `WE` 函数合并：

1. **Keymap 系统** (`BE` 函数读取): 存储用户通过快捷键设置界面配置的绑定
   - Command ID: `globalDictationHold` / `globalDictationToggle`
   
2. **Legacy 设置** (直接存储在 globalState): 
   - Key: `globalDictationHotkey` / `globalDictationToggleHotkey`

```javascript
// 优先级: keymap > legacy
this.configuredHotkey = WE({
  keymapHotkey: BE('globalDictationHold'),
  legacyHotkey: legacyHotkey
})
this.configuredToggleHotkey = WE({
  keymapHotkey: BE('globalDictationToggle'),
  legacyHotkey: legacyToggleHotkey
})
```

### 11.3 重复热键防护

```javascript
function wW(a, b) {
  return a != null && b != null && a === b
}

// 如果 Hold 和 Toggle 热键相同
if (wW(holdHotkey, toggleHotkey)) {
  // 清除 Toggle 热键，以 Hold 为准
  this.configuredToggleHotkey = null
  globalState.set(GLOBAL_DICTATION_TOGGLE_HOTKEY, undefined)
}
```

### 11.4 键盘布局失效标记

```javascript
function kC(hotkey) {
  // 记录热键对应的键盘布局信息
  // 用于检测键盘布局变化后的失效
}

function EW() {
  // macOS: 检查 Accessibility 权限
  if (process.platform === 'darwin') {
    systemPreferences.isTrustedAccessibilityClient(false)
  }
}
```

---

## 12. 错误处理

### 12.1 错误阶段分类

渲染进程在听写失败时发送 `global-dictation-failed` 事件，包含 `stage` 字段：

| stage | 主进程行为 |
|-------|-----------|
| `transcription` | 显示错误 UI (312px 宽度)，用户可重试或关闭 |
| 其他 (如 `recording`) | 直接隐藏窗口，清除会话 |

### 12.2 渲染进程中的错误类型（i18n key）

| i18n Key | 含义 |
|----------|------|
| `dictation.error.connection` | 网络连接错误 |
| `dictation.error.microphoneMissing` | 未检测到麦克风 |
| `dictation.error.microphonePermissionDenied` | 麦克风权限被拒绝 |
| `dictation.error.microphoneUnavailable` | 麦克风被其他应用占用 |
| `dictation.error.unsupported` | 当前设备不支持 |

### 12.3 主进程错误处理

```javascript
// bare-modifier-monitor 错误
"Bare modifier hotkey monitor needs input monitoring access"
"Bare modifier hotkey monitor failed"
"Bare modifier hotkey monitor exited"
"Bare modifier hotkey capture failed"

// 全局听写热键错误
"Shortcut key is not supported for global dictation."
"Global dictation hotkey release watching is not supported."
"Unable to register global dictation hotkey: {hotkey}"
"Unable to register global dictation toggle hotkey: {hotkey}"
"Hold and toggle dictation hotkeys must be different."
"Global dictation is already active in another Codex app."
"Failed to watch global dictation hotkey release"
"Failed to open global dictation window"
"Failed to create global dictation window"

// 粘贴错误
"Accessibility permission is required to paste global dictation."
"Global dictation paste failed"
"Global dictation paste is not supported on this OS."

// 历史错误
"Failed to read global dictation history"
"Failed to write global dictation history"
```

---

## 13. i18n 国际化

### 13.1 渲染进程 UI 字符串

| i18n Key | 说明 |
|----------|------|
| `globalDictation.listening` | 正在听... |
| `globalDictation.transcribing` | 转写中... |
| `globalDictation.retry` | 重试 |
| `globalDictation.dismissError` | 关闭错误提示 |
| `globalDictation.waveformAriaLabel` | 全局听写波形（无障碍标签） |
| `dictation.error.connection` | 连接错误，请检查网络 |
| `dictation.error.microphoneMissing` | 请连接麦克风 |
| `dictation.error.microphonePermissionDenied` | 请允许麦克风权限 |
| `dictation.error.microphoneUnavailable` | 麦克风被其他应用占用 |
| `dictation.error.unsupported` | 此设备不支持语音输入 |

（注: 英文原文可能嵌入在 React 组件中作为 fallback，`comment-preload.js` 中仅包含非英文翻译，已确认支持 63+ 种语言）

### 13.2 特殊说明

`comment-preload.js` 中的 i18n 键为 Amharic（阿姆哈拉语）等非拉丁语言作为翻译值，英文版本作为默认 fallback 直接嵌入 React 组件源码中。该文件包含约 63 种语言的翻译数据。

---

## 14. 应用启动初始化

### 14.1 构造函数

```javascript
constructor(options) {
  this.options = options
  this.windowController = new RecorderWindowController(options.windowManager)

  // 读取强制锁配置（调试用）
  this.forceGlobalDictationLock = 
    options.canForceGlobalDictationLock === true && 
    (options.forceGlobalDictationLock === true || 
     options.globalState.get(GLOBAL_DICTATION_FORCE_LOCK_DEBUG_ENABLED) === true)

  // 加载历史
  this.history.push(...HU())

  // 加载配置热键 (keymap + legacy)
  let legacyHotkey = options.globalState.get(GLOBAL_DICTATION_HOTKEY)
  let legacyToggleHotkey = options.globalState.get(GLOBAL_DICTATION_TOGGLE_HOTKEY)
  let keymapHotkey = getKeymapBinding('globalDictationHold')
  let keymapToggleHotkey = getKeymapBinding('globalDictationToggle')

  this.configuredHotkey = mergeHotkeyConfig(keymapHotkey, legacyHotkey)
  this.configuredToggleHotkey = mergeHotkeyConfig(keymapToggleHotkey, legacyToggleHotkey)

  // 去重
  if (areSameHotkeys(this.configuredHotkey, this.configuredToggleHotkey)) {
    this.configuredToggleHotkey = null
  }

  // 应用生命周期
  this.applyLifecycleWithWarning('startup')
}
```

### 14.2 应用菜单更新

```javascript
// 热键变化时更新应用菜单
"set-codex-command-keybinding": async ({ commandId, update }) => {
  let result = await updateKeymap(commandId, update)

  if (commandId === 'globalDictationHold' || commandId === 'globalDictationToggle') {
    this.globalDictationHotkeyController.syncCommandKeybindings({
      holdHotkey: getHotkeyFromResult('globalDictationHold', result),
      toggleHotkey: getHotkeyFromResult('globalDictationToggle', result)
    })
  }

  this.refreshApplicationMenu()
  return result
}
```

### 14.3 权限请求

在 macOS 上，应用启动时通过 IPC `electron-request-microphone-permission` 触发麦克风权限请求：

```javascript
case 'electron-request-microphone-permission':
  if (process.platform !== 'darwin') break
  try {
    await systemPreferences.askForMediaAccess('microphone')
  } catch (error) {
    logger.error('Microphone permission request failed', { error })
  }
  break
```

---

## 15. 完整消息流时序

### 15.1 Hold 模式 (Push-to-Talk)

```
User                  Main Process             Renderer (Overlay)        Target App
 |                        |                          |                       |
 |--Press Hotkey--------->|                          |                       |
 |                        |--handleHoldHotkeyPressed |                       |
 |                        |--ensureWindow()--------->|                       |
 |                        |<--window ready-----------|                       |
 |                        |--global-dictation-start->|                       |
 |                        |--watchHoldHotkeyRelease  |                       |
 |                        |                          |--[Audio Capture]----->|
 |                        |                          |--[Stream to API]      |
 |                        |                          |                       |
 |--Release Hotkey------->|                          |                       |
 |                        |--stopRecording()-------->|                       |
 |                        |  (global-dictation-stop) |                       |
 |                        |                          |--[Finalize audio]     |
 |                        |                          |--[Wait transcription] |
 |                        |<--global-dictation-      |                       |
 |                        |   completed--------------|                       |
 |                        |--handleTranscript()      |                       |
 |                        |--fW(text) paste--------->|                       |--Cmd+V
 |                        |--hide window             |                       |
```

### 15.2 Toggle 模式

```
User                  Main Process             Renderer (Overlay)        Target App
 |                        |                          |                       |
 |--Press Hotkey--------->|                          |                       |
 |                        |--handleToggleHotkeyPressed|                      |
 |                        |                          |                       |
 |  [ActiveSession==null] |                          |                       |
 |                        |--startSession('toggle')->|                       |
 |                        |--global-dictation-start->|                       |
 |                        |                          |--[Recording...]       |
 |                        |                          |                       |
 |--Press Hotkey Again--->|                          |                       |
 |                        |--handleToggleHotkeyPressed|                      |
 |                        |                          |                       |
 |  [ActiveSession!=null] |                          |                       |
 |  [mode=='toggle']      |                          |                       |
 |                        |--stopRecording()-------->|                       |
 |                        |                          |--[Finish & transcribe]|
 |                        |<--completed--------------|                       |
 |                        |--paste text--------------|---------------------->|
```

---

## 16. 关键代码路径索引

### 16.1 主进程文件 (main-kSlb32Yb.js)

| 偏移量 | 内容 |
|--------|------|
| 340500-341500 | `$S` bare-modifier-monitor 路径常量, `eC` 活跃集合, `tC` 修饰键映射 |
| 341500-343000 | `rC` bare modifier 注册, `iC`/`aC` 捕获函数, `oC` 权限请求 |
| 343000-344500 | `sC` 释放监听创建, `cC` 检测, `mC` spawn 二进制, `hC` 释放模式 spawn |
| 344500-346000 | `_C` 行读取, `vC`/`yC` 二进制路径查找, `TC` 全局热键注册入口 |
| 348500-350000 | `LC` 听写热键校验, `RC` Windows 释放监听, `zC`/`BC`/`VC`/`HC` 辅助函数 |
| 406900-409000 | IPC Handler: hotkey state, set-hotkey, set-toggle-hotkey, capture-fn, history, copy-history, keymap |
| 438100-438300 | `eO` 快捷键绑定校验 (只允许 set/replace, 不允许 append) |
| 748400-749000 | 事件交换机: global-dictation-* 事件名称列表 |
| 749000-749500 | 麦克风权限请求 |
| 914200-914600 | `BU` 历史文件路径, `VU` 数据 schema, `HU` 读取历史 |
| 914600-915000 | `UU` 写入历史, `WU` 文件路径计算 |
| 915000-916300 | `XU`/`ZU`/`QU`/`$U` 进程互斥锁 |
| 916300-917900 | `fW` 粘贴函数, `pW` 保存剪贴板, `mW` 恢复剪贴板, `gW` 模拟粘贴 |
| 917800-920100 | `bW` RecorderWindowController 类 (窗口管理) |
| 919800-920200 | `xW` 事件类型白名单, `CW` GlobalDictationHotkeyController 类声明 |
| 920200-922000 | CW 构造函数, `getHotkeyController`, `handleMessage` 开始 |
| 922000-924000 | `handleMessage` 事件处理, `dispose`, `getHotkeyState`, `setHotkey` |
| 924000-926000 | `applyLifecycleOrThrow`, `applyLifecycleWithWarning`, `setGateEnabled`, `setForceGlobalDictationLock`, `syncCommandKeybindings` |
| 926000-928000 | `deactivateLifecycle`, `ensureLifecycleLock`, `registerHotkeyOrThrow`, `handleHoldHotkeyPressed`, `handleToggleHotkeyPressed`, `startSession` |
| 928000-930000 | `tryStartInAppSession`, `waitForInAppDictationStart`, `watchHoldHotkeyRelease`, `stopRecording` |
| 930000-931000 | `handleHoldHotkeyReleased`, `clearHotkeyReleaseWatcher`, `clearActiveSession`, `handleTranscript`, `recordHistoryText`, `recordHistory`, `copyHistoryItem` |
| 931000-931500 | `wW` 重复检查, `TW` 平台支持, `EW` 权限检查, `DW` 消息类型检查 |

### 16.2 渲染进程文件 (app-session-O7kcZj7R.js)

| 偏移量 | 内容 |
|--------|------|
| 2300-2450 | `Nr` 枚举: GLOBAL_DICTATION_HOTKEY, GLOBAL_DICTATION_TOGGLE_HOTKEY, DICTATION_DICTIONARY |
| 235500-235800 | `wn` 枚举: GLOBAL_DICTATION_FORCE_LOCK_DEBUG_ENABLED, REALTIME_VOICE_MODE_DEBUG_DISABLED |
| 274444-274460 | `ly` 路由常量 = `/global-dictation` |

### 16.3 国际化文件 (comment-preload.js)

| 偏移量 | 内容 |
|--------|------|
| 360497-360850 | 第一个 locale (Amharic) 的 dictation.error.* 翻译 |
| 410225-410500 | 第一个 locale 的 globalDictation.* 翻译 |
| (63+ locale blocks) | 每个约 500KB 的 locale bundle |

### 16.4 原生二进制 (bare-modifier-monitor)

| 文件路径 | 说明 |
|---------|------|
| `/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor` | arm64 Swift 二进制，154KB |

---

## 17. 安全与权限考量

1. **Input Monitoring 权限** (macOS): `bare-modifier-monitor` 需要此权限来监控全局修饰键。系统会通过 `--request-permission` 参数触发权限请求对话框。

2. **Accessibility 权限** (macOS): 粘贴功能使用 `osascript` 模拟 Cmd+V 需要此权限。代码通过 `systemPreferences.isTrustedAccessibilityClient()` 检查。

3. **麦克风权限** (macOS): 通过 `systemPreferences.askForMediaAccess('microphone')` 请求。

4. **进程互斥**: 使用文件锁防止多个 Codex 实例同时使用全局听写。

5. **剪贴板保护**: 粘贴操作前保存剪贴板全部格式，操作后恢复，确保不破坏用户剪贴板数据。

6. **会话 ID 校验**: 所有消息处理都会校验 sessionId 是否匹配当前活跃会话，防止过期消息干扰。

7. **Gate 开关**: 支持运行时禁用全局听写功能。

---

## 18. 重构代码（TypeScript 伪代码）

### 18.1 核心接口

```typescript
// 会话类型
type DictationSession = {
  type: 'overlay' | 'inApp'
  id: string
  mode: 'hold' | 'toggle'
  webContentsId?: number  // inApp 模式特有
}

// 热键状态
interface HotkeyState {
  supported: boolean
  configuredHotkey: string | null
  configuredToggleHotkey: string | null
}

// 设置结果
interface SetHotkeyResult {
  success: boolean
  error?: string
  state: HotkeyState
}

// 历史条目
interface HistoryItem {
  id: string
  createdAtMs: number
  text: string
}

// BareModifier 触发模式
type BareModifierTrigger = 'press' | 'release' | 'immediatePress'

// 窗口布局
type WindowLayout = 'compact' | 'error'
```

### 18.2 GlobalDictationHotkeyController 伪代码

```typescript
class GlobalDictationHotkeyController {
  private isGateEnabled = false
  private forceGlobalDictationLock: boolean
  private configuredHotkey: string | null
  private configuredToggleHotkey: string | null
  private registeredHotkey: string | null = null
  private registeredHotkeyRegistration: HotkeyRegistration | null = null
  private registeredToggleHotkey: string | null = null
  private registeredToggleHotkeyRegistration: HotkeyRegistration | null = null
  private activeSession: DictationSession | null = null
  private activeHotkeyReleaseWatcher: ReleaseWatcher | null = null
  private pendingInAppDictationStart: PendingConfirmation | null = null
  private lifecycleLock: ProcessLock | null = null
  private windowController: RecorderWindowController
  private history: HistoryItem[] = []

  constructor(private options: ControllerOptions) {
    this.windowController = new RecorderWindowController(options.windowManager)
    this.forceGlobalDictationLock = this.resolveForceLock()
    this.history.push(...loadHistory())
    this.loadHotkeyConfig()
    this.applyLifecycleWithWarning('startup')
  }

  // 加载热键配置 (keymap > legacy)
  private loadHotkeyConfig(): void

  // 生命周期
  private applyLifecycleOrThrow(): void
  private applyLifecycleWithWarning(reason: string): void
  private deactivateLifecycle(): void

  // 进程锁
  private ensureLifecycleLock(): boolean
  private releaseLifecycleLock(): void

  // 热键注册
  private registerHotkeyOrThrow(hotkey: string): void
  private unregisterHotkey(): void
  private registerToggleHotkeyOrThrow(hotkey: string): void
  private unregisterToggleHotkey(): void

  // 热键事件处理
  private async handleHoldHotkeyPressed(): Promise<void>
  private async handleToggleHotkeyPressed(): Promise<void>
  private handleHoldHotkeyReleased(): void

  // 会话管理
  private async startSession(mode: 'hold' | 'toggle'): Promise<void>
  private async tryStartInAppSession(
    window: BrowserWindow, mode: 'hold' | 'toggle'
  ): Promise<boolean>
  private stopRecording(sessionId: string): void
  private clearActiveSession(): void

  // 转录处理
  private async handleTranscript(sessionId: string, text: string): Promise<void>

  // 历史管理
  private recordHistoryText(sessionId: string, text: string): string | null
  private recordHistory(entry: HistoryItem): void
  copyHistoryItem(id: string): boolean

  // 消息处理入口
  async handleMessage(source: any, message: DictationMessage): Promise<boolean>

  // 公共 API
  getHotkeyState(): HotkeyState
  setHotkey(hotkey: string | null): SetHotkeyResult
  setToggleHotkey(hotkey: string | null): SetHotkeyResult
  syncCommandKeybindings(bindings: {
    holdHotkey: string | null
    toggleHotkey: string | null
  }): void
  getHistory(): HistoryItem[]
  dispose(): void
}
```

### 18.3 RecorderWindowController 伪代码

```typescript
class RecorderWindowController {
  private recorderWindowId: number | null = null
  private recorderWindowPromise: Promise<BrowserWindow | null> | null = null

  constructor(private windowManager: WindowManager) {}

  prewarm(): void
  async showAndStart(sessionId: string): Promise<boolean>
  sendStop(sessionId: string): void
  setLayout(layout: WindowLayout): void
  hide(): void
  close(): void
  getFocusedInAppWindow(): BrowserWindow | null
  private async ensureWindow(): Promise<BrowserWindow | null>
  private async createWindow(): Promise<BrowserWindow | null>
  private getWindow(): BrowserWindow | null
}
```

### 18.4 BareModifierMonitor 集成伪代码

```typescript
const BINARY_NAME = 'bare-modifier-monitor'

// 修饰键映射
const MODIFIER_KEY_MAP = new Map([
  ['fn', 'Fn'],
  ['leftoption', 'LeftOption'],
  ['leftalt', 'LeftOption'],
  ['rightoption', 'RightOption'],
  ['leftcommand', 'LeftCommand'],
  ['leftmeta', 'LeftCommand'],
  ['rightcommand', 'RightCommand'],
  ['rightmeta', 'RightCommand'],
  ['doublecommand', 'DoubleCommand'],
  ['leftcontrol', 'LeftControl'],
])

// 查找二进制路径
function findNativeBinary(): string | null {
  const searchPaths = [
    path.join(process.resourcesPath, 'native', BINARY_NAME),
    path.join(app.getAppPath(), 'native', BINARY_NAME, 
              'build', `Release-${process.arch}`, BINARY_NAME),
  ]
  for (const p of searchPaths) {
    if (existsSync(p)) return p
  }
  return null
}

// 启动按键监控
function spawnKeyMonitor(
  binaryPath: string, key: string, 
  options?: { immediate?: boolean; trigger?: BareModifierTrigger }
): ChildProcess {
  const args = ['--key', key]
  if (options?.immediate || options?.trigger === 'immediatePress') {
    args.push('--immediate')
  } else if (options?.trigger === 'release') {
    args.push('--trigger-on-release')
  }
  return spawn(binaryPath, args, { stdio: ['pipe', 'pipe', 'ignore'] })
}

// 注册 bare modifier 热键
function registerBareModifier(
  key: string, callbacks: { onPressed: () => void; onReleased?: () => void },
  trigger: BareModifierTrigger = 'press'
): HotkeyRegistration | null {
  if (process.platform !== 'darwin') return null
  
  const nativeKey = MODIFIER_KEY_MAP.get(normalizeKey(key))
  if (!nativeKey) return null
  
  const binaryPath = findNativeBinary()
  if (!binaryPath) return null
  
  const monitor = spawnKeyMonitor(binaryPath, nativeKey, { trigger })
  
  // 解析 stdout 行
  parseLines(monitor, (line) => handleMonitorLine(line, callbacks))
  
  // 错误处理
  monitor.once('error', (err) => logError(err))
  monitor.once('exit', () => cleanup(key))
  
  return {
    handlesRelease: true,
    unregister: () => {
      monitor.kill()
      cleanup(key)
    }
  }
}
```

### 18.5 全局粘贴伪代码

```typescript
async function pasteText(text: string): Promise<void> {
  // 1. 保存剪贴板
  const saved = saveClipboard()
  
  // 2. 写入文本
  electron.clipboard.writeText(text)
  
  try {
    // 3. 等待剪贴板就绪
    await sleep(150)
    
    // 4. 模拟粘贴
    await simulatePaste()
    
    // 5. 等待粘贴完成
    await sleep(700)
  } finally {
    // 6. 恢复剪贴板
    restoreClipboard(saved, text)
  }
}

async function simulatePaste(): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      // 检查 Accessibility 权限
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        throw new Error('Accessibility permission is required')
      }
      // osascript 模拟 Cmd+V
      await execFile('/usr/bin/osascript', [
        '-e',
        'tell application "System Events" to keystroke "v" using command down'
      ])
      break
    case 'win32':
      // PowerShell SendKeys
      await execFile('powershell.exe', [
        '-STA', '-NoProfile', '-NonInteractive',
        '-ExecutionPolicy', 'Bypass', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "[System.Windows.Forms.SendKeys]::SendWait('^v')"
      ])
      break
    default:
      throw new Error('Not supported on this OS')
  }
}
```

---

## 19. 总结

Codex 的语音输入系统是一个精心设计的跨平台全局听写解决方案，核心特点包括：

1. **双模式热键**：支持 Hold（PTT）和 Toggle 两种操作模式，适配不同使用场景
2. **原生级按键监控**：通过 `bare-modifier-monitor` Swift 原生二进制，实现对 Fn、Option、Command 等纯修饰键的全局监控，突破了 Electron 的限制
3. **双会话模式**：Overlay 浮动窗口模式适用于在任意应用中输入，In-App 模式适用于 Codex 内部
4. **安全的剪贴板操作**：粘贴前完整保存剪贴板，粘贴后恢复，不破坏用户数据
5. **进程互斥**：文件锁机制防止多实例冲突
6. **完整的历史管理**：JSONL 格式持久化，保留最近 10 条，支持复制
7. **Gate 控制**：支持运行时开/关，无需重启
8. **全面的权限管理**：macOS 上的 Input Monitoring、Accessibility、Microphone 三项权限的请求和检查

**平台支持**：macOS 完整支持，Windows 基本支持，Linux 不支持。

**关键文件**：
- `/tmp/claude-501/codex-extracted/.vite/build/main-kSlb32Yb.js` - 主进程逻辑
- `/tmp/claude-501/codex-extracted/.vite/build/app-session-O7kcZj7R.js` - 渲染进程路由和设置
- `/tmp/claude-501/codex-extracted/.vite/build/comment-preload.js` - 63+ 语言 i18n
- `/Applications/Codex.app/Contents/Resources/native/bare-modifier-monitor` - macOS 原生按键监控
