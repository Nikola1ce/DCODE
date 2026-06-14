import { describe, expect, it } from 'vitest'
import { StreamCommitter } from './streamCommit.js'

function contentOf(chunks: ReturnType<StreamCommitter['onDone']>): string {
  return chunks
    .filter((chunk) => !chunk.spacer)
    .map((chunk) => chunk.text)
    .join('')
}

describe('StreamCommitter', () => {
  it('does not commit the same tail twice when onDone is called again', () => {
    const c = new StreamCommitter(false)

    expect(c.onText('final tail without newline')).toEqual([])
    const firstDone = c.onDone()
    const secondDone = c.onDone()

    expect(contentOf(firstDone)).toBe('final tail without newline')
    expect(secondDone).toEqual([])
  })

  it('does not recommit text that was already flushed by newline', () => {
    const c = new StreamCommitter(false)

    const chunks = c.onText('line one\n')
    const done = c.onDone()

    expect(contentOf(chunks)).toBe('line one')
    expect(done.filter((chunk) => !chunk.spacer)).toEqual([])
  })

  it('reasoning 不再落入 Static：onReasoning 无返回，仅更新动态预览', () => {
    const c = new StreamCommitter(true)

    // 新行为：onReasoning 不产出可提交分块（返回 void），只把内容累计到 liveReasoning 预览。
    c.onReasoning('thinking tail')
    expect(c.liveReasoning).toBe('thinking tail')

    // 正文开始：只产出正文分块，思维链不混入。
    const textChunks = c.onText('answer')
    const doneChunks = c.onDone()
    // 正文开始后思考结束，预览清空。
    expect(c.liveReasoning).toBe('')
    expect(contentOf(textChunks) + contentOf(doneChunks)).toBe('answer')
  })

  it('takeThinkingSummary 在出现思维链后给出折叠摘要且幂等', () => {
    let clock = 1000
    const c = new StreamCommitter(true, () => clock)

    c.onReasoning('正在规划答案结构…')
    clock = 3500 // 思考 2.5 秒
    c.onText('最终答案')

    const summary = c.takeThinkingSummary()
    expect(summary.hadReasoning).toBe(true)
    expect(summary.durationMs).toBe(2500)
    expect(summary.chars).toBe('正在规划答案结构…'.length)

    // 幂等：再次取走应返回 hadReasoning=false，避免重复折叠项。
    expect(c.takeThinkingSummary().hadReasoning).toBe(false)
  })

  it('无思维链时 takeThinkingSummary 返回 hadReasoning=false', () => {
    const c = new StreamCommitter(true)
    c.onText('直接回答，没有思考')
    expect(c.takeThinkingSummary().hadReasoning).toBe(false)
  })

  it('关闭 showThinking 时忽略所有 reasoning 增量', () => {
    const c = new StreamCommitter(false)
    c.onReasoning('这段思考应被忽略')
    expect(c.liveReasoning).toBe('')
    expect(c.takeThinkingSummary().hadReasoning).toBe(false)
  })

  it('soft-flushes long unbroken answer text so the live region stays short', () => {
    const c = new StreamCommitter(false)
    const text =
      'Story begins during the Cultural Revolution, when the physicist Ye Wenjie loses faith in humanity after betrayal and tragedy. '.repeat(
        5,
      )

    const chunks = c.onText(text)

    expect(chunks.filter((chunk) => !chunk.spacer).length).toBeGreaterThan(0)
    expect(c.liveText.length).toBeGreaterThan(0)
    expect(c.liveText.length).toBeLessThan(text.length)
    expect(contentOf([...chunks, ...c.onDone()])).toBe(text)
  })

  it('长思维链只在动态预览中保留尾部，且不泄漏进正文', () => {
    const c = new StreamCommitter(true)
    const reasoning =
      'The model is planning the structure of a long response before writing the visible answer. '.repeat(
        80,
      )

    // 新行为：reasoning 不产出分块；动态预览只保留尾部（远小于原文）。
    c.onReasoning(reasoning)
    expect(c.liveReasoning.length).toBeGreaterThan(0)
    expect(c.liveReasoning.length).toBeLessThan(reasoning.length)
    // 预览是原文的尾部子串。
    expect(reasoning.endsWith(c.liveReasoning)).toBe(true)

    // 正文只包含正文内容，绝不含思维链。
    const textChunks = c.onText('final answer')
    const doneChunks = c.onDone()
    const allText = contentOf([...textChunks, ...doneChunks])
    expect(allText).toBe('final answer')
    expect(allText.includes('planning the structure')).toBe(false)
  })
})
