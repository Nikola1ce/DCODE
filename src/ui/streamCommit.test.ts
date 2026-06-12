// StreamCommitter 单元测试。
// 验证 UI 流式提交状态机不会在 done / 异常收尾路径重复提交尾巴。

import { describe, expect, it } from 'vitest'
import { StreamCommitter } from './streamCommit.js'

describe('StreamCommitter', () => {
  it('onDone 重入不会重复提交已经落盘的尾巴', () => {
    const c = new StreamCommitter(false)

    expect(c.onText('没有换行的最后一段')).toEqual([])
    const firstDone = c.onDone()
    const secondDone = c.onDone()

    expect(firstDone.filter((chunk) => !chunk.spacer).map((chunk) => chunk.text)).toEqual([
      '没有换行的最后一段',
    ])
    expect(secondDone).toEqual([])
  })

  it('已按换行提交的正文不会在 done 时重复提交', () => {
    const c = new StreamCommitter(false)

    const chunks = c.onText('第一行\n')
    const done = c.onDone()

    expect(chunks.filter((chunk) => !chunk.spacer).map((chunk) => chunk.text)).toEqual([
      '第一行',
    ])
    expect(done.filter((chunk) => !chunk.spacer)).toEqual([])
  })

  it('正文开始后 reasoning 尾巴只落盘一次', () => {
    const c = new StreamCommitter(true)

    expect(c.onReasoning('思考尾巴')).toEqual([])
    const textChunks = c.onText('正文')
    const doneChunks = c.onDone()

    expect(textChunks.filter((chunk) => !chunk.spacer).map((chunk) => chunk.text)).toEqual([
      '思考尾巴',
    ])
    expect(doneChunks.filter((chunk) => !chunk.spacer).map((chunk) => chunk.text)).toEqual([
      '正文',
    ])
  })
})
