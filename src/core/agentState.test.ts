// 真实 Agent 的上下文状态回归：显示估算、压缩与会话快照保持一致。
// 制作人：Moriarty_Dox
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DCodeConfig } from '../config.js'
import { createLLMClient } from '../providers/factory.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'
import { Agent } from './agent.js'
import { estimateMessagesTokens, estimateTextTokens } from './compact.js'
import type { SessionRecorder } from './session.js'
import type { AgentRunEvent, DeepMessage } from './types.js'

vi.mock('../providers/factory.js', () => ({ createLLMClient: vi.fn() }))
vi.mock('../memory.js', () => ({ loadMemories: () => [], formatMemories: () => '' }))

const config: DCodeConfig = {
  provider: 'custom', baseURL: 'https://example.test', model: 'state-test',
  theme: 'dark', showThinking: false, reasoningEffort: 'high', alwaysAllow: [],
  totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false,
  soundEnabled: false, soundVolume: 0,
}

class StateClient implements LLMClient {
  calls: StreamChatParams[] = []
  summary = '已检查旧任务，保留当前需求并继续验证。'
  getProviderId() { return 'custom' as const }
  hasApiKey() { return true }
  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push({ ...params, messages: structuredClone(params.messages) })
    const content = params.tools.length ? '本轮完成' : this.summary
    yield { type: 'text', delta: content }
    yield { type: 'done', finishReason: 'stop', message: { role: 'assistant', content } }
  }
}

function history(): DeepMessage[] {
  return [
    { role: 'system', content: '测试系统提示' },
    ...Array.from({ length: 14 }, (_, i): DeepMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: i < 8 ? `旧任务${i}：` + '上下文内容。'.repeat(1000) : `最近消息${i}`,
    })),
  ]
}

function setup(messages: DeepMessage[], patch: Partial<DCodeConfig> = {}) {
  const client = new StateClient()
  vi.mocked(createLLMClient).mockReturnValue(client)
  let persisted = structuredClone(messages)
  const snapshots: DeepMessage[][] = []
  const recorder = {
    id: 'state-session',
    append: vi.fn((message: DeepMessage) => { persisted.push(structuredClone(message)) }),
    appendEvent: vi.fn(),
    replaceMessages: vi.fn((next: DeepMessage[]) => {
      persisted = structuredClone(next)
      snapshots.push(structuredClone(next))
    }),
  }
  const agent = new Agent({
    config: { ...config, ...patch },
    cwd: process.cwd(), initialMessages: messages,
    recorder: recorder as unknown as SessionRecorder,
  })
  return { agent, client, recorder, snapshots, persisted: () => persisted }
}

