// 流式输出幂等去重与 StreamCommitter 集成测试。
// 覆盖 Bug 1 的关键场景：
// 1. 连续 delta 正常拼接。
// 2. 重复收到同一个 delta 不会重复渲染。
// 3. 收到 full snapshot 时不会被当成 delta 追加。
// 4. thinking 内容不会重复进入 answer 内容。
// 5. 工具调用后的继续输出不会重复之前内容。
//
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { StreamCommitter } from './streamCommit.js'
import { applyStreamContentDelta } from '../providers/streamDelta.js'
import { makeEventKey, isEventDuplicate } from './eventKey.js'

// ============================================================================
// 辅助：模拟一个简化的流式处理器，追踪"已提交到 Static"的块内容。
// ============================================================================

interface CommittedChunk {
  variant: 'text' | 'reasoning'
  text: string
  head: boolean
}

// 事件类型（与 simulateStreamProcessor 的参数匹配）
type StreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'done' }

/**
 * 模拟 App 对 StreamCommitter 的驱动方式（与新 Claude Code 风格一致）：
 * - reasoning：只更新动态预览，不落 Static（无 committed chunk）；
 * - text 首次到达 / done：先 takeThinkingSummary 取折叠摘要（hadReasoning 时计为一次思考摘要）；
 * 返回已落 Static 的正文/分块，以及思考摘要次数与最后的思考字符数，供断言。
 */
function simulateStreamProcessor(
  showThinking: boolean,
  events: StreamEvent[],
): CommittedChunk[] {
  return runStream(showThinking, events).committed
}

interface StreamRunResult {
  committed: CommittedChunk[]
  thinkingSummaries: number
  lastThinkingChars: number
  // 思考过程中动态预览出现过的最大长度（用于验证预览确实更新过）。
  maxReasoningPreview: number
}

function runStream(showThinking: boolean, events: StreamEvent[]): StreamRunResult {
  const committer = new StreamCommitter(showThinking)
  const committed: CommittedChunk[] = []
  let thinkingSummaries = 0
  let lastThinkingChars = 0
  let maxReasoningPreview = 0
  let textStarted = false

  const takeSummary = () => {
    const s = committer.takeThinkingSummary()
    if (s.hadReasoning) {
      thinkingSummaries += 1
      lastThinkingChars = s.chars
    }
  }

  for (const ev of events) {
    if (ev.type === 'done') {
      takeSummary()
      for (const c of committer.onDone()) {
        if (!c.spacer) committed.push({ variant: c.variant, text: c.text, head: c.head })
      }
    } else if (ev.type === 'reasoning') {
      committer.onReasoning(ev.delta)
      maxReasoningPreview = Math.max(maxReasoningPreview, committer.liveReasoning.length)
    } else if (ev.type === 'text') {
      if (!textStarted) {
        textStarted = true
        takeSummary()
      }
      for (const c of committer.onText(ev.delta)) {
        if (!c.spacer) committed.push({ variant: c.variant, text: c.text, head: c.head })
      }
    }
  }

  return { committed, thinkingSummaries, lastThinkingChars, maxReasoningPreview }
}

// ============================================================================
// 场景 1：连续 delta 正常拼接。
// ============================================================================

describe('Bug 1 修复验证：连续 delta 正常拼接', () => {
  it('多段零碎 delta 拼接为完整句子', () => {
    const events: StreamEvent[] = [
      { type: 'text', delta: '今天' },
      { type: 'text', delta: '天' },
      { type: 'text', delta: '气' },
      { type: 'text', delta: '很好。' },
      { type: 'done' },
    ]

    const committed = simulateStreamProcessor(false, events)
    const fullText = committed.map((c) => c.text).join('')
    expect(fullText).toBe('今天天气很好。')
  })

  it('多行输出每行独立提交', () => {
    const events: StreamEvent[] = [
      { type: 'text', delta: '第一行\n' },
      { type: 'text', delta: '第二行\n' },
      { type: 'text', delta: '第三行' },
      { type: 'done' },
    ]

    const committed = simulateStreamProcessor(false, events)
    expect(committed).toHaveLength(3)
    expect(committed[0].text).toBe('第一行')
    expect(committed[1].text).toBe('第二行')
    expect(committed[2].text).toBe('第三行')
  })
})

