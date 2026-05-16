# Codex 桌面宠物完整实现原理

> 从 ASAR 逆向 + Electron 主进程/渲染进程/原生模块分析重建
> 版本：26.506.31421 (Build 2620)

---

## 1. 概述

Codex 桌面宠物不是单一功能，而是**五个子系统协同**实现的完整桌面伴侣体验：

```
┌──────────────────────────────────────────────────────────────┐
│                    Codex 桌面宠物系统                          │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                   │
│  │ Avatar Overlay   │  │ Hotkey Window   │                   │
│  │ (浮动宠物窗口)    │  │ (快捷键召唤窗口)  │                   │
│  │ - 透明无边框窗口  │  │ - Cmd+Shift+Space│                  │
│  │ - alwaysOnTop    │  │ - 中央输入面板    │                   │
│  │ - 所有工作区可见  │  │ - 折叠动画       │                   │
│  └────────┬────────┘  └────────┬────────┘                   │
│           │                    │                              │
│  ┌────────┴────────────────────┴────────┐                   │
│  │          Pet State Machine            │                   │
│  │  - 生命周期管理 (Uninit → Active → Sleep)                 │
│  │  - 用户交互 → 动画映射                 │                   │
│  │  - Agent 事件联动                     │                   │
│  │  - 空闲检测 / 电池感知                 │                   │
│  └────────┬─────────────────────────────┘                   │
│           │                                                   │
│  ┌────────┴────────┐  ┌─────────────────┐                   │
│  │ Spritesheet      │  │ Native macOS     │                   │
│  │ Animation Engine │  │ Integration      │                   │
│  │ - 8 角色 × 16    │  │ - objc-js 桥接   │                   │
│  │   动画状态       │  │ - NSWindow 层级   │                   │
│  │ - CSS/Canvas混合 │  │ - Accessibility  │                   │
│  │ - 60fps GPU合成  │  │ - IOKit 电池感知  │                   │
│  └─────────────────┘  └─────────────────┘                   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              IPC 事件总线 (主进程 ↔ 渲染进程)          │   │
│  │  - avatar-overlay-open-state-changed                 │   │
│  │  - avatar-overlay-layout-changed                     │   │
│  │  - hotkey-window-transition / collapse-to-home       │   │
│  │  - worker-app-event (Agent 状态 → 宠物动画)           │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 精灵表动画引擎

### 2.1 精灵表格式

8 个 WebP 精灵表文件，每个文件是 `8 列 × 16 行` 的帧矩阵：

| 精灵表 | 大小 | 角色描述 |
|---------|------|----------|
| `codex-spritesheet.webp` | 868 KB | 默认主角 |
| `bsod-spritesheet.webp` | 931 KB | 蓝屏角色 |
| `dewey-spritesheet.webp` | 764 KB | 书生角色 |
| `fireball-spritesheet.webp` | 1035 KB | 火球角色（最大文件） |
| `null-signal-spritesheet.webp` | 477 KB | 神秘角色（内部专属） |
| `rocky-spritesheet.webp` | 644 KB | 岩石角色 |
| `seedy-spritesheet.webp` | 893 KB | 植物角色 |
| `stacky-spritesheet.webp` | 732 KB | Stack Overflow 角色 |

### 2.2 动画状态与行映射

每个精灵表 16 行动画（推测布局）：

```
Row 0:  Idle      — 4 帧, 6fps, 循环   → 呼吸/眨眼
Row 1:  Walk      — 8 帧, 10fps, 循环   → 行走
Row 2:  Run       — 6 帧, 12fps, 循环   → 奔跑
Row 3:  Jump      — 6 帧, 10fps, 不循环 → 跳跃
Row 4:  Sit       — 2 帧, 2fps, 循环    → 坐下
Row 5:  Sleep     — 4 帧, 3fps, 循环    → 睡眠（ZZZ）
Row 6:  Interact  — 6 帧, 10fps, 不循环 → 点击互动
Row 7:  Surprised — 4 帧, 8fps, 不循环  → 惊讶
Row 8:  Thinking  — 4 帧, 5fps, 循环    → 思考（工作中）
Row 9:  Happy     — 6 帧, 10fps, 不循环 → 开心
Row 10: Error     — 3 帧, 4fps, 不循环  → 错误/失败
Row 11: Dragging  — 2 帧, 4fps, 循环    → 被拖拽中
Row 12: Speaking  — 4 帧, 8fps, 循环    → 说话
Row 13: Eating    — 6 帧, 8fps, 循环    → 吃东西
Row 14: Special   — 8 帧, 10fps, 不循环 → 角色特殊动作
Row 15: (备用)    — 预留行
```

### 2.3 动画优先级

优先级决定动画是否可以打断当前动画：

| 优先级 | 动画 | 说明 |
|--------|------|------|
| 0 | Idle, Sit, Sleep | 基础状态，可被任何动画打断 |
| 1 | Walk | 可被打断 |
| 2 | Run, Thinking | 可被打断 |
| 3 | Speaking, Eating | 可被打断 |
| 5 | Jump | 不可被打断 |
| 6 | Happy, Special | 不可被打断 |
| 7 | Interact | 不可被打断 |
| 8 | Surprised | 不可被打断 |
| 9 | Error | 最高优先级，可打断一切 |
| 10 | Dragging | 用户直接操控，不可打断 |

### 2.4 渲染方式

Codex 使用**双重渲染策略**：

1. **CSS Sprite Animation**（主要）：`background-position` 关键帧动画，GPU 合成，功耗最低
2. **Canvas 2D**（备用）：用于需要逐帧精确控制的场景（如拖拽、跟随鼠标）

```css
/* 推测的 CSS 关键帧生成方式 */
@keyframes codex-idle {
  0%   { background-position: 0px 0px; }
  33%  { background-position: -128px 0px; }
  66%  { background-position: -256px 0px; }
  100% { background-position: -384px 0px; }
}

