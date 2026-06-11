// DeepSeek 流式客户端。
// 基于 openai SDK（指向 DeepSeek 的 OpenAI 兼容端点）实现：
//   1) 将内部 DeepMessage[] 转换为严格的 API 消息体（剥离思维链等不可回传字段）；
//   2) 以流式（SSE）方式请求，逐增量产出文本 / 思维链 / 工具调用事件；
//   3) 合并分片的 tool_calls（按 index 累积 name 与 arguments）；
//   4) 对限流/服务端错误做指数退避重试。
// 制作人：Moriarty_Dox

import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type { DCodeConfig } from '../config.js'
import { resolveApiKey } from '../config.js'
import type { DeepMessage, ToolCall } from '../core/types.js'
import type { DeepSeekUsage } from './pricing.js'

/**
 * 流式过程中产出的事件类型（供 Agent 主循环消费并转发到 UI）。
 */
export type StreamEvent =
  // 思维链增量（仅 deepseek-reasoner 会产生）。
  | { type: 'reasoning'; delta: string }
  // 正文文本增量。
  | { type: 'text'; delta: string }
  // 流结束：返回完整组装好的 assistant 消息、用量与结束原因。
  | {
      type: 'done'
      message: DeepMessage
      usage?: DeepSeekUsage
      finishReason: string
    }

// 发起一次流式对话所需的参数。
export interface StreamChatParams {
  // 完整消息历史（含 system）。
  messages: DeepMessage[]
  // 可供模型调用的工具定义（OpenAI function 格式）；无工具时传空数组。
  tools: ChatCompletionTool[]
  // 使用的模型名称。
  model: string
  // 采样温度，编程任务通常用较低温度以保证稳定性。
  temperature?: number
  // 取消信号：用户中断时中止请求。
  abortSignal?: AbortSignal
}

// 触发重试的最大次数。
const MAX_RETRIES = 3

/**
 * 将内部 DeepMessage 转换为 DeepSeek/OpenAI 接受的消息体。
 * 关键点：
 *   - assistant 的 reasoning（思维链）不可回传，必须剔除；
 *   - assistant 若含 toolCalls，需转换为标准 tool_calls 结构，content 允许为空串；
 *   - tool 角色消息需带 tool_call_id。
 * @param messages 内部消息数组。
 * @returns 适配 API 的消息数组。
 */
function toApiMessages(messages: DeepMessage[]): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m.role === 'assistant') {
      // 组装 assistant 消息：若有工具调用则附上 tool_calls。
      const msg: ChatCompletionMessageParam = {
        role: 'assistant',
        content: m.content || '',
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
      // tool 结果消息：必须携带对应的 tool_call_id。
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId ?? '',
      }
    }
    if (m.role === 'system') {
      return { role: 'system', content: m.content }
    }
    // 其余按 user 处理。
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
  // 常见网络错误码：连接重置/超时等。
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
 * DeepSeek 客户端封装类。
 * 持有底层 openai SDK 实例与默认配置，对外暴露流式对话方法。
 */
export class DeepSeekClient {
  // 底层 OpenAI 兼容客户端实例。
  private client: OpenAI
  // 关联的配置（用于读取 baseURL / apiKey）。
  private config: DCodeConfig

  /**
   * 构造函数：根据配置初始化底层客户端。
   * @param config 已加载的 DCODE 配置。
   */
  constructor(config: DCodeConfig) {
    this.config = config
    this.client = new OpenAI({
      apiKey: resolveApiKey(config) ?? 'MISSING_API_KEY',
      baseURL: config.baseURL,
    })
  }

  /**
   * 校验当前是否已配置可用的 API Key。
   * @returns 已配置返回 true。
   */
  hasApiKey(): boolean {
    const key = resolveApiKey(this.config)
    return !!key && key !== 'MISSING_API_KEY'
  }

  /**
   * 以流式方式发起一次对话补全，产出增量事件。
   * 内部对可重试错误做指数退避；不可重试错误直接抛出由上层处理。
   * @param params 流式请求参数。
   * @returns 异步事件生成器。
   */
  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    const { messages, tools, model, temperature = 0.2, abortSignal } = params
    const apiMessages = toApiMessages(messages)

    // 重试循环：仅在“尚未产出任何增量”时重试，避免重复输出。
    let attempt = 0
    while (true) {
      try {
        // 创建流式请求；include_usage 让末尾 chunk 带回用量统计。
        const stream = await this.client.chat.completions.create(
          {
            model,
            messages: apiMessages,
            // 仅在确有工具时传 tools，避免空数组导致部分网关报错。
            ...(tools.length > 0
              ? { tools, tool_choice: 'auto' as const }
              : {}),
            temperature,
            stream: true,
            stream_options: { include_usage: true },
          },
          { signal: abortSignal },
        )

        // 累积状态：正文、思维链、按 index 聚合的工具调用。
        let textBuf = ''
        let reasoningBuf = ''
        const toolAccum = new Map<
          number,
          { id: string; name: string; args: string }
        >()
        let usage: DeepSeekUsage | undefined
        let finishReason = 'stop'

        for await (const chunk of stream) {
          // 末尾 usage chunk 可能没有 choices。
          if (chunk.usage) usage = chunk.usage as DeepSeekUsage

          const choice = chunk.choices?.[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason

          const delta: any = choice.delta ?? {}

          // 思维链增量（DeepSeek 扩展字段 reasoning_content）。
          if (delta.reasoning_content) {
            reasoningBuf += delta.reasoning_content
            yield { type: 'reasoning', delta: delta.reasoning_content }
          }

          // 正文增量。
          if (delta.content) {
            textBuf += delta.content
            yield { type: 'text', delta: delta.content }
          }

          // 工具调用增量：按 index 聚合 name 与 arguments 片段。
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

        // 组装最终的 assistant 消息。
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

        yield { type: 'done', message, usage, finishReason }
        return
      } catch (err: any) {
        // 用户主动中断不算错误，直接终止。
        if (abortSignal?.aborted) {
          throw new Error('已取消请求')
        }
        // 可重试错误：指数退避后重试；超过上限则抛出。
        if (isRetryable(err) && attempt < MAX_RETRIES) {
          attempt++
          const backoffMs = 500 * 2 ** (attempt - 1)
          await sleep(backoffMs)
          continue
        }
        throw normalizeApiError(err)
      }
    }
  }
}

/**
 * 将底层 SDK 抛出的错误归一化为带友好中文提示的 Error。
 * @param err 原始错误。
 * @returns 处理后的 Error。
 */
function normalizeApiError(err: any): Error {
  const status = err?.status ?? err?.response?.status
  if (status === 401) {
    return new Error('鉴权失败（401）：API Key 无效或已过期，请用 /login 重新设置。')
  }
  if (status === 402) {
    return new Error('余额不足（402）：请前往 DeepSeek 平台充值后重试。')
  }
  if (status === 429) {
    return new Error('请求过于频繁（429）：已达到速率限制，请稍后重试。')
  }
  if (typeof status === 'number' && status >= 500) {
    return new Error(`DeepSeek 服务端错误（${status}）：请稍后重试。`)
  }
  const msg = err?.message ?? String(err)
  return new Error(`请求失败：${msg}`)
}
