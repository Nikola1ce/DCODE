// OpenAI Responses 流式适配：保留工具调用与加密推理，复用现有 Agent 事件协议。
// 制作人：Moriarty_Dox
import type OpenAI from 'openai'
import type { ResponseInputItem, ResponseOutputItem } from 'openai/resources/responses/responses'
import type { DeepMessage } from '../core/types.js'
import type { StreamChatParams, StreamEvent } from './types.js'
import { DEFAULT_REASONING_EFFORT } from '../constants.js'

/** GPT-5+ 与 Pro/Codex 使用 Responses，旧模型和其它供应商继续使用兼容接口。 */
export function usesResponsesApi(model: string): boolean {
  return /^gpt-(?:[5-9]|\d{2,})(?:[.-]|$)/i.test(model) || /^(?:o\d.*-pro|codex-)/i.test(model)
}

export function toResponsesInput(messages: DeepMessage[]): ResponseInputItem[] {
  const input: ResponseInputItem[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId ?? '', output: message.content })
    } else if (message.role === 'assistant') {
      if (message.responseOutput?.length) {
        // 必须保留顺序及 reasoning.encrypted_content，不能只回传可见文本。
        input.push(...message.responseOutput)
      } else {
        if (message.content) input.push({ role: 'assistant', content: message.content })
        for (const call of message.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argsJson || '{}' })
        }
      }
    } else {
      input.push({ role: message.role, content: message.content })
    }
  }
  return input
}

export async function* streamResponses(
  client: OpenAI,
  params: StreamChatParams,
): AsyncGenerator<StreamEvent> {
  const effort = params.reasoningEffort ?? DEFAULT_REASONING_EFFORT
  // 旧推理系列最高为 high；新系列才接受 max，避免升级影响旧配置。
  const supportsMax = /^gpt-(?:5\.6|[6-9]|\d{2,})(?:[.-]|$)/i.test(params.model)
  const stream = await client.responses.create({
    model: params.model,
    input: toResponsesInput(params.messages),
    tools: params.tools.map(({ function: fn }) => ({
      type: 'function' as const,
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters ?? { type: 'object', properties: {} },
      // 现有工具含可选参数，不能隐式启用 Responses 默认 strict schema。
      strict: false,
    })),
    reasoning: { effort: (effort === 'max' && !supportsMax ? 'high' : effort) as 'low' | 'medium' | 'high' },
    store: false,
    include: ['reasoning.encrypted_content'],
    stream: true,
  }, { signal: params.abortSignal })

  let text = ''
  let reasoning = ''
  const completedItems = new Map<number, ResponseOutputItem>()
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      text += event.delta
      yield { type: 'text', delta: event.delta }
    } else if (event.type === 'response.reasoning_summary_text.delta') {
      reasoning += event.delta
      yield { type: 'reasoning', delta: event.delta }
    } else if (event.type === 'response.output_item.done') {
      completedItems.set(event.output_index, event.item)
    } else if (event.type === 'response.failed') {
      throw new Error(event.response.error?.message ?? 'OpenAI 响应失败')
    } else if (event.type === 'error') {
      throw new Error(event.message)
    } else if (event.type === 'response.incomplete') {
      // 不执行可能被截断的工具参数，也不把缺失的结尾误报为完成。
      throw new Error(`OpenAI 输出未完成（${event.response.incomplete_details?.reason ?? 'unknown'}），请缩短输入或继续重试。`)
    } else if (event.type === 'response.completed') {
      const response = event.response
      const output = response.output.length
        ? response.output.map((item, index) => completedItems.get(index) ?? item)
        : [...completedItems.entries()]
        .sort(([a], [b]) => a - b).map(([, item]) => item)
      const toolCalls = output.flatMap((item) => item.type === 'function_call'
        ? [{ id: item.call_id, name: item.name, argsJson: item.arguments }]
        : [])
      const finalText = output.flatMap((item) => item.type === 'message'
        ? item.content.map((part) => part.type === 'output_text' ? part.text : part.refusal)
        : []).join('')
      // 某些网关只在完成事件携带文本；有流式增量时只补齐缺失尾部。
      if (finalText.startsWith(text) && finalText.length > text.length) {
        yield { type: 'text', delta: finalText.slice(text.length) }
        text = finalText
      }
      // SDK 4 的类型尚未声明新版缓存写入字段，传输层已能原样返回它。
      const inputDetails = response.usage?.input_tokens_details as
        { cached_tokens?: number; cache_write_tokens?: number } | undefined
      yield {
        type: 'done',
        message: { role: 'assistant', content: text, reasoning: reasoning || undefined,
          toolCalls: toolCalls.length ? toolCalls : undefined, responseOutput: output, timestamp: Date.now() },
        finishReason: toolCalls.length ? 'tool_calls' : 'stop',
        usage: response.usage ? {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.total_tokens,
          prompt_cache_hit_tokens: inputDetails?.cached_tokens ?? 0,
          prompt_cache_write_tokens: inputDetails?.cache_write_tokens ?? 0,
        } : undefined,
      }
      return
    }
  }
  throw new Error('OpenAI 流式连接提前结束，未收到完成事件。')
}
