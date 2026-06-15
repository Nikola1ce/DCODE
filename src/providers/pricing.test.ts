// Provider 感知计费单元测试。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL } from '../constants.js'
import { formatCost } from '../deepseek/pricing.js'
import {
  calcCostForProvider,
  getModelPricingStatus,
  isFreeModelForProvider,
} from './pricing.js'
import { OPENAI_CHAT_MODELS } from './openaiModels.js'
import { ZHIPU_FREE_MODELS, ZHIPU_PAID_MODELS } from './zhipuModels.js'

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

describe('定价表与可选模型清单一致性（回归保护）', () => {
  it('每个 OpenAI 可选模型都必须有定价条目（否则会被误显示为免费）', () => {
    const missing = OPENAI_CHAT_MODELS.filter(
      (m) => getModelPricingStatus('openai', m) !== 'priced',
    )
    expect(missing).toEqual([])
  })

  it('每个智谱「付费」可选模型都必须有定价条目', () => {
    const missing = ZHIPU_PAID_MODELS.filter(
      (m) => getModelPricingStatus('zhipu', m) !== 'priced',
    )
    expect(missing).toEqual([])
  })

  it('智谱免费模型状态为 free', () => {
    for (const m of ZHIPU_FREE_MODELS) {
      expect(getModelPricingStatus('zhipu', m)).toBe('free')
    }
  })
})

describe('getModelPricingStatus（区分免费/有价/未知）', () => {
  it('本地后端（ollama/custom）恒为 free', () => {
    expect(getModelPricingStatus('ollama', 'any')).toBe('free')
    expect(getModelPricingStatus('custom', 'any')).toBe('free')
  })

  it('DeepSeek 任意模型视为 priced（未知模型回退默认价仍可估算）', () => {
    expect(getModelPricingStatus('deepseek', DEFAULT_MODEL)).toBe('priced')
    expect(getModelPricingStatus('deepseek', 'unknown-ds-model')).toBe('priced')
  })

  it('OpenAI/智谱 未配置价目的收费模型为 unknown（不再误判免费）', () => {
    expect(getModelPricingStatus('openai', 'unknown-model-xyz')).toBe('unknown')
    expect(getModelPricingStatus('zhipu', 'glm-unknown-paid')).toBe('unknown')
  })

  it('此前缺失定价的 gpt-5.3-codex 现已为 priced', () => {
    expect(getModelPricingStatus('openai', 'gpt-5.3-codex')).toBe('priced')
    expect(calcCostForProvider('openai', 'gpt-5.3-codex', sampleUsage)).toBeGreaterThan(0)
  })
})
