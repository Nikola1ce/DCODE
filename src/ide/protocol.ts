// DCODE IDE 集成 —— 进程间通信（IPC）协议定义。
// 本文件是「VSCode 扩展（客户端）」与「dcode --ide-server 子进程（服务端）」之间的通信契约：
// 双方通过子进程的 stdin/stdout 以「换行分隔的 JSON（NDJSON，每行一个 JSON 对象）」收发消息。
// 之所以独立成协议文件，是为了让扩展侧与内核侧共享同一套类型（扩展子项目会从此处复制/引用类型），
// 避免两端字段漂移。设计原则：
//   1. 服务端不重复实现任何 Agent 逻辑，只把现有 AgentRunEvent 序列化转发；
//   2. 权限请求（写文件/执行命令等）通过「服务端→客户端 request + 客户端→服务端 response」往返，
//      从而支持在 IDE 内弹窗逐次确认（而非终端）；
//   3. 所有消息都带 type 判别字段，便于在两端做穷尽式 switch 与类型收窄。
// 制作人：Moriarty_Dox

import type { PermissionDecision, PermissionRequest } from '../core/types.js'

// 当前协议版本号。客户端连接后服务端会在 ready 消息里回传此值，
// 两端大版本不一致时客户端可据此给出升级提示（向后兼容的小改动不提升大版本）。
export const IDE_PROTOCOL_VERSION = 1

// IDE 服务端启动时使用的权限模式（与 config.PermissionMode 对齐，单独列出避免循环依赖语义）。
// - default：写文件/执行命令前发起权限请求（IDE 内弹窗确认）；
// - acceptEdits：自动允许文件读写，命令等仍需确认（扩展默认值）；
// - plan：只读规划模式，禁止任何写入/执行；
// - bypass：跳过所有确认（危险）。
export type IdePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// —— 客户端 → 服务端 的消息（请求/指令） —— //

// 发起一轮对话：把用户输入交给 Agent 主循环执行。
export interface ClientPromptMessage {
  type: 'prompt'
  // 客户端生成的轮次 id，用于把后续的流式事件、完成/错误回执关联到本轮。
  requestId: string
  // 用户输入文本（可能由扩展拼接了选区代码、文件路径等上下文）。
  text: string
}

// 中断当前正在进行的一轮对话（对应终端里的 Esc）。
export interface ClientCancelMessage {
  type: 'cancel'
  // 要中断的轮次 id；省略则中断当前进行中的轮次。
  requestId?: string
}

// 对服务端权限请求的回执（用户在 IDE 弹窗中点了允许/总是允许/拒绝）。
export interface ClientPermissionResponseMessage {
  type: 'permission_response'
  // 与服务端 permission_request 的 id 对应。
  permissionId: string
  // 用户决策。
  decision: PermissionDecision
}

// 运行期切换权限模式（对应终端 /plan、/auto 等）。
export interface ClientSetPermissionModeMessage {
  type: 'set_permission_mode'
  mode: IdePermissionMode
}

// 运行期切换模型（对应终端 /model）。
export interface ClientSetModelMessage {
  type: 'set_model'
  model: string
}

// 清空当前会话上下文（对应终端 /clear）。
export interface ClientClearMessage {
  type: 'clear'
}

// 优雅关闭服务端（扩展停用/面板关闭时发送）。
export interface ClientShutdownMessage {
  type: 'shutdown'
}

// 客户端可发送的全部消息联合类型。
export type ClientMessage =
  | ClientPromptMessage
  | ClientCancelMessage
  | ClientPermissionResponseMessage
  | ClientSetPermissionModeMessage
  | ClientSetModelMessage
  | ClientClearMessage
  | ClientShutdownMessage

// —— 服务端 → 客户端 的消息（事件/回执） —— //

// 服务端就绪（启动并完成 Agent 初始化后第一条消息）。
export interface ServerReadyMessage {
  type: 'ready'
  // 协议版本，供客户端校验兼容性。
  protocolVersion: number
  // dcode 产品版本。
  version: string
  // 当前生效模型名。
  model: string
  // 当前 Provider 标识。
  provider: string
  // 当前权限模式。
  permissionMode: IdePermissionMode
  // 工作目录（绝对路径）。
  cwd: string
  // 是否已配置可用 API Key；为 false 时客户端应提示用户去配置。
  hasApiKey: boolean
  // 当前会话 id（用于 dcode -c 续聊；无持久化时为 null）。
  sessionId: string | null
}

// 思维链（reasoning）增量。仅推理模型会产生。
export interface ServerReasoningMessage {
  type: 'reasoning'
  requestId: string
  delta: string
}

// 正文文本增量。
export interface ServerTextMessage {
  type: 'text'
  requestId: string
  delta: string
}

