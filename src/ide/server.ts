// DCODE IDE 集成 —— IPC 服务端。
// 由 `dcode --ide-server` 启动：把子进程的 stdin/stdout 变成一条「NDJSON 双向通道」，
// 桥接到现有的 Agent 主循环，从而让 VSCode 扩展复用整套内核能力（工具、MCP、Hooks、
// 检查点、多 Provider、上下文压缩）而无需重复实现。
//
// 设计要点：
//   - stdout 是「纯协议通道」：服务端只往 stdout 写 NDJSON 协议消息，其余一切日志走 stderr，
//     以免污染协议帧（因此本模式下禁用 stdout trace、并兜底劫持 console.*）。
//   - 权限请求通过「服务端 permission_request → 客户端 permission_response」往返实现，
//     使写文件/执行命令可在 IDE 内弹窗逐次确认。
//   - 单轮串行：同一时刻只跑一轮对话；新 prompt 到来时若上一轮未结束会被拒绝并提示。
// 制作人：Moriarty_Dox

import { randomUUID } from 'node:crypto'
import type { Agent } from '../core/agent.js'
import type {
  AgentRunEvent,
  PermissionDecision,
  PermissionRequest,
} from '../core/types.js'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { loadConfig, updateConfig } from '../config.js'
import {
  getSlashSuggestions,
  isSlashCommand,
  runSlashCommand,
  type CommandSuggestion,
  type SlashCommandResult,
} from '../commands/index.js'
import {
  IDE_PROTOCOL_VERSION,
  createLineDecoder,
  encodeMessage,
  type ClientMessage,
  type ContextAttachment,
  type IdePermissionMode,
  type ModelOption,
  type ProviderOption,
  type ServerMessage,
} from './protocol.js'
import { VERSION } from '../constants.js'
import {
  buildProviderLoginPatch,
  buildProviderSwitchPatch,
  getActiveProviderId,
  getModelSelectOptions,
  getProviderDefinition,
  getProviderLoginMeta,
  isValidProviderId,
  PROVIDER_SWITCH_OPTIONS,
  resolveProviderApiKey,
} from '../providers/registry.js'
import type { ProviderId } from '../providers/types.js'

// 服务端运行所需的依赖（便于测试时注入假的输入/输出流与 Agent）。
export interface IdeServerDeps {
  // Agent 实例（已在 cli 中按 cwd/config 构造好）。
  agent: Agent
  // 当前生效配置（用于斜杠命令读取/展示；server 内会随命令热更新此引用）。
  config: DCodeConfig
  // 读取客户端消息的输入流（默认 process.stdin）。
  input: NodeJS.ReadableStream
  // 写出服务端消息的输出流（默认 process.stdout，必须是纯协议通道）。
  output: NodeJS.WritableStream
  // 日志输出流（默认 process.stderr）。
  log?: NodeJS.WritableStream
  // 持久化并热更新配置的回调（默认：updateConfig 写盘 + agent.applyConfigPatch 热更新）。
  // 抽成依赖便于测试注入。
  applyConfig?: (patch: Partial<DCodeConfig>) => void
}

/**
 * IDE IPC 服务端。
 * 维护与单个客户端的会话：接收指令、驱动 Agent、转发事件、协调权限往返。
 */
export class IdeServer {
  private readonly agent: Agent
  // 当前生效配置；斜杠命令通过 applyConfig 修改后会同步刷新此引用。
  private config: DCodeConfig
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  private readonly logStream: NodeJS.WritableStream
  // 持久化 + 热更新配置的回调。
  private readonly applyConfig: (patch: Partial<DCodeConfig>) => void

