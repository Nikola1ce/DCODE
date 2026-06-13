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
import type { PermissionMode } from '../config.js'
import {
  IDE_PROTOCOL_VERSION,
  createLineDecoder,
  encodeMessage,
  type ClientMessage,
  type IdePermissionMode,
  type ServerMessage,
} from './protocol.js'
import { VERSION } from '../constants.js'

// 服务端运行所需的依赖（便于测试时注入假的输入/输出流与 Agent）。
export interface IdeServerDeps {
  // Agent 实例（已在 cli 中按 cwd/config 构造好）。
  agent: Agent
  // 读取客户端消息的输入流（默认 process.stdin）。
  input: NodeJS.ReadableStream
  // 写出服务端消息的输出流（默认 process.stdout，必须是纯协议通道）。
  output: NodeJS.WritableStream
  // 日志输出流（默认 process.stderr）。
  log?: NodeJS.WritableStream
}

/**
 * IDE IPC 服务端。
 * 维护与单个客户端的会话：接收指令、驱动 Agent、转发事件、协调权限往返。
 */
export class IdeServer {
  private readonly agent: Agent
  private readonly input: NodeJS.ReadableStream
  private readonly output: NodeJS.WritableStream
  private readonly logStream: NodeJS.WritableStream

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
    this.input = deps.input
    this.output = deps.output
    this.logStream = deps.log ?? process.stderr
  }

  /**
   * 启动服务端：先回送 ready，再监听输入流直到收到 shutdown 或输入流结束。
   * @returns 在服务端关闭后 resolve。
   */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve
      // 第一条消息：宣告就绪并回传当前状态，客户端据此初始化 UI。
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
          await this.handlePrompt(msg.requestId, msg.text)
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
        case 'clear':
          this.handleClear()
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
   */
  private async handlePrompt(requestId: string, text: string): Promise<void> {
    // 串行约束：同一时刻只允许一轮，避免消息历史竞态与输出交织。
    if (this.activeRequestId) {
      this.send({
        type: 'turn_error',
        requestId,
        message: '已有任务进行中，请等待当前任务完成或先中断。',
      })
      return
    }
    if (!text.trim()) {
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
      await this.agent.runTurn(text, {
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
   * @param model 模型名。
   */
  private handleSetModel(model: string): void {
    this.agent.setModel(model)
    this.emitStatus()
  }

  /** 清空当前会话上下文。 */
  private handleClear(): void {
    this.agent.clear()
    this.send({ type: 'log', level: 'info', message: '已清空当前会话上下文。' })
    this.emitStatus()
  }

  /** 回推当前状态（模型/Provider/权限模式/会话）。 */
  private emitStatus(): void {
    this.send({
      type: 'status',
      model: this.agent.getModel(),
      provider: this.agent.getProviderId(),
      permissionMode: this.toIdeMode(this.agent.permissionMode),
      sessionId: this.agent.getSessionId(),
    })
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
 * 以默认依赖（process.stdin/stdout/stderr）运行 IDE 服务端。
 * 供 cli.tsx 在 --ide-server 模式下调用。
 * @param agent 已构造的 Agent 实例。
 * @returns 服务端关闭后 resolve。
 */
export async function runIdeServer(agent: Agent): Promise<void> {
  const server = new IdeServer({
    agent,
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
