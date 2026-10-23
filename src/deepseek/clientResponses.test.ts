// 新模型的协议回归：真实 SDK 接口边界的可控流，覆盖工具往返、推理状态与中断。
// 制作人：Moriarty_Dox
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DCodeConfig } from '../config.js'
import type { DeepMessage } from '../core/types.js'
import type { StreamChatParams, StreamEvent } from '../providers/types.js'

const sdk = vi.hoisted(() => ({ chat: vi.fn(), responses: vi.fn(), options: vi.fn() }))
vi.mock('openai', () => ({ default: class {
  chat = { completions: { create: sdk.chat } }
  responses = { create: sdk.responses }
  constructor(options: unknown) { sdk.options(options) }
} }))
import { OpenAICompatibleClient } from './client.js'

const config: DCodeConfig = {
  provider: 'openai', model: 'gpt-6-luna', baseURL: 'https://api.openai.com/v1',
  theme: 'dark', showThinking: true, reasoningEffort: 'medium', alwaysAllow: [],
  totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false, soundEnabled: false, soundVolume: 0,
}
const tools: StreamChatParams['tools'] = [{ type: 'function', function: {
  name: 'read_file', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } } },
} }]
async function* events(...items: any[]) { yield* items }
const messageItem = (text: string) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] })
const done = (output: any[]) => ({ type: 'response.completed', response: { output,
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 40 } } } })
async function collect(client: OpenAICompatibleClient, params: Partial<StreamChatParams> = {}) {
  const result: StreamEvent[] = []
  for await (const event of client.streamChat({ model: config.model, tools,
    messages: [{ role: 'user', content: '读文件' }], ...params })) result.push(event)
  return result
}

beforeEach(() => vi.clearAllMocks())
describe('Responses 新模型工具调用', () => {
  it.each(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])('%s 使用 Responses，保留强度及可选工具参数', async (model) => {
    sdk.responses.mockResolvedValue(events(done([messageItem('完成')])))
    const result = await collect(new OpenAICompatibleClient(config), { model, reasoningEffort: 'max' })
    const body = sdk.responses.mock.calls[0][0]
    expect(body.model).toBe(model)
    expect(body.reasoning.effort).toBe('max')
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'read_file', strict: false })
    expect(body.temperature).toBeUndefined()
    expect(body.store).toBe(false)
    expect(body.include).toContain('reasoning.encrypted_content')
    expect(sdk.chat).not.toHaveBeenCalled()
    expect(sdk.options).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }))
    expect(result.at(-1)).toMatchObject({ type: 'done', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 } })
  })

  it('工具往返保留加密推理和 call_id，会话序列化后仍可续接', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-complete' }
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' }
    sdk.responses.mockResolvedValueOnce(events(
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, encrypted_content: 'partial' } },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      done([{ ...reasoning, encrypted_content: undefined }, call]),
    )).mockResolvedValueOnce(events(done([messageItem('已读取')])))
    const client = new OpenAICompatibleClient(config)
    const result = await collect(client)
    const final = result.at(-1)
    expect(final?.type).toBe('done')
    if (final?.type !== 'done') throw new Error('missing done')
    expect(final.message.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', argsJson: '{"path":"a.ts"}' }])
    const restored: DeepMessage = JSON.parse(JSON.stringify(final.message))
    await collect(client, { messages: [{ role: 'user', content: '读文件' }, restored,
      { role: 'tool', toolCallId: 'call_1', content: '文件内容' }] })
    expect(sdk.responses.mock.calls[1][0].input).toEqual([
      { role: 'user', content: '读文件' }, reasoning, call,
      { type: 'function_call_output', call_id: 'call_1', output: '文件内容' },
    ])
  })

  it('逐 token 重复字符与最终快照不丢字、不重复', async () => {
    sdk.responses.mockResolvedValue(events(
      ...['哈', '哈', '\n', '\n', '  ', '  ', 'x'].map((delta) => ({ type: 'response.output_text.delta', delta })),
      done([messageItem('哈哈\n\n    x')]),
    ))
    const result = await collect(new OpenAICompatibleClient(config))
    expect(result.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('哈哈\n\n    x')
    expect(result.at(-1)).toMatchObject({ message: { content: '哈哈\n\n    x' } })
  })

  it.each([
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }, '未完成'],
    [{ type: 'response.failed', response: { error: { message: 'model unavailable' } } }, 'model unavailable'],
    [{ type: 'error', message: 'bad request' }, 'bad request'],
  ])('失败或截断不伪造成功和工具调用', async (event, error) => {
    sdk.responses.mockResolvedValue(events(event))
    await expect(collect(new OpenAICompatibleClient(config))).rejects.toThrow(error)
  })

  it('无完成事件的断流报错', async () => {
    sdk.responses.mockResolvedValue(events({ type: 'response.output_text.delta', delta: '未完' }))
    await expect(collect(new OpenAICompatibleClient(config))).rejects.toThrow('提前结束')
    expect(sdk.responses).toHaveBeenCalledTimes(1)
  })

  it('取消退避等待立即结束，不再发送请求', async () => {
    const controller = new AbortController()
    sdk.responses.mockRejectedValue(Object.assign(new Error('限流'), { status: 429 }))
    const pending = collect(new OpenAICompatibleClient(config), { abortSignal: controller.signal })
    // 等待第一次请求失败进入退避，再主动中断。
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(pending).rejects.toThrow('已取消')
    expect(sdk.responses).toHaveBeenCalledTimes(1)
  })

  it('兼容 API 的标准 delta 同样保留重复字符与换行', async () => {
    sdk.chat.mockResolvedValue(events(...['a', 'a', '\n', '\n'].map((content) => ({ choices: [{ delta: { content } }] }))))
    const result = await collect(new OpenAICompatibleClient({ ...config, provider: 'custom' }))
    expect(result.at(-1)).toMatchObject({ message: { content: 'aa\n\n' } })
    expect(sdk.responses).not.toHaveBeenCalled()
  })

  it('GLM-5.3 Flash 映射 medium，隐藏思考不发送 unsupported disabled', async () => {
    sdk.chat.mockResolvedValue(events({ choices: [{ delta: { content: '完成' } }] }))
    await collect(new OpenAICompatibleClient({ ...config, provider: 'zhipu', showThinking: false }), { model: 'glm-5.3-flash' })
    expect(sdk.chat.mock.calls[0][0]).toMatchObject({ thinking: { type: 'enabled', clear_thinking: false },
      reasoning_effort: 'high', tool_stream: true, temperature: 1 })
  })
})
