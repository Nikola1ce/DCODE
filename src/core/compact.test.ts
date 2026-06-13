// compact 单元测试。
// 验证上下文压缩时 assistant+tool 消息组不会被拆断。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import type { DeepMessage } from './types.js'
import {
  compactMessages,
  estimateMessagesTokens,
  partitionGroupsForCompact,
  shouldCompact,
  splitConversationGroups,
} from './compact.js'
import type { LLMClient, StreamChatParams, StreamEvent } from '../providers/types.js'

class SummaryClient implements LLMClient {
  hasApiKey(): boolean {
    return true
  }

  getProviderId() {
    return 'custom' as const
  }

  async *streamChat(_params: StreamChatParams): AsyncGenerator<StreamEvent> {
    yield { type: 'text', delta: '摘要' }
    yield {
      type: 'done',
      finishReason: 'stop',
      message: { role: 'assistant', content: '摘要' },
    }
  }
}

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

describe('shouldCompact（压缩阈值随上下文窗口动态变化）', () => {
  // 构造一批消息，使其估算 token 落在指定区间，便于跨阈值断言。
  // estimateTextTokens 约为 length/3，故内容长度 ≈ 目标 token × 3。
  function makeMessagesWithTokens(targetTokens: number): DeepMessage[] {
    const content = 'x'.repeat(targetTokens * 3)
    return [{ role: 'user', content }]
  }

  it('同一份历史在小窗口下触发压缩、在大窗口下不触发', () => {
    // 约 150K token 的历史：
    const messages = makeMessagesWithTokens(150_000)
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(140_000)
    // 200K 窗口阈值 = 180K，150K < 180K，不压缩。
    expect(shouldCompact(messages, 200_000)).toBe(false)
    // 128K 窗口阈值 = 115.2K，150K > 115.2K，触发压缩。
    expect(shouldCompact(messages, 128_000)).toBe(true)
  })

  it('1M 大窗口下同样的历史不会触发压缩（阈值 900K）', () => {
    const messages = makeMessagesWithTokens(150_000)
    expect(shouldCompact(messages, 1_000_000)).toBe(false)
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
  it('压缩摘要写为 system metadata，且旧摘要会被重新折叠', async () => {
    const messages: DeepMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'system',
        content: 'old summary',
        metadata: { kind: 'summary', source: 'system' },
      },
    ]
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}` })
    }

    const compacted = await compactMessages(new SummaryClient(), messages, 'test-model')
    const summaries = compacted.filter((m) => m.metadata?.kind === 'summary')

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      role: 'system',
      metadata: { kind: 'summary', source: 'system' },
    })
  })
})
