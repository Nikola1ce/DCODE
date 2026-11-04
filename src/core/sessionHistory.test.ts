// 会话历史纯函数回归测试：稳定身份、工具链边界与事件裁剪。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import type { AgentRunEvent, DeepMessage } from './types.js'
import {
  assertSafeSessionHistory,
  forkSessionHistory,
  getSessionHistoryBoundary,
  legacySessionMessageId,
  retainSessionEvents,
  rewindSessionHistory,
  sameSessionMessage,
  sessionToolCalls,
  truncateSessionHistory,
  withSessionMessageIds,
} from './sessionHistory.js'

function history(): DeepMessage[] {
  const first = { runId: 'run-1', turnId: 'turn-1' }
  const second = { runId: 'run-2', turnId: 'turn-2' }
  return [
    { id: 'system', role: 'system', content: 'system' },
    { ...first, id: 'user-1', role: 'user', content: '第一轮' },
    {
      ...first, id: 'assistant-1', role: 'assistant', content: '', reasoning: '规划',
      toolCalls: [
        { id: 'call-1', name: 'read_file', argsJson: '{"path":"one"}' },
        { id: 'call-2', name: 'read_file', argsJson: '{"path":"two"}' },
      ],
      responseOutput: [
        { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'encrypted-reasoning' },
        { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'read_file', arguments: '{"path":"one"}', status: 'completed' },
      ],
    },
    { ...first, id: 'tool-2', role: 'tool', content: 'two', toolCallId: 'call-2' },
    { ...first, id: 'tool-1', role: 'tool', content: 'one', toolCallId: 'call-1' },
    {
      ...first, id: 'assistant-2', role: 'assistant', content: '',
      responseOutput: [
        { type: 'reasoning', id: 'reason-2', summary: [], encrypted_content: 'second-encrypted-reasoning' },
        { type: 'function_call', id: 'fc-3', call_id: 'call-3', name: 'list_dir', arguments: '{}', status: 'completed' },
      ],
    },
    { ...first, id: 'tool-3', role: 'tool', content: 'dir', toolCallId: 'call-3' },
    {
      ...first, id: 'assistant-3', role: 'assistant', content: '完成',
      responseOutput: [{ type: 'message', id: 'output-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成', annotations: [] }] }],
    },
    { ...second, id: 'user-2', role: 'user', content: '第二轮' },
    { ...second, id: 'assistant-4', role: 'assistant', content: '第二轮完成' },
  ]
}

function eventsFor(messages: DeepMessage[]): AgentRunEvent[] {
  const events: AgentRunEvent[] = []
  for (const [index, message] of messages.entries()) {
    if (!message.runId || !message.turnId) continue
    const base = { runId: message.runId, turnId: message.turnId, timestamp: index }
    if (message.role === 'user') {
      events.push({ ...base, type: 'run_start' })
      events.push({ ...base, type: 'turn_start', messageId: message.id, userInput: message.content })
    } else if (message.role === 'assistant') {
      events.push({
        ...base, type: 'llm_done', iteration: index, message: structuredClone(message),
        finishReason: sessionToolCalls(message).length ? 'tool_calls' : 'stop', durationMs: 30,
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, costUsd: 0.001,
      })
      events.push({ ...base, type: 'assistant_message', iteration: index, message: structuredClone(message) })
      if (sessionToolCalls(message).length === 0) {
        events.push({ ...base, type: 'run_end', iterations: index, reason: 'final' })
      }
    } else if (message.role === 'tool') {
      events.push({ ...base, type: 'tool_message', iteration: index, message: structuredClone(message) })
    }
  }
  return events
}

describe('session message identities', () => {
  it('为旧消息生成可重复且按会话与序号区分的 ID，不修改输入', () => {
    const messages: DeepMessage[] = [
      { role: 'user', content: '相同正文' },
      { role: 'user', content: '相同正文' },
      { role: 'assistant', content: '已有身份', id: 'existing', runId: 'run', turnId: 'turn' },
    ]
    const identified = withSessionMessageIds('legacy', messages)
    expect(withSessionMessageIds('legacy', messages)).toEqual(identified)
    expect(identified.map((message) => message.id)).toEqual([
      legacySessionMessageId('legacy', 0), legacySessionMessageId('legacy', 1), 'existing',
    ])
    expect(new Set(identified.map((message) => message.id)).size).toBe(3)
    expect(withSessionMessageIds('other', messages)[0].id).not.toBe(identified[0].id)
    expect(withSessionMessageIds('legacy', messages.slice(1), 1)).toEqual(identified.slice(1))
    expect(messages[0].id).toBeUndefined()
    expect(identified[2]).toEqual(messages[2])
  })

  it('深复制 Responses 完整输出，包含加密推理、函数调用和消息项', () => {
    const original = history()
    const copy = withSessionMessageIds('session', original)
    expect(copy).toEqual(original)
    expect(copy[2].responseOutput).not.toBe(original[2].responseOutput)
    expect(copy[2].responseOutput![0]).not.toBe(original[2].responseOutput![0])
    const reasoning = copy[2].responseOutput![0]
    if (reasoning.type === 'reasoning') reasoning.encrypted_content = 'changed'
    expect(original[2].responseOutput![0]).toMatchObject({ encrypted_content: 'encrypted-reasoning' })
  })

  it('旧消息按正文匹配，已知 ID 不因相同正文混淆', () => {
    const legacy: DeepMessage = { role: 'assistant', content: '正文', timestamp: 1 }
    expect(sameSessionMessage(legacy, { ...legacy, id: 'new', runId: 'run', turnId: 'turn', reasoning: undefined })).toBe(true)
    expect(sameSessionMessage({ ...legacy, id: 'one' }, { ...legacy, id: 'two' })).toBe(false)
    expect(sameSessionMessage(legacy, { ...legacy, content: '不同正文' })).toBe(false)
  })
})