// ============================================================================
// 场景 2：重复 delta 不会重复渲染（applyStreamContentDelta 去重层）。
// ============================================================================

describe('Bug 1 修复验证：重复 delta 不会重复渲染', () => {
  it('applyStreamContentDelta 层会丢弃完全相同的重复 chunk', () => {
    // 注意：delta 去重发生在 deepseek/client.ts 的 applyStreamContentDelta 层，
    // 而非 StreamCommitter 层。本测试验证 applyStreamContentDelta 的去重行为。
    let acc = ''
    const r1 = applyStreamContentDelta(acc, '你好')
    acc = r1.next
    expect(r1.delta).toBe('你好')

    // 重复发送相同的 chunk
    const r2 = applyStreamContentDelta(acc, '你好')
    // 去重后 delta 为空
    expect(r2.delta).toBe('')
    expect(r2.next).toBe(acc)
  })

  it('相同的重复段落不会输出两遍（applyStreamContentDelta 层）', () => {
    // 模拟 Provider 重新发送完整段落的场景
    let acc = ''
    const r1 = applyStreamContentDelta(acc, '第一段内容。\n')
    acc = r1.next
    expect(r1.delta).toBe('第一段内容。\n')

    // Provider 重新发送第一段 + 新增内容
    const r2 = applyStreamContentDelta(acc, '第一段内容。\n第二段内容。\n')
    expect(r2.delta).toBe('第二段内容。\n')
  })

  it('列表编号前缀重放不重复编号', () => {
    let acc = ''
    const r1 = applyStreamContentDelta(acc, '1. 第一项\n2. ')
    acc = r1.next
    expect(r1.delta).toBe('1. 第一项\n2. ')

    // Provider 从"2. "重放并扩展
    const r2 = applyStreamContentDelta(acc, '2. 第二项')
    expect(r2.delta).toBe('第二项')
  })

  it('reasoning delta 被重复发送不产生重复内容（applyStreamContentDelta 层）', () => {
    // 同理，reasoning 的重复 delta 也应由 applyStreamContentDelta 层处理
    let reasoningAcc = ''
    const r1 = applyStreamContentDelta(reasoningAcc, '推理过程')
    reasoningAcc = r1.next
    expect(r1.delta).toBe('推理过程')

    const r2 = applyStreamContentDelta(reasoningAcc, '推理过程')
    // 去重后 delta 为空
    expect(r2.delta).toBe('')
    expect(r2.next).toBe(reasoningAcc)

    const r3 = applyStreamContentDelta(reasoningAcc, '继续推理')
    expect(r3.delta).toBe('继续推理')
  })
})

// ============================================================================
// 场景 3：full snapshot 不会被当成 delta 追加（applyStreamContentDelta 累积模式）。
// ============================================================================

describe('Bug 1 修复验证：full snapshot 不会被当成 delta 追加', () => {
  it('收到累积全文而非增量时，只追加真正的新增部分', () => {
    let acc = ''
    // 模拟 Provider 发送累积全文（DeepSeek 等有时会这样）
    const r1 = applyStreamContentDelta(acc, '第一句。')
    acc = r1.next
    expect(r1.delta).toBe('第一句。')

    // 下一块是"至今全文"而非增量
    const r2 = applyStreamContentDelta(acc, '第一句。第二句。')
    expect(r2.delta).toBe('第二句。')
    expect(r2.next).toBe('第一句。第二句。')
  })

  it('Provider 发完整 message.content 而非 delta 时正确处理', () => {
    // 模拟一些中间 delta
    let acc = ''
    const chunks = ['这', '是', '一', '段', '文', '本']
    for (const ch of chunks) {
      const r = applyStreamContentDelta(acc, ch)
      acc = r.next
      expect(r.delta).toBe(ch)
    }

    // Provider 突然发完整已累积内容（某些 provider 在流结束时这样做）
    const fullSnapshot = '这是一段文本'
    const r = applyStreamContentDelta(acc, fullSnapshot)
    // 因为 acc 已经是完整内容，r.delta 应为空（不追加）
    expect(r.delta).toBe('')
    expect(r.next).toBe(acc)
  })
})

// ============================================================================
// 场景 4：thinking 内容不会重复进入 answer 内容。
// ============================================================================

