// AgentRunner 单元测试。
// 覆盖无工具、工具回填、finishReason 与迭代上限路径。

import { afterEach, describe, expect, it } from 'vitest'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { DCodeConfig } from '../config.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'
import { ALL_TOOLS } from '../tools/index.js'
import { globalToolRegistry } from '../tools/registry.js'
import { AgentRunner } from './agentRunner.js'
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

function makeRunner(client: FakeClient, messages: DeepMessage[]): AgentRunner {
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
  })
}

async function collect(runner: AgentRunner): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = []
  for await (const ev of runner.run()) events.push(ev)
  return events
}

afterEach(() => {
  globalToolRegistry.registerBuiltin(ALL_TOOLS)
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

  it('工具调用结果按 tool 消息回填后继续下一次模型调用', async () => {
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
          finishReason: 'tool_calls',
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

  it('保留 finishReason=length 事件供上层观测', async () => {
    const messages: DeepMessage[] = [{ role: 'system', content: 'sys' }]
    const client = new FakeClient([[done('partial', 'length')]])

    const events = await collect(makeRunner(client, messages))

    expect(events.find((e) => e.type === 'llm_done')).toMatchObject({
      type: 'llm_done',
      finishReason: 'length',
    })
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
