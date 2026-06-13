// 模型上下文窗口查询单元测试。
// 校验各 Provider 已知模型返回正确窗口、未知模型按 Provider 回退、模型名大小写兼容；
// 并覆盖「多档候选解析、用户选定档位解析、压缩阈值计算、档位标签格式化与输入解析」等新增能力，
// 这些是「随模型切换的动态压缩阈值 + 多档上下文长度选择」功能的核心，必须有回归保护。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { COMPACT_THRESHOLD_RATIO, DEFAULT_MODEL, PRO_MODEL } from '../constants.js'
import {
  contextOverrideKey,
  formatContextWindowLabel,
  getCompactThreshold,
  getModelContextOptions,
  getModelContextWindow,
  modelHasContextChoices,
  parseContextWindowInput,
  renderModelSwitchContextHint,
  resolveContextWindow,
} from './contextWindow.js'

describe('providers/contextWindow', () => {
  it('DeepSeek V4 主模型为 128K', () => {
    expect(getModelContextWindow('deepseek', DEFAULT_MODEL)).toBe(128_000)
    expect(getModelContextWindow('deepseek', PRO_MODEL)).toBe(128_000)
  })

  it('OpenAI gpt-5 系列为 400K、gpt-4.1 为 1M、gpt-4o-mini 为 128K', () => {
    expect(getModelContextWindow('openai', 'gpt-5.5')).toBe(400_000)
    expect(getModelContextWindow('openai', 'gpt-4.1')).toBe(1_000_000)
    expect(getModelContextWindow('openai', 'gpt-4o-mini')).toBe(128_000)
  })

  it('智谱 GLM 旗舰为 200K、glm-4-flash 为 128K、glm-4-long 为 1M', () => {
    expect(getModelContextWindow('zhipu', 'glm-4.6')).toBe(200_000)
    expect(getModelContextWindow('zhipu', 'glm-4-flash')).toBe(128_000)
    expect(getModelContextWindow('zhipu', 'glm-4-long')).toBe(1_000_000)
  })

  it('模型名大小写不敏感', () => {
    expect(getModelContextWindow('openai', 'GPT-4O-MINI')).toBe(128_000)
    expect(getModelContextWindow('openai', 'O3')).toBe(200_000)
  })

  it('未知模型回退到 Provider 缺省窗口', () => {
    expect(getModelContextWindow('deepseek', 'unknown-xyz')).toBe(128_000)
    expect(getModelContextWindow('openai', 'unknown-xyz')).toBe(128_000)
    expect(getModelContextWindow('zhipu', 'unknown-xyz')).toBe(128_000)
    expect(getModelContextWindow('ollama', 'llama3.2')).toBe(32_000)
    expect(getModelContextWindow('custom', 'whatever')).toBe(32_000)
  })

  it('空模型名也返回 Provider 缺省窗口', () => {
    expect(getModelContextWindow('deepseek', '')).toBe(128_000)
    expect(getModelContextWindow('zhipu', '   ')).toBe(128_000)
  })

  it('返回值恒为正整数', () => {
    const v = getModelContextWindow('deepseek', DEFAULT_MODEL)
    expect(Number.isInteger(v)).toBe(true)
    expect(v).toBeGreaterThan(0)
  })
})

describe('getModelContextOptions（多档候选解析）', () => {
  it('单档模型仅返回唯一最大窗口', () => {
    expect(getModelContextOptions('deepseek', DEFAULT_MODEL)).toEqual([128_000])
    expect(getModelContextOptions('openai', 'gpt-4o')).toEqual([128_000])
    // 旗舰智谱模型未登记多档，应只含官方最大值。
    expect(getModelContextOptions('zhipu', 'glm-4.6')).toEqual([200_000])
  })

  it('智谱 glm-4-long 返回升序去重的多档候选', () => {
    expect(getModelContextOptions('zhipu', 'glm-4-long')).toEqual([
      128_000, 200_000, 1_000_000,
    ])
  })

  it('本地 Ollama 模型回退到通用档位（升序，且不超过最大窗口）', () => {
    // Ollama 缺省窗口 32K，故通用档位中超过 32K 的项（64K/128K）会被裁掉。
    expect(getModelContextOptions('ollama', 'llama3.2')).toEqual([
      8_000, 16_000, 32_000,
    ])
  })

  it('custom 后端同样回退到通用档位', () => {
    expect(getModelContextOptions('custom', 'whatever')).toEqual([
      8_000, 16_000, 32_000,
    ])
  })

  it('候选恒为升序、去重、正整数，且必含最大档', () => {
    const opts = getModelContextOptions('zhipu', 'glm-4-long')
    const max = getModelContextWindow('zhipu', 'glm-4-long')
    expect(opts).toContain(max)
    expect([...opts].sort((a, b) => a - b)).toEqual(opts)
    expect(new Set(opts).size).toBe(opts.length)
    for (const v of opts) expect(Number.isInteger(v) && v > 0).toBe(true)
  })
})

describe('modelHasContextChoices（是否值得展示档位选择）', () => {
  it('多档模型返回 true，单档模型返回 false', () => {
    expect(modelHasContextChoices('zhipu', 'glm-4-long')).toBe(true)
    expect(modelHasContextChoices('ollama', 'llama3.2')).toBe(true)
    expect(modelHasContextChoices('deepseek', DEFAULT_MODEL)).toBe(false)
    expect(modelHasContextChoices('openai', 'gpt-4o')).toBe(false)
  })
})