describe('Bug 1 修复验证：thinking 内容不会重复进入 answer 内容', () => {
  it('reasoning 不再落 Static：正文区只含正文，思考折叠为一次摘要', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning', delta: '推理中...\n' },
      { type: 'reasoning', delta: '继续推理' },
      { type: 'text', delta: '这是回答。\n' }, // 正文开始 → 思考结束，折叠为摘要
      { type: 'done' },
    ]

    const result = runStream(true, events)

    // 新行为：committed 中不应出现任何 reasoning 分块。
    const reasoningChunks = result.committed.filter((c) => c.variant === 'reasoning')
    const answerChunks = result.committed.filter((c) => c.variant === 'text')
    expect(reasoningChunks).toHaveLength(0)

    // 思考只折叠出一次摘要，字符数为两段思维链长度之和。
    expect(result.thinkingSummaries).toBe(1)
    expect(result.lastThinkingChars).toBe('推理中...\n'.length + '继续推理'.length)
    // 动态预览在思考过程中确实更新过（非空）。
    expect(result.maxReasoningPreview).toBeGreaterThan(0)

    // answer 内容：这是回答。（不含任何思维链）
    const answerText = answerChunks.map((c) => c.text).join('')
    expect(answerText).toBe('这是回答。')
    expect(answerText.includes('推理')).toBe(false)
  })

  it('关闭 thinking 时 reasoning delta 被静默忽略，不进入 text', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning', delta: '推理内容\n' },
      { type: 'reasoning', delta: '更多推理' },
      { type: 'text', delta: '回答内容\n' },
      { type: 'done' },
    ]

    // showThinking = false
    const committed = simulateStreamProcessor(false, events)

    expect(committed).toHaveLength(1)
    expect(committed[0].variant).toBe('text')
    expect(committed[0].text).toBe('回答内容')
  })

  it('纯 reasoning 消息（正文为空）结束后只折叠出一次思考摘要、无 text 块', () => {
    const events: StreamEvent[] = [
      { type: 'reasoning', delta: '仅推理\n' },
      { type: 'reasoning', delta: '没有正文' },
      { type: 'done' }, // 没有 text：done 时取走思考摘要
    ]

    const result = runStream(true, events)
    // 不再落任何 Static 分块（思维链与正文都没有可提交内容）。
    expect(result.committed).toHaveLength(0)
    // 思考折叠出一次摘要。
    expect(result.thinkingSummaries).toBe(1)
    expect(result.lastThinkingChars).toBe('仅推理\n'.length + '没有正文'.length)
  })
})

// ============================================================================
// 场景 5：工具调用后的继续输出不会重复之前内容。
// ============================================================================

describe('Bug 1 修复验证：工具调用后继续输出不重复', () => {
  it('每轮消息独立提交器状态，工具结果后新消息正文不受前一条影响', () => {
    // 第一条消息
    const committer1 = new StreamCommitter(false)
    const chunks1: CommittedChunk[] = []
    for (const c of committer1.onText('第一段回答\n')) {
      if (!c.spacer) chunks1.push({ variant: c.variant, text: c.text, head: c.head })
    }
    for (const c of committer1.onDone()) {
      if (!c.spacer) chunks1.push({ variant: c.variant, text: c.text, head: c.head })
    }

    // 工具调用结束后，新建提交器（模拟下一轮 LLM 调用）
    const committer2 = new StreamCommitter(false)
    const chunks2: CommittedChunk[] = []
    for (const c of committer2.onText('第二段回答\n')) {
      if (!c.spacer) chunks2.push({ variant: c.variant, text: c.text, head: c.head })
    }
    for (const c of committer2.onDone()) {
      if (!c.spacer) chunks2.push({ variant: c.variant, text: c.text, head: c.head })
    }

    expect(chunks1.map((c) => c.text).join('')).toBe('第一段回答')
    expect(chunks2.map((c) => c.text).join('')).toBe('第二段回答')
    // 关键断言：两段内容独立，不重复
    expect(chunks1[0]?.text).not.toBe(chunks2[0]?.text)
  })

  it('onDone 重入不会重复提交已落盘的尾巴', () => {
    const committer = new StreamCommitter(false)

    const firstDone = committer.onDone()
    const secondDone = committer.onDone()

    expect(firstDone.filter((c) => !c.spacer)).toHaveLength(0)
    expect(secondDone.filter((c) => !c.spacer)).toHaveLength(0)
  })

  it('有尾巴时 onDone 提交一次，再次调用无内容', () => {
    const committer = new StreamCommitter(false)

    committer.onText('没有换行的尾巴')
    const firstDone = committer.onDone()
    const secondDone = committer.onDone()

    expect(firstDone.filter((c) => !c.spacer).map((c) => c.text)).toEqual(['没有换行的尾巴'])
    expect(secondDone).toHaveLength(0)
  })
})

