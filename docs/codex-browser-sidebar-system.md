# Codex Browser Sidebar / Comment Overlay 系统逆向分析

## 概述

Codex 桌面应用的浏览器侧边栏（Browser Sidebar）是一个复杂的双进程系统，负责在嵌入式浏览器中提供**评论模式（Comment Mode）**和**浏览器自动化（Browser Use）**功能。系统由两个主要部分组成：

1. **主进程（Main Process）**：`main-kSlb32Yb.js` - 管理窗口生命周期、评论 CRUD、截图捕获、overlay 定位
2. **预加载进程（Preload）**：`comment-preload.js`（35MB）- React 应用，运行在 Shadow DOM 中，负责 UI 渲染和用户交互

---

## 一、架构总览

### 1.1 类层次结构

```
SidebarManager (Zz 类)                 -- 主宿主类，管理所有子系统
  ├── browserSidebarManager (uR 类)    -- 浏览器侧边栏核心管理器
  │   ├── comments (Tk 类)             -- 评论 CRUD 控制器
  │   ├── overlayManager (GO 类)       -- 评论悬浮窗管理器
  │   └── emptyPageLocalServers (aM 类) -- 本地开发服务器发现
  ├── browserSessionRegistry (VL 类)   -- 浏览器会话注册表
  ├── overlayManager (GO 类)           -- Overlay 窗口管理
  └── nodeReplComputerUseTurnRoutes (ka 类) -- Computer Use 路由
```

### 1.2 关键常量

```javascript
// IPC 通道
Eu = 'codex_desktop:message-for-view'      // 主进程 → 预加载
Du = 'codex_desktop:browser-sidebar-runtime-message'  // 预加载 → 主进程

// 配置
KL = 15000   // 截图就绪超时 15 秒
YL = 1000    // 设备指标同步超时 1 秒
XL = 'light' // 默认主题
ZL = 240     // 最小 viewport 宽度
QL = 160     // 最小 viewport 高度
$L = 4096    // 最大 viewport 宽度
eR = 4096    // 最大 viewport 高度
nR = 50      // viewport 宽度约束最小值
rR = 100     // viewport 高度约束最小值

// DOM 属性
qL = 'data-browser-sidebar-conversation-id'
JL = 'persist:codex-browser-app-route:'

// 环境变量
tR = 'CODEX_BROWSER_USE_DEFAULT_VIEWPORT_SIZE'

// Shadow DOM 根节点 ID
Js = 'codex-browser-sidebar-comments-root'
```

### 1.3 TabType 枚举

```typescript
enum TabType {
  WEB = 'web',           // 普通网页
  NEW_TAB_PAGE = 'new_tab',  // 新标签页
  // ... 可能还有其他类型
}
```

---

## 二、IPC 消息系统完整事件列表

### 2.1 主进程 → 预加载（通过 `codex_desktop:message-for-view` 通道）

| 事件类型 | 方向 | 说明 |
|---------|------|------|
| `browser-sidebar-runtime-sync` | M→P | 同步状态（评论列表、交互模式、缩放等） |
| `browser-sidebar-runtime-close-editor` | M→P | 关闭编辑器 |
| `browser-sidebar-runtime-prepare-comment-screenshot` | M→P | 准备截图（设置标注标记） |
| `browser-sidebar-runtime-clear-comment-screenshot` | M→P | 清除截图标注 |
| `browser-sidebar-runtime-select-comment` | M→P | 选中某条评论 |
| `browser-sidebar-runtime-create-comment-at-point` | M→P | 在指定坐标创建评论 |
| `browser-sidebar-runtime-restore-editor` | M→P | 恢复编辑器状态 |
| `browser-sidebar-comment-overlay-session` | M→P | 同步 overlay 会话信息 |
| `browser-sidebar-browser-use-state` | M→P | 同步 browser-use 激活状态 |
| `browser-sidebar-browser-use-viewport` | M→P | 同步 viewport 尺寸 |
| `browser-sidebar-browser-use-capture-surface` | M→P | 同步截图区域 |
| `browser-sidebar-browser-use-cursor-state` | M→P | 同步光标状态 |
| `browser-sidebar-local-servers` | M→P | 同步本地服务器列表 |
| `browser-sidebar-direct-comment` | M→P | 直接创建评论 |
| `browser-sidebar-command` | M→P | 浏览器命令 |
| `browser-sidebar-state` | M→P | 侧边栏状态 |
| `browser-sidebar-usage` | M→P | 使用统计数据 |
| `browser-sidebar-find-state` | M→P | 查找状态 |
| `browser-sidebar-screenshot-copied` | M→P | 截图已复制 |
| `browser-sidebar-screenshot-copy-failed` | M→P | 截图复制失败 |
| `browser-sidebar-clear-pending-panel-open` | M→P | 清除待打开的 panel |
| `browser-sidebar-open-panel-without-animation` | M→P | 无动画打开 panel |
| `toggle-browser-panel` | M→P | 切换浏览器面板 |


### 2.2 预加载 → 主进程（通过 `codex_desktop:browser-sidebar-runtime-message` 通道）

| 事件类型 | 方向 | 说明 |
|---------|------|------|
| `browser-sidebar-runtime-open-editor` | P→M | 打开编辑器（create/edit） |
| `browser-sidebar-runtime-close-comment-preview` | P→M | 关闭评论预览 |
| `browser-sidebar-runtime-open-comment-preview` | P→M | 打开评论预览 |
| `browser-sidebar-runtime-comment-screenshot-ready` | P→M | 截图标注就绪 |
| `browser-sidebar-runtime-update-anchor` | P→M | 更新锚点位置 |
| `browser-sidebar-runtime-focus-editor` | P→M | 聚焦编辑器 |
| `browser-sidebar-runtime-exit-comment-mode` | P→M | 退出评论模式 |
| `browser-sidebar-runtime-mouse-navigation` | P→M | 鼠标导航（前进/后退） |
| `browser-sidebar-runtime-message` | P→M | 通用消息 |