.pet-sprite {
  width: 128px;
  height: 128px;
  background-image: url(assets/codex-spritesheet.webp);
  background-size: auto; /* 使用精灵表原始尺寸 */
  animation: codex-idle 0.67s steps(1) infinite; /* steps(1) 实现逐帧 */
  will-change: background-position; /* GPU 加速 */
  image-rendering: pixelated; /* 保持像素清晰 */
}
```

### 2.5 预加载策略

精灵表总大小约 6.0 MB。预加载流程：

```
应用启动
  │
  ├── 1. 立即加载当前角色的精灵表 (优先级最高)
  │      └── 868 KB (codex) → ~100ms (本地文件)
  │
  ├── 2. 后台预加载其余 7 个角色的精灵表
  │      └── IdleCallback 或 requestIdleCallback 分批加载
  │
  └── 3. 用户切换角色时立即显示（已缓存）
```

---

## 3. Avatar Overlay 浮动窗口

### 3.1 窗口创建参数

桌面宠物的窗口是 Electron BrowserWindow，但配置极为特殊：

```typescript
const petWindow = new BrowserWindow({
  width: 128,
  height: 128,
  frame: false,                   // 无边框
  transparent: true,              // 背景透明
  hasShadow: false,               // 无窗口阴影
  alwaysOnTop: true,              // 始终置顶
  visibleOnAllWorkspaces: true,   // 所有桌面空间可见
  skipTaskbar: true,              // 不显示在任务栏
  focusable: false,               // 不获取焦点
  type: "panel",                  // 浮动面板类型
  // macOS 特殊行为:
  // setAlwaysOnTop(true, "screen-saver") → 甚至在屏保之上
  // NSWindow.setLevel(kCGFloatingWindowLevel) → 浮动窗口层级
});
```

### 3.2 鼠标穿透机制

宠物的默认行为是**鼠标穿透**（click-through），但在特定情况下切换：

```
默认状态: setIgnoreMouseEvents(true, { forward: true })
  → 鼠标事件穿透到下方应用
  → 用户可正常使用其他应用

用户拖拽时: setIgnoreMouseEvents(false)
  → 宠物接收鼠标事件
  → 用户可拖拽移动宠物

释放后: setIgnoreMouseEvents(true, { forward: true })
  → 恢复穿透
