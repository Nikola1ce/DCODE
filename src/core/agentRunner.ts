// AgentRunner：事件驱动的 Agent 主循环内核。
// 它只负责 orchestration：压缩上下文、调用模型、调度工具、回填消息并产出事件。
// UI/headless 继续通过 Agent.runTurn 的兼容适配器消费旧 TurnHandlers。

import { randomUUID } from 'node:crypto'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { MAX_AGENT_ITERATIONS } from '../constants.js'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { calcCost } from '../deepseek/pricing.js'
import type { LLMClient } from '../providers/types.js'
import {
  getAvailableTools,
  toOpenAITools,
} from '../tools/index.js'
import { canCompactMessages, compactMessages } from './compact.js'
import { estimateRequestTokens } from './contextUsage.js'
import { trimHistoryForRequest } from './historyTrim.js'
import { getCompactThreshold, resolveContextWindow } from '../providers/contextWindow.js'
import { executeToolBatch } from './toolScheduler.js'
import { traceEvent, traceTextFields } from '../trace.js'
import type {
  AgentRunEvent,
  DeepMessage,
  PermissionDecision,
  PermissionRequest,
  TodoItem,
  ToolContext,
  ToolDefinition,
} from './types.js'

export interface AgentRunnerOptions {
  client: LLMClient
  config: DCodeConfig
  cwd: string
  // 经 /add-dir 额外授权的工作目录（绝对路径），注入 ToolContext.extraDirs。
  extraDirs?: string[]
  permissionMode: PermissionMode
  model: string
  userInput: string
  abortSignal: AbortSignal
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision>
  getMessages: () => DeepMessage[]
  setMessages: (messages: DeepMessage[]) => void
  appendMessage: (message: DeepMessage) => void
  getTodos: () => TodoItem[]
  setTodos: (todos: TodoItem[]) => void
  sessionId?: string | null
  getAvailableTools?: (permissionMode: PermissionMode) => ToolDefinition[]
  maxIterations?: number
  runId?: string
  turnId?: string
}

export class AgentRunner {
  private readonly opts: AgentRunnerOptions
  private readonly runId: string
  private readonly turnId: string
  // 本轮压缩失败或没有收益后不反复消耗请求；下一次用户输入可重新尝试。
  private compactUnavailable = false

  constructor(opts: AgentRunnerOptions) {
    this.opts = opts
    this.runId = opts.runId ?? randomUUID()
    this.turnId = opts.turnId ?? randomUUID()
  }

