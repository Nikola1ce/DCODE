// historyTrim 单元测试。
// 验证「发送前历史瘦身」：旧的大工具结果被截断、最近窗口与小结果保持原样、
// 入参不被原地修改、重复调用幂等、非 tool 消息不受影响。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  HISTORY_TRIM_HEAD_CHARS,
  HISTORY_TRIM_KEEP_RECENT,
  HISTORY_TRIM_MAX_TOOL_RESULT_CHARS,
} from '../constants.js'
import type { DeepMessage } from './types.js'
import { trimHistoryForRequest } from './historyTrim.js'

/**
 * 构造一条工具结果消息。
 * @param content 内容。
 * @param toolName 工具名。
 * @returns DeepMessage。
 */
function toolMsg(content: string, toolName = 'read_file'): DeepMessage {
  return { role: 'tool', content, toolName, toolCallId: 'x', metadata: { source: 'tool' } }
}

/** 生成超过瘦身阈值的大内容字符串。 */
function bigContent(): string {
  return 'A'.repeat(HISTORY_TRIM_MAX_TOOL_RESULT_CHARS + 500)
}

/**
 * 构造一段「足够长」的历史：头部放置目标消息，尾部用占位消息填满最近窗口。
 * @param head 要置于历史深处（会被瘦身判定）的消息。
 * @returns 完整消息数组。
 */
function withRecentPadding(head: DeepMessage[]): DeepMessage[] {
  const padding: DeepMessage[] = []
  for (let i = 0; i < HISTORY_TRIM_KEEP_RECENT + 1; i++) {
    padding.push({ role: 'user', content: `padding-${i}` })
  }
  return [{ role: 'system', content: 'sys' }, ...head, ...padding]
}

describe('trimHistoryForRequest', () => {
  it('历史很短时原样返回（同一引用）', () => {
    const msgs: DeepMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      toolMsg(bigContent()),
    ]
    expect(trimHistoryForRequest(msgs)).toBe(msgs)
  })

  it('滚出最近窗口的大工具结果会被截断并加占位说明', () => {
    const big = toolMsg(bigContent())
    const msgs = withRecentPadding([{ role: 'user', content: 'q' }, big])
    const out = trimHistoryForRequest(msgs)

    // 找到被处理后的那条 tool 消息。
    const trimmed = out.find((m) => m.role === 'tool')!
    expect(trimmed.content.length).toBeLessThan(bigContent().length)
    expect(trimmed.content.startsWith('A'.repeat(HISTORY_TRIM_HEAD_CHARS))).toBe(true)
    expect(trimmed.content).toContain('历史瘦身')
    expect(trimmed.metadata?.trimmed).toBe(true)
  })

  it('不修改入参数组与原消息对象（纯函数）', () => {
    const big = toolMsg(bigContent())
    const originalContent = big.content
    const msgs = withRecentPadding([big])
    trimHistoryForRequest(msgs)
    // 原消息对象内容保持不变。
    expect(big.content).toBe(originalContent)
    expect(big.metadata?.trimmed).toBeUndefined()
  })

  it('最近窗口内的大工具结果保持原样', () => {
    const big = toolMsg(bigContent())
    // 把大结果放在最末尾（属于最近窗口）。
    const msgs: DeepMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: HISTORY_TRIM_KEEP_RECENT }, (_, i) => ({
        role: 'user' as const,
        content: `u${i}`,
      })),
      big,
    ]
    const out = trimHistoryForRequest(msgs)
    const last = out[out.length - 1]
    expect(last.content).toBe(bigContent())
    expect(last.metadata?.trimmed).toBeUndefined()
  })

  it('小于阈值的旧工具结果不被瘦身', () => {
    const small = toolMsg('short result')
    const msgs = withRecentPadding([small])
    const out = trimHistoryForRequest(msgs)
    const stillSmall = out.find((m) => m.role === 'tool')!
    expect(stillSmall.content).toBe('short result')
    expect(stillSmall.metadata?.trimmed).toBeUndefined()
  })

  it('非 tool 角色的大消息不被瘦身', () => {
    const bigUser: DeepMessage = { role: 'user', content: bigContent() }
    const msgs = withRecentPadding([bigUser])
    const out = trimHistoryForRequest(msgs)
    const found = out.find((m) => m.role === 'user' && m.content.length > 1000)!
    expect(found.content).toBe(bigContent())
  })

  it('幂等：对已瘦身结果再次调用不二次截断', () => {
    const big = toolMsg(bigContent())
    const msgs = withRecentPadding([big])
    const once = trimHistoryForRequest(msgs)
    const onceContent = once.find((m) => m.role === 'tool')!.content
    const twice = trimHistoryForRequest(once)
    const twiceContent = twice.find((m) => m.role === 'tool')!.content
    expect(twiceContent).toBe(onceContent)
  })

  it('没有任何可瘦身消息时返回原数组引用', () => {
    const msgs = withRecentPadding([{ role: 'user', content: 'nothing big here' }])
    expect(trimHistoryForRequest(msgs)).toBe(msgs)
  })
})