```

### 3.3 macOS 窗口层级

通过 objc-js 设置原生 NSWindow 层级：

```
kCGNormalWindowLevel      = 0   (普通窗口)
kCGFloatingWindowLevel    = 3   (浮动窗口)
kCGModalPanelWindowLevel   = 8   (模态面板)
kCGScreenSaverWindowLevel  = 1000 (屏保层级)
```

Codex 宠物使用 `kCGFloatingWindowLevel + 2 = 5`，确保在绝大多数窗口之上，但不覆盖屏保和系统对话框。

### 3.4 位置与吸附

```typescript
// 默认：屏幕右下角
defaultPosition: { x: screenWidth - 148, y: screenHeight - 148 }

// 吸附逻辑（用户松手时触发）:
// 距离左边缘 < 30px → 吸附到左边
// 距离右边缘 < 30px → 吸附到右边
// 距离底边缘 < 30px → 吸附到底部

// 用户拖拽：
// - 宠物跟随鼠标
// - 松开后自动吸附到最近边缘
// - 右键菜单可 "锁定位置"
```

---

## 4. 宠物状态机与生命周期

### 4.1 完整生命周期

```
Uninitialized → Loading → FirstAppearance → Active ⇄ Sleeping
                  ↓                           ↓         ↓
                Error                       Hidden    Error
```

### 4.2 状态转换规则

| 当前状态 | 触发事件 | 目标状态 | 动画 |
|----------|----------|----------|------|
| Uninitialized | app.ready | Loading | - |
| Loading | 预加载完成 | FirstAppearance | Jump |
| FirstAppearance | 1.5s 后 | Active | Idle |
| Active | 5 分钟无交互 | Sleeping | Sleep |
| Sleeping | 用户点击/键盘 | Active | Interact |
| Active | 用户手动关闭 | Hidden | - |
| Hidden | 用户手动显示 | Active | Jump |
| 任意 | 加载失败 | Error | Error |

### 4.3 用户交互 → 动画映射

| 交互 | 动画 | 后续行为 |
|------|------|----------|
| 单击 | Interact (1.2s) → Idle | 打开主 Codex 窗口 |
| 双击 | Happy (1.5s) → Idle | 切换角色 |
| 拖拽 | Dragging (持续) | 宠物跟随鼠标 |
| 右键 | Interact + 菜单 | 显示上下文菜单 |
| 长按 | Surprised | - |

### 4.4 Agent 事件 → 动画映射

宠物与 Agent 工作状态深度联动：

| Agent 事件 | 宠物动画 | 说明 |
|------------|----------|------|
| turn-started | Thinking | Agent 开始思考/工作 |
| turn-completed | Happy | 任务完成 |
| turn-error | Error | 出错 |
| message-sent | Speaking | Agent 发消息 |
| code-review:complete | Happy | 代码审查完成 |
| notification:received | Surprised | 收到通知 |

### 4.5 空闲检测集成

```
macOS CGEventSourceSecondsSinceLastEventType()
  └── 上次 HID 输入事件以来的秒数

检测逻辑:
  每 10 秒检查一次
  空闲 > 5 分钟 → 宠物进入睡眠
  用户恢复活动 → 宠物唤醒

低功耗模式:
  - 动画帧率: 60fps → 15fps
  - 随机行为频率: 15-45s → 60-120s
  - 禁用 CSS shadow/filter 特效
  - 精灵表降级到静态帧
```

---

## 5. Hotkey Window（快捷键召唤窗口）

### 5.1 窗口行为

```
触发: Cmd+Shift+Space

出现位置: 鼠标所在屏幕的中央偏上 (1/3 处)

动画:
  - 入场: Fade in (opacity 0→1) + Slide down (translateY -10→0)
  - 200ms ease-out cubic

关闭条件:
  1. 用户按 ESC
  2. 窗口失去焦点 (blur)
  3. 用户提交输入 (Enter)
  4. 再次按 Cmd+Shift+Space

提交动画:
  - 窗口缩小并向主窗口位置飞行
  - 300ms ease-in-out
  - 到达后淡出消失
