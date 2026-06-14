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
// v2：新增斜杠命令（slash_command / request_commands）与命令补全（command_suggestions /
//     command_result）相关消息，使 VSCode 扩展可复用 CLI 的本地命令系统。
// v3：ready/status 携带「可用供应商列表（providers）」与「当前供应商下的模型列表（models）」，
//     并新增 set_provider 指令，使扩展面板可做「点击切换模型 / 点击切换供应商」的下拉菜单。
// v4：新增「面板内 /login」交互——服务端 login_prompt（请求录入 Key）+ 客户端 submit_api_key
//     （提交 Key），使 VSCode 面板可直接输入并保存 API Key，无需再跳转终端。
export const IDE_PROTOCOL_VERSION = 4

// IDE 服务端启动时使用的权限模式（与 config.PermissionMode 对齐，单独列出避免循环依赖语义）。
// - default：写文件/执行命令前发起权限请求（IDE 内弹窗确认）；
// - acceptEdits：自动允许文件读写，命令等仍需确认（扩展默认值）；
// - plan：只读规划模式，禁止任何写入/执行；
// - bypass：跳过所有确认（危险）。
export type IdePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// —— 客户端 → 服务端 的消息（请求/指令） —— //

// 上下文附件：拖拽到对话面板或右键加入的文件/选区引用。
// 设计为「轻量引用」：默认只把相对路径告诉模型，由模型按需用 read_file 自行读取（更省 token）；
// 选区场景可携带 snippet 直接内联展示。
export interface ContextAttachment {
  // 附件类型：整文件引用 / 选区代码片段。
  kind: 'file' | 'selection'
  // 相对工作区的路径（展示与提示模型用）。
  path: string
  // 选区起止行（1 基，仅 selection 携带，用于提示模型聚焦范围）。
  startLine?: number
  endLine?: number
  // 选区代码片段（仅 selection 携带，内联给模型）。
  snippet?: string
  // 语言标识（用于片段围栏，可选）。
  languageId?: string
}

