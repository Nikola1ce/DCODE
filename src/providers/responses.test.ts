// 使用真实 OpenAI SDK 解析 SSE，只替换 HTTP transport，不需要外网或 API Key。
// 制作人：Moriarty_Dox
import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { streamResponses } from './responses.js'
import type { StreamEvent } from './types.js'

describe('Responses SDK SSE 兼容', () => {
  it('真实 SDK 将 SSE 转为正文、工具调用与标准用量', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '开始读取', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ]
    const sse = [
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '开始' },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '读取' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output,
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 5 } } } },
    ].map(event => 'event: ' + event.type + '\n' + 'data: ' + JSON.stringify(event) + '\n\n').join('')
    const fetchMock = vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
    const client = new OpenAI({ apiKey: 'test-only', baseURL: 'https://example.invalid/v1',
      fetch: fetchMock as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'], maxRetries: 0 })
    const result: StreamEvent[] = []
    for await (const event of streamResponses(client, {
      model: 'gpt-6.1-sol', messages: [{ role: 'user', content: '读取文件' }], tools: [],
    })) result.push(event)
    expect(result.filter(event => event.type === 'text').map(event => event.delta).join('')).toBe('开始读取')
    expect(result.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls',
      message: { content: '开始读取', responseOutput: output, toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{"path":"a.ts"}' }] },
      usage: { prompt_tokens: 20, completion_tokens: 10, prompt_cache_hit_tokens: 5 } })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
