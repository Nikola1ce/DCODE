// compact 单元测试。
// 验证上下文压缩时 assistant+tool 消息组不会被拆断。
// 制作人：Moriarty_Dox

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeepMessage } from './types.js'
import {
  canCompactMessages,
  compactMessages,
  estimateMessagesTokens,
  partitionGroupsForCompact,
  shouldCompact,
  splitConversationGroups,
} from './compact.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'

class SummaryClient implements LLMClient {
  calls: StreamChatParams[] = []
  hasApiKey(): boolean {
    return true
  }

  getProviderId() {
    return 'custom' as const
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent> {
    this.calls.push(params)
    yield { type: 'text', delta: '摘要' }
    yield {
      type: 'done',
      finishReason: 'stop',
      message: { role: 'assistant', content: '摘要' },
    }
  }
}

afterEach(() => vi.unstubAllEnvs())

describe('splitConversationGroups', () => {
  it('assistant+tool_calls 与后续 tool 消息同组', () => {
    const convo: DeepMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }],
      },
      { role: 'tool', content: 'file body', toolCallId: 'c1', toolName: 'read_file' },
      { role: 'assistant', content: 'done' },
    ]
    const groups = splitConversationGroups(convo)
    expect(groups).toHaveLength(3)
    expect(groups[1]).toHaveLength(2)
    expect(groups[1][0].role).toBe('assistant')
    expect(groups[1][1].role).toBe('tool')
  })
})

describe('partitionGroupsForCompact', () => {
  it('保留段不从孤立 tool 消息开始', () => {
    const convo: DeepMessage[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'mid' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'grep', argsJson: '{}' }],
      },
      { role: 'tool', content: 'grep out', toolCallId: 'c1', toolName: 'grep' },
      { role: 'user', content: 'recent' },
    ]
    const groups = splitConversationGroups(convo)
    const [, kept] = partitionGroupsForCompact(groups, 3)
    const recent = kept.flat()
    expect(recent[0].role).not.toBe('tool')
    if (recent.some((m) => m.role === 'tool' && m.toolCallId === 'c1')) {
      expect(
        recent.some((m) => m.role === 'assistant' && m.toolCalls?.some((t) => t.id === 'c1')),
      ).toBe(true)
    }
  })
})

describe('canCompactMessages', () => {
  it('短历史、只有一个完整大工具组的历史均不发起压缩', async () => {
    const short: DeepMessage[] = Array.from({ length: 8 }, () => ({ role: 'user', content: '短历史' }))
    expect(canCompactMessages(short)).toBe(false)
    const toolGroup: DeepMessage[] = [
      { role: 'assistant', content: '', toolCalls: Array.from({ length: 8 }, (_, i) => ({
        id: `call${i}`, name: 'read_file', argsJson: '{}',
      })) },
      ...Array.from({ length: 8 }, (_, i): DeepMessage => ({ role: 'tool', content: '结果', toolCallId: `call${i}` })),
    ]
    expect(canCompactMessages(toolGroup)).toBe(false)
    const client = new SummaryClient()
    expect(await compactMessages(client, toolGroup, 'test-model')).toBe(toolGroup)
    expect(client.calls).toHaveLength(0)
    expect(canCompactMessages([{ role: 'user', content: '可摘要的旧需求' }, ...toolGroup])).toBe(true)
  })
})