beforeEach(() => vi.stubEnv('DCODE_COMPACT_MAX_TOKENS', ''))
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe('Agent 上下文与快照', () => {
  it.each([false, true])('恢复缺少基础system的历史时补齐指令且保留摘要（摘要=%s）', (hasSummary) => {
    const messages: DeepMessage[] = [
      ...(hasSummary ? [{ role: 'system' as const, content: '已有工作摘要', metadata: { kind: 'summary' as const, source: 'system' as const } }] : []),
      { role: 'user', content: '继续任务' },
    ]
    const { agent } = setup(messages)
    expect(agent.getMessages()[0].role).toBe('system')
    expect(agent.getMessages()[0].metadata?.kind).not.toBe('summary')
    expect(agent.getMessages()[0].content).toContain(process.cwd())
    expect(agent.getMessages().slice(1)).toEqual(messages)
    agent.setModel('另一个模型')
    expect(agent.getMessages().slice(1)).toEqual(messages)
    agent.replaceMessages(messages)
    expect(agent.getMessages().slice(1)).toEqual(messages)
  })

  it('clear 清除对话和旧摘要，并持久化只含当前系统提示的快照', () => {
    const messages = history()
    messages.splice(1, 0, {
      role: 'system', content: '旧摘要', metadata: { kind: 'summary', source: 'system' },
    })
    const { agent, recorder, snapshots, persisted } = setup(messages)

    agent.clear()

    expect(agent.getMessages()).toEqual([messages[0]])
    expect(recorder.replaceMessages).toHaveBeenCalledTimes(1)
    expect(snapshots[0]).toEqual(agent.getMessages())
    expect(persisted()).toEqual(agent.getMessages())
  })

  it.each([true, false])('replaceMessages 持久化替换后的历史（自带 system=%s）', (hasSystem) => {
    const { agent, recorder, persisted } = setup(history())
    const replacement: DeepMessage[] = [
      ...(hasSystem ? [{ role: 'system' as const, content: '恢复的系统提示' }] : []),
      { role: 'user', content: '恢复的任务' },
    ]

    agent.replaceMessages(replacement)

    expect(agent.getMessages()[0].role).toBe('system')
    expect(agent.getMessages().at(-1)?.content).toBe('恢复的任务')
    expect(agent.getMessages()).not.toBe(replacement)
    expect(recorder.replaceMessages).toHaveBeenCalledTimes(1)
    expect(persisted()).toEqual(agent.getMessages())
    expect(persisted().some((m) => m.content.includes('旧任务'))).toBe(false)
  })

  it('手动压缩成功后保存快照，恢复状态与上下文估算同步下降', async () => {
    const { agent, recorder, snapshots, persisted } = setup(history())
    const before = agent.getContextTokens()

    expect(await agent.compactNow()).toContain('已压缩上下文')

    expect(recorder.replaceMessages).toHaveBeenCalledTimes(1)
    expect(snapshots[0]).toEqual(agent.getMessages())
    expect(persisted()).toEqual(agent.getMessages())
    expect(agent.getMessages().filter((m) => m.metadata?.kind === 'summary')).toHaveLength(1)
    expect(agent.getContextTokens()).toBeLessThan(before)
  })

  it('手动压缩收到空摘要时不覆盖或持久化无效快照', async () => {
    const messages = history()
    const { agent, client, recorder, persisted } = setup(messages)
    client.summary = ''

    expect(await agent.compactNow()).toContain('未应用压缩')

    expect(agent.getMessages()).toEqual(messages)
    expect(recorder.replaceMessages).not.toHaveBeenCalled()
    expect(persisted()).toEqual(messages)
  })

  it('自动压缩先保存替换快照，之后的回答继续追加，恢复结果与内存一致', async () => {
    const { agent, client, recorder, snapshots, persisted } = setup(history(), {
      modelContextOverrides: { 'custom:state-test': 8000 },
    })
    const events: AgentRunEvent[] = []

    await agent.runTurn('继续验证', {
      abortSignal: new AbortController().signal,
      requestPermission: async () => 'deny', onEvent: (event) => events.push(event),
    })

    expect(client.calls).toHaveLength(2)
    expect(events.find((e) => e.type === 'compact_end')).toMatchObject({ applied: true })
    expect(events.at(-1)).toMatchObject({ type: 'run_end', reason: 'final' })
    expect(recorder.replaceMessages).toHaveBeenCalledTimes(1)
    expect(snapshots[0].at(-1)).toMatchObject({ role: 'user', content: '继续验证' })
    expect(snapshots[0].some((m) => m.content === '本轮完成')).toBe(false)
    expect(persisted()).toEqual(agent.getMessages())
    expect(persisted().at(-1)).toMatchObject({ role: 'assistant', content: '本轮完成' })
    expect(client.calls[1].messages).toEqual(snapshots[0])
  })

  it('自动压缩失败时保留历史，只追加本轮对话，不写入替换快照', async () => {
    const messages = history()
    const original = structuredClone(messages)
    const { agent, client, recorder, persisted } = setup(messages, {
      modelContextOverrides: { 'custom:state-test': 8000 },
    })
    client.summary = ''
    const events: AgentRunEvent[] = []

    await agent.runTurn('继续验证', {
      abortSignal: new AbortController().signal,
      requestPermission: async () => 'deny', onEvent: (event) => events.push(event),
    })

    expect(events.find((e) => e.type === 'compact_end')).toMatchObject({ applied: false })
    expect(recorder.replaceMessages).not.toHaveBeenCalled()
    expect(agent.getMessages().slice(0, original.length)).toEqual(original)
    expect(persisted()).toEqual(agent.getMessages())
  })

  it('上下文估算采用实际请求的旧工具瘦身结果，并包含工具定义', async () => {
    const messages: DeepMessage[] = [
      { role: 'system', content: '测试系统提示' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', content: '历史工具结果'.repeat(40_000), toolCallId: 'old', toolName: 'read_file' },
      ...Array.from({ length: 10 }, (): DeepMessage => ({ role: 'user', content: '最近短消息' })),
    ]
    const rawTokens = estimateMessagesTokens(messages)
    const originalToolResult = messages[2].content
    const { agent, client } = setup(messages)
    let shownTokens = 0
    await agent.runTurn('继续', {
      abortSignal: new AbortController().signal,
      requestPermission: async () => 'deny',
      onEvent: (event) => { if (event.type === 'llm_start') shownTokens = agent.getContextTokens() },
    })

    expect(client.calls).toHaveLength(1)
    const request = client.calls[0]
    const bodyTokens = estimateMessagesTokens(request.messages)
    expect(request.messages[2].content).toContain('[历史瘦身')
    expect(shownTokens).toBe(bodyTokens + estimateTextTokens(JSON.stringify(request.tools)))
    expect(shownTokens).toBeGreaterThan(bodyTokens)
    expect(shownTokens).toBeLessThan(rawTokens)
    expect(agent.getMessages()[2].content).toBe(originalToolResult)
  })
})