### 2.3 主进程内部的 Overlay 事件（通过 WebContents.sendMessageToWebContents）

| 事件类型 | 说明 |
|---------|------|
| `browser-sidebar-comment-overlay-session` | 发送 overlay 会话信息给预加载页 |
| `browser-sidebar-comment-overlay-prepare` | 准备 overlay |
| `browser-sidebar-comment-overlay-submit` | 提交评论 |
| `browser-sidebar-comment-overlay-delete` | 删除评论 |
| `browser-sidebar-comment-overlay-mounted` | Overlay 已挂载 |
| `browser-sidebar-comment-overlay-close` | 关闭 overlay |
| `browser-sidebar-comment-overlay-preview-open-changed` | 预览打开状态变更 |
| `browser-sidebar-comment-overlay-anomaly` | Overlay 生命周期异常报告 |

---

## 三、状态管理

### 3.1 预加载端初始化状态（`ku`）

```typescript
const initialState = {
  interactionMode: 'browse',        // 'browse' | 'comment'
  isAgentControllingBrowser: false, // Agent 是否正在控制浏览器
  comments: [],                     // 评论数组
  intlConfig: undefined,            // 国际化配置
  viewportScale: 1,                 // 视口缩放
  zoomPercent: 100                  // 页面缩放百分比
}
```

### 3.2 主进程 ThreadState（每条线程独立状态）

```typescript
interface ThreadState {
  cwd: string | null
  rolloutPath: string | null
  visible: boolean
  hasPendingBrowserUseVisibilityRequest: boolean
  isAgentControllingBrowser: boolean
  isBrowserUseNavigationRestrictionActive: boolean
  runtimeIntlConfig: any
  themeVariant: string              // 'light' | 'dark'
  bounds: { x, y, width, height } | null
  emulatedViewportSize: { width, height } | null
  viewportScale: number
  isBrowserUseActive: boolean
  browserUseTurnId: string | null
  pendingBrowserUsePanelOpen: boolean
  pendingCommentModeActivation: any
  commentModeBlockCheckUrl: string | null
  commentModeBlockCheckRequestId: number
  page: { pageKey, webContents } | null
  snapshot: ViewportSnapshot       // 包含 comments, interactionMode 等
}
```

### 3.3 state 同步流程（`uR.sync`）

```
主进程调用 uR.sync(webContents, syncPayload)
  │
  ├── ensureCurrentWindowState(webContents)     // 确保窗口状态存在
  ├── transferConversationState()               // 转换会话（如果需要）
  ├── 检查 ignoredConversationIds               // 跳过忽略的会话
  ├── ensureThreadState(windowState, conversationId)
  │     └── 设置 cwd, rolloutPath, visible, bounds 等
  ├── syncThreadState()                          // 同步线程状态到 snapshot
  ├── comments.prepare()                         // 准备评论 overlay
  ├── 如果之前的 activeConversationId 不同:
  │     ├── comments.dismiss()                    // 关闭旧评论
  │     └── comments.close()                      // 关闭旧 overlay
  ├── 如果 !visible || bounds == null:
  │     └── comments.dismiss()
  └── resolveBrowserUseOpenRequests()
```

---

## 四、评论类型与锚点系统

### 4.1 评论锚点类型

#### Element Anchor（元素锚点）

```typescript
interface ElementAnchor {
  kind: 'element'
  pageUrl: string              // 页面 URL
  frameUrl: string | null      // iframe URL
  title: string                // 元素标题
  elementPath: string          // 元素路径
  point: {
    xPercent: number           // 锚点 X 百分比（0-100）
    y: number                  // 锚点 Y（像素）
  }
  rect: {                      // 元素矩形
    x: number
    y: number
    width: number
    height: number
  }
  isFixed: boolean             // 是否固定定位
  role: string | null          // ARIA role
  name: string | null          // aria-label 或文本内容
  selector: string | null      // CSS 选择器
  framePath: string[]          // iframe 路径
  nearbyText: string | null    // 附近文本
  documentContext: object | null
  scrollContainers: Array<{    // 可滚动容器
    selector: string
    scrollLeft: number
    scrollTop: number
  }>
}
```

#### Region Anchor（区域锚点）

```typescript
interface RegionAnchor {
  kind: 'region'
  pageUrl: string
  frameUrl: string | null
  title: string                // 'Selected browser region'
  elementPath: string          // 'browser region'
  point: { xPercent, y }
  rect: { x, y, width, height }
  isFixed: false
  role: null
  name: null
  selector: null
  framePath: string[]
  nearbyText: null
  documentContext: object | null
  scrollContainers: Array<{ selector, scrollLeft, scrollTop }>
}
```

### 4.2 评论数据模型

```typescript
interface Comment {
  id: string
  anchor: ElementAnchor | RegionAnchor  // 锚点信息
  body: string                          // 评论正文
  attachedImages?: Array<{              // 附件图片
    url: string
    // ...
  }>
  screenshot?: {                        // 截图（可选）
    dataUrl: string                     // base64 图片数据
    isCompact: boolean                  // 是否压缩
    annotationViewportRect?: Rect       // 标注区域
    cropViewportRect?: Rect             // 裁剪区域
    markerViewportPoint?: Point         // 标记点
    cropPaddingPx?: number              // 裁剪边距
  }
  markerViewportPoint?: Point           // 标记点位置
  markerViewportSize?: Size             // 标记区域大小
  viewportSize?: Size                   // 视口大小
}

// 序列化后的评论（发送给预加载端）
interface SerializedComment {
  id: string
  anchor: ElementAnchor | RegionAnchor
  body: string
  attachedImages?: Array<{ url: string }>
  screenshot?: { dataUrl, isCompact, ... }
}
```

---

## 五、评论模式交互流程

### 5.1 进入评论模式

