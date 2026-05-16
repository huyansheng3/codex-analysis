// ============================================================
// Computer Use MCP Tools — 从 SkyComputerUseClient 二进制 strings 逆向重建
// 9 个 MCP Tools 的完整接口定义
// ============================================================

// --- 基础类型 ---

interface AppInfo {
  /** 应用 Bundle ID（如 "com.spotify.client"） */
  bundleIdentifier: string;
  /** 应用显示名 */
  displayName: string;
  /** 是否正在运行 */
  isRunning: boolean;
  /** 最近使用时间 */
  lastUsedAt?: number;
  /** 使用频率 */
  usageFrequency?: "frequent" | "occasional" | "rare";
}

interface AccessibilityElement {
  /** Accessibility tree 中的顺序索引 */
  index: number;
  /** ARIA 角色 */
  role: string;
  /** 元素描述/标签 */
  description?: string;
  /** 元素值 */
  value?: string;
  /** 元素在截图中的 frame */
  frame?: { x: number; y: number; width: number; height: number };
  /** 子元素 */
  children?: AccessibilityElement[];
  /** 是否可交互 */
  enabled?: boolean;
  /** 是否聚焦 */
  focused?: boolean;
  /** 辅助操作 */
  actions?: string[];
}

interface GetAppStateResponse {
  /** Base64 编码的 PNG 截图 */
  screenshot: string;
  /** 当前窗口的 Accessibility 树 */
  accessibilityTree: AccessibilityElement[];
  /** 应用信息 */
  appInfo: AppInfo;
  /** CUA Service 版本号 */
  cuaAppVersion: string;
}

// --- Tool 1: list_apps ---

const LIST_APPS_TOOL = {
  name: "list_apps",
  description:
    "List the apps on this computer. Returns the set of apps " +
    "that are currently running, as well as any that have been " +
    "used in the last 14 days, including details on usage frequency.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    additionalProperties: false,
  },
};

type ListAppsResponse = {
  apps: AppInfo[];
};

// --- Tool 2: get_app_state ---

const GET_APP_STATE_TOOL = {
  name: "get_app_state",
  description:
    "Start an app use session if needed, then get the state of " +
    "the app's key window and return a screenshot and accessibility " +
    "tree. This must be called once per assistant turn before " +
    "interacting with the app.",
  inputSchema: {
    type: "object" as const,
    properties: {
      app: {
        type: "string",
        description: "App name or bundle identifier",
      },
    },
    required: ["app"],
    additionalProperties: false,
  },
};

// --- Tool 3: click ---

const CLICK_TOOL = {
  name: "click",
  description:
    "Click an element by index or pixel coordinates from screenshot.",
  inputSchema: {
    type: "object" as const,
    properties: {
      elementIndex: {
        type: "number",
        description: "Element index to click",
      },
      x: {
        type: "number",
        description: "X coordinate in screenshot pixel coordinates",
      },
      y: {
        type: "number",
        description: "Y coordinate in screenshot pixel coordinates",
      },
      button: {
        type: "string",
        description: "Mouse button to click. Defaults to left.",
        enum: ["left", "right", "center"],
      },
      clicks: {
        type: "number",
        description: "Number of clicks. Defaults to 1.",
      },
    },
    // elementIndex 或 (x,y) 二选一
  },
};

// --- Tool 4: perform_secondary_action ---

const PERFORM_SECONDARY_ACTION_TOOL = {
  name: "perform_secondary_action",
  description:
    "Invoke a secondary accessibility action exposed by an element.",
  inputSchema: {
    type: "object" as const,
    properties: {
      elementIndex: {
        type: "number",
        description: "Element identifier",
      },
      actionName: {
        type: "string",
        description: "Secondary accessibility action name",
      },
    },
    required: ["elementIndex", "actionName"],
    additionalProperties: false,
  },
};

// --- Tool 5: set_value ---

const SET_VALUE_TOOL = {
  name: "set_value",
  description:
    "Set the value of a settable accessibility element.",
  inputSchema: {
    type: "object" as const,
    properties: {
      elementIndex: {
        type: "number",
        description: "Element identifier",
      },
      value: {
        type: "string",
        description: "Value to set",
      },
    },
    required: ["elementIndex", "value"],
    additionalProperties: false,
  },
};

// --- Tool 6: scroll ---

const SCROLL_TOOL = {
  name: "scroll",
  description:
    "Scroll an element in a direction by a number of pages. " +
    "Fractional values are supported.",
  inputSchema: {
    type: "object" as const,
    properties: {
      elementIndex: {
        type: "number",
        description: "Element identifier",
      },
      direction: {
        type: "string",
        description: "Scroll direction: up, down, left, or right",
        enum: ["up", "down", "left", "right"],
      },
      pages: {
        type: "number",
        description:
          "Number of pages to scroll. Fractional values are supported. " +
          "Defaults to 1.",
      },
    },
    required: ["elementIndex", "direction"],
    additionalProperties: false,
  },
};

// --- Tool 7: drag ---

const DRAG_TOOL = {
  name: "drag",
  description:
    "Drag from one point to another using pixel coordinates.",
  inputSchema: {
    type: "object" as const,
    properties: {
      startX: { type: "number", description: "Start X coordinate" },
      startY: { type: "number", description: "Start Y coordinate" },
      endX: { type: "number", description: "End X coordinate" },
      endY: { type: "number", description: "End Y coordinate" },
    },
    required: ["startX", "startY", "endX", "endY"],
    additionalProperties: false,
  },
};

// --- Tool 8: press_key ---