// 发起一轮对话：把用户输入交给 Agent 主循环执行。
export interface ClientPromptMessage {
  type: 'prompt'
  // 客户端生成的轮次 id，用于把后续的流式事件、完成/错误回执关联到本轮。
  requestId: string
  // 用户输入文本（可能由扩展拼接了选区代码、文件路径等上下文）。
  text: string
  // 随本轮一并提供的上下文附件（拖拽的文件、右键加入的选区等）。
  // 服务端会把它们转写为一段「上下文清单」前缀拼接到 text 之前，引导模型按需读取。
  attachments?: ContextAttachment[]
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

// 运行期切换 LLM 供应商（对应终端 /provider）。
// 服务端会复用 buildProviderSwitchPatch 计算补丁（含 baseURL、必要时切换默认模型）并持久化热更新，
// 随后回推一条 status（携带新的 provider / model / models 列表）让面板刷新。
export interface ClientSetProviderMessage {
  type: 'set_provider'
  // 目标供应商标识（zhipu / deepseek / openai 等）。
  provider: string
}

// 清空当前会话上下文（对应终端 /clear）。
export interface ClientClearMessage {
  type: 'clear'
}

// 执行一条本地斜杠命令（对应终端里的 /help、/model、/commit、/review 等）。
// 服务端复用 CLI 的 runSlashCommand：能本地处理的（如 /clear、/cost、/config）直接回 command_result；
// 会触发 Agent 任务的（如 /init、/commit、/review）则转为一轮普通 prompt 执行（带 requestId）。
export interface ClientSlashCommandMessage {
  type: 'slash_command'
  // 轮次 id：当命令需要代为提交 prompt（如 /commit）时，复用它关联后续流式事件。
  requestId: string
  // 完整命令输入（含前导 /，如 "/model glm-4-flash"）。
  input: string
}

// 请求斜杠命令补全候选（用户在输入框键入 / 前缀时）。
export interface ClientRequestCommandsMessage {
  type: 'request_commands'
  // 关联本次补全请求的 id，服务端在 command_suggestions 中原样带回。
  queryId: string
  // 当前输入框内容（含前导 /，如 "/mo" 或 "/model "）。
  input: string
}

// 提交 API Key（对应终端 /login 弹窗里输入并回车）。
// 由客户端在收到服务端 login_prompt 后、用户在面板内输入完成时发送；服务端复用
// buildProviderLoginPatch 把 Key 写入 providers[providerId].apiKey 并热更新 Agent，
// 随后回推 command_result（成功/失败提示）与 status（刷新 hasApiKey）。
export interface ClientSubmitApiKeyMessage {
  type: 'submit_api_key'
  // 目标供应商标识（zhipu / deepseek / openai 等）；通常取自先前的 login_prompt。
  provider: string
  // 用户输入的 API Key（明文，仅在本机进程间传递并落盘到 ~/.dcode/config.json）。
  apiKey: string
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
  | ClientSetProviderMessage
  | ClientClearMessage
  | ClientSlashCommandMessage
  | ClientRequestCommandsMessage
  | ClientSubmitApiKeyMessage
  | ClientShutdownMessage

// —— 服务端 → 客户端 的消息（事件/回执） —— //

// 可切换的供应商选项（供面板「点击切换供应商」下拉菜单使用）。
// 数据源为 registry 的 PROVIDER_SWITCH_OPTIONS + BUILTIN_PROVIDERS，
// 服务端在 ready/status 时一并下发，避免扩展侧重复维护一份供应商目录。
export interface ProviderOption {
  // 供应商标识（zhipu / deepseek / openai 等）。
  id: string
  // 展示名（如「智谱AI」「DeepSeek」「OpenAI」）。
  name: string
  // 一句话说明（如「切换到智谱AI（免费）」）。
  description: string
  // 是否为当前生效供应商（面板用于打勾标记）。
  active: boolean
  // 是否已具备可用 API Key（环境变量或已保存）；为 false 时面板可提示需 /login。
  hasApiKey: boolean
}

// 可选择的模型选项（供面板「点击切换模型」下拉菜单使用）。
// 数据源为 registry 的 getModelSelectOptions（按当前供应商给出建议模型 + hint）。
export interface ModelOption {
  // 模型 id（切换时回传给 set_model 的值）。
  value: string
  // 展示标签（可能带格式化，如智谱模型的友好名）。
  label: string
  // 右侧灰色提示（如「默认 · 快速且经济」「多档上下文」）。
  hint?: string
  // 是否为当前生效模型（面板用于打勾标记）。
  active: boolean
}

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
  // 可切换的供应商列表（v3+）。旧客户端忽略此字段。
  providers?: ProviderOption[]
  // 当前供应商下的可选模型列表（v3+）。旧客户端忽略此字段。
  models?: ModelOption[]
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
  // 可切换的供应商列表（v3+）：切换供应商后名单的 active/hasApiKey 会变化，需随 status 一并下发。
  providers?: ProviderOption[]
  // 当前供应商下的可选模型列表（v3+）：切换供应商或模型后随 status 刷新。
  models?: ModelOption[]
}

// 服务端日志/系统消息（非致命提示，如已清空上下文）。
export interface ServerLogMessage {
  type: 'log'
  level: 'info' | 'warn' | 'error'
  message: string
}

// 单条命令补全候选（与 CLI CommandSuggestion 字段一致）。
export interface CommandSuggestionItem {
  // 展示用短标签（命令名或参数名）。
  name: string
  // 命令说明。
  description: string
  // 补全/回车时写入输入框的完整命令（含前导 /）。
  completion: string
  // 别名（可选）。
  aliases?: string[]
}

// 服务端回传斜杠命令补全候选（响应 request_commands）。
export interface ServerCommandSuggestionsMessage {
  type: 'command_suggestions'
  // 与请求的 queryId 对应；客户端用它丢弃过期的补全响应。
  queryId: string
  // 候选列表（可能为空）。
  suggestions: CommandSuggestionItem[]
}

// 本地斜杠命令的执行结果（不触发 Agent 任务的那一类，如 /help、/cost、/config、/clear）。
export interface ServerCommandResultMessage {
  type: 'command_result'
  // 与 slash_command 的 requestId 对应。
  requestId: string
  // 要在面板内作为系统消息展示的文本（可选）。
  message?: string
  // 该命令是否清空了会话上下文（客户端据此清屏）。
  cleared?: boolean
  // 该命令是否已转为一轮 prompt 在后台执行（true 时客户端应进入「处理中」态，
  // 等待后续 text/tool/turn_done 事件，而非把它当作一次性结果）。
  submitted?: boolean
  // 客户端无法在面板内完成、需引导用户改用终端/设置的提示（如 /login、/resume、/theme、/exit）。
  // 为 true 时客户端把 message 作为「提示」而非「结果」展示。
  hint?: boolean
}

// 服务端请求客户端「打开 API Key 录入界面」（对应终端 /login 的弹窗）。
// 服务端在处理 /login（或检测到需要登录）时发送，携带当前供应商的展示元信息，
// 客户端据此弹出一个安全的掩码输入框，让用户在面板内直接输入 Key 并通过 submit_api_key 回传。
export interface ServerLoginPromptMessage {
  type: 'login_prompt'
  // 供应商标识（zhipu / deepseek / openai 等）；客户端提交时原样带回。
  providerId: string
  // 供应商展示名（如「智谱AI」），用于标题文案。
  providerName: string
  // 获取 Key 的平台链接（可空）；客户端可渲染为可点击链接，方便用户去申请。
  platformUrl: string
  // 当前 API 端点（展示用，便于用户确认环境）。
  baseURL: string
  // 对应的环境变量名（如 ZHIPU_API_KEY）；提示用户也可用环境变量配置。
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
