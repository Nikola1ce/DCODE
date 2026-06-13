// DCODE 核心类型定义。
// 集中定义贯穿全程序的数据结构：标准化消息、工具调用、工具结果、工具接口、
// 工具运行上下文以及权限请求/决策类型。这些类型在 Agent 主循环、工具实现、
// UI 渲染、会话持久化之间共享，是整套架构的“通用语言”。
// 制作人：Moriarty_Dox

import type { DCodeConfig, PermissionMode } from '../config.js'
import type { DeepSeekUsage } from '../deepseek/pricing.js'

// 消息角色：与 OpenAI Chat Completions 对齐，便于直接转换为 API 请求体。
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

// 模型发起的一次工具调用（function call）。
export interface ToolCall {
  // 工具调用唯一 id，由模型/客户端生成，用于把工具结果回填给对应调用。
  id: string
  // 工具名称，需与已注册工具的 name 一致。
  name: string
  // 工具入参的原始 JSON 字符串（流式拼接得到，使用前需 JSON.parse）。
  argsJson: string
}

/**
 * 标准化的内部消息结构。
 * 不直接使用 OpenAI 的类型，是为了附加 reasoning（思维链）等 UI 所需字段，
 * 并在发送前由 deepseek/client 转换为严格的 API 消息体。
 */
export interface DeepMessage {
  // 消息角色。
  role: MessageRole
  // 文本内容（assistant 在仅工具调用时可能为空字符串）。
  content: string
  // 仅 assistant：本轮发起的工具调用列表。
  toolCalls?: ToolCall[]
  // 仅 tool：该结果对应的工具调用 id。
  toolCallId?: string
  // 仅 tool：对应的工具名称（用于 UI 展示）。
  toolName?: string
  // 仅 assistant（deepseek-reasoner）：思维链内容，仅用于展示，不回传给 API。
  reasoning?: string
  // 该 tool 结果是否为错误结果（影响 UI 配色）。
  isError?: boolean
  // 时间戳（毫秒），用于会话回放与排序。
  timestamp?: number
  // 内部元信息：用于区分压缩摘要、合成错误等非用户/模型原生消息。
  metadata?: {
    kind?: 'summary' | 'synthetic_error'
    source?: 'model' | 'tool' | 'system'
  }
}

/**
 * 工具执行结果。
 * llmContent 回传给模型作为 tool 消息内容；uiSummary 仅供终端展示。
 */
export interface ToolResult {
  // 回传给模型的文本内容（工具的“可见输出”）。
  llmContent: string
  // 终端展示用的简短摘要（可选，缺省时由 UI 截断 llmContent）。
  uiSummary?: string
  // 是否为错误结果。
  isError?: boolean
}

// 权限决策结果：允许一次 / 总是允许（记入白名单）/ 拒绝。
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

/**
 * 工具在执行前向用户发起的权限请求描述。
 * UI 据此渲染确认弹窗；无头模式据此决定自动放行或拒绝。
 */
export interface PermissionRequest {
  // 发起请求的工具名。
  toolName: string
  // 操作的一句话描述，例如“写入文件 src/index.ts”。
  title: string
  // 详细预览（可选）：如 diff、将执行的命令等。
  preview?: string
  // 用于记入白名单的规则标识，例如 "Write" 或 "Bash(git status)"。
  ruleKey: string
}

/**
 * 工具运行上下文。
 * 由 Agent 主循环构造并传入每个工具，承载工作目录、配置、取消信号、
 * 权限请求回调以及共享的待办列表状态等。
 */
export interface ToolContext {
  // 当前工作目录（绝对路径）。
  cwd: string
  // 经 /add-dir 额外授权的工作目录（绝对路径）。文件工具可在这些目录内读写。
  extraDirs?: string[]
  // 当前生效的完整配置。
  config: DCodeConfig
  // 当前权限模式（可能在运行期被 /plan 等命令切换）。
  permissionMode: PermissionMode
  // 取消信号：用户中断（Esc/Ctrl+C）时触发，工具应尽快停止。
  abortSignal: AbortSignal
  // 向用户请求权限的回调；无头模式下由调用方提供自动策略实现。
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>
  // 共享的待办事项列表（TodoWrite 工具读写，UI 据此渲染任务进度）。
  todos: TodoItem[]
  // 更新待办列表的回调（替换整份列表）。
  setTodos: (todos: TodoItem[]) => void
  // 流式进度回调：工具执行过程中可推送中间信息到 UI（如命令实时输出）。
  onProgress?: (text: string) => void
  // 当前会话 id（Hooks 与会话持久化用，可选）。
  sessionId?: string | null
}

// 工具副作用与调度策略。缺省时由 readOnly 推断为 none / unknown。
export interface ToolSafetyPolicy {
  sideEffect: 'none' | 'fs_write' | 'shell' | 'network' | 'subagent' | 'state'
  concurrencyKey?: string
  parallelSafe?: boolean
}