```
1. 用户触发进入评论模式
   主进程: uR.sync(webContents, { ...existingState, interactionMode: 'comment' })
   预加载: 收到 browser-sidebar-runtime-sync 事件
         ├── 更新 State: interactionMode = 'comment'
         ├── 注入全局 CSS: cursor 变为十字准星 + 禁止文本选择
         ├── 添加 mousedown/mouseup/auxclick 拦截器
         ├── 挂载 MutationObserver 监听 DOM 变化
         └── 遍历所有可见 iframe，注入相同样式
```

### 5.2 创建评论（Create Mode）

```
1. 用户在页面上点击
   预加载: handlePointSelection(viewportPoint)
         ├── 使用 document.elementFromPoint 查找目标元素
         ├── 穿透 Shadow DOM 查找
         ├── 过滤掉脚本、样式、隐藏元素
         ├── 向上遍历找到可交互或合适大小的父元素
         ├── 计算 ElementAnchor（包含位置、选择器、文本等元数据）
         └── 发送 browser-sidebar-runtime-open-editor
              payload: { target: { mode: 'create' }, anchorState: {...} }

2. 主进程接收
   handleRuntimeOpenEditor()
     ├── 查找 pageState 和 threadState
     ├── 验证 interactionMode === 'comment'
     ├── overlayManager.open({
     │     owner: webContents,
     │     target: { mode: 'create' },
     │     anchorState: ...,
     │     body: '',
     │     surfaceMode: 'editor'
     │   })
     └── OverlayManager 创建独立窗口
           ├── createSession() - 生成 session
           ├── createFrame() - 计算摆放位置
           ├── createGeometry() - 计算窗口边界
           ├── 创建 BrowserWindow（透明、无框）
           ├── 定位 window 在页面上方
           └── 发送 browser-sidebar-comment-overlay-session 给预加载
```

### 5.3 编辑评论（Edit Mode）

```
1. 用户点击已有评论的标记点
   预加载: handleEditComment(comment)
     ├── 查找该评论的 DOM 元素（如果 anchor 是 element 类型）
     │     ├── 使用 selector 查询
     │     ├── 匹配 name、nearbyText 等辅助属性
     │     ├── 打分选择最佳匹配元素
     │     └── 计算新 anchor 数据
     ├── 发送 browser-sidebar-runtime-open-editor
     │     payload: { target: { mode: 'edit', commentId }, anchorState: {...} }
     └── HOST 端: 同上打开 overlay

2. 编辑器中修改后提交
   预加载 → 主进程: browser-sidebar-comment-overlay-submit
     payload: { conversationId, sessionId, body, attachedImages }

3. 主进程处理提交
   comments.handleOverlaySubmit()
     ├── 验证 overlay 状态和 sessionId
     ├── 更新 threadState.snapshot.comments
     ├── syncCommentSnapshot() 同步到预加载
     └── dismiss() 关闭 overlay 窗口
```

### 5.4 评论预览（Preview Mode）

```
1. 用户 hover 标记点
   预加载: handlePreviewComment(comment)
     ├── 设置 previewCommentId state
     ├── 查找该评论的 DOM 元素
     ├── 发送 browser-sidebar-runtime-open-comment-preview
           payload: { commentId, anchorState: {...} }

2. 主进程处理
   handleRuntimeOpenCommentPreview()
     ├── 验证 interactionMode === 'comment'
     ├── overlayManager.open({
     │     target: ...,
     │     body: comment.body,
     │     surfaceMode: 'preview',   // 预览模式而非编辑模式
     │     screenshot: comment.screenshot
     │   })
     └── 叠加层显示在标记点旁边，展示只读内容

3. 用户移开鼠标
   预加载: handleCloseCommentPreview(commentId)
     主进程: overlayManager.close()
```

### 5.5 退出评论模式

```
预加载 → 主进程: browser-sidebar-runtime-exit-comment-mode

主进程: handleRuntimeExitCommentMode()
  └── 切换 interactionMode 回 'browse'

预加载: useEffect 检测到 interactionMode !== 'comment'
  ├── 关闭所有预览
  ├── 清除元素标记
  ├── 移除 CSS 注入
  ├── 移除事件监听器
  └── 清除所有 ref
```

---

## 六、Overlay 窗口管理系统

### 6.1 OverlayManager (GO 类)

负责创建和管理评论编辑/预览的**独立透明 overlay 窗口**。

```typescript
class OverlayManager {
  windows: Map              // 管理的 overlay 窗口
  nextSessionId: number     // 自增 session ID

  // 核心方法
  prepare({ owner, conversationId, browserBounds, viewportScale, cwd })
    // 预创建 overlay 窗口，提升响应速度
  open({ owner, hostId, conversationId, browserBounds, viewportScale, target, anchorState, body, cwd, attachedImages, screenshot, surfaceMode })
    // 创建或复用 overlay 窗口
  dismiss(owner, conversationId)
    // 隐藏 overlay 窗口，保留状态
  close(owner, conversationId)
    // 关闭并销毁 overlay 窗口
  transferConversation(owner, fromConvId, toConvId)
    // 转移会话

  // 几何计算
  createFrame({ owner, browserBounds, viewportScale, anchorState, body, ... })
    // 计算 overlay 摆放策略：'anchored' | 'fallback'
  createGeometry({ owner, browserBounds, viewportScale, anchorState, forceFallback, body, previewSurfaceSize, surfaceMode, fullWindow })
    // 计算精确的窗口边界和 editor 框架位置

  // 窗口生命周期
  attachOwnerWindowListeners(state)
    // 监听 owner 窗口的 move/resize/focus/blur/hide/minimize
  positionOverlayWindow(state)
    // 根据 owner 窗口位置重新定位 overlay
  syncOwnerRenderer(state, { shouldPrewarm })
    // 发送 browser-sidebar-comment-overlay-session 给 owner webContents
  applyWindowInteractivityPolicy(state)
    // 根据 surfaceMode 设置 setIgnoreMouseEvents
    // preview 模式: 忽略鼠标事件（穿透）
    // editor 模式: 接受鼠标事件

  // 可见性管理
  scheduleOverlayVisibilitySync(state)
    // 延迟 0ms 检查是否应该显示
    // 检查条件：owner 窗口可见、未最小化、处于焦点等
  showOverlayWindowIfOwnerFocused(state)
    // 如果 owner 窗口获得焦点则显示 overlay
  showPreviewWindow(state)
    // 显示预览 overlay
}
```

