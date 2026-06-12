// Agent 主循环。
// 这是 DCODE 的“大脑”：维护对话状态，驱动“流式生成 → 执行工具 → 回填结果 → 再生成”的循环，
// 直到模型不再发起工具调用为止。采用回调式接口（TurnHandlers），便于：
//   - 在 Ink UI 中把增量更新映射到 React 状态；
//   - 在无头(-p)模式下直接打印到标准输出。
// 同时负责：上下文超限时自动压缩、用量与成本累计、会话持久化、用户中断处理。
// 制作人：Moriarty_Dox

import { MAX_AGENT_ITERATIONS } from '../constants.js'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { createLLMClient } from '../providers/factory.js'
import type { LLMClient, ProviderId } from '../providers/types.js'
import type { DeepSeekUsage, UsageTotals } from '../deepseek/pricing.js'
import { accumulateUsage, calcCost, emptyUsageTotals } from '../deepseek/pricing.js'
import {
  executeToolCall,
  getAvailableTools,
  toOpenAITools,
  type ExecutedToolResult,
} from '../tools/index.js'
import { buildSystemPrompt } from './systemPrompt.js'
import { compactMessages, shouldCompact } from './compact.js'
import type { SkillDefinition } from './skills.js'
import { loadSkillByName } from './skills.js'
import type { SessionRecorder } from './session.js'
import { extractFileLockKey, withFilePathLock } from './fileToolLock.js'
import type { DeepMessage, PermissionDecision, PermissionRequest, TodoItem, ToolContext, ToolResult } from './types.js'

/**
 * 单轮对话的回调集合。
 * 上层（UI 或无头执行器）实现这些回调以接收增量更新并提供权限决策。
 */
export interface TurnHandlers {
  // 思维链增量（reasoner 模型）。
  onReasoning?: (delta: string) => void
  // 正文文本增量。
  onText?: (delta: string) => void
  // 一条 assistant 消息完成（含可能的工具调用）。
  onAssistantDone?: (message: DeepMessage) => void
  // 某次工具调用开始。
  onToolStart?: (info: { id: string; name: string; summary: string }) => void
  // 工具执行的实时进度输出。
  onToolProgress?: (info: { id: string; text: string }) => void
  // 某次工具调用结束。
  onToolEnd?: (info: { id: string; name: string; result: ToolResult }) => void
  // 一次 API 用量与本次成本。
  onUsage?: (usage: DeepSeekUsage, costUsd: number) => void
  // 即将进行上下文压缩。
  onCompacting?: () => void
  // 请求用户授权（必填）。
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>
  // 取消信号（必填）。
  abortSignal: AbortSignal
}

/**
 * Agent 类：封装一个会话的全部可变状态与主循环逻辑。
 */
export class Agent {
  // 当前生效配置。
  private config: DCodeConfig
  // LLM 客户端（provider / apiKey / baseURL 变更时会重建）。
  private client: LLMClient
  // 完整消息历史（含 system）。
  private messages: DeepMessage[]
  // 会话记录器（持久化）。
  private recorder: SessionRecorder | null
  // 当前权限模式。
  permissionMode: PermissionMode
  // 共享待办列表。
  private todos: TodoItem[] = []
  // 累计用量统计。
  usage: UsageTotals = emptyUsageTotals()
  // 当前工作目录。
  readonly cwd: string
  // 当前会话已加载的技能（/skill 注入 system 提示）。
  private activeSkills: SkillDefinition[] = []

