// OpenAI 兼容 LLM 流式客户端。
// 基于 openai SDK 对接 DeepSeek / OpenAI / Ollama 等 OpenAI 兼容端点：
//   1) 将内部 DeepMessage[] 转换为严格的 API 消息体（剥离思维链等不可回传字段）；
//   2) 以流式（SSE）方式请求，逐增量产出文本 / 思维链 / 工具调用事件；
//   3) 合并分片的 tool_calls（按 index 累积 name 与 arguments）；
//   4) 对限流/服务端错误做指数退避重试。
// 制作人：Moriarty_Dox

import { appendFileSync } from 'node:fs'
import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { DCodeConfig } from '../config.js'
import { resolveApiKey } from '../config.js'
import type { DeepMessage, ToolCall } from '../core/types.js'
import {
  getActiveProviderId,
  getProviderDefinition,
  providerSupportsThinking,
  resolveProviderBaseURL,
} from '../providers/registry.js'
import { buildOpenAIClientAgentOptions } from '../providers/proxy.js'
import { openaiModelSupportsCustomTemperature } from '../providers/openaiModels.js'
import {
  applyStreamContentDelta,
} from '../providers/streamDelta.js'
import type {
  LLMClient,
  ProviderId,
  StreamChatParams,
  StreamEvent,
} from '../providers/types.js'
import { traceEvent, traceTextFields } from '../trace.js'
import type { DeepSeekUsage } from './pricing.js'

// 向后兼容：类型定义已迁移至 providers/types。
export type { StreamEvent, StreamChatParams } from '../providers/types.js'

// 触发重试的最大次数。
const MAX_RETRIES = 3

function debugStreamEvent(event: Record<string, unknown>): void {
  const logPath = process.env.DCODE_STREAM_DEBUG_LOG
  if (!logPath) return
  try {
    appendFileSync(logPath, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8')
  } catch {
    // Debug logging must never affect streaming.
  }
}

function previewText(value: string): string {
  return value.length > 160 ? `${value.slice(0, 160)}...` : value
}

/**
 * 判断一次流式请求失败后是否允许自动重试。
 *
 * 一旦已经向上层 yield 过可见文本/思维链增量，就不能再静默重试：
 * UI 的 Static 历史区已经落盘了前一轮输出，重试会从头再流一次，表现为概率性重复输出。
 */
export function shouldRetryStreamError(
  err: any,
  attempt: number,
  emittedVisibleDelta: boolean,
): boolean {
  if (emittedVisibleDelta) return false
  return isRetryable(err) && attempt < MAX_RETRIES
}

/**
 * 将内部 DeepMessage 转换为 OpenAI 兼容 API 接受的消息体。
 * 关键点：
 *   - 无工具调用的 assistant 消息不回传 reasoning（API 会忽略）；
 *   - 含 tool_calls 的 assistant 必须回传 reasoning_content，否则多轮工具调用会 400；
 *   - tool 角色消息需带 tool_call_id。
 * @param messages 内部消息数组。
 * @returns 适配 API 的消息数组。
 */
function toApiMessages(messages: DeepMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === 'assistant') {
      const msg: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: 'assistant',
        content: m.content || '',
      }
      if (m.toolCalls && m.toolCalls.length > 0 && m.reasoning) {
        msg.reasoning_content = m.reasoning
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        ;(msg as any).tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.argsJson || '{}' },
        }))
      }
      return msg
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      }
    }
    if (m.role === 'system') {
      return { role: 'system', content: m.content }
    }
    return { role: 'user', content: m.content }
  })
}

/**
 * 判断错误是否可重试（限流 429、服务端 5xx、网络抖动）。
 * @param err 捕获到的异常。
 * @returns 可重试返回 true。
 */
function isRetryable(err: any): boolean {
  const status = err?.status ?? err?.response?.status
  if (status === 429) return true
  if (typeof status === 'number' && status >= 500) return true
  const code = err?.code
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND')
    return true
  return false
}

/**
 * 简单的延时工具（用于退避等待）。
 * @param ms 毫秒数。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * OpenAI 兼容 LLM 客户端：根据 config.provider 连接对应后端。
 */
export class OpenAICompatibleClient implements LLMClient {
  private client: OpenAI
  private config: DCodeConfig
  private providerId: ProviderId

  /**
   * 构造函数：根据配置初始化底层客户端。
   * @param config 已加载的 DCODE 配置。
   */
  constructor(config: DCodeConfig) {
    this.config = config
    this.providerId = getActiveProviderId(config)
    const apiKey = resolveApiKey(config) ?? 'MISSING_API_KEY'
    this.client = new OpenAI({
      apiKey,
      baseURL: resolveProviderBaseURL(config),
      ...buildOpenAIClientAgentOptions(config),
    })
  }

