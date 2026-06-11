// DeepSeek 用量与成本计算。
// DeepSeek 的计费按 token 计，且区分“缓存命中（cache hit）”与“缓存未命中（cache miss）”
// 的输入价格（命中价远低于未命中）。本模块封装价格表与成本估算函数，供 /cost 命令、
// 状态栏成本展示与累计统计使用。价格为公开标准价（美元/百万 token），可能随官方调整。
// 制作人：Moriarty_Dox

import { DEFAULT_MODEL, PRO_MODEL } from '../constants.js'

// 单个模型的价格定义：每百万 token 的美元单价。
interface ModelPricing {
  // 输入命中缓存的单价（USD / 1M tokens）。
  inputCacheHit: number
  // 输入未命中缓存的单价（USD / 1M tokens）。
  inputCacheMiss: number
  // 输出 token 单价（USD / 1M tokens）。
  output: number
}

// 价格表（美元 / 每百万 token，参考 DeepSeek 官方公开价；如官方调价可在此集中维护）。
const PRICING: Record<string, ModelPricing> = {
  // deepseek-v4-flash：快速、经济，适合日常编程与高并发场景。
  [DEFAULT_MODEL]: {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
  // deepseek-v4-pro：推理与编码能力更强，单价更高（此处采用当前促销价）。
  [PRO_MODEL]: {
    inputCacheHit: 0.003625,
    inputCacheMiss: 0.435,
    output: 0.87,
  },
  // 旧版兼容别名：deepseek-chat / deepseek-reasoner 实际路由到 v4-flash，沿用其价格。
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

// DeepSeek 接口返回的用量结构（兼容 OpenAI usage 字段 + DeepSeek 扩展字段）。
export interface DeepSeekUsage {
  // 本次请求的总输入 token。
  prompt_tokens?: number
  // 本次请求的输出 token。
  completion_tokens?: number
  // 总 token。
  total_tokens?: number
  // DeepSeek 扩展：命中上下文缓存的输入 token 数。
  prompt_cache_hit_tokens?: number
  // DeepSeek 扩展：未命中缓存的输入 token 数。
  prompt_cache_miss_tokens?: number
}

// 累计用量统计（跨多轮请求聚合）。
export interface UsageTotals {
  // 累计输入 token。
  inputTokens: number
  // 累计输出 token。
  outputTokens: number
  // 累计缓存命中 token。
  cacheHitTokens: number
  // 累计成本（美元）。
  costUsd: number
}

/**
 * 创建空的累计用量对象。
 * @returns 各字段归零的 UsageTotals。
 */
export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, costUsd: 0 }
}

/**
 * 根据单次请求的 usage 计算本次成本（美元）。
 * 对输入区分缓存命中/未命中分别计价；若接口未返回拆分字段，则全部按未命中价估算。
 * @param model 使用的模型名称。
 * @param usage 接口返回的用量对象。
 * @returns 本次请求的成本（美元）。
 */
export function calcCost(model: string, usage: DeepSeekUsage): number {
  // 找不到对应模型价格时，回退到 deepseek-chat 价格，避免崩溃。
  const pricing = PRICING[model] ?? PRICING[DEFAULT_MODEL]

  const promptTokens = usage.prompt_tokens ?? 0
  // 优先使用 DeepSeek 返回的命中/未命中拆分；缺失时按“全部未命中”估算。
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  const cacheMiss =
    usage.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHit)
  const outputTokens = usage.completion_tokens ?? 0

  // 单价以百万 token 为单位，因此除以 1e6 换算。
  const cost =
    (cacheHit * pricing.inputCacheHit +
      cacheMiss * pricing.inputCacheMiss +
      outputTokens * pricing.output) /
    1_000_000

  return cost
}

/**
 * 将单次 usage 累加到累计统计对象上（原地返回新对象）。
 * @param totals 现有累计统计。
 * @param model 本次使用的模型。
 * @param usage 本次用量。
 * @returns 累加后的新的累计统计对象。
 */
export function accumulateUsage(
  totals: UsageTotals,
  model: string,
  usage: DeepSeekUsage,
): UsageTotals {
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  return {
    inputTokens: totals.inputTokens + (usage.prompt_tokens ?? 0),
    outputTokens: totals.outputTokens + (usage.completion_tokens ?? 0),
    cacheHitTokens: totals.cacheHitTokens + cacheHit,
    costUsd: totals.costUsd + calcCost(model, usage),
  }
}

/**
 * 将成本格式化为便于阅读的美元字符串。
 * 对极小金额使用更多小数位，避免显示成 $0.00。
 * @param costUsd 成本（美元）。
 * @returns 形如 "$0.0123" 的字符串。
 */
export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(2)}`
}
