// 请求估算必须和真正发送的瘦身历史一致，并计入工具定义。
// 制作人：Moriarty_Dox
import { describe, expect, it } from 'vitest'
import { estimateRequestTokens } from './contextUsage.js'
import { estimateMessagesTokens } from './compact.js'
import type { DeepMessage } from './types.js'

describe('请求上下文估算', () => {
  it('计入工具schema且不修改消息', () => {
    const messages: DeepMessage[] = [{ role: 'user', content: '测试' }]
    const withoutTools = estimateRequestTokens(messages)
    const withTools = estimateRequestTokens(messages, [{ type: 'function', function: {
      name: 'read_file', description: '读取文件'.repeat(200), parameters: { type: 'object' },
    } }])
    expect(withTools).toBeGreaterThan(withoutTools + 200)
    expect(messages).toEqual([{ role: 'user', content: '测试' }])
  })
  it('旧工具全文不计入发送空间，最近工具结果仍计入', () => {
    const messages: DeepMessage[] = [{ role: 'tool', content: 'x'.repeat(300000) },
      ...Array.from({ length: 9 }, (): DeepMessage => ({ role: 'user', content: '继续' }))]
    expect(estimateRequestTokens(messages)).toBeLessThan(1000)
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(100000)
    messages.push({ role: 'tool', content: 'y'.repeat(30000) })
    expect(estimateRequestTokens(messages)).toBeGreaterThan(10000)
    expect(messages[0].content).toHaveLength(300000)
  })
})