const PRESS_KEY_TOOL = {
  name: "press_key",
  description:
    "Press a key or key-combination on the keyboard, including " +
    "modifier and navigation keys.\n" +
    "  - This supports xdotool's `key` syntax.\n" +
    '  - Examples: "a", "Return", "Tab", "super+c", "Up", ' +
    '"KP_0" (for the numpad 0 key).',
  inputSchema: {
    type: "object" as const,
    properties: {
      key: {
        type: "string",
        description: "Key or key combination to press",
      },
    },
    required: ["key"],
    additionalProperties: false,
  },
};

// --- Tool 9: type_text ---

const TYPE_TEXT_TOOL = {
  name: "type_text",
  description: "Type literal text using keyboard input.",
  inputSchema: {
    type: "object" as const,
    properties: {
      text: {
        type: "string",
        description: "Literal text to type",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
};

// --- 按键参考 ---

/**
 * xdotool 支持的按键（从 SkyComputerUseService 二进制提取）
 */
const SUPPORTED_KEYS = {
  modifiers: {
    ctrl: "Control_L/R",
    shift: "Shift_L/R",
    super: "Super_L/R",
    meta: "Meta_L/R",
    alt: "Alt_L/R",
    command: "Command",     // macOS 专用
  },
  navigation: {
    Back: "Back",
    Home: "Home",
    Left: "Left",
    Up: "Up",
    Right: "Right",
    Down: "Down",
    Prior: "Page Up",
    Next: "Page Down",
    Begin: "Begin",
    End: "End",
  },
  special: {
    BackSpace: "BackSpace",
    Tab: "Tab",
    Linefeed: "Linefeed",
    Clear: "Clear",
    Return: "Return",
    Escape: "Escape",
    Delete: "Delete",
    Pause: "Pause",
    Scroll_Lock: "Scroll_Lock",
    Sys_Req: "Sys_Req",
  },
  function: {
    Insert: "Insert",
    Menu: "Menu",
    Help: "Help",
    Select: "Select",
    Print: "Print",
    Execute: "Execute",
    Undo: "Undo",
    Redo: "Redo",
    Find: "Find",
    Cancel: "Cancel",
    Break: "Break",
    Mode_switch: "Mode_switch",
    Num_Lock: "Num_Lock",
  },
  numpad: {
    KP_0: "KP_0", KP_1: "KP_1", KP_2: "KP_2", KP_3: "KP_3",
    KP_4: "KP_4", KP_5: "KP_5", KP_6: "KP_6", KP_7: "KP_7",
    KP_8: "KP_8", KP_9: "KP_9",
    KP_Delete: "KP_Delete", KP_Enter: "KP_Enter",
    KP_Add: "KP_Add", KP_Subtract: "KP_Subtract",
    KP_Multiply: "KP_Multiply", KP_Divide: "KP_Divide",
    KP_Decimal: "KP_Decimal", KP_Equal: "KP_Equal",
    KP_Space: "KP_Space", KP_Tab: "KP_Tab",
    KP_F1: "KP_F1", KP_F2: "KP_F2", KP_F3: "KP_F3", KP_F4: "KP_F4",
    KP_Home: "KP_Home", KP_Left: "KP_Left", KP_Up: "KP_Up",
    KP_Right: "KP_Right", KP_Down: "KP_Down",
    KP_Prior: "KP_Page_Up", KP_Next: "KP_Page_Down",
    KP_End: "KP_End", KP_Begin: "KP_Begin",
    KP_Insert: "KP_Insert", KP_Separator: "KP_Separator",
  },
};

// --- 错误类型 ---

const COMPUTER_USE_ERRORS = {
  PERMISSIONS_PENDING:
    "Computer Use permissions are still pending. The user has " +
    "not finished granting Accessibility and Screen Recording " +
    "permissions in the Codex Computer Use window.",

  PERMISSIONS_NOT_GRANTED:
    "Computer Use permissions are not granted.",

  NOT_ACTIVE:
    "Computer Use is not active for '{app}'. You first must " +
    "call `get_app_state` to get the latest state before doing " +
    "other Computer Use actions.",

  VERSION_MISMATCH:
    "The Computer Use server and client have a version mismatch.",

  URL_BLOCKED:
    "This session has been stopped because Computer Use is not " +
    "allowed on the current browser URL.",

  SESSION_STOPPED:
    "This application session has been explicitly stopped by the " +
    "user for this turn.",

  APP_BLOCKED:
    "Computer Use is not allowed to use the app '{app}' for " +
    "safety reasons.",

  APP_NOT_FOUND:
    "Running application not found: {app}",

  AX_ERROR:
    "Accessibility error: {error}",

  APP_BLOCKED_BY_POLICY:
    "Computer Use is blocked from using the app '{app}' by your " +
    "organization's policy.",
} as const;

// --- 所有 MCP Tools 注册 ---

const ALL_COMPUTER_USE_TOOLS = [
  LIST_APPS_TOOL,
  GET_APP_STATE_TOOL,
  CLICK_TOOL,
  PERFORM_SECONDARY_ACTION_TOOL,
  SET_VALUE_TOOL,
  SCROLL_TOOL,
  DRAG_TOOL,
  PRESS_KEY_TOOL,
  TYPE_TEXT_TOOL,
] as const;

export {
  LIST_APPS_TOOL,
  GET_APP_STATE_TOOL,
  CLICK_TOOL,
  PERFORM_SECONDARY_ACTION_TOOL,
  SET_VALUE_TOOL,
  SCROLL_TOOL,
  DRAG_TOOL,
  PRESS_KEY_TOOL,
  TYPE_TEXT_TOOL,
  ALL_COMPUTER_USE_TOOLS,
  SUPPORTED_KEYS,
  COMPUTER_USE_ERRORS,
};

export type {
  AppInfo,
  AccessibilityElement,
  GetAppStateResponse,
  ListAppsResponse,
};
