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

  it('中文段落无 whitespace 差异的纯前缀重放（修复 Bug：之前因 matchPrefixIgnoringWhitespaceRuns 要求 whitespace 而误判）', () => {
    // 这是三体重复问题的关键场景：模型重新输出整个段落（无空格差异）
    const accumulated = '故事从物理学家汪淼的视角切入，描述了地球基础科学界出现异常扰动，科学界为此陷入恐慌。'
    const incoming = accumulated + '之后汪淼发现这一切与三体世界有关。'
    // 此场景被 check 1 累积模式捕获
    const r = applyStreamContentDelta(accumulated, incoming)
    expect(r.delta).toBe('之后汪淼发现这一切与三体世界有关。')
    expect(r.next).toBe(incoming)
  })

  it('中文段落重放（incoming 不是累积全文但以当前段落开头，无 whitespace 差异）', () => {
    // 场景：accumulated 包含多段，block 是当前段，incoming 是从当前段开始重写的新版本
    // block 长度 >= 24，直接用 incoming.startsWith(block) 检测（无需 whitespace 回退）
    const accumulated = '第一段内容。\n\n第二段当前段落内容（无换行，纯粹连续中文段落。）'
    const block = '第二段当前段落内容（无换行，纯粹连续中文段落。）'
    expect(block.length).toBeGreaterThanOrEqual(24)

    // incoming 从 block 开头重写并扩展（无 whitespace 差异）
    const incoming = block + '追加的新内容。'
    expect(incoming.startsWith(block)).toBe(true)

    const r = applyStreamContentDelta(accumulated, incoming)
    // 修复后：check 2 的 incoming.startsWith(block) 直接匹配
    expect(r.delta).toBe('追加的新内容。')
    expect(r.next).toBe(accumulated + '追加的新内容。')
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
  it('skips stale full-answer prefix snapshots', () => {
    const accumulated =
      'StoryFromPhysicsLabStartsWithALongAlreadyRenderedPrefix and continues with more answer text.'
    const incoming = 'StoryFromPhysicsLabStartsWithALongAlreadyRenderedPrefix'

    const r = applyStreamContentDelta(accumulated, incoming, { snapshot: true })

    expect(r.delta).toBe('')
    expect(r.next).toBe(accumulated)
  })

  it('skips stale current-block prefix snapshots without appending them again', () => {
    const blockPrefix = 'StoryFromCulturalRevolutionStartsWithYeWenjieAtRedCoastBase'
    const accumulated = `## Part One\n\n${blockPrefix} already emitted suffix.`

    const r = applyStreamContentDelta(accumulated, blockPrefix)

    expect(r.delta).toBe('')
    expect(r.next).toBe(accumulated)
  })

  it('continues after a skipped stale current-block prefix snapshot', () => {
    const blockPrefix = 'StoryFromCulturalRevolutionStartsWithYeWenjieAtRedCoastBase'
    let acc = `## Part One\n\n${blockPrefix} already emitted suffix.`

    const stale = applyStreamContentDelta(acc, blockPrefix)
    acc = stale.next
    const expanded = applyStreamContentDelta(
      acc,
      `${blockPrefix} already emitted suffix. New ending.`,
    )

    expect(stale.delta).toBe('')
    expect(expanded.delta).toBe(' New ending.')
    expect(expanded.next).toBe(`${acc} New ending.`)
  })

  it('skips stale current-block prefix snapshots with whitespace run differences', () => {
    const accumulated =
      'Intro\n\nThe current paragraph has a long prefix with multiple spaces already rendered.'
    const incoming = 'The current paragraph has a long prefix with multiple\nspaces'

    const r = applyStreamContentDelta(accumulated, incoming)

    expect(r.delta).toBe('')
    expect(r.next).toBe(accumulated)
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