  // 当前进行中的轮次 id；为 null 表示空闲。用于串行化与中断定位。
  private activeRequestId: string | null = null
  // 当前轮次的中断控制器。
  private activeAbort: AbortController | null = null
  // 待回执的权限请求：permissionId → resolve 回调。
  private readonly pendingPermissions = new Map<
    string,
    (decision: PermissionDecision) => void
  >()
  // 服务端是否已被要求关闭。
  private closed = false
  // 关闭时 resolve 的 Promise（供 start() 等待）。
  private resolveDone: (() => void) | null = null

  constructor(deps: IdeServerDeps) {
    this.agent = deps.agent
    this.config = deps.config
    this.input = deps.input
    this.output = deps.output
    this.logStream = deps.log ?? process.stderr
    // 默认实现：写盘（updateConfig）+ 热更新 Agent（applyConfigPatch），并刷新本地 config 引用。
    // 与 TUI 的 App.applyConfig 行为保持一致，确保斜杠命令在 IDE 模式下与终端一致地生效与持久化。
    this.applyConfig =
      deps.applyConfig ??
      ((patch: Partial<DCodeConfig>) => {
        const next = updateConfig(patch)
        this.config = next
        this.agent.applyConfigPatch(patch)
      })
  }

  /**
   * 启动服务端：先回送 ready，再监听输入流直到收到 shutdown 或输入流结束。
   * @returns 在服务端关闭后 resolve。
   */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve
      // 第一条消息：宣告就绪并回传当前状态，客户端据此初始化 UI。
      // 一并下发可用供应商与模型列表，使面板可直接渲染「点击切换模型 / 供应商」下拉菜单。
      this.send({
        type: 'ready',
        protocolVersion: IDE_PROTOCOL_VERSION,
        version: VERSION,
        model: this.agent.getModel(),
        provider: this.agent.getProviderId(),
        permissionMode: this.toIdeMode(this.agent.permissionMode),
        cwd: this.agent.cwd,
        hasApiKey: this.agent.hasApiKey(),
        sessionId: this.agent.getSessionId(),
        providers: this.buildProviderOptions(),
        models: this.buildModelOptions(),
      })