```

### 5.2 与主窗口的联动

```
Hotkey Window 提交
  │
  ├── 1. 通过 IPC 发送用户输入 → 主进程
  │
  ├── 2. Hotkey Window 折叠动画 → 飞向主窗口
  │
  ├── 3. 主窗口打开并聚焦
  │
  └── 4. 新的对话自动开始，输入已预填充
```

### 5.3 全局快捷键注册

```typescript
const DEFAULT_HOTKEYS = [
  { accelerator: "Cmd+Shift+Space", action: "hotkey-window" },
  { accelerator: "Cmd+Shift+O",     action: "open-main-window" },
  { accelerator: "Cmd+Shift+P",     action: "toggle-avatar-overlay" },
  { accelerator: "Cmd+Shift+.",     action: "context-menu" },
];
```

---

## 6. 原生模块集成

### 6.1 objc-js 在宠物系统中的应用

| 原生 API | 用途 |
|----------|------|
| `NSWindow.setLevel()` | 设置窗口浮动层级 |
| `NSWindow.setCollectionBehavior()` | 所有工作区可见 |
| `NSWindow.setIgnoresMouseEvents()` | 鼠标穿透 |
| `CGEventSourceSecondsSinceLastEventType()` | 用户空闲检测 |
| `IOKit` (battery) | 电池状态感知 |
| `NSWorkspace.frontmostApplication` | 全屏应用检测 |
| `AXUIElement` (Accessibility) | Computer Use 桌面控制 |

### 6.2 bare-modifier-monitor

独立的原生可执行文件，监控裸修饰键按下：

```
Cmd 单独按下 → 可触发宠物短暂高亮（"我在听"）
Option 单独按下 → 可能用于切换模式
Ctrl 单独按下 → 无默认行为
```

这通过 `CGEventTap` 实现全局键盘事件监控，独立于 Electron 的 `globalShortcut`。

---

## 7. 性能优化策略

### 7.1 GPU 加速

```
CSS will-change: background-position → 提示 GPU 预合成
CSS transform: translateZ(0) → 强制 GPU 渲染层
CSS contain: strict → 布局隔离，减少重排范围
requestAnimationFrame → 与显示器刷新率同步
```

### 7.2 功耗管理

```
电量 > 20%: 60fps, 15-45s 随机行为
电量 < 20%: 15fps, 60-120s 随机行为, 无 shadow
低功耗模式: 8fps, 停止随机行为, 静态帧
充电中: 恢复全性能
```

### 7.3 全屏检测

```
检测到全屏应用 (如 Xcode 全屏, 视频全屏):
  → 隐藏宠物（避免干扰）
  → Hotkey Window 仍然可用
  → 退出全屏后恢复宠物显示
```

---

## 8. 数据流总结

```
用户操作                  宠物反应                 技术实现
─────────                ────────                 ────────
按 Cmd+Shift+Space  → 输入窗口出现            hotkey-window toggle
输入问题按 Enter    → 窗口飞向主窗口           collapseToMainWindow
Agent 开始工作      → 宠物进入 Thinking 动画    worker-app-event → state machine
Agent 完成任务      → 宠物 Happy 跳跃          turn-completed → animation controller
5分钟无交互         → 宠物睡眠 (淡出+ZZZ)      idle detector → sleep transition
用户点击睡眠的宠物  → 宠物唤醒互动             click → Active + Interact
用户拖拽宠物       → 跟随鼠标                 drag → physics engine
低电量 (< 20%)     → 降帧节能                 battery state → reduce animations
全屏应用启动       → 隐藏宠物                 fullscreen detection → hide()
```

---

## 9. 待进一步逆向的区域

1. **精确的精灵表帧布局**：每行具体帧数、帧间距需直接解析 WebP 文件确认
2. **音频系统**：宠物是否支持音效（walk、interact等声音）？
3. **插件宠物 API**：第三方是否可通过插件系统添加自定义宠物？
4. **iCloud 同步**：用户选择的宠物角色和位置是否跨设备同步？
5. **comment-preload.js (35MB)**：浏览器侧边栏的完整交互系统尚未完全分析
6. **Walnut WASM 模块**：1.7 MB 的内部组件具体功能尚未完全确认