  async *run(): AsyncGenerator<AgentRunEvent> {
    const startedAt = Date.now()
    yield this.event('run_start', { timestamp: startedAt })
    yield this.event('turn_start', {
      timestamp: Date.now(),
      userInput: this.opts.userInput,
    })

    const userMsg: DeepMessage = {
      role: 'user',
      content: this.opts.userInput,
      timestamp: Date.now(),
    }
    this.opts.appendMessage(userMsg)

    const maxIterations = this.opts.maxIterations ?? MAX_AGENT_ITERATIONS
    for (let iter = 0; iter < maxIterations; iter++) {
      if (this.opts.abortSignal.aborted) {
        yield this.event('run_end', {
          timestamp: Date.now(),
          iterations: iter,
          reason: 'aborted' as const,
        })
        return
      }

      const availableTools = this.resolveAvailableTools()
      const apiTools = toOpenAITools(availableTools)
      yield* this.compactIfNeeded(iter, apiTools)
      if (this.opts.abortSignal.aborted) {
        yield this.event('run_end', { timestamp: Date.now(), iterations: iter, reason: 'aborted' })
        return
      }
      yield this.event('llm_start', {
        timestamp: Date.now(),
        iteration: iter,
        model: this.opts.model,
        toolCount: apiTools.length,
      })

      let assistantMsg: DeepMessage | null = null
      let finishReason = 'stop'
      let streamedText = ''
      let streamedReasoning = ''
      const llmStartedAt = Date.now()
      // 发送前对历史副本做「瘦身」：截断滚出最近窗口的超大旧工具结果，降低每轮输入 token。
      // 纯函数变换，不修改 this.messages，磁盘会话记录与 /resume 仍保留完整原文。
      const requestMessages = trimHistoryForRequest(this.opts.getMessages())
      try {
        for await (const ev of this.opts.client.streamChat({
          messages: requestMessages,
          tools: apiTools,
          model: this.opts.model,
          abortSignal: this.opts.abortSignal,
          reasoningEffort: this.opts.config.reasoningEffort,
          thinkingBudget: this.opts.config.thinkingBudget,
          trace: {
            runId: this.runId,
            turnId: this.turnId,
            iteration: iter,
          },
        })) {
          if (ev.type === 'reasoning') {
            streamedReasoning += ev.delta
            yield this.event('reasoning_delta', {
              timestamp: Date.now(),
              iteration: iter,
              delta: ev.delta,
            })
          } else if (ev.type === 'text') {
            streamedText += ev.delta
            yield this.event('text_delta', {
              timestamp: Date.now(),
              iteration: iter,
              delta: ev.delta,
            })
          } else if (ev.type === 'done') {
            assistantMsg = ev.message
            finishReason = ev.finishReason
            const providerId = this.opts.client.getProviderId()
            const costUsd = ev.usage
              ? calcCost(this.opts.model, ev.usage, providerId)
              : undefined
            yield this.event('llm_done', {
              timestamp: Date.now(),
              iteration: iter,
              message: ev.message,
              finishReason,
              usage: ev.usage,
              costUsd,
              durationMs: Date.now() - llmStartedAt,
            })
          }
        }
        // 流结束不代表回答完成：代理网关可能直接关闭连接，或模型达到输出上限。
        // 必须先校验终态，再把工具调用写入历史并执行，避免留下无法配对的 tool_calls。
        if (this.opts.abortSignal.aborted) {
          yield* this.preservePartialMessage(assistantMsg, streamedText, streamedReasoning, iter)
          yield this.event('run_end', {
            timestamp: Date.now(), iterations: iter + 1, reason: 'aborted',
          })
          return
        }
        if (!assistantMsg) throw new Error('模型连接提前结束，未收到完成事件。请重试或输入“继续”。')
        const completionError = getCompletionError(assistantMsg, finishReason)
        if (completionError) throw new Error(completionError)
      } catch (e: any) {
        // 已经显示的正文也进入可恢复历史；丢弃未确认完整的工具调用及 Responses 输出项。
        yield* this.preservePartialMessage(assistantMsg, streamedText, streamedReasoning, iter)
        if (this.opts.abortSignal.aborted) {
          yield this.event('run_end', {
            timestamp: Date.now(), iterations: iter + 1, reason: 'aborted',
          })
          return
        }
        yield this.event('run_error', {
          timestamp: Date.now(),
          iteration: iter,
          error: e?.message ?? String(e),
        })
        throw e
      }

      assistantMsg.metadata = {
        ...assistantMsg.metadata,
        source: 'model',
      }
      this.opts.appendMessage(assistantMsg)
      yield this.event('assistant_message', {
        timestamp: Date.now(),
        iteration: iter,
        message: assistantMsg,
      })

      const toolCalls = assistantMsg.toolCalls ?? []
      if (toolCalls.length === 0) {
        yield this.event('run_end', {
          timestamp: Date.now(),
          iterations: iter + 1,
          reason: 'final',
        })
        return
      }

      yield this.event('tool_batch_start', {
        timestamp: Date.now(),
        iteration: iter,
        count: toolCalls.length,
      })

      const queue = new EventQueue<AgentRunEvent>()
      const toolBatch = executeToolBatch({
        toolCalls,
        availableTools,
        baseCtx: this.buildToolContext(queue, iter),
        abortSignal: this.opts.abortSignal,
        callbacks: {
          onToolStart: (info) =>
            queue.push(this.event('tool_start', {
              timestamp: Date.now(),
              iteration: iter,
              ...info,
            })),
          onToolProgress: (info) =>
            queue.push(this.event('tool_progress', {
              timestamp: Date.now(),
              iteration: iter,
              ...info,
            })),
          onToolEnd: (info) =>
            queue.push(this.event('tool_end', {
              timestamp: Date.now(),
              iteration: iter,
              ...info,
            })),
        },
      }).finally(() => queue.close())

      let queued: AgentRunEvent | null
      while ((queued = await queue.next())) {
        yield queued
      }
      const executedResults = await toolBatch

      for (const { call, executed } of executedResults) {
        const toolMsg: DeepMessage = {
          role: 'tool',
          content: executed.result.llmContent,
          toolCallId: call.id,
          toolName: call.name,
          isError: executed.result.isError,
          timestamp: Date.now(),
          metadata: { source: 'tool' },
        }
        this.opts.appendMessage(toolMsg)
        yield this.event('tool_message', {
          timestamp: Date.now(),
          iteration: iter,
          message: toolMsg,
        })
      }

      yield this.event('iteration_end', {
        timestamp: Date.now(),
        iteration: iter,
        toolCount: toolCalls.length,
      })
    }

    const warning =
      `\n\n[已达到单轮最大工具调用次数（${maxIterations}），自动停止。` +
      '如需继续请再次输入。]'
    yield this.event('text_delta', {
      timestamp: Date.now(),
      iteration: maxIterations,
      delta: warning,
    })
    yield this.event('run_end', {
      timestamp: Date.now(),
      iterations: maxIterations,
      reason: 'max_iterations',
    })
  }