      const decoder = createLineDecoder<ClientMessage>()
      this.input.on('data', (chunk: Buffer | string) => {
        for (const msg of decoder.push(chunk)) {
          // 逐条处理客户端消息；处理函数内部已捕获异常，避免单条错误拖垮通道。
          void this.handleClientMessage(msg)
        }
      })
      // 输入流结束（客户端关闭管道）视为关闭信号。
      this.input.on('end', () => this.shutdown())
      this.input.on('error', () => this.shutdown())
    })
  }

  /**
   * 分发并处理一条客户端消息。
   * @param msg 已解码的客户端消息。
   */
  private async handleClientMessage(msg: ClientMessage): Promise<void> {
    try {
      switch (msg.type) {
        case 'prompt':
          await this.handlePrompt(msg.requestId, msg.text, msg.attachments)
          break
        case 'cancel':
          this.handleCancel(msg.requestId)
          break
        case 'permission_response':
          this.handlePermissionResponse(msg.permissionId, msg.decision)
          break
        case 'set_permission_mode':
          this.handleSetPermissionMode(msg.mode)
          break
        case 'set_model':
          this.handleSetModel(msg.model)
          break
        case 'set_provider':
          this.handleSetProvider(msg.provider)
          break
        case 'clear':
          this.handleClear()
          break
        case 'slash_command':
          await this.handleSlashCommand(msg.requestId, msg.input)
          break
        case 'request_commands':
          this.handleRequestCommands(msg.queryId, msg.input)
          break
        case 'submit_api_key':
          this.handleSubmitApiKey(msg.provider, msg.apiKey)
          break
        case 'shutdown':
          this.shutdown()
          break
        default:
          // 未知消息类型：忽略但记日志，便于排查协议不一致。
          this.logLine(`[ide-server] 未知消息类型：${(msg as { type?: string }).type}`)
      }
    } catch (e: any) {
      this.logLine(`[ide-server] 处理消息出错：${e?.message ?? String(e)}`)
    }
  }

  /**
   * 处理一轮对话请求：驱动 Agent.runTurn，并把事件流转换为协议消息。
   * @param requestId 客户端轮次 id。
   * @param text 用户输入。
   * @param attachments 可选上下文附件（拖拽文件/选区），会转写为提示前缀拼到 text 前。
   */
  private async handlePrompt(
    requestId: string,
    text: string,
    attachments?: ContextAttachment[],
  ): Promise<void> {
    // 串行约束：同一时刻只允许一轮，避免消息历史竞态与输出交织。
    if (this.activeRequestId) {
      this.send({
        type: 'turn_error',
        requestId,
        message: '已有任务进行中，请等待当前任务完成或先中断。',
      })
      return
    }
    // 把上下文附件转写为提示前缀（拖拽文件以引用形式给出，引导模型按需 read_file）。
    const prefix = buildAttachmentsPrefix(attachments)
    const finalText = prefix ? `${prefix}\n\n${text}`.trim() : text.trim()
    if (!finalText) {
      this.send({ type: 'turn_error', requestId, message: '输入为空。' })
      return
    }
    if (!this.agent.hasApiKey()) {
      this.send({
        type: 'turn_error',
        requestId,
        message: '未配置可用的 API Key，请在终端执行 dcode 后用 /login 配置，或设置相应环境变量。',
      })
      return
    }

    this.activeRequestId = requestId
    const ac = new AbortController()
    this.activeAbort = ac
    // 累计本轮成本（来自每次 llm_done 的 costUsd）。
    let costUsd = 0
    let usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined

    try {
      await this.agent.runTurn(finalText, {
        abortSignal: ac.signal,
        // 权限请求：转为 IPC 往返，等待客户端弹窗决策。
        requestPermission: (req) => this.requestPermissionViaIpc(requestId, req),
        // 直接消费结构化事件，逐一转换为协议消息（比旧回调更完整）。
        onEvent: (ev) => this.forwardRunEvent(requestId, ev, (c, u) => {
          costUsd += c
          if (u) usage = u
        }),
      })
      // runTurn 内部已通过 run_end 事件驱动 forwardRunEvent 发送 turn_done；
      // 但 run_end 是在 onEvent 中处理的，这里无需重复发送。仅兜底：若未发送过结束帧则补发。
      if (this.activeRequestId === requestId && !ac.signal.aborted) {
        // 正常情况下 turn_done 已在 run_end 分支发出，这里不再补发，避免重复。
      }
    } catch (e: any) {
      this.send({
        type: 'turn_error',
        requestId,
        message: e?.message ?? String(e),
      })
    } finally {
      // 清理本轮状态；若有未回执的权限请求，按拒绝处理避免悬挂。
      void costUsd
      void usage
      this.failPendingPermissions()
      this.activeRequestId = null
      this.activeAbort = null
    }
  }

  /**
   * 把单个 AgentRunEvent 转换为协议消息并发送。
   * @param requestId 当前轮次 id。
   * @param ev 运行事件。
   * @param onUsage 收到 llm_done 时回调累计成本/用量。
   */
  private forwardRunEvent(
    requestId: string,
    ev: AgentRunEvent,
    onUsage: (
      costUsd: number,
      usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
    ) => void,
  ): void {
    switch (ev.type) {
      case 'reasoning_delta':
        this.send({ type: 'reasoning', requestId, delta: ev.delta })
        break
      case 'text_delta':
        this.send({ type: 'text', requestId, delta: ev.delta })
        break
      case 'tool_start':
        this.send({
          type: 'tool_start',
          requestId,
          toolCallId: ev.id,
          name: ev.name,
          summary: ev.summary,
        })
        break
      case 'tool_progress':
        this.send({
          type: 'tool_progress',
          requestId,
          toolCallId: ev.id,
          text: ev.text,
        })
        break
      case 'tool_end':
        this.send({
          type: 'tool_end',
          requestId,
          toolCallId: ev.id,
          name: ev.name,
          isError: !!ev.result.isError,
          summary: ev.result.uiSummary,
          detail: ev.result.llmContent,
        })
        break
      case 'llm_done':
        if (ev.usage) {
          onUsage(ev.costUsd ?? 0, {
            promptTokens: ev.usage.prompt_tokens,
            completionTokens: ev.usage.completion_tokens,
            totalTokens: ev.usage.total_tokens,
          })
        } else {
          onUsage(ev.costUsd ?? 0)
        }
        break
      case 'run_end':
        // 一轮结束：发送 turn_done（携带累计成本/用量需在外部聚合，这里读取 agent.usage 兜底）。
        this.send({
          type: 'turn_done',
          requestId,
          reason: ev.reason,
          costUsd: this.agent.usage.costUsd,
          usage: {
            promptTokens: this.agent.usage.inputTokens,
            completionTokens: this.agent.usage.outputTokens,
            totalTokens:
              this.agent.usage.inputTokens + this.agent.usage.outputTokens,
          },
        })
        break
      case 'run_error':
        this.send({ type: 'turn_error', requestId, message: ev.error })
        break
      default:
        // 其余事件（run_start/turn_start/llm_start/compact_* 等）当前客户端无需感知，忽略。
        break
    }
  }

  /**
   * 发起一次权限请求并等待客户端回执。
   * @param requestId 当前轮次 id。
   * @param req 权限请求详情。
   * @returns 用户决策（Promise）。
   */
  private requestPermissionViaIpc(
    requestId: string,
    req: PermissionRequest,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const permissionId = randomUUID()
      this.pendingPermissions.set(permissionId, resolve)
      this.send({
        type: 'permission_request',
        requestId,
        permissionId,
        request: req,
      })
    })
  }

  /**
   * 处理客户端的权限回执：兑现对应的 pending Promise。
   * @param permissionId 权限请求 id。
   * @param decision 用户决策。
   */
  private handlePermissionResponse(
    permissionId: string,
    decision: PermissionDecision,
  ): void {
    const resolve = this.pendingPermissions.get(permissionId)
    if (!resolve) return
    this.pendingPermissions.delete(permissionId)
    resolve(decision)
  }

  /**
   * 中断当前（或指定）轮次。
   * @param requestId 要中断的轮次 id；省略则中断当前进行中的轮次。
   */
  private handleCancel(requestId?: string): void {
    if (!this.activeAbort) return
    if (requestId && requestId !== this.activeRequestId) return
    this.activeAbort.abort()
    // 中断后，悬挂的权限请求按拒绝兑现，避免 Agent 卡在等待授权。
    this.failPendingPermissions()
  }

  /**
   * 切换权限模式。
   * @param mode IDE 权限模式。
   */
  private handleSetPermissionMode(mode: IdePermissionMode): void {
    this.agent.setPermissionMode(mode as PermissionMode)
    this.emitStatus()
  }

  /**
   * 切换模型。
   * 与终端 /model 一致：热更新 Agent 并持久化（写盘 + 刷新本地 config 引用），随后回推 status。
   * @param model 模型名。
   */
  private handleSetModel(model: string): void {
    const trimmed = model.trim()
    if (!trimmed) return
    this.agent.setModel(trimmed)
    // 持久化模型选择，保证下次启动与终端一致；applyConfig 同时刷新 this.config，
    // 使 buildModelOptions 能据新 config 标记 active。
    this.applyConfig({ model: trimmed })
    this.emitStatus()
  }

  /**
   * 切换 LLM 供应商。
   * 复用 registry 的 buildProviderSwitchPatch 计算补丁（含 baseURL、必要时切换默认模型），
   * 经 applyConfig 持久化 + 热更新 Agent（重建 LLM 客户端使新端点/Key 立即生效），随后回推 status。
   * @param provider 目标供应商标识。
   */
  private handleSetProvider(provider: string): void {
    const target = provider.trim().toLowerCase()
    // 仅允许面板可切换的供应商（zhipu / deepseek / openai），其余忽略并提示。
    if (!isValidProviderId(target) || !PROVIDER_SWITCH_OPTIONS.some((o) => o.id === target)) {
      this.send({
        type: 'log',
        level: 'warn',
        message: `暂不支持切换至供应商：${provider}`,
      })
      return
    }
    const patch = buildProviderSwitchPatch(this.config, target as ProviderId)
    this.applyConfig(patch)
    // 若切换后模型随之改变（如 zhipu→openai 自动换默认模型），同步 Agent 的模型，避免发请求用错模型。
    if (patch.model) {
      this.agent.setModel(patch.model)
    }
    const def = getProviderDefinition(target as ProviderId)
    const key = resolveProviderApiKey(this.config)
    // 给一条人类可读的反馈（面板会作为系统行展示）。
    this.send({
      type: 'log',
      level: key ? 'info' : 'warn',
      message: key
        ? `已切换供应商为 ${def.name}（${target}）。`
        : `已切换供应商为 ${def.name}（${target}），但尚未配置该供应商的 API Key，请在终端用 /login 配置或设置环境变量后重启内核。`,
    })
    this.emitStatus()
  }

  /** 清空当前会话上下文。 */
  private handleClear(): void {
    this.agent.clear()
    this.send({ type: 'log', level: 'info', message: '已清空当前会话上下文。' })
    this.emitStatus()
  }

  /**
   * 处理一条斜杠命令：复用 CLI 的 runSlashCommand，并按结果智能适配到 IDE 面板。
   *
   * 适配策略（与用户确认一致）：
   *   - message：作为 command_result 文本展示；
   *   - cleared：通知客户端清屏；
   *   - submitPrompt：转为一轮普通 prompt 在后台执行（复用 requestId 关联流式事件）；
   *   - openFlow（model/login/resume/theme）：面板内无对应交互流程，给出友好提示引导到设置/终端；
   *   - exit：面板不支持退出进程，提示用户改用「重启内核」或关闭面板；
   *   - 命令切换了模型/权限模式时，回推一次 status 让面板刷新状态栏。
   *
   * @param requestId 轮次 id（命令转 prompt 时复用）。
   * @param input 完整命令输入（含前导 /）。
   */
  private async handleSlashCommand(requestId: string, input: string): Promise<void> {
    if (!isSlashCommand(input)) {
      // 兜底：非斜杠输入按普通 prompt 处理（理论上客户端不会走到这里）。
      await this.handlePrompt(requestId, input)
      return
    }

    let result: SlashCommandResult
    try {
      result = await runSlashCommand(input, {
        agent: this.agent,
        config: this.config,
        applyConfig: this.applyConfig,
      })
    } catch (e: any) {
      this.send({
        type: 'command_result',
        requestId,
        message: `命令执行出错：${e?.message ?? String(e)}`,
      })
      return
    }

    // exit：面板内无意义，提示改用重启/关闭面板。
    if (result.exit) {
      this.send({
        type: 'command_result',
        requestId,
        hint: true,
        message:
          '/exit 用于退出终端版 DCODE。在 VS Code 中可直接关闭侧边栏面板；如需重置内核请使用「DCODE: 重启后台内核」命令。',
      })
      return
    }

    // openFlow：终端 TUI 的交互流程。
    if (result.openFlow) {
      // /login：面板内提供等价的「API Key 录入」交互——请求客户端弹出安全输入框，
      // 用户输入后通过 submit_api_key 回传，由 handleSubmitApiKey 保存并热更新（无需跳转终端）。
      if (result.openFlow === 'login') {
        this.sendLoginPrompt()
        return
      }
      // 其余流程（model / resume / theme）面板已有等价能力或跟随 VSCode，给出友好引导提示。
      this.send({
        type: 'command_result',
        requestId,
        hint: true,
        message: describeFlowHint(result.openFlow),
      })
      // 切到设置可能让用户随后改模型/Provider；这里仍回推一次当前状态，保证状态栏准确。
      this.emitStatus()
      return
    }

    // submitPrompt：命令需要 Agent 介入（如 /init、/commit、/review）。转为一轮普通对话执行。
    if (result.submitPrompt) {
      // 先把命令的提示语作为一次性结果展示（如「开始代码审查…」），并标记 submitted=true，
      // 让客户端进入处理中态，等待后续 text/tool/turn_done 事件。
      this.send({
        type: 'command_result',
        requestId,
        message: result.message,
        submitted: true,
      })
      await this.handlePrompt(requestId, result.submitPrompt)
      return
    }

    // 普通本地命令：回传文本结果与是否清屏。
    this.send({
      type: 'command_result',
      requestId,
      message: result.message,
      cleared: result.cleared,
    })
    // 命令可能改了模型/Provider/权限模式，统一回推一次状态。
    this.emitStatus()
  }

  /**
   * 处理命令补全请求：复用 CLI 的 getSlashSuggestions，按当前配置生成候选。
   * @param queryId 补全请求 id（原样带回，便于客户端丢弃过期响应）。
   * @param input 当前输入框内容（含前导 /）。
   */
  private handleRequestCommands(queryId: string, input: string): void {
    let suggestions: CommandSuggestion[]
    try {
      suggestions = getSlashSuggestions(input, this.config)
    } catch (e: any) {
      this.logLine(`[ide-server] 生成命令补全出错：${e?.message ?? String(e)}`)
      suggestions = []
    }
    this.send({
      type: 'command_suggestions',
      queryId,
      // 收窄为协议字段（CommandSuggestion 与 CommandSuggestionItem 字段一致）。
      suggestions: suggestions.map((s) => ({
        name: s.name,
        description: s.description,
        completion: s.completion,
        aliases: s.aliases,
      })),
    })
  }

  /**
   * 向客户端请求打开「API Key 录入界面」（面板内 /login）。
   * 携带当前生效供应商的展示元信息（名称、平台链接、端点、环境变量名），
   * 客户端据此弹出安全输入框；用户输入完成后通过 submit_api_key 回传。
   */
  private sendLoginPrompt(): void {
    const id = getActiveProviderId(this.config)
    const meta = getProviderLoginMeta(id)
    this.send({
      type: 'login_prompt',
      providerId: meta.providerId,
      providerName: meta.providerName,
      platformUrl: meta.platformUrl,
      baseURL: meta.baseURL,
      apiKeyEnv: meta.apiKeyEnv,
    })
  }

  /**
   * 处理客户端提交的 API Key（面板内 /login 的录入结果）。
   * 复用 buildProviderLoginPatch 把 Key 写入 providers[providerId].apiKey（各供应商独立保留），
   * 经 applyConfig 持久化到 ~/.dcode/config.json 并热更新 Agent（重建 LLM 客户端使 Key 立即生效），
   * 随后回推一条反馈与最新 status（刷新面板 hasApiKey 标记，使供应商药丸不再显示「未配置 Key」）。
   * @param provider 目标供应商标识（来自 login_prompt；非法/缺省时回退到当前生效供应商）。
   * @param apiKey 用户输入的 API Key。
   */
  private handleSubmitApiKey(provider: string, apiKey: string): void {
    const key = (apiKey ?? '').trim()
    if (!key) {
      this.send({
        type: 'command_result',
        requestId: '',
        hint: true,
        message: 'API Key 为空，未保存。',
      })
      return
    }
    // 解析目标供应商：优先用客户端回传值，非法时回退到当前生效供应商，保证写入到正确的 providers 槽位。
    const target: ProviderId =
      provider && isValidProviderId(provider)
        ? (provider as ProviderId)
        : getActiveProviderId(this.config)
    try {
      const patch = buildProviderLoginPatch(this.config, target, key)
      this.applyConfig(patch)
    } catch (e: any) {
      this.send({
        type: 'command_result',
        requestId: '',
        message: `保存 API Key 失败：${e?.message ?? String(e)}`,
      })
      return
    }
    const def = getProviderDefinition(target)
    this.send({
      type: 'command_result',
      requestId: '',
      message: `${def.name} API Key 已保存，当前 Provider 已生效。`,
    })
    // 刷新状态：hasApiKey 变为 true，面板供应商药丸/提示同步更新。
    this.emitStatus()
  }

  /** 回推当前状态（模型/Provider/权限模式/会话 + 可切换供应商与模型列表）。 */
  private emitStatus(): void {
    this.send({
      type: 'status',
      model: this.agent.getModel(),
      provider: this.agent.getProviderId(),
      permissionMode: this.toIdeMode(this.agent.permissionMode),
      sessionId: this.agent.getSessionId(),
      providers: this.buildProviderOptions(),
      models: this.buildModelOptions(),
    })
  }

  /**
   * 构建「可切换供应商」列表（供面板下拉菜单）。
   * 数据源为 registry 的 PROVIDER_SWITCH_OPTIONS（面板允许切换的子集）+ BUILTIN_PROVIDERS（展示名）；
   * 逐个解析其 API Key 可用性（环境变量或已保存），并标记当前生效项。
   * @returns 供应商选项数组。
   */
  private buildProviderOptions(): ProviderOption[] {
    const active = getActiveProviderId(this.config)
    return PROVIDER_SWITCH_OPTIONS.map((opt) => {
      const def = getProviderDefinition(opt.id)
      // 以「假设切到该供应商」的配置解析其 Key 是否可用（不修改真实配置）。
      const key = resolveProviderApiKey({ ...this.config, provider: opt.id })
      return {
        id: opt.id,
        name: def.name,
        description: opt.description,
        active: opt.id === active,
        hasApiKey: !!key,
      }
    })
  }

  /**
   * 构建「当前供应商下可选模型」列表（供面板下拉菜单）。
   * 复用 registry 的 getModelSelectOptions（含按供应商格式化的 label 与 hint），并标记当前生效模型。
   * @returns 模型选项数组。
   */
  private buildModelOptions(): ModelOption[] {
    const current = this.agent.getModel()
    return getModelSelectOptions(this.config).map((o) => ({
      value: o.value,
      label: o.label,
      hint: o.hint,
      active: o.value === current,
    }))
  }

  /** 把所有悬挂的权限请求按「拒绝」兑现，避免 Promise 永久挂起。 */
  private failPendingPermissions(): void {
    for (const [, resolve] of this.pendingPermissions) {
      resolve('deny')
    }
    this.pendingPermissions.clear()
  }

  /**
   * 关闭服务端：中断进行中的轮次、清理权限、结束 start() 的等待。
   */
  shutdown(): void {
    if (this.closed) return
    this.closed = true
    this.activeAbort?.abort()
    this.failPendingPermissions()
    this.resolveDone?.()
  }

  /**
   * 发送一条服务端消息（编码为 NDJSON 写入输出流）。
   * @param msg 服务端消息。
   */
  private send(msg: ServerMessage): void {
    if (this.closed && msg.type !== 'ready') {
      // 关闭后仍可能有零星事件，安静丢弃以免写入已结束的流报错。
      return
    }
    try {
      this.output.write(encodeMessage(msg))
    } catch (e: any) {
      this.logLine(`[ide-server] 写出失败：${e?.message ?? String(e)}`)
    }
  }

  /**
   * 写一行日志到日志流（stderr），不影响协议通道。
   * @param line 日志文本（自动补换行）。
   */
  private logLine(line: string): void {
    try {
      this.logStream.write(line + '\n')
    } catch {
      // 日志失败可忽略。
    }
  }

  /**
   * 把内部 PermissionMode 收窄为协议用的 IdePermissionMode（二者取值一致）。
   * @param mode 配置中的权限模式。
   * @returns 协议权限模式。
   */
  private toIdeMode(mode: PermissionMode): IdePermissionMode {
    return mode as IdePermissionMode
  }
}