// 上下文预算策略。当前只使用 tokenThreshold，预留给 repo map / context pack。
export interface ContextPolicy {
  tokenThreshold?: number
}

// Agent 单次 run 的简要追踪信息。
export interface AgentRunTrace {
  runId: string
  turnId: string
  startedAt: number
  endedAt?: number
  iterations: number
  finishReason?: string
  usage?: DeepSeekUsage
  costUsd?: number
  error?: string
}

// AgentRunner 对外产出的结构化事件。UI/headless 可继续使用 TurnHandlers；
// 新消费者可直接订阅 onEvent / SessionRecorder event 行。
export type AgentRunEvent =
  | { type: 'run_start'; runId: string; turnId: string; timestamp: number }
  | { type: 'turn_start'; runId: string; turnId: string; timestamp: number; userInput: string }
  | { type: 'compact_start'; runId: string; turnId: string; iteration: number; timestamp: number; messageCount: number }
  | { type: 'compact_end'; runId: string; turnId: string; iteration: number; timestamp: number; beforeCount: number; afterCount: number }
  | { type: 'llm_start'; runId: string; turnId: string; iteration: number; timestamp: number; model: string; toolCount: number }
  | { type: 'reasoning_delta'; runId: string; turnId: string; iteration: number; timestamp: number; delta: string }
  | { type: 'text_delta'; runId: string; turnId: string; iteration: number; timestamp: number; delta: string }
  | {
      type: 'llm_done'
      runId: string
      turnId: string
      iteration: number
      timestamp: number
      message: DeepMessage
      finishReason: string
      usage?: DeepSeekUsage
      costUsd?: number
      durationMs: number
    }
  | { type: 'assistant_message'; runId: string; turnId: string; iteration: number; timestamp: number; message: DeepMessage }
  | { type: 'tool_batch_start'; runId: string; turnId: string; iteration: number; timestamp: number; count: number }
  | {
      type: 'tool_start'
      runId: string
      turnId: string
      iteration: number
      timestamp: number
      id: string
      name: string
      summary: string
    }
  | { type: 'tool_progress'; runId: string; turnId: string; iteration: number; timestamp: number; id: string; text: string }
  | {
      type: 'tool_end'
      runId: string
      turnId: string
      iteration: number
      timestamp: number
      id: string
      name: string
      result: ToolResult
      durationMs: number
    }
  | { type: 'tool_message'; runId: string; turnId: string; iteration: number; timestamp: number; message: DeepMessage }
  | { type: 'iteration_end'; runId: string; turnId: string; iteration: number; timestamp: number; toolCount: number }
  | { type: 'run_end'; runId: string; turnId: string; timestamp: number; iterations: number; reason: 'final' | 'max_iterations' | 'aborted' }
  | { type: 'run_error'; runId: string; turnId: string; iteration?: number; timestamp: number; error: string }

// 单条待办事项状态。
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

// 待办事项结构（供 TodoWrite 工具与 UI 共享）。
export interface TodoItem {
  // 任务内容描述。
  content: string
  // 当前状态。
  status: TodoStatus
}

/**
 * 工具定义接口。
 * 每个工具实现该接口后注册到工具表；Agent 据此生成 function schema 给模型，
 * 并在模型发起调用时分发执行。
 */
export interface ToolDefinition {
  // 工具名称（function name），需符合 ^[a-zA-Z0-9_-]+$。
  name: string
  // 给模型看的工具说明（描述用途、参数语义、使用约束）。
  description: string
  // 工具入参的 JSON Schema（OpenAI function parameters 格式）。
  parameters: Record<string, unknown>
  // 是否为只读工具（只读工具在 plan 模式下仍可执行）。
  readOnly: boolean
  // 调度/审计用安全策略；不影响工具 schema，对旧工具定义兼容。
  safety?: ToolSafetyPolicy
  /**
   * 判断本次调用是否需要用户授权。
   * @param input 解析后的入参对象。
   * @param ctx 运行上下文（可据 permissionMode / 白名单判断）。
   * @returns 需要授权时返回 PermissionRequest，否则返回 null。
   */
  checkPermission?: (input: any, ctx: ToolContext) => PermissionRequest | null
  /**
   * 执行工具。
   * @param input 解析后的入参对象。
   * @param ctx 运行上下文。
   * @returns 工具结果（Promise）。
   */
  run: (input: any, ctx: ToolContext) => Promise<ToolResult>
  /**
   * 生成调用时的一行 UI 摘要（例如 “读取 src/index.ts”）。
   * @param input 解析后的入参对象。
   * @returns 摘要字符串。
   */
  renderCall?: (input: any) => string
}
