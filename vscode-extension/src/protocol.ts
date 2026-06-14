// DCODE VS Code 扩展 —— IPC 协议（与内核 src/ide/protocol.ts 保持一致的镜像）。
// 扩展子项目与主项目使用不同的模块系统（CJS vs ESM）且独立打包，无法直接跨项目 import，
// 因此在此维护一份「同字段」的协议类型与编解码工具。两端任一处改协议都需同步另一处。
// 协议形态：通过 dcode --ide-server 子进程的 stdin/stdout，以「换行分隔 JSON（NDJSON）」双向通信。
// 制作人：Moriarty_Dox

// 当前协议版本号（与内核常量一致）。
// v2：新增斜杠命令与命令补全相关消息（slash_command / request_commands /
//     command_suggestions / command_result），以及 prompt 的上下文附件（attachments）。
// v3：ready/status 携带可用供应商列表（providers）与当前供应商下的模型列表（models），
//     并新增 set_provider 指令，支撑面板「点击切换模型 / 点击切换供应商」。
// v4：新增「面板内 /login」——服务端 login_prompt + 客户端 submit_api_key，
//     面板可直接录入并保存 API Key，无需跳转终端。
export const IDE_PROTOCOL_VERSION = 4

// 权限决策：允许一次 / 总是允许 / 拒绝（与内核 PermissionDecision 对齐）。
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

// IDE 权限模式（与内核 IdePermissionMode 对齐）。
export type IdePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// 上下文附件：拖拽到对话面板或右键加入的文件/选区引用（与内核 ContextAttachment 对齐）。
export interface ContextAttachment {
  // 附件类型：整文件引用 / 选区代码片段。
  kind: 'file' | 'selection'
  // 相对工作区的路径（展示与提示模型用）。
  path: string
  // 选区起止行（1 基，仅 selection 携带）。
  startLine?: number
  endLine?: number
  // 选区代码片段（仅 selection 携带）。
  snippet?: string
  // 语言标识（可选）。
  languageId?: string
}

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
  // 随本轮一并提供的上下文附件（拖拽文件、右键加入的选区等）。
  attachments?: ContextAttachment[]
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

// 运行期切换 LLM 供应商（对应终端 /provider）。服务端切换后回推 status 刷新面板。
export interface ClientSetProviderMessage {
  type: 'set_provider'
  // 目标供应商标识（zhipu / deepseek / openai 等）。
  provider: string
}

export interface ClientClearMessage {
  type: 'clear'
}

// 执行一条本地斜杠命令（对应终端 /help、/model、/commit、/review 等）。
export interface ClientSlashCommandMessage {
  type: 'slash_command'
  // 轮次 id：命令转 prompt（如 /commit）时复用。
  requestId: string
  // 完整命令输入（含前导 /）。
  input: string
}

// 请求斜杠命令补全候选（用户键入 / 前缀时）。
export interface ClientRequestCommandsMessage {
  type: 'request_commands'
  // 关联本次补全请求；服务端原样带回，便于丢弃过期响应。
  queryId: string
  // 当前输入框内容（含前导 /）。
  input: string
}

// 提交 API Key（面板内 /login 录入完成时发送）。服务端保存到 providers[provider].apiKey
// 并热更新 Agent，随后回推 command_result 与 status。
export interface ClientSubmitApiKeyMessage {
  type: 'submit_api_key'
  // 目标供应商标识（通常取自先前的 login_prompt）。
  provider: string
  // 用户输入的 API Key。
  apiKey: string
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
  | ClientSetProviderMessage
  | ClientClearMessage
  | ClientSlashCommandMessage
  | ClientRequestCommandsMessage
  | ClientSubmitApiKeyMessage
  | ClientShutdownMessage

// —— 服务端 → 客户端 —— //

// 可切换的供应商选项（面板「切换供应商」下拉菜单数据，随 ready/status 下发）。
export interface ProviderOption {
  // 供应商标识（zhipu / deepseek / openai 等）。
  id: string
  // 展示名（如「智谱AI」）。
  name: string
  // 一句话说明（如「切换到智谱AI（免费）」）。
  description: string
  // 是否为当前生效供应商。
  active: boolean
  // 是否已具备可用 API Key（环境变量或已保存）。
  hasApiKey: boolean
}

// 可选择的模型选项（面板「切换模型」下拉菜单数据，随 ready/status 下发）。
export interface ModelOption {
  // 模型 id（切换时回传给 set_model）。
  value: string
  // 展示标签。
  label: string
  // 右侧灰色提示（可选）。
  hint?: string
  // 是否为当前生效模型。
  active: boolean
}

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
  // 可切换供应商列表（v3+）。
  providers?: ProviderOption[]
  // 当前供应商下的模型列表（v3+）。
  models?: ModelOption[]
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
  // 可切换供应商列表（v3+）。
  providers?: ProviderOption[]
  // 当前供应商下的模型列表（v3+）。
  models?: ModelOption[]
}

export interface ServerLogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

// 单条命令补全候选（与内核 CommandSuggestionItem 对齐）。
export interface CommandSuggestionItem {
  name: string
  description: string
  completion: string
  aliases?: string[]
}

// 服务端回传斜杠命令补全候选（响应 request_commands）。
export interface ServerCommandSuggestionsMessage {
  type: 'command_suggestions'
  queryId: string
  suggestions: CommandSuggestionItem[]
}

// 本地斜杠命令的执行结果（不触发 Agent 任务的那一类）。
export interface ServerCommandResultMessage {
  type: 'command_result'
  requestId: string
  // 要展示的系统消息文本。
  message?: string
  // 是否清空了会话上下文。
  cleared?: boolean
  // 是否已转为一轮 prompt 在后台执行（true 时客户端进入处理中态）。
  submitted?: boolean
  // 是否为「引导提示」（面板内无法完成、引导到终端/设置）。
  hint?: boolean
}

// 服务端请求客户端打开「API Key 录入界面」（面板内 /login）。
export interface ServerLoginPromptMessage {
  type: 'login_prompt'
  // 供应商标识（提交时原样带回）。
  providerId: string
  // 供应商展示名（标题用）。
  providerName: string
  // 获取 Key 的平台链接（可空）。
  platformUrl: string
  // 当前 API 端点（展示用）。
  baseURL: string
  // 对应环境变量名（提示用）。
  apiKeyEnv: string
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
  | ServerCommandSuggestionsMessage
  | ServerCommandResultMessage
  | ServerLoginPromptMessage

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