describe('shouldCompact（压缩阈值随上下文窗口动态变化）', () => {
  // 构造一批消息，使其估算 token 落在指定区间，便于跨阈值断言。
  // estimateTextTokens 约为 length/3，故内容长度 ≈ 目标 token × 3。
  function makeMessagesWithTokens(targetTokens: number): DeepMessage[] {
    const content = 'x'.repeat(targetTokens * 3)
    return [{ role: 'user', content }]
  }

  it('窗口越大，自动压缩阈值越高', () => {
    vi.stubEnv('DCODE_COMPACT_MAX_TOKENS', '')
    // 约 100K token 的历史：
    const messages = makeMessagesWithTokens(100_000)
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(95_000)
    // 100K 窗口阈值 = 90K，100K > 90K → 压缩。
    expect(shouldCompact(messages, 100_000)).toBe(true)
    // 128K 窗口阈值 = 115.2K，100K < 115.2K → 不压缩。
    expect(shouldCompact(messages, 128_000)).toBe(false)
  })

  it('大窗口默认按 90% 触发，不被 120K 旧上限提前压缩', () => {
    vi.stubEnv('DCODE_COMPACT_MAX_TOKENS', '')
    const messages = makeMessagesWithTokens(150_000)
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(140_000)
    expect(shouldCompact(messages, 1_000_000)).toBe(false)
    expect(shouldCompact(messages, 200_000)).toBe(false)
    expect(shouldCompact(makeMessagesWithTokens(901_000), 1_000_000)).toBe(true)
  })

  it('显式环境变量上限仍可提前触发压缩', () => {
    vi.stubEnv('DCODE_COMPACT_MAX_TOKENS', '120000')
    expect(shouldCompact(makeMessagesWithTokens(150_000), 1_000_000)).toBe(true)
  })

  it('恰好跨越窗口×90% 阈值的边界判断正确', () => {
    // 128K 窗口阈值 = 115200 token。构造略高于该阈值的历史。
    const justOver = makeMessagesWithTokens(116_000)
    expect(estimateMessagesTokens(justOver)).toBeGreaterThan(115_200)
    expect(shouldCompact(justOver, 128_000)).toBe(true)

    const justUnder = makeMessagesWithTokens(100_000)
    expect(estimateMessagesTokens(justUnder)).toBeLessThan(115_200)
    expect(shouldCompact(justUnder, 128_000)).toBe(false)
  })

  it('未提供窗口时回退到固定兜底阈值（约 60K）', () => {
    const over = makeMessagesWithTokens(70_000)
    expect(shouldCompact(over)).toBe(true)
    const under = makeMessagesWithTokens(50_000)
    expect(shouldCompact(under)).toBe(false)
  })

  it('窗口为 0 或负数时也回退到固定兜底阈值', () => {
    const over = makeMessagesWithTokens(70_000)
    expect(shouldCompact(over, 0)).toBe(true)
    expect(shouldCompact(over, -1)).toBe(true)
  })
})

