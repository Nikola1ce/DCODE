// AgentRunner 单元测试。
// 覆盖无工具、工具回填、finishReason 与迭代上限路径。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { DCodeConfig } from '../config.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'
import { ALL_TOOLS } from '../tools/index.js'
import { globalToolRegistry } from '../tools/registry.js'
import { AgentRunner, type AgentRunnerOptions } from './agentRunner.js'
import type { AgentRunEvent, DeepMessage, ToolDefinition } from './types.js'

const baseConfig: DCodeConfig = {
  baseURL: 'http://example.test',
  model: 'test-model',
  theme: 'dark',
  showThinking: false,
  reasoningEffort: 'high',
  alwaysAllow: [],
  totalCostUsd: 0,
  onboardingComplete: true,
  hooksEnabled: false,
  soundEnabled: true,
  soundVolume: 100,
  provider: 'custom',
}

class FakeClient implements LLMClient {
  calls: StreamChatParams[] = []

  constructor(private readonly responses: StreamEvent[][]) {}

  hasApiKey(): boolean {
    return true
  }

  getProviderId() {
    return 'custom' as const
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push({ ...params, tools: params.tools as ChatCompletionTool[] })
    const next = this.responses.shift() ?? []
    for (const ev of next) yield ev
  }
}

function done(content: string, finishReason = 'stop'): StreamEvent {
  return {
    type: 'done',
    finishReason,
    message: { role: 'assistant', content, timestamp: Date.now() },
  }
}

function makeRunner(client: FakeClient, messages: DeepMessage[], overrides: Partial<AgentRunnerOptions> = {}): AgentRunner {
  return new AgentRunner({
    client,
    config: baseConfig,
    cwd: process.cwd(),
    permissionMode: 'bypass',
    model: baseConfig.model,
    userInput: 'hello',
    abortSignal: new AbortController().signal,
    requestPermission: async () => 'allow_once',
    getMessages: () => messages,
    setMessages: (next) => {
      messages.splice(0, messages.length, ...next)
    },
    appendMessage: (message) => {
      messages.push(message)
    },
    getTodos: () => [],
    setTodos: () => {},
    maxIterations: 3,
    ...overrides,
  })
}

async function collect(runner: AgentRunner, events: AgentRunEvent[] = []): Promise<AgentRunEvent[]> {
  for await (const ev of runner.run()) events.push(ev)
  return events
}

afterEach(() => {
  globalToolRegistry.registerBuiltin(ALL_TOOLS)
  vi.unstubAllEnvs()
})

describe('AgentRunner 上下文预算', () => {
  beforeEach(() => vi.stubEnv('DCODE_COMPACT_MAX_TOKENS', ''))
  const history = (): DeepMessage[] => [
    { role: 'system', content: '系统提示' },
    ...Array.from({ length: 12 }, (_, i): DeepMessage => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(9000) })),
  ]

  it('1M 窗口使用150K时不再提前压缩', async () => {
    const messages = history()
    messages[1].content = 'x'.repeat(360000)
    const client = new FakeClient([[done('完成')]])
    Object.defineProperty(client, 'getProviderId', { value: () => 'deepseek' })
    const events = await collect(makeRunner(client, messages, { model: 'deepseek-v4-pro', getAvailableTools: () => [] }))
    expect(events.some((e) => e.type === 'compact_start')).toBe(false)
    expect(client.calls).toHaveLength(1)
  })

  it('仅历史原文很大、实际发送视图很小时不压缩', async () => {
    const messages: DeepMessage[] = [
      { role: 'user', content: '读取' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', toolCallId: 'read', toolName: 'read_file', content: 'x'.repeat(400000) },
      ...Array.from({ length: 9 }, (): DeepMessage => ({ role: 'user', content: '继续' })),
    ]
    const client = new FakeClient([[done('完成')]])
    const events = await collect(makeRunner(client, messages, { getAvailableTools: () => [] }))
    expect(events.some((e) => e.type === 'compact_start')).toBe(false)
    expect(client.calls[0].messages[2].content.length).toBeLessThan(2000)
    expect(messages[2].content).toHaveLength(400000)
  })

  it('超过所选窗口90%时压缩并报告真实触发数据', async () => {
    const messages = history()
    const client = new FakeClient([[done('已完成前半段，继续检查剩余事项')], [done('完成')]])
    const events = await collect(makeRunner(client, messages, { getAvailableTools: () => [] }))
    expect(client.calls).toHaveLength(2)
    expect(events.find((e) => e.type === 'compact_start')).toMatchObject({ contextWindow: 32000, threshold: 28800 })
    expect(events.find((e) => e.type === 'compact_end')).toMatchObject({ applied: true, beforeCount: 14, afterCount: 8 })
    expect(messages.some((m) => m.metadata?.kind === 'summary')).toBe(true)
  })

  it('摘要失败后本轮工具循环不重复请求压缩', async () => {
    const messages = history()
    const client = new FakeClient([
      [done('')],
      [{ type: 'done', finishReason: 'tool_calls', message: { role: 'assistant', content: '', toolCalls: [{ id: 'unknown', name: 'missing_tool', argsJson: '{}' }] } }],
      [done('完成')],
    ])
    const events = await collect(makeRunner(client, messages, { getAvailableTools: () => [] }))
    expect(events.filter((e) => e.type === 'compact_start')).toHaveLength(1)
    expect(events.find((e) => e.type === 'compact_end')).toMatchObject({ applied: false })
    expect(client.calls).toHaveLength(3)
    expect(messages.some((m) => m.metadata?.kind === 'summary')).toBe(false)
  })

  it('取消压缩后不再发起下一次模型请求', async () => {
    const messages = history()
    const ac = new AbortController()
    const client = new FakeClient([])
    client.streamChat = async function* (params) {
      client.calls.push(params)
      ac.abort()
      yield done('摘要')
    }
    const events = await collect(makeRunner(client, messages, { abortSignal: ac.signal, getAvailableTools: () => [] }))
    expect(client.calls).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'aborted' })
    expect(events.some((e) => e.type === 'llm_start')).toBe(false)
  })
})