// 某次工具调用开始。
export interface ServerToolStartMessage {
  type: 'tool_start'
  requestId: string
  // 工具调用 id（同一轮内唯一）。
  toolCallId: string
  // 工具名（如 read_file / run_command）。
  name: string
  // 一行人类可读摘要（如「读取 src/index.ts」）。
  summary: string
}

// 工具执行过程中的实时进度（如命令的增量输出）。
export interface ServerToolProgressMessage {
  type: 'tool_progress'
  requestId: string
  toolCallId: string
  text: string
}

// 某次工具调用结束。
export interface ServerToolEndMessage {
  type: 'tool_end'
  requestId: string
  toolCallId: string
  name: string
  // 是否为错误结果（影响客户端配色）。
  isError: boolean
  // 终端展示用的简短摘要（缺省时客户端可截断 detail）。
  summary?: string
  // 工具回传给模型的完整文本（客户端可折叠展示）。
  detail?: string
}

// 服务端发起权限请求：等待客户端 permission_response。
export interface ServerPermissionRequestMessage {
  type: 'permission_request'
  requestId: string
  // 本次权限请求的唯一 id，客户端回执时原样带回。
  permissionId: string
  // 权限请求详情（工具名、标题、预览、白名单规则键）。
  request: PermissionRequest
}

// 一轮对话正常结束。
export interface ServerTurnDoneMessage {
  type: 'turn_done'
  requestId: string
  // 结束原因：正常结束 / 达到最大迭代 / 被中断。
  reason: 'final' | 'max_iterations' | 'aborted'
  // 本轮累计成本（美元，估算；免费模型为 0）。
  costUsd: number
  // 本轮使用的 token 统计（可选）。
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

// 一轮对话执行出错（如网络/鉴权失败）。
export interface ServerTurnErrorMessage {
  type: 'turn_error'
  requestId: string
  message: string
}

// 服务端状态变更通知（模型/权限模式/会话被切换后回推，便于客户端刷新 UI）。
export interface ServerStatusMessage {
  type: 'status'
  model: string
  provider: string
  permissionMode: IdePermissionMode
  sessionId: string | null
}

// 服务端日志/系统消息（非致命提示，如已清空上下文）。
export interface ServerLogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

// 服务端可发送的全部消息联合类型。
export type ServerMessage =
  | ServerReadyMessage
  | ServerReasoningMessage
  | ServerTextMessage
  | ServerToolStartMessage
  | ServerToolProgressMessage
  | ServerToolEndMessage
  | ServerPermissionRequestMessage
  | ServerTurnDoneMessage
  | ServerTurnErrorMessage
  | ServerStatusMessage
  | ServerLogMessage

/**
 * 把一条消息编码为 NDJSON 行（JSON 字符串 + 换行符）。
 * 两端写出消息时统一调用，确保「一行一条消息」的帧约定。
 * @param msg 要发送的消息对象。
 * @returns 形如 `{"type":"text",...}\n` 的字符串。
 */
export function encodeMessage(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * 解析一行文本为消息对象。
 * 仅做 JSON.parse 与基本对象校验，不强约束具体 type（由调用方按联合类型收窄）。
 * @param line 单行文本（不含换行符）。
 * @returns 解析出的对象；空行或非法 JSON 返回 null。
 */
export function decodeMessage<T = ClientMessage | ServerMessage>(
  line: string,
): T | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as T
    }
    return null
  } catch {
    return null
  }
}

/**
 * 创建一个「按行切分」的流式解码器。
 * stdin/stdout 的 data 事件可能把多条 NDJSON 拆成任意 chunk（半行/多行混合），
 * 该解码器维护缓冲区，按 \n 切分并逐行解析，正确处理跨 chunk 的半行。
 *
 * 用法：
 *   const decoder = createLineDecoder<ClientMessage>()
 *   stream.on('data', (buf) => { for (const msg of decoder.push(buf)) handle(msg) })
 *
 * @returns 含 push(chunk) 方法的解码器；push 返回本次新解析出的完整消息数组。
 */
export function createLineDecoder<T = ClientMessage | ServerMessage>() {
  // 跨 chunk 的未完成行缓冲。
  let buffer = ''
  return {
    /**
     * 喂入一段原始数据，返回本次新解析出的消息（可能为空）。
     * @param chunk Buffer 或字符串数据块。
     * @returns 本次切分出的完整消息数组。
     */
    push(chunk: Buffer | string): T[] {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const out: T[] = []
      let idx: number
      // 循环提取所有以 \n 结尾的完整行，剩余半行留在 buffer 等待后续 chunk。
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const msg = decodeMessage<T>(line)
        if (msg) out.push(msg)
      }
      return out
    },
  }
}