### 6.2 Overlay 窗口生命周期事件

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│  prepare()  │ ──→ │   open()    │ ──→ │  mounted     │
│ (预创建窗口)  │     │ (显示窗口)   │     │ (渲染完成)    │
└─────────────┘     └─────────────┘     └──────────────┘
                           │
                     ┌─────┴─────┐
                     ▼           ▼
              ┌──────────┐ ┌──────────┐
              │ dismiss()│ │ close()  │
              │ (隐藏)    │ │ (销毁)    │
              └──────────┘ └──────────┘
```

### 6.3 Overlay 摆放策略

```typescript
// 两种摆放模式
surfaceMode: 'editor'   // 完整编辑器窗口，接受输入
surfaceMode: 'preview'  // 预览卡片，鼠标穿透

// 预览对齐方式
previewAlignment: 'start'  // 元素左侧
previewAlignment: 'center' // 元素居中
previewAlignment: 'end'    // 元素右侧

// 摆放策略
placementStrategy: 'anchored'  // 锚定在元素旁
placementStrategy: 'fallback'  // 回退到安全位置
```

Overlay 窗口的**位置跟随**是通过监听 owner BrowserWindow 的以下事件实现的：
- `move`: 重新定位
- `resize`: 重新定位 + 重新计算几何
- `focus` / `show` / `restore`: 同步渲染器 + 可见性检查
- `blur` / `hide` / `minimize`: 隐藏 overlay

---

## 七、截图捕获管道

### 7.1 完整截图流程

```
1. 发起截图请求
   主进程: captureSavedCommentScreenshot({
     annotationViewportRect,  // 标注区域
     commentId,
     conversationId,
     markerViewportPoint,     // 标记点
     owner, page,             // 页面引用
     screenshotCropRect,      // 裁剪区域
     shouldUseCompactScreenshot,
     threadState
   })

2. 通知预加载端准备
   主进程 → 预加载: browser-sidebar-runtime-prepare-comment-screenshot
     payload: { commentId }
   
   预加载: 接收后
     ├── 设置 pendingCommentScreenshotId = commentId
     ├── 渲染标注矩形（annotationViewportRect）
     ├── 渲染标记点（markerViewportPoint）
     ├── 渲染元素高亮框
     ├── 计算所有可见评论标记的位置
     └── requestAnimationFrame 回调中:
          发送 browser-sidebar-runtime-comment-screenshot-ready
          payload: {
            commentId,
            annotationViewportRect,
            markerViewportPoint
          }

3. 等待截图就绪（带超时）
   主进程: waitForRuntimeCommentScreenshotReady(page, commentId)
     ├── 设置 15 秒超时（KL = 15000）
     ├── 超时上报: browser-sidebar-comment-screenshot-ready-timeout
     └── 收到就绪消息后 resolve

4. 捕获页面截图
   主进程: captureBrowserScreenshot(page, {
     annotationViewportRect,
     comment,
     markerViewportPoint,
     readyMessage,
     screenshotCropRect,
     shouldUseCompactScreenshot
   })
     ├── page.capturePage()  // Electron 页面截图
     ├── 处理截图: crop + resize + compress
     ├── 返回处理后的 dataUrl
     └── 失败上报: browser-sidebar-comment-screenshot

5. 存储截图
   threadState.snapshot.comments[index] = {
     ...comment,
     screenshot: {
       dataUrl,
       isCompact: shouldUseCompactScreenshot
     }
   }

6. 清理
   主进程 → 预加载: browser-sidebar-runtime-clear-comment-screenshot
   预加载: 清除 pendingCommentScreenshotId

7. 截图压缩（当评论超过 10 条时）
   compactThreadCommentScreenshotsIfNeeded(threadState)
     └── 对每条非 compact 的评论截图进行降质压缩
```

### 7.2 截图类型

| 类型 | 说明 |
|-----|------|
| `captureSavedCommentScreenshot` | 为已有评论截图（编辑时） |
| `captureDirectCommentScreenshot` | 为新建评论截图（创建时，会先 sync 评论到页面） |

### 7.3 截图处理函数

```typescript
// 裁剪并缩放截图
function kk(nativeImage, { comment, screenshotCropRect, shouldUseCompactScreenshot }) {
  // 如果已有 cropViewportRect，使用 Mk() 裁剪
  // 否则使用 Nk() 直接裁剪
  // 如果 shouldUseCompactScreenshot: resize 到宽度 768px
}

// 压缩截图
function Dk(nativeImage, comment, cropRect) {
  // 如果已有 cropViewportRect: 使用 Mk() 裁剪 + resize 到 wk(768)
  // 否则: 使用 Nk() 裁剪
}
```

---

## 八、编辑器集成

### 8.1 编辑器交互流程

```typescript
// 打开编辑器（创建模式）
function handleOpenEditor(element, anchorState) {
  // 1. 关闭任何打开的预览
  if (previewCommentId != null) {
    sendMessageToHost({
      type: 'browser-sidebar-runtime-close-comment-preview',
      commentId: previewCommentId
    })
    setPreviewCommentId(null)
  }
  
  // 2. 发送打开编辑器请求
  sendMessageToHost({
    type: 'browser-sidebar-runtime-open-editor',
    target: { mode: 'create' },
    anchorState: anchorState
  })
  
  // 3. 更新本地状态
  setActiveEditSession({
    target: { mode: 'create' },
    anchor: {
      type: 'element',
      element: element,
      value: anchorState.anchor,
      viewportSize: anchorState.viewportSize
    }
  })
  
  // 4. 记录元素元数据（用于 editor 显示）
  setElementMetadata(getElementMetadata(element))
}