  private *preservePartialMessage(
    message: DeepMessage | null,
    streamedText: string,
    streamedReasoning: string,
    iteration: number,
  ): Generator<AgentRunEvent> {
    const content = message?.content || streamedText
    if (!content.trim()) return
    const partial: DeepMessage = {
      role: 'assistant',
      content,
      reasoning: message?.reasoning || streamedReasoning || undefined,
      timestamp: Date.now(),
      metadata: { source: 'model' },
    }
    this.opts.appendMessage(partial)
    yield this.event('assistant_message', {
      timestamp: Date.now(), iteration, message: partial,
    })
  }

  private async *compactIfNeeded(iteration: number, tools: ChatCompletionTool[]): AsyncGenerator<AgentRunEvent> {
    const messages = this.opts.getMessages()
    // 压缩阈值随「当前生效模型最大上下文长度 × 90%」动态变化：
    // 解析当前 Provider + 模型 + 用户选定档位（modelContextOverrides）得到生效窗口，再据此判断是否压缩。
    const contextWindow = resolveContextWindow(
      this.opts.client.getProviderId(),
      this.opts.model,
      this.opts.config.modelContextOverrides,
    )
    const usedTokens = estimateRequestTokens(messages, tools)
    const threshold = getCompactThreshold(contextWindow)
    if (this.compactUnavailable || usedTokens <= threshold || !canCompactMessages(messages)) return
    const beforeCount = messages.length
    yield this.event('compact_start', {
      timestamp: Date.now(),
      iteration,
      messageCount: messages.length,
      usedTokens, threshold, contextWindow,
    })
    const compacted = await compactMessages(
      this.opts.client,
      messages,
      this.opts.model,
      this.opts.abortSignal,
    )
    const applied = compacted !== messages
    if (applied) this.opts.setMessages(compacted)
    else this.compactUnavailable = true
    yield this.event('compact_end', {
      timestamp: Date.now(),
      iteration,
      beforeCount,
      afterCount: compacted.length,
      applied,
    })
  }

  private buildToolContext(
    queue: EventQueue<AgentRunEvent>,
    iteration: number,
  ): ToolContext {
    return {
      cwd: this.opts.cwd,
      extraDirs: this.opts.extraDirs ?? [],
      config: this.opts.config,
      permissionMode: this.opts.permissionMode,
      abortSignal: this.opts.abortSignal,
      requestPermission: this.opts.requestPermission,
      todos: this.opts.getTodos(),
      setTodos: this.opts.setTodos,
      sessionId: this.opts.sessionId ?? null,
      onProgress: (text) =>
        queue.push(this.event('tool_progress', {
          timestamp: Date.now(),
          iteration,
          id: 'unknown',
          text,
        })),
    }
  }

  private resolveAvailableTools(): ToolDefinition[] {
    return this.opts.getAvailableTools?.(this.opts.permissionMode) ??
      getAvailableTools(this.opts.permissionMode)
  }