describe('session history boundaries', () => {
  it('合并 Chat Completions 与 Responses 调用，并按 call_id 去重', () => {
    expect(sessionToolCalls(history()[2]).map((call) => call.id)).toEqual(['call-1', 'call-2'])
    expect(sessionToolCalls(history()[5])).toEqual([{ id: 'call-3', name: 'list_dir', argsJson: '{}' }])
    expect(sessionToolCalls(history()[1])).toEqual([])
  })

  it('rewind 从目标 user 前截断，fork 则保留目标 user', () => {
    const messages = history()
    expect(rewindSessionHistory(messages, 'user-1')).toEqual(messages.slice(0, 1))
    expect(rewindSessionHistory(messages, 'user-2')).toEqual(messages.slice(0, 8))
    expect(forkSessionHistory(messages, 'user-2')).toEqual(messages.slice(0, 9))
  })

  it.each(['assistant-1', 'assistant-2', 'assistant-3'])('选择 %s 保留完整连续工具链及最终 assistant', (id) => {
    const messages = history()
    expect(getSessionHistoryBoundary(messages, id, 'rewind')).toBe(8)
    expect(rewindSessionHistory(messages, id)).toEqual(messages.slice(0, 8))
    expect(forkSessionHistory(messages, id)).toEqual(messages.slice(0, 8))
  })

  it.each(['system', 'tool-1', 'tool-2', 'tool-3', 'missing', ''])('拒绝非 user/assistant 或不存在的锚点 %s', (id) => {
    expect(() => rewindSessionHistory(history(), id)).toThrow()
    expect(() => forkSessionHistory(history(), id)).toThrow()
  })

  it('拒绝重复锚点 ID', () => {
    const messages = history()
    messages[9].id = 'user-2'
    expect(() => rewindSessionHistory(messages, 'user-2')).toThrow(/ID 不唯一/)
  })

  it.each([0, 1, 2, 5, 7, 8, 9, 10])('truncate 精确保留 %i 条安全前缀且返回深副本', (count) => {
    const messages = history()
    const retained = truncateSessionHistory(messages, count)
    expect(retained).toEqual(messages.slice(0, count))
    expect(retained).not.toBe(messages)
    if (count > 0) expect(retained[0]).not.toBe(messages[0])
    expect(messages).toEqual(history())
  })

  it.each([3, 4, 6])('truncate 拒绝停在未完成的工具批次 %i', (count) => {
    expect(() => truncateSessionHistory(history(), count)).toThrow(/工具调用尚未全部收到结果/)
  })

  it.each([-1, 1.5, NaN, Infinity, 11])('拒绝非法消息数量 %s', (count) => {
    expect(() => truncateSessionHistory(history(), count)).toThrow(/无效的会话消息数量/)
  })

  it('工具结果齐全但没有最终 assistant 时仍拒绝消息级 rewind/fork', () => {
    const messages = history().slice(0, 5)
    expect(() => rewindSessionHistory(messages, 'assistant-1')).toThrow(/不完整的工具链/)
    expect(() => forkSessionHistory(messages, 'assistant-1')).toThrow(/不完整的工具链/)
    expect(truncateSessionHistory(messages, 5)).toEqual(messages)
  })

  it('有最终 assistant 但缺少某个工具结果时拒绝，不通过修补伪造安全边界', () => {
    const messages = history().filter((message) => message.id !== 'tool-2')
    expect(() => rewindSessionHistory(messages, 'assistant-1')).toThrow(/工具调用尚未全部收到结果/)
    expect(() => forkSessionHistory(messages)).toThrow(/工具调用尚未全部收到结果/)
    expect(rewindSessionHistory(messages, 'user-1')).toEqual(messages.slice(0, 1))
  })

  it('拒绝孤立、重复的结果及重复的工具调用 ID', () => {
    const messages = history()
    expect(() => assertSafeSessionHistory([messages[4]])).toThrow(/孤立或重复/)
    expect(() => assertSafeSessionHistory([...messages.slice(0, 5), messages[4]])).toThrow()
    const duplicateCall = structuredClone(messages[2])
    duplicateCall.toolCalls!.push(structuredClone(duplicateCall.toolCalls![0]))
    expect(() => assertSafeSessionHistory([duplicateCall])).toThrow(/工具调用 ID 重复/)
    const duplicateResponse = structuredClone(messages[5])
    duplicateResponse.responseOutput!.push(structuredClone(duplicateResponse.responseOutput![1]))
    expect(() => assertSafeSessionHistory([duplicateResponse])).toThrow(/工具调用 ID 重复/)
  })

  it('fork 全量保留消息 ID 与 Responses 输出，但不共享可变数据', () => {
    const messages = history()
    const retained = forkSessionHistory(messages)
    expect(retained).toEqual(messages)
    retained[2].toolCalls![0].argsJson = 'changed'
    expect(messages[2].toolCalls![0].argsJson).toBe('{"path":"one"}')
    expect(retained[2].responseOutput).toEqual(messages[2].responseOutput)
    expect(retained[2].responseOutput).not.toBe(messages[2].responseOutput)
  })
})