// 打开编辑器（编辑模式）
function handleEditComment(comment) {
  let resolvedElement = resolveElement(comment.anchor)
  if (resolvedElement != null) {
    elementCache.set(comment.id, resolvedElement)
  }
  
  // 关闭预览
  if (previewCommentId != null) {
    sendMessageToHost({
      type: 'browser-sidebar-runtime-close-comment-preview',
      commentId: previewCommentId
    })
  }
  
  sendMessageToHost({
    type: 'browser-sidebar-runtime-open-editor',
    target: { mode: 'edit', commentId: comment.id },
    anchorState: computeEditAnchorState(comment, resolvedElement, zoomFactor)
  })
  
  setActiveEditSession({
    target: { mode: 'edit', commentId: comment.id },
    anchor: computeAnchorTarget(comment, resolvedElement)
  })
  
  setPreviewCommentId(null)
}

// 聚焦编辑器
function handleFocusEditor() {
  if (activeEditSession != null) {
    sendMessageToHost({ type: 'browser-sidebar-runtime-focus-editor' })
  }
}
```

### 8.2 编辑器状态变量（预加载端）

| State 变量 | 类型 | 说明 |
|-----------|------|------|
| `comments` (w) | Comment[] | 从 sync 消息接收的评论列表 |
| `interactionMode` (T) | 'browse' \| 'comment' | 当前交互模式 |
| `elementMetadata` (i) | ElementMetadata \| null | 被选中元素的元数据 |
| `previewCommentId` (o) | string \| null | 当前预览的评论 ID |
| `selectedCommentId` (c) | string \| null | 选中（高亮）的评论 ID |
| `activeEditSession` (u) | EditSession \| null | 当前编辑会话 |
| `pendingCommentScreenshotId` (p) | string \| null | 等待截图的评论 ID |
| `commentScreenshotPrimedId` (h) | string \| null | 截图已就绪的评论 ID |
| `elementCache` (y) | Map<string, HTMLElement> | 元素位置缓存 |
| `lastCapturedClick` (x) | { element, anchorState, capturedAt } \| null | 上次点击缓存（5 秒有效） |

### 8.3 EditSession 类型

```typescript
interface EditSession {
  target: 
    | { mode: 'create' }                          // 新建模式
    | { mode: 'edit', commentId: string }         // 编辑模式
  anchor: 
    | { type: 'element', element: HTMLElement, value: Anchor, viewportSize: Size }
    | { type: 'region', value: RegionAnchor }
}
```

---

## 九、Browser-Use 集成

### 9.1 状态同步

当 Agent 使用 `computer_use` 工具控制浏览器时：

```typescript
// 主进程设置 browser-use 激活状态
setBrowserUseActiveForRoute({ conversationId, windowId }, isActive, turnId) {
  // 更新 threadState.isBrowserUseActive
  // 如果首次激活且没有 emulatedViewportSize，设置默认 viewport
  // 发送 browser-sidebar-browser-use-state 给预加载
  // 停用时：
  //   - 清除 browserUseTurnId
  //   - 清除 navigation restriction
  //   - 设置 browserUseCursor(null)
}

// 预加载收到状态同步
case 'browser-sidebar-runtime-sync':
  r({
    comments: ...,
    interactionMode: ...,
    isAgentControllingBrowser: e.isAgentControllingBrowser,  // 反映 browser-use 状态
    ...
  })
```

### 9.2 Viewport 管理

```typescript
// 设置 browser-use viewport
setViewportForBrowserUseForRoute({ conversationId, windowId }, viewportSize) {
  // 验证 viewport 尺寸范围: 240-4096 x 160-4096
  // 更新 threadState.emulatedViewportSize
  // 如果不同则 queuePageDeviceMetricsSync() 同步到 Chromium
  // 发送 browser-sidebar-browser-use-viewport 给预加载
  //   payload: { conversationId, viewportSize }
}

// 同步设备指标到页面
queuePageDeviceMetricsSync(page, viewportSize) {
  // 通过 DevTools Protocol: Emulation.setDeviceMetricsOverride
  // 带 1 秒超时
}
```

### 9.3 光标状态

```typescript
// 设置 browser-use 光标
setBrowserUseCursorForRoute({ conversationId, windowId }, cursorState) {
  // cursorState 可以是:
  //   null        - 隐藏光标
  //   { x, y }    - 显示位置
  //   { x, y, moveSequence, animateMovement }
  
  // 只在 window focused + active conversation + visible 时允许动画
  canAnimateBrowserUseCursorMovement(windowState, conversationId)
  
  // 发送 browser-sidebar-browser-use-cursor-state
  //   payload: { conversationId, visible, x, y, animateMovement?, moveSequence? }
}
```

### 9.4 截图区域

```typescript
// 设置 browser-use 截图区域
setCaptureSurfaceForBrowserUseForRoute({ conversationId, windowId }, surfaceSize) {
  // 发送 browser-sidebar-browser-use-capture-surface
  //   payload: { conversationId, surfaceSize: { width, height } | null }
}
```

### 9.5 导航限制

```typescript
// 浏览器自动化期间的导航限制
class BrowserUseNavigationRestriction {
  activate(route)    // 激活导航限制
  assertAllowed(route, url)  // 检查导航是否允许
  // 如果不允许:
  //   - 上报警告
  //   - notifyBrowserUseNavigationBlocked()
  //   - 触发 browserUseNavigationBlockedListeners
}

