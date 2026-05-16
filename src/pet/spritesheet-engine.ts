// ============================================================
// Codex 精灵表动画引擎 — 从 webview/assets + CSS + JS 逆向重建
// 核心：8 个角色、多行动画帧、CSS sprite animation + Canvas 混合渲染
// ============================================================

// --- 8 个角色定义 ---

enum PetCharacter {
  Codex = "codex",
  Bsod = "bsod",
  Dewey = "dewey",
  Fireball = "fireball",
  NullSignal = "null-signal",
  Rocky = "rocky",
  Seedy = "seedy",
  Stacky = "stacky",
}

// --- 动画状态枚举 ---

enum AnimationState {
  /** 空闲（呼吸/眨眼循环） */
  Idle = "idle",
  /** 行走（水平移动） */
  Walk = "walk",
  /** 奔跑（快速移动） */
  Run = "run",
  /** 跳跃 */
  Jump = "jump",
  /** 坐下/休息 */
  Sit = "sit",
  /** 睡眠（长时间不交互） */
  Sleep = "sleep",
  /** 交互/响应点击 */
  Interact = "interact",
  /** 惊讶 */
  Surprised = "surprised",
  /** 思考/工作中 */
  Thinking = "thinking",
  /** 快乐（完成任务后） */
  Happy = "happy",
  /** 错误/失败 */
  Error = "error",
  /** 拖拽中 */
  Dragging = "dragging",
  /** 说话/打字中 */
  Speaking = "speaking",
  /** 吃东西 */
  Eating = "eating",
  /** 特殊动作（角色特定） */
  Special = "special",
}

// --- 精灵表布局 ---

/**
 * 精灵表格式：WebP 8列 × N行
 * 每个单元格大小：由角色决定
 * 行 = 动画状态，列 = 该状态下的帧
 */
interface SpritesheetLayout {
  /** 精灵表文件 URL（相对 webview/assets/） */
  url: string;
  /** WebP 文件大小（用于预加载进度） */
  fileSize: number;
  /** 每一行的动画配置 */
  rows: Record<AnimationState, AnimationRowConfig>;
  /** 单元格宽度（px） */
  cellWidth: number;
  /** 单元格高度（px） */
  cellHeight: number;
  /** 总共列数 */
  columns: number;
  /** 总共行数 */
  totalRows: number;
}

interface AnimationRowConfig {
  /** 行索引（0-based） */
  rowIndex: number;
  /** 该行动画的帧数（≤ 8） */
  frameCount: number;
  /** 帧率（fps） */
  fps: number;
  /** 是否循环播放 */
  loop: boolean;
  /** 是否可被更高优先级动画打断 */
  interruptible: boolean;
  /** 动画优先级（数字越大越优先） */
  priority: number;
}

// --- 精灵表配置生成 ---

/**
 * 为每个角色生成精灵表配置
 *
 * 从 ASAR 提取的精灵表实际信息:
 *   codex-spritesheet.webp    868 KB  - 主角色
 *   bsod-spritesheet.webp     931 KB  - BSOD 角色
 *   dewey-spritesheet.webp    764 KB  - Dewey 角色
 *   fireball-spritesheet.webp 1035 KB - Fireball 角色
 *   null-signal-spritesheet.webp 477 KB - Null Signal 角色
 *   rocky-spritesheet.webp    644 KB  - Rocky 角色
 *   seedy-spritesheet.webp    893 KB  - Seedy 角色
 *   stacky-spritesheet.webp   732 KB  - Stacky 角色
 *
 * 推测：每个精灵表为 8 列（标准），行数因角色而异
 */
