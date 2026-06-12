// compact 单元测试。
// 验证上下文压缩时 assistant+tool 消息组不会被拆断。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import type { DeepMessage } from './types.js'
import { compactMessages, partitionGroupsForCompact, splitConversationGroups } from './compact.js'
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
