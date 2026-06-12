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

  it('局部累计段落只追加真正新增的后缀', () => {
    let acc = '1. **接收输入**：首先，我会接收用户的输入。\n\n'
    const first = '2. **解析输入**：接下来，我会对用户的输入进行解析。'
    const r1 = applyStreamContentDelta(acc, first)
    acc = r1.next
    expect(r1.delta).toBe(first)

    const second =
      '2. **解析输入**：接下来，我会对用户的输入进行解析。这包括理解用户的意图。'
    const r2 = applyStreamContentDelta(acc, second)
    expect(r2.delta).toBe('这包括理解用户的意图。')
    expect(r2.next).toBe(
      '1. **接收输入**：首先，我会接收用户的输入。\n\n' + second,
    )
  })

  it('列表编号短前缀被局部累计段落重放时不重复编号', () => {
    let acc = '1. 接收输入\n2. 解析输入\n3.'
    const incoming = '3. **任务规划**：根据用户输入规划任务。'

    const r = applyStreamContentDelta(acc, incoming)

    expect(r.delta).toBe(' **任务规划**：根据用户输入规划任务。')
    expect(r.next).toBe('1. 接收输入\n2. 解析输入\n3. **任务规划**：根据用户输入规划任务。')
  })

  it('当前段落从段首重放并扩展时只追加未输出的新尾部', () => {
    const paragraph =
      '选择 Claude Code 还是 DCODE 代理取决于具体的需求和偏好。如果主要目标是快速生成代码，并且对自然语言交互有较高需求，Claude Code 可能是更好的选择。如果需要更全面的开发支持，包括代'
    const incoming =
      '选择 Claude Code 还是 DCODE 代理取决于具体的需求和偏好。如果主要目标是快速生成代码，并且对自然语言交互有较高需求，Claude Code 可能是更好的选择。如果需要更全面的开发支持，包括代码分析、调试和版本控制，DCODE 代理可能更合适。'

    const r = applyStreamContentDelta(`### 总结\n\n${paragraph}`, incoming)

    expect(r.delta).toBe('码分析、调试和版本控制，DCODE 代理可能更合适。')
    expect(r.next).toBe(`### 总结\n\n${paragraph}码分析、调试和版本控制，DCODE 代理可能更合适。`)
  })

  it('当前段落重放中仅换行不同也不重复输出', () => {
    const paragraph =
      '选择 Claude Code 还是 DCODE 代理取决于具体的需求和偏好。如果主要目标是快速生成代码，并且对自然语言交互有较高需求，Claude Code 可能是更好的选择。如果需要更全面的开发支持，包括代'
    const incoming =
      '选择 Claude Code 还是 DCODE 代理取决于具体的需求和偏好。如果主要目标是快速生成代码，并且对自然语言交互有较高需求，Claude Code\n可能是更好的选择。如果需要更全面的开发支持，包括代码分析、调试和版本控制，DCODE 代理可能更合适。'

    const r = applyStreamContentDelta(`### 总结\n\n${paragraph}`, incoming)

    expect(r.delta).toBe('码分析、调试和版本控制，DCODE 代理可能更合适。')
  })

  it('普通短重叠增量不误删字符', () => {
    const r = applyStreamContentDelta('hel', 'lo')
    expect(r.delta).toBe('lo')
    expect(r.next).toBe('hello')
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