allowNonLocalBrowserUseNavigation: boolean = false
// 默认仅允许导航到本地服务器
```

### 9.6 颜色方案

```typescript
// 模拟浏览器颜色方案
emulateBrowserPageColorScheme(page, colorScheme: 'light' | 'dark') {
  // 通过 DevTools Protocol: Emulation.setEmulatedMedia
  // features: [{ name: 'prefers-color-scheme', value: colorScheme }]
  // 带 1 秒超时
}
```

---

## 十、本地服务器发现

### 10.1 EmptyPageLocalServers (aM 类)

发现和管理本地开发服务器。

```typescript
class EmptyPageLocalServers {
  localServerDiscovery: LocalServerDiscovery
  latestRefreshIdsByRolloutPath: Map
  visibleRefreshTimeout: number | null
  visiblePortScanTimeout: number | null

  // 持久化路径
  persistencePath: path.join(app.getPath('userData'), 'browser-sidebar-local-servers.json')

  // 刷新可见空页面（非 WEB tab 类型）
  refreshVisibleEmptyPages({ force, forcePortScan, includePortScan, revalidateKnownServers, showLoading })
  
  // 获取有资格接收 local server 的目标
  getTargets({ includeWeb }): Array<{
    conversationId, threadState, windowState
  }>
  // 仅非 WEB 类型的 tab（即 NEW_TAB_PAGE）

  // 发送状态给预加载
  sendState(owner, conversationId, state)
    // 发送 browser-sidebar-local-servers
    //   payload: { conversationId, state }
  
  // 定时刷新
  scheduleVisibleRefresh()
    // 立即刷新（无 port scan）
    // 延迟刷新（含 port scan）
  
  // 广播缓存状态给所有可见空页面
  broadcastCachedStatesToVisibleEmptyPages()
}
```

### 10.2 刷新策略

```
1. 当有可见空页面时
   ├── visibleRefreshTimeout: 立即触发基础刷新（无 port scan）
   │     └── 使用缓存数据快速响应
   └── visiblePortScanTimeout: 延迟触发完整扫描（含 port scan）
         └── 扫描本地端口，发现新服务器
```

---

## 十一、CSS 注入与样式系统

### 11.1 评论模式 CSS

进入评论模式时，预加载端向页面注入以下 CSS：

```css
html, body, body *, #codex-browser-sidebar-comments-root, #codex-browser-sidebar-comments-root * {
  cursor: url("data:image/svg+xml,...") 13 12, crosshair !important;
  -webkit-user-select: none !important;
  user-select: none !important;
}
```

### 11.2 评论标记 CSS 自定义属性

```css
--browser-sidebar-overlay-size-scale       /* 缩放比例 (1/viewportScale) */
--browser-sidebar-draft-marker-size         /* 草稿标记大小: 26 * scale */
--browser-sidebar-marker-label-font-size    /* 标记编号字体: 10 * scale */
--browser-sidebar-marker-label-offset       /* 标记编号偏移: -0.5 * scale */
--browser-sidebar-metadata-column-gap       /* 元数据列间距: 12 * scale */
--browser-sidebar-metadata-height           /* 元数据高度: 72 * scale */
--browser-sidebar-metadata-padding-x        /* 元数据水平内边距: 10 * scale */
--browser-sidebar-metadata-padding-y        /* 元数据垂直内边距: 8 * scale */
--browser-sidebar-metadata-radius           /* 元数据圆角: 12 * scale */
--browser-sidebar-metadata-row-gap          /* 元数据行间距: 3 * scale */
--browser-sidebar-overlay-font-size         /* Overlay 字体: 13 * scale */
--browser-sidebar-saved-marker-size         /* 已保存标记大小: 25 * scale */
```

### 11.3 视口缩放处理

当浏览器缩放不等于 100% 时，overlay 容器添加变换：

```css
/* zoomFactor !== 1 时 */
height: ${zoomFactor * 100}vh;
transform: scale(${1/zoomFactor});
transform-origin: top left;
width: ${zoomFactor * 100}vw;
```

---

## 十二、国际化（i18n）键

### 12.1 上下文菜单

| Key | 默认值 |
|-----|-------|
| `browserSidebar.contextMenu.inspect` | (Inspect) |
| `browserSidebar.contextMenu.back` | (Back) |
| `browserSidebar.contextMenu.forward` | (Forward) |
| `browserSidebar.contextMenu.reload` | (Reload) |
| `browserSidebar.contextMenu.openExternalBrowser` | (Open in external browser) |
| `browserSidebar.contextMenu.commentWithCodex` | (Comment with Codex) |

### 12.2 加载错误

| Key | 默认值 |
|-----|-------|
| `browserSidebar.loadError.heading` | "This site can't be reached" |
| `browserSidebar.loadError.try` | "Try:" |
| `browserSidebar.loadError.checkConnection` | "Checking the connection" |
| `browserSidebar.loadError.checkProxyFirewallDns` | "Checking the proxy, firewall, and DNS configuration" |
| `browserSidebar.loadError.reload` | "Reload" |
| `browserSidebar.loadError.dnsSummary` | "{host}'s server IP address could not be found" |
| `browserSidebar.loadError.offlineSummary` | "{host} could not be loaded because the computer is offline" |
| `browserSidebar.loadError.refusedSummary` | "{host} refused to connect" |
| `browserSidebar.loadError.timeoutSummary` | "{host} took too long to respond" |
| `browserSidebar.loadError.certificateSummary` | "{host}'s certificate could not be verified" |
| `browserSidebar.loadError.genericSummary` | "{host} could not be loaded" |
| `browserSidebar.loadError.internetHeader` | "Check your Internet connection" |
| `browserSidebar.loadError.internetBody` | "Check any cables and restart any routers, modems, or other network devices you may be using" |
| `browserSidebar.loadError.dnsHeader` | "Check your DNS settings" |
| `browserSidebar.loadError.dnsBody` | "Contact your network administrator" |
| `browserSidebar.loadError.networkAccessHeader` | (Network access header) |
| `browserSidebar.loadError.networkAccessBody` | (Network access body) |
| `browserSidebar.loadError.proxyHeader` | (Proxy header) |
| `browserSidebar.loadError.proxyBody` | (Proxy body) |

### 12.3 崩溃

| Key | 默认值 |
|-----|-------|
| `browserSidebar.crashError.heading` | "This page crashed" |
| `browserSidebar.crashError.summary` | "{host} crashed unexpectedly" |
| `browserSidebar.crashError.openExternalBrowser` | "Open in external browser" |

---

## 十三、鼠标导航

预加载端拦截鼠标后退/前进按钮：

```typescript
// 监听 mousedown, mouseup, auxclick 事件
window.addEventListener('mousedown', handleMouseButton, true)
window.addEventListener('mouseup', handleMouseUp, true)
window.addEventListener('auxclick', handleMouseButton, true)