describe('compactMessages', () => {
  function history(): DeepMessage[] {
    return [
      { role: 'system', content: '系统提示必须完整保留' },
      ...Array.from({ length: 12 }, (_, i): DeepMessage => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `第${i}条历史：` + '重要上下文。'.repeat(50),
      })),
    ]
  }

  function scriptedClient(events: StreamEvent[]): LLMClient {
    const client = new SummaryClient()
    client.streamChat = async function* () { yield* events }
    return client
  }

  const completed = (content: string, finishReason = 'stop'): StreamEvent => ({
    type: 'done', finishReason, message: { role: 'assistant', content },
  })

  it.each([
    { label: '空流', events: [] },
    { label: '缺少完成事件', events: [{ type: 'text', delta: '只生成了一部分摘要' }] },
    { label: '空摘要', events: [completed('')] },
    { label: '空白摘要', events: [completed(' \n ')] },
    { label: '完整事件为空不能用增量兜底', events: [{ type: 'text', delta: '部分摘要' }, completed('')] },
    { label: '输出达到上限', events: [completed('截断摘要', 'length')] },
    { label: '内容过滤中断', events: [completed('部分摘要', 'content_filter')] },
    { label: '工具终态', events: [completed('摘要', 'tool_calls')] },
    { label: '重复完成事件', events: [completed('摘要一'), completed('摘要二')] },
    { label: '摘要包含工具调用', events: [{
      type: 'done', finishReason: 'stop', message: {
        role: 'assistant', content: '错误的工具摘要',
        toolCalls: [{ id: 'call', name: 'read_file', argsJson: '{}' }],
      },
    }] },
  ] satisfies Array<{ label: string; events: StreamEvent[] }>)('$label 不覆盖历史', async ({ events }) => {
    const messages = history()
    const snapshot = structuredClone(messages)

    expect(await compactMessages(scriptedClient(events), messages, 'test-model')).toBe(messages)
    expect(messages).toEqual(snapshot)
  })

  it('已取消时不发起摘要请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const messages = history()
    const client = new SummaryClient()

    expect(await compactMessages(client, messages, 'test-model', controller.signal)).toBe(messages)
    expect(client.calls).toHaveLength(0)
  })

  it('摘要已生成但连接结束前取消，仍保留原历史', async () => {
    const controller = new AbortController()
    const messages = history()
    const client = new SummaryClient()
    client.streamChat = async function* () {
      yield completed('完整摘要')
      controller.abort()
    }

    expect(await compactMessages(client, messages, 'test-model', controller.signal)).toBe(messages)
  })

  it('流式请求失败不会把已有部分摘要应用到历史', async () => {
    const messages = history()
    const client = new SummaryClient()
    client.streamChat = async function* () {
      yield { type: 'text', delta: '部分摘要' }
      throw new Error('连接失败')
    }

    expect(await compactMessages(client, messages, 'test-model')).toBe(messages)
  })

  it('摘要没有释放 token 空间时保持原历史', async () => {
    const messages = history()
    const client = scriptedClient([completed('冗长摘要'.repeat(2000))])

    expect(await compactMessages(client, messages, 'test-model')).toBe(messages)
  })

  it('摘要请求继承取消信号，中断时保留原历史', async () => {
    const controller = new AbortController()
    const messages: DeepMessage[] = Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`,
    }))
    const client = new SummaryClient()
    client.streamChat = async function* (params) {
      expect(params.abortSignal).toBe(controller.signal)
      controller.abort()
      throw new Error('已取消请求')
    }
    expect(await compactMessages(client, messages, 'test-model', controller.signal)).toBe(messages)
  })
  it('压缩摘要写为 system metadata，且旧摘要会被重新折叠', async () => {
    const messages: DeepMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'system',
        content: 'old summary '.repeat(100),
        metadata: { kind: 'summary', source: 'system' },
      },
    ]
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` })
    }

    const compacted = await compactMessages(new SummaryClient(), messages, 'test-model')
    const summaries = compacted.filter((m) => m.metadata?.kind === 'summary')

    expect(summaries).toHaveLength(1)
    expect(compacted).not.toBe(messages)
    expect(summaries[0].content).not.toContain('old summary')
    expect(summaries[0]).toMatchObject({
      role: 'system',
      metadata: { kind: 'summary', source: 'system' },
    })
  })

  it('成功压缩保留最近完整工具组及原对象，不修改原始历史', async () => {
    const messages = history().slice(0, 7)
    const toolGroup: DeepMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', content: '最新工具原文'.repeat(1000), toolCallId: 'call', toolName: 'read_file' },
    ]
    messages.push(...toolGroup, ...history().slice(-5))
    const snapshot = structuredClone(messages)
    const compacted = await compactMessages(new SummaryClient(), messages, 'test-model')

    expect(compacted).not.toBe(messages)
    expect(compacted[0]).toBe(messages[0])
    expect(compacted.slice(-7)).toEqual(messages.slice(-7))
    expect(compacted[2]).toBe(toolGroup[0])
    expect(compacted[3]).toBe(toolGroup[1])
    expect(estimateMessagesTokens(compacted)).toBeLessThan(estimateMessagesTokens(messages))
    expect(messages).toEqual(snapshot)
  })

  it('摘要输入先瘦身旧工具结果，同时完整保留最近工具原文', async () => {
    const oldResult = '旧结果'.repeat(10_000)
    const recentResult = '最近结果'.repeat(2000)
    const messages: DeepMessage[] = [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '旧任务' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', content: oldResult, toolCallId: 'old', toolName: 'read_file' },
      ...history().slice(1),
      { role: 'assistant', content: '', toolCalls: [{ id: 'recent', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', content: recentResult, toolCallId: 'recent', toolName: 'read_file' },
    ]
    const client = new SummaryClient()

    const compacted = await compactMessages(client, messages, 'test-model')

    const transcript = client.calls[0].messages[1].content
    expect(transcript).toContain('[历史瘦身')
    expect(transcript).not.toContain(oldResult)
    expect(compacted.at(-1)).toBe(messages.at(-1))
    expect(compacted.at(-1)?.content).toBe(recentResult)
    expect(messages[3].content).toBe(oldResult)
  })

  it('摘要比原始工具结果短、却比实际发送视图长时也不应用', async () => {
    const messages: DeepMessage[] = [
      { role: 'system', content: '系统提示' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', argsJson: '{}' }] },
      { role: 'tool', content: '旧工具结果'.repeat(10_000), toolCallId: 'old', toolName: 'read_file' },
      ...history().slice(1),
    ]
    const summary = '摘要'.repeat(5000)
    expect(summary.length).toBeLessThan(messages[2].content.length)

    expect(await compactMessages(scriptedClient([completed(summary)]), messages, 'test-model')).toBe(messages)
  })
})