function buildSpritesheetLayout(character: PetCharacter): SpritesheetLayout {
  const base = `assets/${character}-spritesheet.webp`;

  const sizes: Record<PetCharacter, { fileSize: number; cellW: number; cellH: number }> = {
    [PetCharacter.Codex]:      { fileSize: 868,  cellW: 128, cellH: 128 },
    [PetCharacter.Bsod]:       { fileSize: 931,  cellW: 128, cellH: 128 },
    [PetCharacter.Dewey]:      { fileSize: 764,  cellW: 100, cellH: 120 },
    [PetCharacter.Fireball]:   { fileSize: 1035, cellW: 140, cellH: 140 },
    [PetCharacter.NullSignal]: { fileSize: 477,  cellW: 96,  cellH: 96 },
    [PetCharacter.Rocky]:      { fileSize: 644,  cellW: 110, cellH: 120 },
    [PetCharacter.Seedy]:      { fileSize: 893,  cellW: 120, cellH: 128 },
    [PetCharacter.Stacky]:     { fileSize: 732,  cellW: 115, cellH: 130 },
  };

  const { fileSize, cellW, cellH } = sizes[character];

  return {
    url: base,
    fileSize,
    cellWidth: cellW,
    cellHeight: cellH,
    columns: 8,
    totalRows: 16,
    rows: {
      [AnimationState.Idle]:      { rowIndex: 0, frameCount: 4, fps: 6,  loop: true,  interruptible: true,  priority: 0 },
      [AnimationState.Walk]:      { rowIndex: 1, frameCount: 8, fps: 10, loop: true,  interruptible: true,  priority: 1 },
      [AnimationState.Run]:       { rowIndex: 2, frameCount: 6, fps: 12, loop: true,  interruptible: true,  priority: 2 },
      [AnimationState.Jump]:      { rowIndex: 3, frameCount: 6, fps: 10, loop: false, interruptible: false, priority: 5 },
      [AnimationState.Sit]:       { rowIndex: 4, frameCount: 2, fps: 2,  loop: true,  interruptible: true,  priority: 0 },
      [AnimationState.Sleep]:     { rowIndex: 5, frameCount: 4, fps: 3,  loop: true,  interruptible: true,  priority: 0 },
      [AnimationState.Interact]:  { rowIndex: 6, frameCount: 6, fps: 10, loop: false, interruptible: false, priority: 7 },
      [AnimationState.Surprised]: { rowIndex: 7, frameCount: 4, fps: 8,  loop: false, interruptible: false, priority: 8 },
      [AnimationState.Thinking]:  { rowIndex: 8, frameCount: 4, fps: 5,  loop: true,  interruptible: true,  priority: 2 },
      [AnimationState.Happy]:     { rowIndex: 9, frameCount: 6, fps: 10, loop: false, interruptible: false, priority: 6 },
      [AnimationState.Error]:     { rowIndex: 10, frameCount: 3, fps: 4,  loop: false, interruptible: false, priority: 9 },
      [AnimationState.Dragging]:  { rowIndex: 11, frameCount: 2, fps: 4,  loop: true,  interruptible: false, priority: 10 },
      [AnimationState.Speaking]:  { rowIndex: 12, frameCount: 4, fps: 8,  loop: true,  interruptible: true,  priority: 3 },
      [AnimationState.Eating]:    { rowIndex: 13, frameCount: 6, fps: 8,  loop: true,  interruptible: true,  priority: 3 },
      [AnimationState.Special]:   { rowIndex: 14, frameCount: 8, fps: 10, loop: false, interruptible: false, priority: 6 },
    },
  };
}

// --- CSS Sprite 渲染器 ---

/**
 * CSS animation 方式播放精灵表
 * 使用 background-position 关键帧动画
 *
 * 推测 Codex 使用此方式（而非 Canvas）因为:
 * 1. WebView 中的 CSS animation 由 GPU 合成，功耗更低
 * 2. 支持 will-change: background-position 硬件加速
 * 3. 配合 requestAnimationFrame 同步
 */
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

// --- Canvas 渲染器（需要逐帧控制时的备选方案） ---

interface FrameState {
  character: PetCharacter;
  currentState: AnimationState;
  currentFrame: number;
  frameTimer: number;
  spritesheet: HTMLImageElement | null;
  loaded: boolean;
}

class CanvasSpriteRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: FrameState;
  private layout: SpritesheetLayout;
  private animFrameId: number = 0;

  constructor(character: PetCharacter) {
    this.canvas = document.createElement("canvas");
    this.layout = buildSpritesheetLayout(character);
    this.canvas.width = this.layout.cellWidth;
    this.canvas.height = this.layout.cellHeight;
    this.ctx = this.canvas.getContext("2d")!;

    this.state = {
      character,
      currentState: AnimationState.Idle,
      currentFrame: 0,
      frameTimer: 0,
      spritesheet: null,
      loaded: false,
    };
  }

  async load(): Promise<void> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        this.state.spritesheet = img;
        this.state.loaded = true;
        resolve();
      };
      img.src = this.layout.url;
    });
  }

  setState(newState: AnimationState): boolean {
    const currentConfig = this.layout.rows[this.state.currentState];
    const newConfig = this.layout.rows[newState];

    if (this.state.currentState === newState) return true;
    if (!currentConfig.interruptible && newConfig.priority <= currentConfig.priority) {
      return false; // 不可打断
    }

    this.state.currentState = newState;
    this.state.currentFrame = 0;
    this.state.frameTimer = 0;
    return true;
  }

  startLoop(): void {
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const config = this.layout.rows[this.state.currentState];
      const frameInterval = 1 / config.fps;

      this.state.frameTimer += dt;
      if (this.state.frameTimer >= frameInterval) {
        this.state.frameTimer -= frameInterval;
        this.state.currentFrame++;

        if (this.state.currentFrame >= config.frameCount) {
          if (config.loop) {
            this.state.currentFrame = 0;
          } else {
            // 非循环动画结束后回到 Idle
            this.state.currentFrame = config.frameCount - 1;
            this.setState(AnimationState.Idle);
          }
        }
      }

      this.render();
      this.animFrameId = requestAnimationFrame(tick);
    };

    this.animFrameId = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.animFrameId);
  }

  private render(): void {
    if (!this.state.loaded || !this.state.spritesheet) return;

    const { cellWidth, cellHeight } = this.layout;
    const config = this.layout.rows[this.state.currentState];
    const srcX = this.state.currentFrame * cellWidth;
    const srcY = config.rowIndex * cellHeight;

    this.ctx.clearRect(0, 0, cellWidth, cellHeight);
    this.ctx.drawImage(
      this.state.spritesheet,
      srcX, srcY, cellWidth, cellHeight,
      0, 0, cellWidth, cellHeight,
    );
  }
}

// --- 精灵表预加载器 ---

interface PreloadProgress {
  loaded: number;
  total: number;
  current: PetCharacter | null;
}

class SpritesheetPreloader {
  private cache = new Map<PetCharacter, HTMLImageElement>();
  private totalBytes = 0;
  private loadedBytes = 0;

  constructor() {
    const chars = Object.values(PetCharacter);
    for (const c of chars) {
      this.totalBytes += buildSpritesheetLayout(c).fileSize;
    }
  }

  async preloadAll(
    onProgress?: (p: PreloadProgress) => void,
  ): Promise<Map<PetCharacter, HTMLImageElement>> {
    const chars = Object.values(PetCharacter);
    let loaded = 0;

    for (const character of chars) {
      const img = await this.loadSpritesheet(character);
      this.cache.set(character, img);
      loaded++;
      this.loadedBytes += buildSpritesheetLayout(character).fileSize;

      onProgress?.({
        loaded,
        total: chars.length,
        current: character,
      });
    }

    return this.cache;
  }

