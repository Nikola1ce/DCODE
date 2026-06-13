// 推理强度与思维链预算相关常量/工具函数的单元测试。
// 覆盖四级强度校验、DeepSeek 兼容映射、thinking budget 区间校验与解析。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_EFFORT,
  MAX_THINKING_BUDGET,
  MIN_THINKING_BUDGET,
  REASONING_EFFORTS,
  isValidReasoningEffort,
  isValidThinkingBudget,
  mapEffortToDeepSeek,
  parseThinkingBudget,
} from './constants.js'

describe('reasoning effort 四级强度', () => {
  it('REASONING_EFFORTS 暴露 low/medium/high/max 四档', () => {
    expect(REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('默认强度为 high', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('high')
  })

  it('isValidReasoningEffort 接受四档、拒绝非法值', () => {
    for (const e of REASONING_EFFORTS) {
      expect(isValidReasoningEffort(e)).toBe(true)
    }
    expect(isValidReasoningEffort('xhigh')).toBe(false)
    expect(isValidReasoningEffort('')).toBe(false)
    expect(isValidReasoningEffort('HIGH')).toBe(false)
  })

  it('mapEffortToDeepSeek 将 low/medium 归并为 high，max 保持 max', () => {
    expect(mapEffortToDeepSeek('low')).toBe('high')
    expect(mapEffortToDeepSeek('medium')).toBe('high')
    expect(mapEffortToDeepSeek('high')).toBe('high')
    expect(mapEffortToDeepSeek('max')).toBe('max')
  })
})

describe('thinking budget 区间校验与解析', () => {
  it('isValidThinkingBudget 仅接受区间内整数', () => {
    expect(isValidThinkingBudget(MIN_THINKING_BUDGET)).toBe(true)
    expect(isValidThinkingBudget(MAX_THINKING_BUDGET)).toBe(true)
    expect(isValidThinkingBudget(16000)).toBe(true)
    // 边界外。
    expect(isValidThinkingBudget(MIN_THINKING_BUDGET - 1)).toBe(false)
    expect(isValidThinkingBudget(MAX_THINKING_BUDGET + 1)).toBe(false)
    // 非整数 / 非数字。
    expect(isValidThinkingBudget(1024.5)).toBe(false)
    expect(isValidThinkingBudget('16000')).toBe(false)
    expect(isValidThinkingBudget(undefined)).toBe(false)
    expect(isValidThinkingBudget(Number.NaN)).toBe(false)
  })

  it('parseThinkingBudget 解析合法整数字符串', () => {
    expect(parseThinkingBudget('16000')).toBe(16000)
    expect(parseThinkingBudget('  2048  ')).toBe(2048)
    expect(parseThinkingBudget(String(MIN_THINKING_BUDGET))).toBe(MIN_THINKING_BUDGET)
    expect(parseThinkingBudget(String(MAX_THINKING_BUDGET))).toBe(MAX_THINKING_BUDGET)
  })

  it('parseThinkingBudget 拒绝非法/越界字符串', () => {
    expect(parseThinkingBudget('abc')).toBeUndefined()
    expect(parseThinkingBudget('16000.5')).toBeUndefined()
    expect(parseThinkingBudget('-100')).toBeUndefined()
    expect(parseThinkingBudget('')).toBeUndefined()
    expect(parseThinkingBudget(String(MIN_THINKING_BUDGET - 1))).toBeUndefined()
    expect(parseThinkingBudget(String(MAX_THINKING_BUDGET + 1))).toBeUndefined()
  })
})
