// 流式 delta 归一化单元测试。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { applyStreamContentDelta, collapseObviousRepetition } from './streamDelta.js'

describe('applyStreamContentDelta', () => {
  it('标准增量模式逐段追加', () => {
    let acc = ''
    const r1 = applyStreamContentDelta(acc, '你好')
    acc = r1.next
    expect(r1.delta).toBe('你好')
    const r2 = applyStreamContentDelta(acc, '世界')
    expect(r2.next).toBe('你好世界')
    expect(r2.delta).toBe('世界')
  })

  it('累积模式只取后缀增量', () => {
    let acc = ''
    const r1 = applyStreamContentDelta(acc, '使用当前模型')
    acc = r1.next
    const r2 = applyStreamContentDelta(acc, '使用当前模型是免费的')
    expect(r2.next).toBe('使用当前模型是免费的')
    expect(r2.delta).toBe('是免费的')
  })

  it('重复 chunk 不产生增量', () => {
    const sentence = '使用当前模型 (glm-4-flash) 是免费的。'
    let acc = sentence
    const r = applyStreamContentDelta(acc, sentence)
    expect(r.delta).toBe('')
    expect(r.next).toBe(sentence)
  })

  it('空 incoming 跳过', () => {
    const r = applyStreamContentDelta('已有', '')
    expect(r.delta).toBe('')
    expect(r.next).toBe('已有')
  })
})

describe('collapseObviousRepetition', () => {
  it('连续相同分句只保留一次', () => {
    const s = '第一句。第一句。第一句。'
    expect(collapseObviousRepetition(s)).toBe('第一句。')
  })

  it('整段周期重复折叠为一段', () => {
    const unit = '使用当前模型是免费的。'
    const repeated = unit.repeat(5)
    expect(collapseObviousRepetition(repeated)).toBe(unit)
  })

  it('短文本或正常长文不改变', () => {
    expect(collapseObviousRepetition('短')).toBe('短')
    const normal = '第一句。第二句不同。第三句也不同。'
    expect(collapseObviousRepetition(normal)).toBe(normal)
  })
})
