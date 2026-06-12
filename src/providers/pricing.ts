// 多 Provider 用量与成本估算。
// 按 Provider + 模型选择价目；免费模型（智谱 Flash、Ollama 等）成本为 0，不再回退 DeepSeek 价。
// 制作人：Moriarty_Dox

import { DEFAULT_MODEL, PRO_MODEL } from '../constants.js'
import type { DeepSeekUsage } from '../deepseek/pricing.js'
import { OPENAI_CHAT_MODELS } from './openaiModels.js'
import type { ProviderId } from './types.js'
import { ZHIPU_FREE_MODELS, ZHIPU_PAID_MODELS } from './zhipuModels.js'

/** 单模型价格（美元 / 百万 token）。 */
interface ModelPricing {
  inputCacheHit: number
  inputCacheMiss: number
  output: number
}

/** DeepSeek 价目表。 */
const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  [DEFAULT_MODEL]: {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
  [PRO_MODEL]: {
    inputCacheHit: 0.003625,
    inputCacheMiss: 0.435,
    output: 0.87,
  },
  'deepseek-chat': {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
  'deepseek-reasoner': {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
}

/** OpenAI 简化价目（USD / 1M tokens，参考官方公开价）。 */
const OPENAI_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini': { inputCacheHit: 0.15, inputCacheMiss: 0.15, output: 0.6 },
  'gpt-4o': { inputCacheHit: 2.5, inputCacheMiss: 2.5, output: 10 },
  'gpt-4.1': { inputCacheHit: 2, inputCacheMiss: 2, output: 8 },
  'gpt-4.1-mini': { inputCacheHit: 0.4, inputCacheMiss: 0.4, output: 1.6 },
  'gpt-4.1-nano': { inputCacheHit: 0.1, inputCacheMiss: 0.1, output: 0.4 },
  'gpt-5.5': { inputCacheHit: 5, inputCacheMiss: 5, output: 30 },
  'gpt-5.5-pro': { inputCacheHit: 10, inputCacheMiss: 10, output: 60 },
  'gpt-5.4': { inputCacheHit: 2.5, inputCacheMiss: 2.5, output: 15 },
  'gpt-5.4-pro': { inputCacheHit: 5, inputCacheMiss: 5, output: 30 },
  'gpt-5.4-mini': { inputCacheHit: 0.75, inputCacheMiss: 0.75, output: 4.5 },
  'gpt-5.4-nano': { inputCacheHit: 0.2, inputCacheMiss: 0.2, output: 1.2 },
  'gpt-5': { inputCacheHit: 2.5, inputCacheMiss: 2.5, output: 10 },
  'gpt-5-mini': { inputCacheHit: 0.5, inputCacheMiss: 0.5, output: 2 },
  'gpt-5-nano': { inputCacheHit: 0.15, inputCacheMiss: 0.15, output: 0.6 },
  'gpt-5-pro': { inputCacheHit: 5, inputCacheMiss: 5, output: 20 },
  'gpt-5.2': { inputCacheHit: 3, inputCacheMiss: 3, output: 12 },
  'gpt-5.2-pro': { inputCacheHit: 6, inputCacheMiss: 6, output: 24 },
  'gpt-5.1': { inputCacheHit: 2.5, inputCacheMiss: 2.5, output: 10 },
  'gpt-5.1-mini': { inputCacheHit: 0.5, inputCacheMiss: 0.5, output: 2 },
  'o3': { inputCacheHit: 10, inputCacheMiss: 10, output: 40 },
  'o3-pro': { inputCacheHit: 20, inputCacheMiss: 20, output: 80 },
}

/** 智谱按量计费价目（USD / 1M tokens，参考 Z.AI 官方公开价）。 */
const ZHIPU_PRICING: Record<string, ModelPricing> = {
  'glm-5.1': { inputCacheHit: 0.26, inputCacheMiss: 1.4, output: 4.4 },
  'glm-5': { inputCacheHit: 0.2, inputCacheMiss: 1, output: 3.2 },
  'glm-5-turbo': { inputCacheHit: 0.24, inputCacheMiss: 1.2, output: 4 },
  'glm-4.7': { inputCacheHit: 0.11, inputCacheMiss: 0.6, output: 2.2 },
  'glm-4.6': { inputCacheHit: 0.11, inputCacheMiss: 0.6, output: 2.2 },
  'glm-4.5': { inputCacheHit: 0.11, inputCacheMiss: 0.6, output: 2.2 },
  'glm-4.5-x': { inputCacheHit: 0.45, inputCacheMiss: 2.2, output: 8.9 },
  'glm-4.5-air': { inputCacheHit: 0.03, inputCacheMiss: 0.2, output: 1.1 },
  'glm-4.5-airx': { inputCacheHit: 0.22, inputCacheMiss: 1.1, output: 4.5 },
  'glm-4.7-flashx': { inputCacheHit: 0.01, inputCacheMiss: 0.07, output: 0.4 },
  // FlashX 增强版，价位参考同档 FlashX。
  'glm-4-flashx-250414': { inputCacheHit: 0.01, inputCacheMiss: 0.07, output: 0.4 },
  // 超长上下文模型，官方未单列美元价，按 4.7 档估算。
  'glm-4-long': { inputCacheHit: 0.11, inputCacheMiss: 0.6, output: 2.2 },
}

/** 智谱免费模型集合。 */
const ZHIPU_FREE_MODEL_SET = new Set<string>(ZHIPU_FREE_MODELS)

/**
 * 判断该 Provider+模型 是否按免费计（成本恒为 0）。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @returns 免费返回 true。
 */
export function isFreeModelForProvider(providerId: ProviderId, model: string): boolean {
  if (providerId === 'ollama' || providerId === 'custom') return true
  if (providerId === 'zhipu') {
    return ZHIPU_FREE_MODEL_SET.has(model)
  }
  return false
}

/**
 * 按 token 用量与价目表计算单次请求成本（美元）。
 * @param pricing 价目。
 * @param usage 用量。
 * @returns 成本美元数。
 */
function calcCostFromPricing(pricing: ModelPricing, usage: DeepSeekUsage): number {
  const promptTokens = usage.prompt_tokens ?? 0
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  const cacheMiss = usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit)
  const outputTokens = usage.completion_tokens ?? 0
  return (
    (cacheHit * pricing.inputCacheHit +
      cacheMiss * pricing.inputCacheMiss +
      outputTokens * pricing.output) /
    1_000_000
  )
}