  /** @inheritdoc */
  hasApiKey(): boolean {
    const def = getProviderDefinition(this.providerId)
    if (!def.requiresApiKey) return true
    const key = resolveApiKey(this.config)
    return !!key && key !== 'MISSING_API_KEY'
  }

  /** @inheritdoc */
  getProviderId(): ProviderId {
    return this.providerId
  }

  /** @inheritdoc */
  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { messages, tools, model, temperature = 0.2, abortSignal } = params
    const traceContext = params.trace ?? {}
    const apiMessages = toApiMessages(messages)
    const supportsThinking = providerSupportsThinking(this.config)
    const thinkingType =
      params.thinking ?? (this.config.showThinking ? 'enabled' : 'disabled')
    const reasoningEffort =
      params.reasoningEffort ?? this.config.reasoningEffort ?? 'high'

    let attempt = 0
    while (true) {
      let emittedVisibleDelta = false
      try {
        const requestBody: Record<string, unknown> = {
          model,
          messages: apiMessages,
          ...(tools.length > 0
            ? { tools, tool_choice: 'auto' as const }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        }

        // GPT-5+ / o 系列等仅支持默认 temperature=1，传 0.2 会 400。
        const maySetTemperature =
          this.providerId !== 'openai' || openaiModelSupportsCustomTemperature(model)
        if (maySetTemperature) {
          requestBody.temperature = temperature
        }

        // 仅 DeepSeek 等支持 thinking 的 Provider 发送扩展字段。
        if (supportsThinking) {
          requestBody.thinking = { type: thinkingType }
          if (thinkingType === 'enabled') {
            requestBody.reasoning_effort = reasoningEffort
          }
        }

        const stream = (await this.client.chat.completions.create(
          requestBody as any,
          { signal: abortSignal },
        )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>
        traceEvent('provider', 'stream_start', {
          model,
          providerId: this.providerId,
          messageCount: apiMessages.length,
          toolCount: tools.length,
          thinkingType,
          reasoningEffort,
        }, traceContext)

        let textBuf = ''
        let reasoningBuf = ''
        const toolAccum = new Map<
          number,
          { id: string; name: string; args: string }
        >()
        let usage: DeepSeekUsage | undefined
        let finishReason = 'stop'

        let providerSeq = 0
        for await (const chunk of stream) {
          providerSeq += 1
          if (chunk.usage) usage = chunk.usage as DeepSeekUsage

          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta: any = choice.delta ?? {}
          const messageContent: string | undefined = (choice as any).message?.content
          traceEvent('provider', 'raw_chunk', {
            providerSeq,
            choiceCount: chunk.choices?.length ?? 0,
            finishReason: choice.finish_reason ?? null,
            hasDeltaContent: typeof delta.content === 'string' && delta.content.length > 0,
            hasReasoningContent:
              typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0,
            hasMessageContent: typeof messageContent === 'string' && messageContent.length > 0,
            rawChunk: chunk,
          }, traceContext)

          if (delta.reasoning_content) {
            const bufferBefore = reasoningBuf
            const { next, delta: reasoningDelta } = applyStreamContentDelta(
              reasoningBuf,
              delta.reasoning_content,
            )
            debugStreamEvent({
              kind: 'reasoning_incoming',
              incomingLength: delta.reasoning_content.length,
              emittedLength: reasoningDelta.length,
              bufferBefore: reasoningBuf.length,
              bufferAfter: next.length,
              incomingPreview: previewText(delta.reasoning_content),
              emittedPreview: previewText(reasoningDelta),
            })
            traceEvent('provider', 'reasoning_incoming', {
              providerSeq,
              ...traceTextFields('incoming', delta.reasoning_content),
              ...traceTextFields('emitted', reasoningDelta),
              bufferBeforeHash: traceTextFields('bufferBefore', bufferBefore).bufferBeforeHash,
              bufferBeforeLength: bufferBefore.length,
              bufferAfterHash: traceTextFields('bufferAfter', next).bufferAfterHash,
              bufferAfterLength: next.length,
            }, traceContext)
            reasoningBuf = next
            if (reasoningDelta) {
              emittedVisibleDelta = true
              traceEvent('provider', 'yield_reasoning', {
                providerSeq,
                ...traceTextFields('delta', reasoningDelta),
              }, traceContext)
              yield { type: 'reasoning', delta: reasoningDelta }
            }
          }

          const textIncoming =
            typeof delta.content === 'string' && delta.content.length > 0
              ? { text: delta.content, snapshot: false }
              : typeof messageContent === 'string' && messageContent.length > 0
                ? { text: messageContent, snapshot: true }
                : null
          if (textIncoming) {
            const bufferBefore = textBuf
            const { next, delta: textDelta } = applyStreamContentDelta(
              textBuf,
              textIncoming.text,
              { snapshot: textIncoming.snapshot },
            )
            debugStreamEvent({
              kind: 'text_incoming',
              source: textIncoming.snapshot ? 'snapshot' : 'delta',
              incomingLength: textIncoming.text.length,
              emittedLength: textDelta.length,
              bufferBefore: textBuf.length,
              bufferAfter: next.length,
              incomingPreview: previewText(textIncoming.text),
              emittedPreview: previewText(textDelta),
            })
            traceEvent('provider', 'text_incoming', {
              providerSeq,
              source: textIncoming.snapshot ? 'snapshot' : 'delta',
              ...traceTextFields('incoming', textIncoming.text),
              ...traceTextFields('emitted', textDelta),
              bufferBeforeHash: traceTextFields('bufferBefore', bufferBefore).bufferBeforeHash,
              bufferBeforeLength: bufferBefore.length,
              bufferAfterHash: traceTextFields('bufferAfter', next).bufferAfterHash,
              bufferAfterLength: next.length,
            }, traceContext)
            textBuf = next
            if (textDelta) {
              emittedVisibleDelta = true
              traceEvent('provider', 'yield_text', {
                providerSeq,
                source: textIncoming.snapshot ? 'snapshot' : 'delta',
                ...traceTextFields('delta', textDelta),
              }, traceContext)
              yield { type: 'text', delta: textDelta }
            }
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              const cur = toolAccum.get(idx) ?? { id: '', name: '', args: '' }
              if (tc.id) cur.id = tc.id
              if (tc.function?.name) cur.name = tc.function.name
              if (tc.function?.arguments) cur.args += tc.function.arguments
              toolAccum.set(idx, cur)
            }
          }
        }

        const toolCalls: ToolCall[] = [...toolAccum.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => ({ id: v.id, name: v.name, argsJson: v.args }))

        const message: DeepMessage = {
          role: 'assistant',
          content: textBuf,
          reasoning: reasoningBuf || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
        }

        traceEvent('provider', 'yield_done', {
          finishReason,
          toolCallCount: toolCalls.length,
          ...traceTextFields('content', textBuf),
          ...(reasoningBuf ? traceTextFields('reasoning', reasoningBuf) : {}),
        }, traceContext)
        yield { type: 'done', message, usage, finishReason }
        return
      } catch (err: any) {
        if (abortSignal?.aborted) {
          throw new Error('已取消请求')
        }
        if (shouldRetryStreamError(err, attempt, emittedVisibleDelta)) {
          attempt++
          const backoffMs = 500 * 2 ** (attempt - 1)
          await sleep(backoffMs)
          continue
        }
        throw normalizeApiError(err, this.providerId)
      }
    }
  }
}

