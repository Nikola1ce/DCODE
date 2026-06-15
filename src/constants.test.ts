// 推理强度与思维链预算相关常量/工具函数的单元测试。
// 覆盖四级强度校验、DeepSeek 兼容映射、thinking budget 区间校验与解析、提示音音量夹紧与解析。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REASONING_EFFORT,
  DEFAULT_SOUND_VOLUME,
  MAX_SOUND_VOLUME,
  MAX_THINKING_BUDGET,
  MIN_SOUND_VOLUME,
  MIN_THINKING_BUDGET,
  REASONING_EFFORTS,
  clampSoundVolume,
  isValidReasoningEffort,
  isValidThinkingBudget,
  mapEffortToDeepSeek,
  mapSoundVolumeToGain,
  parseSoundVolume,
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

describe('提示音音量夹紧与解析', () => {
  it('常量取值符合预期（0–100，默认 100）', () => {
    expect(MIN_SOUND_VOLUME).toBe(0)
    expect(MAX_SOUND_VOLUME).toBe(100)
    expect(DEFAULT_SOUND_VOLUME).toBe(100)
  })

  it('clampSoundVolume 夹紧越界值、四舍五入小数、对非法回退默认', () => {
    expect(clampSoundVolume(50)).toBe(50)
    expect(clampSoundVolume(0)).toBe(0)
    expect(clampSoundVolume(100)).toBe(100)
    // 越界。
    expect(clampSoundVolume(-5)).toBe(0)
    expect(clampSoundVolume(500)).toBe(100)
    // 小数四舍五入。
    expect(clampSoundVolume(72.4)).toBe(72)
    expect(clampSoundVolume(72.6)).toBe(73)
    // 字符串数字可解析。
    expect(clampSoundVolume('80')).toBe(80)
    // 非法值回退默认。
    expect(clampSoundVolume('abc')).toBe(DEFAULT_SOUND_VOLUME)
    expect(clampSoundVolume(undefined)).toBe(DEFAULT_SOUND_VOLUME)
    expect(clampSoundVolume(Number.NaN)).toBe(DEFAULT_SOUND_VOLUME)
  })

  it('parseSoundVolume 解析合法整数（可带 % 与空白）', () => {
    expect(parseSoundVolume('0')).toBe(0)
    expect(parseSoundVolume('60')).toBe(60)
    expect(parseSoundVolume('100')).toBe(100)
    expect(parseSoundVolume('  80  ')).toBe(80)
    expect(parseSoundVolume('80%')).toBe(80)
  })

  it('parseSoundVolume 拒绝非法/越界字符串', () => {
    expect(parseSoundVolume('abc')).toBeUndefined()
    expect(parseSoundVolume('60.5')).toBeUndefined()
    expect(parseSoundVolume('-10')).toBeUndefined()
    expect(parseSoundVolume('101')).toBeUndefined()
    expect(parseSoundVolume('500')).toBeUndefined()
    expect(parseSoundVolume('')).toBeUndefined()
  })

  it('mapSoundVolumeToGain 采用感知响度曲线（100→1，50 明显低于线性 0.5）', () => {
    expect(mapSoundVolumeToGain(100)).toBe(1)
    expect(mapSoundVolumeToGain(0)).toBe(0)
    // 50 配置 → 0.25 增益（平方曲线），而非线性 0.5。
    expect(mapSoundVolumeToGain(50)).toBeCloseTo(0.25, 5)
    expect(mapSoundVolumeToGain(50)).toBeLessThan(0.5)
    expect(mapSoundVolumeToGain(30)).toBeCloseTo(0.09, 5)
    expect(mapSoundVolumeToGain(10)).toBeCloseTo(0.01, 5)
  })
})