describe('retainSessionEvents', () => {
  it('保留完整留存 turn 的全部事件及原始用量，删除后续 turn', () => {
    const messages = history()
    const events = eventsFor(messages)
    const retained = retainSessionEvents(events, messages, rewindSessionHistory(messages, 'user-2'))
    expect(retained).toEqual(events.filter((event) => event.turnId === 'turn-1'))
    expect(retained.filter((event) => event.type === 'llm_done')).toHaveLength(3)
    expect(retained.at(-1)?.type).toBe('run_end')
    expect(retained[0]).not.toBe(events[0])
  })

  it('fork 到 user 时只保留该轮开始事件，不带入被删除回答的用量和 run_end', () => {
    const messages = history()
    const events = eventsFor(messages)
    const retained = retainSessionEvents(events, messages, forkSessionHistory(messages, 'user-2'))
    expect(retained).toEqual(events.filter((event) => event.turnId === 'turn-1'
      || event.type === 'run_start' || event.type === 'turn_start'))
    expect(retained.at(-1)).toMatchObject({ type: 'turn_start', messageId: 'user-2' })
  })

  it('截断 turn 中的后续迭代，同时保留已完成工具批次的 llm_done 用量', () => {
    const messages = history()
    const events = eventsFor(messages)
    const retained = retainSessionEvents(events, messages, truncateSessionHistory(messages, 5))
    const lastEventIndex = events.findIndex((event) => event.type === 'tool_message' && event.message.id === 'tool-1')
    expect(retained).toEqual(events.slice(0, lastEventIndex + 1))
    expect(retained.filter((event) => event.type === 'llm_done')).toHaveLength(1)
    expect(retained.some((event) => event.type === 'run_end')).toBe(false)
  })

  it('相同 turnId 不串联其他 run 的事件', () => {
    const messages = history()
    for (const message of messages) if (message.turnId === 'turn-2') message.turnId = 'turn-1'
    const events = eventsFor(messages)
    expect(retainSessionEvents(events, messages, messages.slice(0, 8)))
      .toEqual(events.filter((event) => event.runId === 'run-1'))
  })

  it('裁剪旧事件时可按不带 ID 的消息正文匹配', () => {
    const messages = history()
    const events = eventsFor(messages)
    for (const event of events) {
      if ('message' in event) {
        delete event.message.id
        delete event.message.runId
        delete event.message.turnId
      }
      if (event.type === 'turn_start') delete event.messageId
    }
    const retained = retainSessionEvents(events, messages, messages.slice(0, 2))
    expect(retained).toEqual(events.slice(0, 2))
    const partial = retainSessionEvents(events, messages, messages.slice(0, 5))
    expect(partial.at(-1)).toMatchObject({ type: 'tool_message', message: { toolCallId: 'call-1' } })
  })

  it('保留压缩摘要代表的旧 turn 用量，但仍删除显式截断 turn 的事件', () => {
    const original = history()
    const events = eventsFor(original)
    const messages: DeepMessage[] = [
      { id: 'summary', role: 'system', content: '第一轮摘要', metadata: { kind: 'summary' } },
      ...original.slice(8),
    ]
    const retained = retainSessionEvents(events, messages, messages.slice(0, 1))
    expect(retained).toEqual(events.filter((event) => event.turnId === 'turn-1'))
  })

  it('空历史不留事件，未裁剪时返回事件深副本', () => {
    const messages = history()
    const events = eventsFor(messages)
    expect(retainSessionEvents(events, messages, [])).toEqual([])
    const retained = retainSessionEvents(events, messages, messages)
    expect(retained).toEqual(events)
    expect(retained).not.toBe(events)
    const done = retained.find((event) => event.type === 'llm_done')!
    expect(done).not.toBe(events.find((event) => event.type === 'llm_done'))
    done.usage!.total_tokens = 0
    expect(events.find((event) => event.type === 'llm_done')?.usage?.total_tokens).toBe(120)
  })
})
