// Provider 感知计费单元测试。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL } from '../constants.js'
import { formatCost } from '../deepseek/pricing.js'
import { calcCostForProvider, isFreeModelForProvider } from './pricing.js'

const sampleUsage = {
  prompt_tokens: 1000,
  completion_tokens: 500,
  prompt_cache_hit_tokens: 200,
  prompt_cache_miss_tokens: 800,
}

describe('providers/pricing', () => {
  it('zhipu glm-4-flash 免费', () => {
    expect(isFreeModelForProvider('zhipu', 'glm-4-flash')).toBe(true)
    expect(calcCostForProvider('zhipu', 'glm-4-flash', sampleUsage)).toBe(0)
    expect(formatCost(0)).toBe('免费')
  })

  it('zhipu glm-4.7 按量计费', () => {
    expect(isFreeModelForProvider('zhipu', 'glm-4.7')).toBe(false)
    const cost = calcCostForProvider('zhipu', 'glm-4.7', sampleUsage)
    expect(cost).toBeGreaterThan(0)
  })

  it('deepseek 使用 DeepSeek 价目', () => {
    const cost = calcCostForProvider('deepseek', DEFAULT_MODEL, sampleUsage)
    expect(cost).toBeGreaterThan(0)
  })

  it('openai gpt-4o-mini 使用 OpenAI 价目', () => {
    const cost = calcCostForProvider('openai', 'gpt-4o-mini', sampleUsage)
    expect(cost).toBeGreaterThan(0)
  })

  it('openai 未知模型不回退 DeepSeek 价', () => {
    const cost = calcCostForProvider('openai', 'unknown-model-xyz', sampleUsage)
    expect(cost).toBe(0)
  })

  it('ollama 免费', () => {
    expect(calcCostForProvider('ollama', 'llama3.2', sampleUsage)).toBe(0)
  })
})
