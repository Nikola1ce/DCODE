// AgentRunner：事件驱动的 Agent 主循环内核。
// 它只负责 orchestration：压缩上下文、调用模型、调度工具、回填消息并产出事件。
// UI/headless 继续通过 Agent.runTurn 的兼容适配器消费旧 TurnHandlers。

import { randomUUID } from 'node:crypto'
import { MAX_AGENT_ITERATIONS } from '../constants.js'
import type { DCodeConfig, PermissionMode } from '../config.js'
import { calcCost } from '../deepseek/pricing.js'
import type { LLMClient } from '../providers/types.js'
import {
  getAvailableTools,
  toOpenAITools,
} from '../tools/index.js'
import { compactMessages, shouldCompact } from './compact.js'
import { executeToolBatch } from './toolScheduler.js'
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

      yield* this.compactIfNeeded(iter)

      const availableTools = this.resolveAvailableTools()
      const apiTools = toOpenAITools(availableTools)
      yield this.event('llm_start', {
        timestamp: Date.now(),
        iteration: iter,
        model: this.opts.model,
        toolCount: apiTools.length,
      })

      let assistantMsg: DeepMessage | null = null
      let finishReason = 'stop'
      const llmStartedAt = Date.now()
      try {
        for await (const ev of this.opts.client.streamChat({
          messages: this.opts.getMessages(),
          tools: apiTools,
          model: this.opts.model,
          abortSignal: this.opts.abortSignal,
          reasoningEffort: this.opts.config.reasoningEffort,
        })) {
          if (ev.type === 'reasoning') {
            yield this.event('reasoning_delta', {
              timestamp: Date.now(),
              iteration: iter,
              delta: ev.delta,
            })
          } else if (ev.type === 'text') {
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
      } catch (e: any) {
        yield this.event('run_error', {
          timestamp: Date.now(),
          iteration: iter,
          error: e?.message ?? String(e),
        })
        throw e
      }

      if (!assistantMsg) {
        yield this.event('run_end', {
          timestamp: Date.now(),
          iterations: iter + 1,
          reason: this.opts.abortSignal.aborted ? 'aborted' : 'final',
        })
        return
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

  private async *compactIfNeeded(iteration: number): AsyncGenerator<AgentRunEvent> {
    const messages = this.opts.getMessages()
    if (!shouldCompact(messages)) return
    yield this.event('compact_start', {
      timestamp: Date.now(),
      iteration,
      messageCount: messages.length,
    })
    const compacted = await compactMessages(
      this.opts.client,
      messages,
      this.opts.model,
    )
    this.opts.setMessages(compacted)
    yield this.event('compact_end', {
      timestamp: Date.now(),
      iteration,
      beforeCount: messages.length,
      afterCount: compacted.length,
    })
  }

  private buildToolContext(
    queue: EventQueue<AgentRunEvent>,
    iteration: number,
  ): ToolContext {
    return {
      cwd: this.opts.cwd,
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
    return {
      type,
      runId: this.runId,
      turnId: this.turnId,
      ...payload,
    } as Extract<AgentRunEvent, { type: T }>
  }
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