// ============================================================================
// 场景 6：makeEventKey 幂等去重键的唯一性验证。
// ============================================================================

describe('Bug 1 修复验证：makeEventKey 幂等去重键', () => {
  it('text_delta / reasoning_delta 返回 null（不需要也不应该去重）', () => {
    const ev1 = { type: 'text_delta' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, delta: 'hello' }
    const ev2 = { type: 'text_delta' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 2, delta: ' world' }
    const ev3 = { type: 'reasoning_delta' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 3, delta: 'thinking' }
    expect(makeEventKey(ev1)).toBeNull()
    expect(makeEventKey(ev2)).toBeNull()
    expect(makeEventKey(ev3)).toBeNull()
  })

  it('不同 iteration 的 tool_start 生成不同 key', () => {
    const ev1 = { type: 'tool_start' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, id: 'tool_1', name: 'read_file', summary: '' }
    const ev2 = { type: 'tool_start' as const, runId: 'r1', turnId: 't1', iteration: 1, timestamp: 2, id: 'tool_2', name: 'write_file', summary: '' }
    expect(makeEventKey(ev1)).not.toBe(makeEventKey(ev2))
  })

  it('不同 tool id 的 tool_end 生成不同 key', () => {
    const ev1 = { type: 'tool_end' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, id: 'tool_1', name: 'read_file', result: { llmContent: '', isError: false, uiSummary: '' }, durationMs: 100 }
    const ev2 = { type: 'tool_end' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 2, id: 'tool_2', name: 'write_file', result: { llmContent: '', isError: false, uiSummary: '' }, durationMs: 200 }
    expect(makeEventKey(ev1)).not.toBe(makeEventKey(ev2))
  })

  it('不同 runId 生成不同 key（即使事件类型相同）', () => {
    const ev1 = { type: 'run_end' as const, runId: 'r1', turnId: 't1', timestamp: 1, iterations: 1, reason: 'final' as const }
    const ev2 = { type: 'run_end' as const, runId: 'r2', turnId: 't1', timestamp: 1, iterations: 1, reason: 'final' as const }
    expect(makeEventKey(ev1)).not.toBe(makeEventKey(ev2))
  })

  it('相同 assistant_message 只生成相同 key（按 message.timestamp）', () => {
    const ev1 = { type: 'assistant_message' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, message: { role: 'assistant' as const, content: 'hi', timestamp: 1000 } }
    const ev2 = { type: 'assistant_message' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 2, message: { role: 'assistant' as const, content: 'hi', timestamp: 1000 } }
    expect(makeEventKey(ev1)).toBe(makeEventKey(ev2))
  })

  it('tool_message 按 toolCallId 去重', () => {
    const ev1 = { type: 'tool_message' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, message: { role: 'tool' as const, content: 'result', toolCallId: 'call_1', timestamp: 1000 } }
    const ev2 = { type: 'tool_message' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 2, message: { role: 'tool' as const, content: 'result', toolCallId: 'call_2', timestamp: 1000 } }
    expect(makeEventKey(ev1)).not.toBe(makeEventKey(ev2))
  })

  it('isEventDuplicate 对 delta 事件返回 false（不跳过）', () => {
    const ev = { type: 'text_delta' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, delta: 'hello' }
    const processed = new Set<string>()
    expect(isEventDuplicate(makeEventKey(ev), processed)).toBe(false)
  })

  it('isEventDuplicate 对已见过的 tool_end 返回 true（跳过）', () => {
    const ev = { type: 'tool_end' as const, runId: 'r1', turnId: 't1', iteration: 0, timestamp: 1, id: 'tool_1', name: 'read_file', result: { llmContent: '', isError: false, uiSummary: '' }, durationMs: 100 }
    const processed = new Set<string>()
    const key = makeEventKey(ev)!
    processed.add(key)
    expect(isEventDuplicate(key, processed)).toBe(true)
  })
})