describe('resolveContextWindow（解析当前生效窗口）', () => {
  it('无用户选择时返回模型默认（最大）窗口', () => {
    expect(resolveContextWindow('zhipu', 'glm-4-long')).toBe(1_000_000)
    expect(resolveContextWindow('deepseek', DEFAULT_MODEL, {})).toBe(128_000)
  })

  it('用户选择为合法候选时采用用户选择', () => {
    const key = contextOverrideKey('zhipu', 'glm-4-long')
    expect(resolveContextWindow('zhipu', 'glm-4-long', { [key]: 200_000 })).toBe(
      200_000,
    )
  })

  it('用户选择非当前模型合法候选时回退默认窗口（防止沿用失效档位）', () => {
    const key = contextOverrideKey('zhipu', 'glm-4-long')
    // 999999 不是 glm-4-long 的候选档位，应忽略并回退到 1M。
    expect(resolveContextWindow('zhipu', 'glm-4-long', { [key]: 999_999 })).toBe(
      1_000_000,
    )
  })

  it('用户为单档模型设过档位也只会回退默认（单档模型不可切换）', () => {
    const key = contextOverrideKey('deepseek', DEFAULT_MODEL)
    expect(resolveContextWindow('deepseek', DEFAULT_MODEL, { [key]: 64_000 })).toBe(
      128_000,
    )
  })

  it('overrides 键大小写无关（模型名统一小写）', () => {
    const key = contextOverrideKey('zhipu', 'GLM-4-LONG')
    expect(key).toBe('zhipu:glm-4-long')
    expect(resolveContextWindow('zhipu', 'glm-4-long', { [key]: 128_000 })).toBe(
      128_000,
    )
  })
})

describe('getCompactThreshold（压缩阈值 = 窗口×比率）', () => {
  it('按 COMPACT_THRESHOLD_RATIO 计算并向下取整', () => {
    expect(getCompactThreshold(200_000)).toBe(
      Math.floor(200_000 * COMPACT_THRESHOLD_RATIO),
    )
    expect(getCompactThreshold(128_000)).toBe(
      Math.floor(128_000 * COMPACT_THRESHOLD_RATIO),
    )
  })

  it('窗口随档位变化，阈值随之变化（200K→1M 阈值约为 5 倍）', () => {
    expect(getCompactThreshold(1_000_000)).toBe(900_000)
    expect(getCompactThreshold(200_000)).toBe(180_000)
  })

  it('非法窗口回退到兜底窗口，结果恒为正整数', () => {
    expect(getCompactThreshold(0)).toBeGreaterThan(0)
    expect(getCompactThreshold(-100)).toBeGreaterThan(0)
    expect(Number.isInteger(getCompactThreshold(128_000))).toBe(true)
  })
})

describe('formatContextWindowLabel（档位标签格式化）', () => {
  it('整千以 K 显示、整百万以 M 显示', () => {
    expect(formatContextWindowLabel(8_000)).toBe('8K')
    expect(formatContextWindowLabel(128_000)).toBe('128K')
    expect(formatContextWindowLabel(200_000)).toBe('200K')
    expect(formatContextWindowLabel(1_000_000)).toBe('1M')
  })

  it('< 1000 直接显示原值', () => {
    expect(formatContextWindowLabel(512)).toBe('512')
    expect(formatContextWindowLabel(0)).toBe('0')
  })
})

describe('parseContextWindowInput（档位输入解析）', () => {
  it('支持 k / K / m / M 单位与纯数字', () => {
    expect(parseContextWindowInput('128k')).toBe(128_000)
    expect(parseContextWindowInput('128K')).toBe(128_000)
    expect(parseContextWindowInput('1m')).toBe(1_000_000)
    expect(parseContextWindowInput('1M')).toBe(1_000_000)
    expect(parseContextWindowInput('128000')).toBe(128_000)
  })

  it('支持小数与单位组合（如 1.5m）', () => {
    expect(parseContextWindowInput('1.5m')).toBe(1_500_000)
    expect(parseContextWindowInput('0.5k')).toBe(500)
  })

  it('容忍首尾空白与数字单位间空格', () => {
    expect(parseContextWindowInput('  200k ')).toBe(200_000)
    expect(parseContextWindowInput('200 k')).toBe(200_000)
  })

  it('非法输入返回 undefined', () => {
    expect(parseContextWindowInput('')).toBeUndefined()
    expect(parseContextWindowInput('abc')).toBeUndefined()
    expect(parseContextWindowInput('12kb')).toBeUndefined()
    expect(parseContextWindowInput('-5k')).toBeUndefined()
    expect(parseContextWindowInput('0')).toBeUndefined()
  })

  it('解析结果与 formatContextWindowLabel 往返一致', () => {
    for (const n of [8_000, 128_000, 200_000, 1_000_000]) {
      const label = formatContextWindowLabel(n).toLowerCase()
      expect(parseContextWindowInput(label)).toBe(n)
    }
  })
})

describe('renderModelSwitchContextHint（切换后多档提示）', () => {
  it('多档模型返回含档位与用法的提示', () => {
    const hint = renderModelSwitchContextHint('zhipu', 'glm-4-long')
    expect(hint).toBeDefined()
    expect(hint).toContain('128K')
    expect(hint).toContain('1M')
    expect(hint).toContain('/model context')
  })

  it('单档模型返回 undefined（不打扰用户）', () => {
    expect(renderModelSwitchContextHint('deepseek', DEFAULT_MODEL)).toBeUndefined()
    expect(renderModelSwitchContextHint('openai', 'gpt-4o')).toBeUndefined()
  })

  it('提示中的「当前窗口」反映用户已选档位', () => {
    const key = contextOverrideKey('zhipu', 'glm-4-long')
    const hint = renderModelSwitchContextHint('zhipu', 'glm-4-long', { [key]: 200_000 })
    expect(hint).toContain('当前 200K')
  })
})
