// 使用真实 SDK 解析 SSE，验证断流不会伪装成成功，也不会重放已显示的内容。
import OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import type { DCodeConfig } from '../config.js'
import type { StreamEvent } from '../providers/types.js'
import { OpenAICompatibleClient } from './client.js'

const config: DCodeConfig = {
  provider: 'custom', model: 'test-model', baseURL: 'https://example.invalid/v1',
  apiKey: 'test-only', theme: 'dark', showThinking: true, reasoningEffort: 'high',
  alwaysAllow: [], totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false,
  soundEnabled: false, soundVolume: 0,
}
const params = { model: config.model, messages: [{ role: 'user' as const, content: '继续处理' }], tools: [] }
const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

function fromSse(chunks: unknown[], doneMarker = false) {
  const sse = chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('')
    + (doneMarker ? 'data: [DONE]\n\n' : '')
  const fetchMock = vi.fn(async () => new Response(sse, { headers: { 'content-type': 'text/event-stream' } }))
  const client = new OpenAICompatibleClient(config)
  // 仅替换 HTTP transport，结束标记和 EOF 仍经 SDK 的 SSE 解析器处理。
  Object.assign(client, { client: new OpenAI({ apiKey: 'test-only', baseURL: config.baseURL,
    fetch: fetchMock as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'], maxRetries: 0 }) })
  return { client, fetchMock }
}

describe('兼容 API 流式完成边界', () => {
  it.each([
    ['正文', chunk({ content: '尚未完成的回答' }), false],
    ['思考', chunk({ reasoning_content: '正在检查' }), false],
    ['工具参数', chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
      function: { name: 'write_file', arguments: '{"path":"a.ts","content":' } }] }), false],
    ['只有 DONE 标记', chunk({ content: '尚未完成的回答' }), true],
  ])('%s 断流时不发 done，也不自动重放内容', async (_name, item, doneMarker) => {
    const { client, fetchMock } = fromSse([item], doneMarker)
    const received: StreamEvent[] = []
    await expect(async () => {
      for await (const event of client.streamChat(params)) received.push(event)
    }).rejects.toThrow('未收到完成标记')
    expect(received.some((event) => event.type === 'done')).toBe(false)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('空 SSE 流也必须报告连接未完成', async () => {
    const { client } = fromSse([])
    await expect(async () => {
      for await (const _event of client.streamChat(params)) { /* 消费直到 EOF */ }
    }).rejects.toThrow('未收到完成标记')
  })

  it('收到 finish_reason 后保留合法重复增量和尾部 usage', async () => {
    const { client } = fromSse([
      chunk({ content: '哈' }), chunk({ content: '哈' }), chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ], true)
    const received: StreamEvent[] = []
    for await (const event of client.streamChat(params)) received.push(event)
    expect(received.filter((event) => event.type === 'text').map((event) => event.delta)).toEqual(['哈', '哈'])
    expect(received.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop',
      message: { content: '哈哈' }, usage: { total_tokens: 12 } })
  })

  it('完整工具调用保留 finish_reason 交给主循环处理', async () => {
    const { client } = fromSse([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function',
        function: { name: 'read_file', arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, 'tool_calls'),
    ], true)
    const received: StreamEvent[] = []
    for await (const event of client.streamChat(params)) received.push(event)
    expect(received.at(-1)).toMatchObject({ type: 'done', finishReason: 'tool_calls',
      message: { toolCalls: [{ id: 'call_1', name: 'read_file', argsJson: '{"path":"a.ts"}' }] } })
  })

  it('SDK 静默结束取消的流时也不能误发 done', async () => {
    const controller = new AbortController()
    const client = new OpenAICompatibleClient(config)
    Object.assign(client, { client: { chat: { completions: { create: async function* () {
      yield chunk({ content: '片段' }, 'stop')
      controller.abort()
    } } } } })
    const received: StreamEvent[] = []
    await expect(async () => {
      for await (const event of client.streamChat({ ...params, abortSignal: controller.signal })) received.push(event)
    }).rejects.toThrow('已取消请求')
    expect(received.some((event) => event.type === 'done')).toBe(false)
  })
})