/**
 * 根据 Provider + 模型 + usage 计算单次请求成本（美元）。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @param usage 接口返回的用量。
 * @returns 成本（美元）；免费或未知 OpenAI 模型为 0。
 */
export function calcCostForProvider(
  providerId: ProviderId,
  model: string,
  usage: DeepSeekUsage,
): number {
  if (isFreeModelForProvider(providerId, model)) return 0

  if (providerId === 'deepseek') {
    const pricing = DEEPSEEK_PRICING[model] ?? DEEPSEEK_PRICING[DEFAULT_MODEL]
    return calcCostFromPricing(pricing, usage)
  }

  if (providerId === 'openai') {
    const pricing = OPENAI_PRICING[model]
    if (!pricing) return 0
    return calcCostFromPricing(pricing, usage)
  }

  if (providerId === 'zhipu') {
    const pricing = ZHIPU_PRICING[model]
    if (!pricing) return 0
    return calcCostFromPricing(pricing, usage)
  }

  return 0
}

/** 导出智谱已知收费模型列表（供测试断言）。 */
export const ZHIPU_PRICED_MODELS = [...ZHIPU_PAID_MODELS.filter((m) => m in ZHIPU_PRICING)]

/** 导出 OpenAI 已知模型列表（供测试断言）。 */
export const OPENAI_PRICED_MODELS = [...OPENAI_CHAT_MODELS.filter((m) => m in OPENAI_PRICING)]