function getDirection(event: MouseEvent): 'back' | 'forward' | null {
  // button === 3: 后退 (通常是侧键后退)
  // button === 4: 前进 (通常是侧键前进)
  return event.button === 3 ? 'back' : event.button === 4 ? 'forward' : null
}

// mouseup 时发送导航请求
function handleMouseUp(event) {
  let direction = getDirection(event)
  if (direction != null && event.isTrusted) {
    handleMouseButton(event)  // preventDefault + stopPropagation
    ipcRenderer.invoke(Du, {
      type: 'browser-sidebar-runtime-mouse-navigation',
      direction: direction
    })
  }
}
```

主进程处理：
```typescript
handleRuntimeMouseNavigation(sender, { direction }) {
  // direction === 'back'  → goBack()
  // direction === 'forward' → goForward()
  navigateCurrentPageHistory(webContents, conversationId, direction)
}
```

---

## 十四、评论过滤与优化

### 14.1 评论可见性过滤

```typescript
// 仅显示与当前页面 URL 匹配的评论
function isCurrentPageComment(comment) {
  return urlMatches(comment.anchor.pageUrl, window.location.href)
}

// URL 匹配逻辑
function urlMatches(a, b) {
  // http/https: origin + pathname + search 匹配
  // file: pathname + search 匹配
  // 其他: 完全相等
}
```

### 14.2 评论截图压缩

当线程中评论数 >= 10 时，触发截图压缩：

```typescript
compactThreadCommentScreenshotsIfNeeded(threadState) {
  if (threadState.snapshot.comments.length < 10) return
  
  // 对每条非 compact 的截图重新处理
  // 使用压缩模式，resize 到 768px 宽度
  let compressed = threadState.snapshot.comments.map(comment => {
    if (comment.screenshot == null || comment.screenshot.isCompact) return comment
    // 重新压缩
    return { ...comment, screenshot: compress(comment) }
  })
  
  threadState.snapshot = { ...threadState.snapshot, comments: compressed }
}
```

---

## 十五、预加载端初始化流程

### 15.1 启动序列

```typescript
// 1. 页面加载检测
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', init, { once: true })
} else {
  init()
}

// 2. 全局事件监听（捕获阶段）
window.addEventListener('mousedown', handleMouseButton, true)
window.addEventListener('mouseup', handleMouseUp, true)
window.addEventListener('auxclick', handleMouseButton, true)

// 3. 初始化函数
function init() {
  mountReactApp(createBridge())
}

// 4. 创建 IPC 桥接
function createBridge() {
  return {
    initialState: defaultState,
    sendMessageToHost(message) {
      ipcRenderer.invoke(Du, message)
    },
    subscribeToHostMessages(callback) {
      hasActiveSubscription = true
      let handler = (event, message) => {
        switch (message.type) {
          case 'browser-sidebar-runtime-sync':
            updateCachedState(message)
            callback(message)
            return
          case 'browser-sidebar-runtime-prepare-comment-screenshot':
          case 'browser-sidebar-runtime-clear-comment-screenshot':
          case 'browser-sidebar-runtime-select-comment':
          case 'browser-sidebar-runtime-close-editor':
          case 'browser-sidebar-runtime-create-comment-at-point':
          case 'browser-sidebar-runtime-restore-editor':
            callback(message)
            return
        }
      }
      
      ipcRenderer.on(Eu, handler)
      
      // 重放缓存的消息（在订阅前到达的消息）
      if (queuedMessage != null) {
        callback(queuedMessage)
        queuedMessage = null
      }
      
      return () => {
        hasActiveSubscription = false
        ipcRenderer.removeListener(Eu, handler)
      }
    }
  }
}

// 5. 挂载 React（Shadow DOM）
function mountReactApp(bridge) {
  let hostElement = getOrCreateHost()
  let shadowRoot = hostElement.shadowRoot ?? hostElement.attachShadow({ mode: 'open' })
  shadowRoot.replaceChildren()
  
  let container = document.createElement('div')
  shadowRoot.appendChild(container)
  
  let root = createRoot(container)
  root.render(<App rootHost={hostElement} bridge={bridge} />)
  
  return {
    dispose() {
      root.unmount()
      hostElement.remove()
    }
  }
}
```

### 15.2 消息缓冲机制

在 React 组件挂载（即 `subscribeToHostMessages` 注册）之前到达的消息会被缓存：

```typescript
let hasActiveSubscription = false
let queuedMessage = null

// 在 ipcRenderer.on 中
if (!hasActiveSubscription) {
  queuedMessage = coalesceMessages(queuedMessage, message)
} else {
  // 消息已经被 subscribeToHostMessages 的 handler 处理
}