/**
 * 把上下文附件转写为「上下文清单」提示前缀，拼接到用户输入之前。
 * 设计：文件附件以相对路径引用形式给出，明确告诉模型「按需用 read_file 读取」，避免无谓内联占用上下文；
 * 选区附件携带 snippet 时直接内联代码围栏，便于模型聚焦。
 * @param attachments 附件列表（可空）。
 * @returns 前缀文本；无有效附件时返回空串。
 */
function buildAttachmentsPrefix(attachments?: ContextAttachment[]): string {
  if (!attachments || attachments.length === 0) return ''
  const fileRefs: string[] = []
  const snippets: string[] = []
  for (const att of attachments) {
    if (!att || !att.path) continue
    if (att.kind === 'selection' && att.snippet) {
      const range =
        att.startLine && att.endLine ? `（第 ${att.startLine}-${att.endLine} 行）` : ''
      const fence = '```' + (att.languageId ?? '') + '\n' + att.snippet + '\n```'
      snippets.push(`文件 \`${att.path}\`${range} 的选区：\n${fence}`)
    } else {
      fileRefs.push(att.path)
    }
  }
  const parts: string[] = []
  if (fileRefs.length > 0) {
    const list = fileRefs.map((p) => `  - ${p}`).join('\n')
    parts.push(
      `【上下文文件】用户拖拽/添加了以下文件作为参考，请在需要时用 read_file 读取其内容：\n${list}`,
    )
  }
  if (snippets.length > 0) {
    parts.push(`【选区上下文】\n${snippets.join('\n\n')}`)
  }
  return parts.join('\n\n')
}