  /**
   * 构造函数。
   * @param opts 初始化选项。
   */
  constructor(opts: {
    config: DCodeConfig
    cwd: string
    recorder?: SessionRecorder | null
    initialMessages?: DeepMessage[]
    permissionMode?: PermissionMode
  }) {
    this.config = opts.config
    this.cwd = opts.cwd
    this.client = createLLMClient(opts.config)
    this.recorder = opts.recorder ?? null
    this.permissionMode = opts.permissionMode ?? 'default'

    // 初始化消息历史：若有历史则沿用，否则以 system 提示开场。
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      this.messages = opts.initialMessages
    } else {
      this.messages = [
        {
          role: 'system',
          content: buildSystemPrompt({
            cwd: this.cwd,
            model: this.config.model,
            permissionMode: this.permissionMode,
            activeSkills: this.activeSkills,
          }),
        },
      ]
    }
  }

  /** 获取当前模型名。 */
  getModel(): string {
    return this.config.model
  }

  /**
   * 是否已配置可用的 API Key（供启动检查与无头模式使用）。
   * @returns 已配置返回 true。
   */
  hasApiKey(): boolean {
    return this.client.hasApiKey()
  }

  /**
   * 获取当前会话 id（无持久化记录器时返回 null）。
   * @returns 会话 id 或 null。
   */
  getSessionId(): string | null {
    return this.recorder?.id ?? null
  }

  /** 获取当前 Provider 标识。 */
  getProviderId(): ProviderId {
    return this.client.getProviderId()
  }

  /**
   * 应用一组配置补丁到 Agent。
   * 当 provider / apiKey / baseURL 变化时，重建 LLM 客户端使其立即生效；
   * 当 model 变化时，刷新系统提示。
   * @param patch 配置补丁。
   */
  applyConfigPatch(patch: Partial<DCodeConfig>): void {
    const prev = this.config
    const merged: Partial<DCodeConfig> = { ...patch }
    if (patch.providers) {
      merged.providers = { ...this.config.providers }
      for (const [id, overrides] of Object.entries(patch.providers)) {
        const pid = id as ProviderId
        merged.providers[pid] = { ...this.config.providers?.[pid], ...overrides }
      }
    }
    this.config = { ...this.config, ...merged }
    const needsClientRebuild =
      (merged.provider !== undefined && merged.provider !== prev.provider) ||
      (merged.apiKey !== undefined && merged.apiKey !== prev.apiKey) ||
      (merged.baseURL !== undefined && merged.baseURL !== prev.baseURL) ||
      merged.providers !== undefined ||
      merged.proxy !== undefined
    if (needsClientRebuild) {
      this.client = createLLMClient(this.config)
    }
    if (
      (patch.model && patch.model !== prev.model) ||
      (merged.provider !== undefined && merged.provider !== prev.provider)
    ) {
      this.refreshSystemPrompt()
    }
  }

  /** 切换模型并刷新系统提示中的模型字段。 */
  setModel(model: string): void {
    this.config.model = model
    this.refreshSystemPrompt()
  }

  /** 切换权限模式并刷新系统提示中的相关说明。 */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode
    this.refreshSystemPrompt()
  }

  /** 返回当前待办列表（只读副本）。 */
  getTodos(): TodoItem[] {
    return this.todos
  }

  /** 返回消息历史（供 UI 回放或导出）。 */
  getMessages(): DeepMessage[] {
    return this.messages
  }

  /** 返回当前会话已加载的技能名列表。 */
  getActiveSkillNames(): string[] {
    return this.activeSkills.map((s) => s.name)
  }

  /** 返回当前会话已加载的技能（只读副本）。 */
  getActiveSkills(): SkillDefinition[] {
    return [...this.activeSkills]
  }

  /**
   * 加载技能到当前会话（注入 system 提示）。
   * @param name 技能名。
   * @returns 是否成功及提示信息。
   */
  loadSkill(name: string): { ok: boolean; message: string } {
    const skill = loadSkillByName(name, this.cwd)
    if (!skill) {
      return { ok: false, message: `未找到技能「${name}」。执行 /skill list 查看可用技能。` }
    }
    if (this.activeSkills.some((s) => s.name === skill.name)) {
      return { ok: true, message: `技能「${skill.name}」已在当前会话中加载。` }
    }
    this.activeSkills.push(skill)
    this.refreshSystemPrompt()
    return {
      ok: true,
      message: `已加载技能「${skill.name}」：${skill.description}`,
    }
  }

  /**
   * 从当前会话卸载技能。
   * @param name 技能名。
   * @returns 是否成功及提示信息。
   */
  unloadSkill(name: string): { ok: boolean; message: string } {
    const before = this.activeSkills.length
    this.activeSkills = this.activeSkills.filter((s) => s.name !== name)
    if (this.activeSkills.length === before) {
      return { ok: false, message: `当前会话未加载技能「${name}」。` }
    }
    this.refreshSystemPrompt()
    return { ok: true, message: `已卸载技能「${name}」。` }
  }

  /**
   * 用给定历史替换当前会话消息（保留/重建 system 提示）。
   * 供 /resume 恢复历史会话使用。
   * @param messages 要载入的历史消息（通常来自磁盘，可能不含 system）。
   */
  replaceMessages(messages: DeepMessage[]): void {
    const hasSystem = messages.some((m) => m.role === 'system')
    if (hasSystem) {
      this.messages = [...messages]
    } else {
      // 历史不含 system 时，补一条最新的系统提示放在最前。
      const sys: DeepMessage = {
        role: 'system',
        content: buildSystemPrompt({
          cwd: this.cwd,
          model: this.config.model,
          permissionMode: this.permissionMode,
          activeSkills: this.activeSkills,
        }),
      }
      this.messages = [sys, ...messages]
    }
  }

  /** 重置对话（保留 system），用于 /clear。 */
  clear(): void {
    this.messages = this.messages.filter((m) => m.role === 'system').slice(0, 1)
    this.todos = []
  }

  /**
   * 重新构建并替换首条 system 消息（模型/模式/记忆变化后调用）。
   */
  private refreshSystemPrompt(): void {
    const sys: DeepMessage = {
      role: 'system',
      content: buildSystemPrompt({
        cwd: this.cwd,
        model: this.config.model,
        permissionMode: this.permissionMode,
        activeSkills: this.activeSkills,
      }),
    }
    if (this.messages[0]?.role === 'system') this.messages[0] = sys
    else this.messages.unshift(sys)
  }

  /**
   * 手动触发一次上下文压缩（供 /compact 命令调用）。
   * @returns 压缩前后估算 token 变化的提示信息。
   */
  async compactNow(): Promise<string> {
    const before = this.messages.length
    this.messages = await compactMessages(
      this.client,
      this.messages,
      this.config.model,
    )
    return `已压缩上下文：消息条数 ${before} → ${this.messages.length}。`
  }

  /**
   * 执行一轮对话：把用户输入加入历史并驱动主循环，直至模型给出最终答复。
   * @param userInput 用户本轮输入文本。
   * @param handlers 回调集合。
   */
  async runTurn(userInput: string, handlers: TurnHandlers): Promise<void> {
    // 1) 若历史过长，先压缩，避免超出上下文限制。
    if (shouldCompact(this.messages)) {
      handlers.onCompacting?.()
      this.messages = await compactMessages(
        this.client,
        this.messages,
        this.config.model,
      )
    }

    // 2) 追加用户消息并持久化。
    const userMsg: DeepMessage = {
      role: 'user',
      content: userInput,
      timestamp: Date.now(),
    }
    this.messages.push(userMsg)
    this.recorder?.append(userMsg)

    // 3) 构造工具运行上下文（在多次迭代间复用同一份，共享 todos）。
    const toolCtx: ToolContext = {
      cwd: this.cwd,
      config: this.config,
      permissionMode: this.permissionMode,
      abortSignal: handlers.abortSignal,
      requestPermission: handlers.requestPermission,
      todos: this.todos,
      setTodos: (todos) => {
        this.todos = todos
      },
      sessionId: this.recorder?.id ?? null,
      onProgress: undefined, // 每次工具调用前单独绑定，见下方。
    }

    // 4) 主循环：流式生成 → 执行工具 → 回填 → 再生成。
    for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
      // 用户已中断则停止。
      if (handlers.abortSignal.aborted) return

      // 根据权限模式决定可用工具，并转换为 API schema。
      const availableTools = getAvailableTools(this.permissionMode)
      const apiTools = toOpenAITools(availableTools)

      // 流式请求模型。
      let assistantMsg: DeepMessage | null = null
      try {
        for await (const ev of this.client.streamChat({
          messages: this.messages,
          tools: apiTools,
          model: this.config.model,
          abortSignal: handlers.abortSignal,
          reasoningEffort: this.config.reasoningEffort,
        })) {
          if (ev.type === 'reasoning') handlers.onReasoning?.(ev.delta)
          else if (ev.type === 'text') handlers.onText?.(ev.delta)
          else if (ev.type === 'done') {
            assistantMsg = ev.message
            // 累计用量与成本。
            if (ev.usage) {
              const providerId = this.client.getProviderId()
              this.usage = accumulateUsage(
                this.usage,
                this.config.model,
                ev.usage,
                providerId,
              )
              handlers.onUsage?.(ev.usage, calcCost(this.config.model, ev.usage, providerId))
            }
          }
        }
      } catch (e: any) {
        // 流式请求失败：作为一条系统级错误消息记录并停止本轮。
        throw e
      }

      if (!assistantMsg) return

      // 记录 assistant 消息。
      this.messages.push(assistantMsg)
      this.recorder?.append(assistantMsg)
      handlers.onAssistantDone?.(assistantMsg)

      // 没有工具调用 → 本轮结束。
      const toolCalls = assistantMsg.toolCalls ?? []
      if (toolCalls.length === 0) return

      // 5) 并行执行本轮所有工具调用（支持 Task 子代理并行），结果按原顺序回填历史。
      // 对同一文件路径的 read/write/edit 串行化，避免交错写入。
      const filePathLocks = new Map<string, Promise<void>>()
      const executedResults = await Promise.all(
        toolCalls.map(async (call) =>
          withFilePathLock(filePathLocks, extractFileLockKey(call), async () => {
          if (handlers.abortSignal.aborted) {
            return {
              call,
              executed: {
                toolCallId: call.id,
                toolName: call.name,
                result: {
                  llmContent: '操作已取消。',
                  isError: true,
                },
              } as ExecutedToolResult,
            }
          }

          const tool = availableTools.find((t) => t.name === call.name)
          let summary = call.name
          try {
            const parsed = call.argsJson ? JSON.parse(call.argsJson) : {}
            summary = tool?.renderCall?.(parsed) ?? call.name
          } catch {
            summary = call.name
          }
          handlers.onToolStart?.({ id: call.id, name: call.name, summary })

          const localCtx: ToolContext = {
            ...toolCtx,
            permissionMode: this.permissionMode,
            onProgress: (text) =>
              handlers.onToolProgress?.({ id: call.id, text }),
          }

          const executed = await executeToolCall(call, localCtx)
          handlers.onToolEnd?.({
            id: call.id,
            name: call.name,
            result: executed.result,
          })
          return { call, executed }
        }),
        ),
      )

      for (const { call, executed } of executedResults) {
        const toolMsg: DeepMessage = {
          role: 'tool',
          content: executed.result.llmContent,
          toolCallId: call.id,
          toolName: call.name,
          isError: executed.result.isError,
          timestamp: Date.now(),
        }
        this.messages.push(toolMsg)
        this.recorder?.append(toolMsg)
      }
      // 工具结果已回填，进入下一轮让模型据此继续。
    }

    // 达到迭代上限仍未收敛：提示并结束，避免无限循环。
    handlers.onText?.(
      `\n\n[已达到单轮最大工具调用次数（${MAX_AGENT_ITERATIONS}），自动停止。如需继续请再次输入。]`,
    )
  }
}