// 消息合并逻辑
function coalesceMessages(prev, next) {
  switch (next.type) {
    case 'browser-sidebar-runtime-select-comment':
    case 'browser-sidebar-runtime-create-comment-at-point':
      return next  // 覆盖前一个
    case 'browser-sidebar-runtime-restore-editor':
      // 如果前一个是 select/comment-at-point，保留前一个
      return prev?.type === 'browser-sidebar-runtime-select-comment' 
          || prev?.type === 'browser-sidebar-runtime-create-comment-at-point'
        ? prev : next
    case 'browser-sidebar-runtime-close-editor':
      return null  // 清除前一个
    case 'browser-sidebar-runtime-sync':
    case 'browser-sidebar-runtime-prepare-comment-screenshot':
    case 'browser-sidebar-runtime-clear-comment-screenshot':
      return prev  // 保留前一个
  }
}
```

---

## 十六、浏览器命令系统

主进程通过 `browser-sidebar-command` 事件转发以下浏览器命令：

| 命令 | 说明 |
|-----|------|
| `go-back` | 后退 |
| `go-forward` | 前进 |
| `reload` | 刷新（支持 ignoreCache） |
| `reset` | 重置页面 |
| `stop` | 停止加载 |
| `focus-address` | 聚焦地址栏 |
| `refresh-cursor` | 刷新光标 |
| `step-zoom` | 缩放步进 |
| `set-zoom-percent` | 设置缩放百分比 |
| `reset-zoom` | 重置缩放 |
| `select-comment` | 选中评论 |
| `transfer-conversation` | 转移会话 |
| `find-next` | 查找下一个 |
| `find-previous` | 查找上一个 |
| `close-find` | 关闭查找 |

---

## 十七、架构模式总结

### 17.1 设计模式

1. **双向 IPC 通信**：主进程和预加载通过两个独立 IPC 通道通信
2. **状态同步**：主进程持有权威状态，通过 `sync` 事件推送给预加载
3. **覆盖窗口**：评论编辑器作为独立、透明的 Chromium 窗口浮动在浏览器上方
4. **位置跟随**：Overlay 窗口监听 owner 窗口的 move/resize 等事件实时调整位置
5. **Shadow DOM 隔离**：评论 UI 完全在 Shadow DOM 中渲染，避免页面 CSS 污染
6. **消息缓冲**：在 React 挂载前到达的消息被缓存并合并，避免丢失

### 17.2 数据流方向

```
┌─────────────────────────────────────────────────────────────────┐
│                         主进程 (Electron Main)                    │
│                                                                   │
│  SidebarManager ──→ BrowserSidebarManager ──→ Comments (Tk)     │
│       │                    │                    │                 │
│       │                    ├── OverlayManager (GO)                │
│       │                    ├── EmptyPageLocalServers (aM)         │
│       │                    └── BrowserSessionRegistry (VL)        │
│       │                                                           │
│       └── handleMessage() ──→ 所有 browser-sidebar-* 事件路由     │
└───────────────────────────┬───────────────────────────────────────┘
                            │ IPC: codex_desktop:message-for-view
                            │      codex_desktop:browser-sidebar-runtime-message
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    预加载 (comment-preload.js)                     │
│                                                                   │
│  Shadow DOM Root: #codex-browser-sidebar-comments-root           │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  React App (Sc 组件)                                        │ │
│  │  ├── 评论标记层 (markers-layer)                              │ │
│  │  ├── 元素高亮框 (hover-box)                                  │ │
│  │  ├── 元数据提示 (element-metadata-tooltip)                   │ │
│  │  └── 元素选择交互 (element selection interaction)            │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  全局 CSS 注入 | 事件拦截 | DOM 观察 | 元素选择算法               │
└─────────────────────────────────────────────────────────────────┘
```

### 17.3 安全与隔离

- 评论数据通过 IPC 传递，不直接访问页面 DOM
- 页面元素选择通过 `elementFromPoint` 算法实现，不依赖页面提供的 API
- Shadow DOM 确保评论 UI 与页面 DOM 完全隔离
- overlay 窗口使用 `setIgnoreMouseEvents` 控制交互穿透
- 导航限制防止 browser-use 期间访问外部站点

---

## 附录 A：预加载端核心变量速查表

| 变量 | 类型 | 说明 |
|-----|------|------|
| `w` | Comment[] | 评论列表 |
| `T` | 'browse'\|'comment' | 交互模式 |
| `i` | ElementMetadata\|null | 元素元数据 |
| `o` | string\|null | 预览评论 ID |
| `c` | string\|null | 选中评论 ID |
| `u` | EditSession\|null | 编辑会话 |
| `p` | string\|null | 等待截图的评论 ID |
| `h` | string\|null | 截图就绪评论 ID |
| `y` | Map<string,Element> | 元素缓存 |
| `x` | ClickCache\|null | 点击缓存（5s 有效） |
| `n` | State | 完整同步状态 |
| `E` | number | 缩放因子 |
| `D` | number | 视口缩放倒数 |
| `se` | Map<string,number> | 评论编号映射 |
| `O` | Comment[] | 当前页评论 |
| `k` | ResolvedComment[] | 已解析元素的评论 |
| `ce` | boolean | 是否有非固定锚点 |
| `le` | boolean | 是否有元素锚点的选择器 |

## 附录 B：主进程核心变量速查表

| 变量 | 值 | 说明 |
|-----|---|------|
| `KL` | 15000 | 截图就绪超时 |
| `YL` | 1000 | 设备指标同步超时 |
| `XL` | 'light' | 默认主题 |
| `ZL` | 240 | 最小 viewport 宽 |
| `QL` | 160 | 最小 viewport 高 |
| `$L` | 4096 | 最大 viewport 宽 |
| `eR` | 4096 | 最大 viewport 高 |
| `nR` | 50 | viewport 约束最小宽 |
| `rR` | 100 | viewport 约束最小高 |
| `Eu` | 'codex_desktop:message-for-view' | Main→Preload IPC |
| `Du` | 'codex_desktop:browser-sidebar-runtime-message' | Preload→Main IPC |
| `Js` | 'codex-browser-sidebar-comments-root' | Shadow DOM 根 ID |
| `qL` | 'data-browser-sidebar-conversation-id' | DOM 属性 |
| `JL` | 'persist:codex-browser-app-route:' | localStorage 前缀 |