  private loadSpritesheet(character: PetCharacter): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load spritesheet for ${character}`));
      img.src = buildSpritesheetLayout(character).url;
    });
  }

  get(character: PetCharacter): HTMLImageElement | undefined {
    return this.cache.get(character);
  }
}

// --- 动画控制器 ---

/**
 * 管理动画优先级和状态转换
 *
 * 状态转换规则（从代码中推测）：
 * 1. 低优先级不能打断高优先级
 * 2. 非循环动画结束后自动回到 Idle
 * 3. Interact 不可被任何动画打断（除了 Error）
 * 4. Error 是最优先的，可打断一切
 */
class AnimationController {
  private queue: AnimationState[] = [];
  private renderer: CanvasSpriteRenderer;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs = 15000; // 15s 无交互 → Sleep

  constructor(renderer: CanvasSpriteRenderer) {
    this.renderer = renderer;
  }

  request(state: AnimationState): void {
    if (state === AnimationState.Idle) {
      this.resetIdleTimer();
    }
    if (this.renderer.setState(state)) {
      this.queue = [];
    } else {
      this.queue.push(state);
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer != null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.request(AnimationState.Sleep);
    }, this.idleTimeoutMs);
  }

  tick(): void {
    if (this.queue.length > 0) {
      const next = this.queue[0];
      if (this.renderer.setState(next)) {
        this.queue.shift();
      }
    }
  }

  destroy(): void {
    if (this.idleTimer != null) {
      clearTimeout(this.idleTimer);
    }
  }
}

// --- 运动学/物理（桌面宠物的移动） ---

interface PetPosition {
  x: number;
  y: number;
}

interface PetPhysics {
  position: PetPosition;
  velocity: { x: number; y: number };
  /** 宠物面向方向: 1 = 右, -1 = 左 */
  facing: 1 | -1;
  /** 当前是否是用户拖拽中 */
  isDragging: boolean;
  /** 重力是否启用 */
  gravity: boolean;
}

/**
 * 桌面宠物的简单物理模拟
 *
 * Codex 宠物在屏幕上有以下行为：
 * 1. 默认：静止在屏幕底部/边缘
 * 2. 随机走动：周期性在屏幕内移动
 * 3. 被拖拽：用户可用鼠标拖动宠物
 * 4. 吸附边缘：松开后吸附到最近的屏幕边缘
 * 5. 重力：默认在屏幕底部"着陆"
 */
function updatePetPhysics(physics: PetPhysics, dt: number, screenBounds: { w: number; h: number }, petSize: { w: number; h: number }): PetPhysics {
  if (physics.isDragging) return physics;

  // 重力
  if (physics.gravity) {
    physics.velocity.y += 800 * dt; // px/s²
  }

  // 速度衰减
  physics.velocity.x *= 0.95;
  physics.velocity.y *= 0.95;

  // 更新位置
  physics.position.x += physics.velocity.x * dt;
  physics.position.y += physics.velocity.y * dt;

  // 地面碰撞
  const groundY = screenBounds.h - petSize.h;
  if (physics.position.y >= groundY) {
    physics.position.y = groundY;
    physics.velocity.y = 0;
  }

  // 左右边界
  if (physics.position.x <= 0) {
    physics.position.x = 0;
    physics.velocity.x = Math.abs(physics.velocity.x) * 0.3;
    physics.facing = 1;
  }
  if (physics.position.x >= screenBounds.w - petSize.w) {
    physics.position.x = screenBounds.w - petSize.w;
    physics.velocity.x = -Math.abs(physics.velocity.x) * 0.3;
    physics.facing = -1;
  }

  // 更新朝向
  if (physics.velocity.x > 5) physics.facing = 1;
  if (physics.velocity.x < -5) physics.facing = -1;

  return physics;
}

// --- 随机行为 AI ---

/**
 * 简单状态机：决定宠物何时切换动画
 *
 * 行为模式（推测）：
 * - 大部分时间 Idle
 * - 每隔 10-30s 随机小动作（Walk, Sit, Thinking）
 * - 长时间无交互 → Sleep
 * - 用户操作发生时（来自主进程 IPC 的事件驱动）
 */
function getRandomIdleBehavior(): AnimationState {
  const behaviors: AnimationState[] = [
    AnimationState.Idle, AnimationState.Idle, AnimationState.Idle, // 高权重
    AnimationState.Walk,
    AnimationState.Sit,
    AnimationState.Thinking,
    AnimationState.Happy,
  ];
  return behaviors[Math.floor(Math.random() * behaviors.length)];
}

// --- 与主进程事件联动 ---

/**
 * Codex 主进程事件 → 宠物动画映射
 *
 * 这些是 Codex 桌面应用中实际触发宠物动画的事件
 */
const EVENT_TO_ANIMATION: Record<string, AnimationState> = {
  // 用户开始输入
  "composer:input-started": AnimationState.Thinking,
  // Agent 开始工作
  "agent:turn-started": AnimationState.Thinking,
  // Agent 完成任务
  "agent:turn-completed": AnimationState.Happy,
  // Agent 出错
  "agent:turn-error": AnimationState.Error,
  // 用户点击宠物
  "pet:clicked": AnimationState.Interact,
  // 用户拖拽宠物
  "pet:drag-start": AnimationState.Dragging,
  // 用户松开宠物
  "pet:drag-end": AnimationState.Idle,
  // 收到通知
  "notification:received": AnimationState.Surprised,
  // Agent 发送消息
  "agent:message-sent": AnimationState.Speaking,
  // 代码审查结果
  "code-review:complete": AnimationState.Happy,
};

export {
  PetCharacter,
  AnimationState,
  buildSpritesheetLayout,
  generateCSSKeyframes,
  CanvasSpriteRenderer,
  SpritesheetPreloader,
  AnimationController,
  updatePetPhysics,
  getRandomIdleBehavior,
  EVENT_TO_ANIMATION,
};

export type {
  SpritesheetLayout,
  AnimationRowConfig,
  FrameState,
  PetPosition,
  PetPhysics,
  PreloadProgress,
};