/**
 * 为终端 TUI 专属的交互流程（openFlow）生成面板内的友好引导提示。
 * @param flow 流程类型。
 * @returns 引导文本。
 */
function describeFlowHint(flow: 'model' | 'login' | 'resume' | 'theme'): string {
  switch (flow) {
    case 'model':
      return '在 VS Code 中切换模型请直接输入「/model <模型名>」（如 /model glm-4-flash），或在 DCODE 设置的「dcode.model」中配置。'
    case 'login':
      // 正常情况下 /login 走 sendLoginPrompt（面板内录入），不会到这里；保留作为防御性兜底文案。
      return '在输入框输入 /login 即可在面板内直接录入 API Key；也可设置环境变量（如 ZHIPU_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY）后重启内核。'
    case 'resume':
      return '面板暂不支持历史会话选择。可在终端用 dcode -r 恢复历史会话；本面板内可用「清空」开始新会话。'
    case 'theme':
      return '面板主题跟随 VS Code 的明暗主题，无需单独切换。'
    default:
      return '该操作请在终端版 DCODE 中完成。'
  }
}

/**
 * 以默认依赖（process.stdin/stdout/stderr）运行 IDE 服务端。
 * 供 cli.tsx 在 --ide-server 模式下调用。
 * @param agent 已构造的 Agent 实例。
 * @param config 当前生效配置（供斜杠命令读取/展示/持久化）。
 * @returns 服务端关闭后 resolve。
 */
export async function runIdeServer(agent: Agent, config?: DCodeConfig): Promise<void> {
  const server = new IdeServer({
    agent,
    // 未显式传入时回退到从磁盘加载当前配置，保证斜杠命令可用。
    config: config ?? loadConfig(),
    input: process.stdin,
    output: process.stdout,
    log: process.stderr,
  })
  // 进程信号也触发优雅关闭。
  const onSignal = () => server.shutdown()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  try {
    await server.start()
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}