describe('AgentRunner', () => {
  it('无工具调用时追加用户与 assistant，并发出 final run_end', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([[{ type: 'text', delta: 'hi' }, done('hi')]])

    const events = await collect(makeRunner(client, messages))

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(events.some((e) => e.type === 'text_delta' && e.delta === 'hi')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'final' })
  })

  it.each(['tool_calls', 'stop'])('结束原因 %s 携带完整工具调用时回填结果并继续模型调用', async (finishReason) => {
    const tool: ToolDefinition = {
      name: 'unit_tool',
      description: 'unit tool',
      readOnly: true,
      safety: { sideEffect: 'none', parallelSafe: true },
      parameters: { type: 'object', properties: {} },
      run: async () => ({ llmContent: 'tool ok', uiSummary: 'ok' }),
    }
    globalToolRegistry.registerBuiltin([...ALL_TOOLS, tool])

    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([
      [
        {
          type: 'done',
          finishReason,
          message: {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'unit_tool', argsJson: '{}' }],
          },
        },
      ],
      [done('final')],
    ])

    const events = await collect(makeRunner(client, messages))

    expect(client.calls).toHaveLength(2)
    expect(messages.some((m) => m.role === 'tool' && m.content === 'tool ok')).toBe(true)
    expect(events.some((e) => e.type === 'tool_start' && e.name === 'unit_tool')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'final' })
  })

  it('达到输出上限时保留部分正文并明确报错，不误报任务完成', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([[done('partial', 'length')]])
    const events: AgentRunEvent[] = []

    await expect(collect(makeRunner(client, messages), events)).rejects.toThrow('输出长度上限')

    expect(events.find((e) => e.type === 'llm_done')).toMatchObject({
      type: 'llm_done',
      finishReason: 'length',
    })
    expect(events.at(-1)).toMatchObject({ type: 'run_error' })
    expect(events.some((e) => e.type === 'run_end')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: 'partial' })
  })

  it('连接结束却没有 done 时报告断流，并保留已显示的正文供继续使用', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([[{ type: 'text', delta: '已经完成第一步，' }]])
    const events: AgentRunEvent[] = []

    await expect(collect(makeRunner(client, messages), events)).rejects.toThrow('未收到完成事件')

    expect(events.at(-1)).toMatchObject({ type: 'run_error' })
    expect(events.some((e) => e.type === 'run_end')).toBe(false)
    expect(messages.at(-1)?.content).toBe('已经完成第一步，')
  })

  it.each([
    { label: '空响应', response: [] },
    { label: '只有思考', response: [
      { type: 'reasoning', delta: '正在准备调用工具' }, done(''),
    ] },
    { label: '空白正文', response: [done('  \n')] },
    { label: '缺失工具调用', response: [done('', 'tool_calls')] },
  ] satisfies Array<{ label: string; response: StreamEvent[] }>)('$label 不会被视为已完成', async ({ response }) => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const events: AgentRunEvent[] = []

    await expect(collect(makeRunner(new FakeClient([response]), messages), events)).rejects.toThrow()

    expect(events.at(-1)).toMatchObject({ type: 'run_error' })
    expect(events.some((e) => e.type === 'run_end')).toBe(false)
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it.each(['length', 'content_filter', 'unexpected'])('结束原因 %s 不执行残缺工具，也不污染下一轮调用历史', async (finishReason) => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([[{
      type: 'done', finishReason,
      message: {
        role: 'assistant', content: '准备读取文件',
        toolCalls: [{ id: 'partial-call', name: 'read_file', argsJson: '{"path":' }],
        responseOutput: [{
          type: 'function_call', call_id: 'partial-call', name: 'read_file', arguments: '{"path":',
        }],
      },
    }]])
    const events: AgentRunEvent[] = []

    await expect(collect(makeRunner(client, messages), events)).rejects.toThrow()

    expect(events.some((e) => e.type === 'tool_batch_start' || e.type === 'tool_start')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: '准备读取文件' })
    expect(messages.at(-1)?.toolCalls).toBeUndefined()
    expect(messages.at(-1)?.responseOutput).toBeUndefined()
    expect(messages.some((m) => m.role === 'tool')).toBe(false)

    // 下一轮继续时仍能使用合法历史，不需要先 /clear。
    const nextClient = new FakeClient([[done('继续完成')]])
    expect((await collect(makeRunner(nextClient, messages))).at(-1)).toMatchObject({ type: 'run_end', reason: 'final' })
  })

  it('供应商在已输出部分正文后抛错时保留正文并传播原始错误', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([])
    client.streamChat = async function* () {
      yield { type: 'text', delta: '已检查配置' }
      throw new Error('network disconnected')
    }
    const events: AgentRunEvent[] = []

    await expect(collect(makeRunner(client, messages), events)).rejects.toThrow('network disconnected')

    expect(messages.at(-1)?.content).toBe('已检查配置')
    expect(events.filter((e) => e.type === 'assistant_message')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'run_error', error: 'network disconnected' })
  })

  it('用户在模型完成与工具执行之间中断时，不执行工具也不误报完成', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const ac = new AbortController()
    const client = new FakeClient([[{
      type: 'done', finishReason: 'tool_calls', message: {
        role: 'assistant', content: '开始检查',
        toolCalls: [{ id: 'call', name: 'read_file', argsJson: '{"path":"package.json"}' }],
      },
    }]])
    const events: AgentRunEvent[] = []
    for await (const event of makeRunner(client, messages, { abortSignal: ac.signal }).run()) {
      events.push(event)
      if (event.type === 'llm_done') ac.abort()
    }

    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'aborted' })
    expect(events.some((e) => e.type === 'tool_batch_start' || e.type === 'run_error')).toBe(false)
    expect(messages.at(-1)?.toolCalls).toBeUndefined()
  })

  it('用户中断导致供应商抛错时记录 aborted，不作为连接故障', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const ac = new AbortController()
    const client = new FakeClient([])
    client.streamChat = async function* () {
      yield { type: 'text', delta: '部分回答' }
      ac.abort()
      throw new Error('request aborted')
    }

    const events = await collect(makeRunner(client, messages, { abortSignal: ac.signal }))

    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'aborted' })
    expect(events.some((e) => e.type === 'run_error')).toBe(false)
    expect(messages.at(-1)?.content).toBe('部分回答')
  })

  it('达到迭代上限时发出提示并停止', async () => {
    const loopMessage = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [{ id: 'missing', name: 'missing_tool', argsJson: '{}' }],
    }
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([
      [{ type: 'done', finishReason: 'tool_calls', message: loopMessage }],
      [{ type: 'done', finishReason: 'tool_calls', message: loopMessage }],
      [{ type: 'done', finishReason: 'tool_calls', message: loopMessage }],
    ])

    const events = await collect(makeRunner(client, messages))

    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'max_iterations' })
    expect(events.some((e) => e.type === 'text_delta' && e.delta.includes('最大工具调用次数'))).toBe(true)
  })
})
