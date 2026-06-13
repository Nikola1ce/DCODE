// DCODE VS Code 扩展 —— IPC 协议（与内核 src/ide/protocol.ts 保持一致的镜像）。
// 扩展子项目与主项目使用不同的模块系统（CJS vs ESM）且独立打包，无法直接跨项目 import，
// 因此在此维护一份「同字段」的协议类型与编解码工具。两端任一处改协议都需同步另一处。
// 协议形态：通过 dcode --ide-server 子进程的 stdin/stdout，以「换行分隔 JSON（NDJSON）」双向通信。
// 制作人：Moriarty_Dox

// 当前协议版本号（与内核常量一致）。
export const IDE_PROTOCOL_VERSION = 1

// 权限决策：允许一次 / 总是允许 / 拒绝（与内核 PermissionDecision 对齐）。
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

// IDE 权限模式（与内核 IdePermissionMode 对齐）。
export type IdePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// 权限请求详情（与内核 PermissionRequest 对齐）。
export interface PermissionRequest {
  // 发起请求的工具名。
  toolName: string
  // 操作的一句话描述。
  title: string
  // 详细预览（可选）：diff、将执行的命令等。
  preview?: string
  // 记入白名单的规则标识。
  ruleKey: string
}

// —— 客户端 → 服务端 —— //

export interface ClientPromptMessage {
  type: 'prompt'
  requestId: string
  text: string
}

export interface ClientCancelMessage {
  type: 'cancel'
  requestId?: string
}

export interface ClientPermissionResponseMessage {
  type: 'permission_response'
  permissionId: string
  decision: PermissionDecision
}

export interface ClientSetPermissionModeMessage {
  type: 'set_permission_mode'
  mode: IdePermissionMode
}

export interface ClientSetModelMessage {
  type: 'set_model'
  model: string
}

export interface ClientClearMessage {
  type: 'clear'
}

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

// —— 服务端 → 客户端 —— //

export interface ServerReadyMessage {
  type: 'ready'
  protocolVersion: number
  version: string
  model: string
  provider: string
  permissionMode: IdePermissionMode
  cwd: string
  hasApiKey: boolean
  sessionId: string | null
}

export interface ServerReasoningMessage {
  type: 'reasoning'
  requestId: string
  delta: string
}

export interface ServerTextMessage {
  type: 'text'
  requestId: string
  delta: string
}

export interface ServerToolStartMessage {
  type: 'tool_start'
  requestId: string
  toolCallId: string
  name: string
  summary: string
}

export interface ServerToolProgressMessage {
  type: 'tool_progress'
  requestId: string
  toolCallId: string
  text: string
}

export interface ServerToolEndMessage {
  type: 'tool_end'
  requestId: string
  toolCallId: string
  name: string
  isError: boolean
  summary?: string
  detail?: string
}

export interface ServerPermissionRequestMessage {
  type: 'permission_request'
  requestId: string
  permissionId: string
  request: PermissionRequest
}

export interface ServerTurnDoneMessage {
  type: 'turn_done'
  requestId: string
  reason: 'final' | 'max_iterations' | 'aborted'
  costUsd: number
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface ServerTurnErrorMessage {
  type: 'turn_error'
  requestId: string
  message: string
}

export interface ServerStatusMessage {
  type: 'status'
  model: string
  provider: string
  permissionMode: IdePermissionMode
  sessionId: string | null
}

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
 * 把一条客户端消息编码为 NDJSON 行。
 * @param msg 客户端消息。
 * @returns JSON 字符串 + 换行。
 */
export function encodeClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * 解析一行文本为服务端消息。
 * @param line 单行文本（不含换行）。
 * @returns 服务端消息；空行/非法 JSON 返回 null。
 */
export function decodeServerMessage(line: string): ServerMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as ServerMessage
    }
    return null
  } catch {
    return null
  }
}

/**
 * 创建一个按行切分的流式解码器，正确处理跨 chunk 的半行。
 * @returns 含 push(chunk) 的解码器；push 返回本次新解析出的服务端消息数组。
 */
export function createServerMessageDecoder() {
  let buffer = ''
  return {
    /**
     * 喂入一段数据，返回本次解析出的服务端消息。
     * @param chunk Buffer 或字符串。
     * @returns 服务端消息数组。
     */
    push(chunk: Buffer | string): ServerMessage[] {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const out: ServerMessage[] = []
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        const msg = decodeServerMessage(line)
        if (msg) out.push(msg)
      }
      return out
    },
  }
}