/** 向后兼容别名：历史代码中的 DeepSeekClient 即 OpenAICompatibleClient。 */
export const DeepSeekClient = OpenAICompatibleClient

/**
 * 将底层 SDK 抛出的错误归一化为带友好中文提示的 Error。
 * @param err 原始错误。
 * @param providerId 当前 Provider。
 * @returns 处理后的 Error。
 */
function normalizeApiError(err: any, providerId: ProviderId): Error {
  const def = getProviderDefinition(providerId)
  const status = err?.status ?? err?.response?.status
  if (status === 401) {
    return new Error(
      `鉴权失败（401）：${def.name} API Key 无效或已过期，请用 /login 或环境变量 ${def.apiKeyEnv} 重新设置。`,
    )
  }
  if (status === 402 && providerId === 'deepseek') {
    return new Error('余额不足（402）：请前往 DeepSeek 平台充值后重试。')
  }
  if (status === 429) {
    return new Error('请求过于频繁（429）：已达到速率限制，请稍后重试。')
  }
  const msg = err?.message ?? String(err)
  if (typeof status !== 'number' && /connection|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    const hint =
      providerId === 'openai' || providerId === 'custom'
        ? ' 外国 Provider 需配置代理，例如 /proxy http://127.0.0.1:10793 或设置 HTTPS_PROXY。'
        : ''
    return new Error(`网络连接失败：${msg}${hint}`)
  }
  if (typeof status === 'number' && status >= 500) {
    return new Error(`${def.name} 服务端错误（${status}）：请稍后重试。`)
  }
  return new Error(`请求失败：${msg}`)
}
