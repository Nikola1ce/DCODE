// 模型上下文窗口查询单元测试。
// 校验各 Provider 已知模型返回正确窗口、未知模型按 Provider 回退、模型名大小写兼容。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL, PRO_MODEL } from '../constants.js'
import { getModelContextWindow } from './contextWindow.js'

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