  private event<T extends AgentRunEvent['type']>(
    type: T,
    payload: Omit<Extract<AgentRunEvent, { type: T }>, 'type' | 'runId' | 'turnId'>,
  ): Extract<AgentRunEvent, { type: T }> {
    const event = {
      type,
      runId: this.runId,
      turnId: this.turnId,
      ...payload,
    } as Extract<AgentRunEvent, { type: T }>
    traceRunnerEvent(event)
    return event
  }
}

function getCompletionError(message: DeepMessage, finishReason: string): string | null {
  if (finishReason === 'length') {
    return '模型达到本次输出长度上限，回答或工具参数尚未完成。未执行本次工具调用，可输入“继续”重试。'
  }
  if (finishReason === 'content_filter') {
    return '模型输出被供应商内容过滤器中止（content_filter），本轮未完成。请调整请求后重试。'
  }
  if (finishReason !== 'stop' && finishReason !== 'tool_calls') {
    return `模型返回非正常结束原因（${finishReason || 'unknown'}），本轮未完成。请重试。`
  }
  if (!message.toolCalls?.length) {
    if (finishReason === 'tool_calls') return '模型声明要调用工具，但未返回工具调用。本轮未完成，请重试。'
    if (!message.content.trim()) return '模型未返回正文或工具调用，本轮未完成。请重试或调整模型。'
  }
  return null
}

function traceRunnerEvent(event: AgentRunEvent): void {
  const context = {
    runId: event.runId,
    turnId: event.turnId,
    iteration: 'iteration' in event ? event.iteration : undefined,
  }
  if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
    traceEvent('runner', event.type, {
      ...traceTextFields('delta', event.delta),
    }, context)
    return
  }
  if (event.type === 'turn_start') {
    traceEvent('runner', event.type, {
      ...traceTextFields('userInput', event.userInput),
    }, context)
    return
  }
  if (event.type === 'llm_done' || event.type === 'assistant_message') {
    traceEvent('runner', event.type, {
      finishReason: event.type === 'llm_done' ? event.finishReason : undefined,
      toolCallCount: event.message.toolCalls?.length ?? 0,
      ...traceTextFields('content', event.message.content),
      ...(event.message.reasoning ? traceTextFields('reasoning', event.message.reasoning) : {}),
    }, context)
    return
  }
  traceEvent('runner', event.type, summarizeRunnerEvent(event), context)
}

function summarizeRunnerEvent(event: AgentRunEvent): Record<string, unknown> {
  if (event.type === 'tool_start') {
    return { id: event.id, name: event.name, summary: event.summary }
  }
  if (event.type === 'tool_progress') {
    return { id: event.id, ...traceTextFields('text', event.text) }
  }
  if (event.type === 'tool_end') {
    return {
      id: event.id,
      name: event.name,
      isError: !!event.result.isError,
      durationMs: event.durationMs,
      ...traceTextFields('result', event.result.llmContent),
    }
  }
  if (event.type === 'run_end') return { reason: event.reason, iterations: event.iterations }
  if (event.type === 'run_error') return { error: event.error }
  if (event.type === 'llm_start') return { model: event.model, toolCount: event.toolCount }
  if (event.type === 'tool_batch_start') return { count: event.count }
  if (event.type === 'iteration_end') return { toolCount: event.toolCount }
  if (event.type === 'compact_start') return { messageCount: event.messageCount }
  if (event.type === 'compact_end') return { beforeCount: event.beforeCount, afterCount: event.afterCount }
  if (event.type === 'tool_message') {
    return {
      toolName: event.message.toolName,
      toolCallId: event.message.toolCallId,
      ...traceTextFields('content', event.message.content),
    }
  }
  return {}
}

class EventQueue<T> {
  private items: T[] = []
  private waiters: Array<(value: T | null) => void> = []
  private closed = false

  push(item: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null)
    }
  }

  async next(): Promise<T | null> {
    const item = this.items.shift()
    if (item) return item
    if (this.closed) return null
    return await new Promise<T | null>((resolve) => {
      this.waiters.push(resolve)
    })
  }
}
