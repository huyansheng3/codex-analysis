// ============================================================
// Codex IPC 消息类型系统 — 从 main.js + comment-preload.js 逆向重建
// 运行时通道: codex_desktop:message-from-view / codex_desktop:message-for-view
// ============================================================

// --- 窗口路由消息 ---

type WindowRoutingMessage =
  | { type: "open-in-main-window"; [key: string]: unknown }
  | { type: "open-current-main-window"; [key: string]: unknown }
  | { type: "open-in-new-window"; [key: string]: unknown }
  | { type: "open-in-hotkey-window"; [key: string]: unknown }
  | { type: "open-in-browser"; [key: string]: unknown }
  | { type: "open-in-targets"; [key: string]: unknown }
  | { type: "open-in-browser-button"; [key: string]: unknown }
  | { type: "close-active-app-shell-tab"; [key: string]: unknown };

// --- 应用状态消息 ---

type AppStateMessage =
  | { type: "electron-app-state-snapshot-request" }
  | { type: "electron-window-focus-changed"; focused: boolean }
  | { type: "window-fullscreen-changed"; isFullscreen: boolean }
  | { type: "electron-desktop-features-changed"; features: DesktopFeatures }
  | { type: "electron-onboarding-skip-workspace-result"; [key: string]: unknown }
  | { type: "electron-onboarding-pick-workspace-or-create-default-result"; [key: string]: unknown }
  | { type: "persisted-atom-updated"; key: string; value: unknown }
  | { type: "custom-prompts-updated" }
  | { type: "shared-object-updated"; key: string; value: unknown }
  | { type: "shared-object-set"; key: string; value?: unknown }  // value undefined = delete
  | { type: "global-state-updated" }
  | { type: "workspace-root-options-updated" }
  | { type: "active-workspace-roots-updated" };

// --- Hotkey Window 事件 ---

type HotkeyWindowMessage =
  | { type: "hotkey-window-enabled-changed"; enabled: boolean }
  | { type: "mac-menu-bar-enabled-changed"; enabled: boolean }
  | { type: "hotkey-window-transition-done" }
  | { type: "hotkey-window-collapse-to-home" }
  | { type: "hotkey-window-home-pointer-interaction"; [key: string]: unknown }
  | { type: "hotkey-window-transition"; [key: string]: unknown };

// --- 更新生命周期 ---

type UpdateMessage =
  | { type: "app-update-ready-changed"; ready: boolean }
  | { type: "app-update-lifecycle-state-changed"; state: string }
  | { type: "app-update-install-progress-changed"; progress: number };

// --- 命令系统 ---

type CommandMessage =
  | { type: "command-menu" }
  | { type: "file-search-command-menu" }
  | { type: "chat-search-command-menu" }
  | { type: "run-command"; commandId: string }
  | { type: "step-window-zoom"; direction: "in" | "out" }
  | { type: "reset-window-zoom" };

// --- 通知 ---

type NotificationMessage =
  | { type: "desktop-notification-show"; notification: DesktopNotification }
  | { type: "desktop-notification-hide"; id: string }
  | { type: "desktop-notification-action"; id: string; action: string };

interface DesktopNotification {
  id: string;
  title: string;
  body: string;
  [key: string]: unknown;
}

// --- 调试 ---

type DebugMessage =
  | { type: "debug-run-app-action-request"; [key: string]: unknown }
  | { type: "debug-run-app-action-response"; [key: string]: unknown }
  | { type: "debug-window-origin-conversation-changed"; [key: string]: unknown };

// --- Dictation ---

type DictationMessage =
  | { type: "global-dictation-in-app-start" }
  | { type: "global-dictation-in-app-stop" };

// --- Computer Use ---

type ComputerUseMessage =
  | { type: "computer-use-capture-updated" };

// --- 运行时 ---

type RuntimeMessage =
  | { type: "primary-runtime-install-progress"; progress: number }
  | { type: "pinned-threads-updated" }
  | { type: "fetch-stream-error"; error: unknown }
  | { type: "trace-recording-state-changed" }
  | { type: "avatar-overlay-open-state-changed" }
  | { type: "avatar-overlay-layout-changed" }
  | { type: "terminal-error"; error: string }
  | { type: "native-window-context-shortcut" }
  | { type: "worker-app-event"; event: unknown };

// --- Desktop Features ---

interface DesktopFeatures {
  inAppBrowserUse: boolean;
  inAppBrowserUseAllowed: boolean;
  externalBrowserUse: boolean;
  externalBrowserUseAllowed: boolean;
  computerUse: boolean;
  computerUseNodeRepl: boolean;
  control: boolean;
  multiWindow: boolean;
  ambientSuggestions?: boolean;
  artifactsPane?: boolean;
  allowDevtools?: boolean;
  allowDebugMenu?: boolean;
  allowWindowReload?: boolean;
  enableSparkle?: boolean;
}

// --- 联合类型：所有 View ↔ Main 的消息 ---

type ViewMessage =
  | WindowRoutingMessage
  | AppStateMessage
  | HotkeyWindowMessage
  | UpdateMessage
  | CommandMessage
  | NotificationMessage
  | DebugMessage
  | DictationMessage
  | ComputerUseMessage
  | RuntimeMessage;
