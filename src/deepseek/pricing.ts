// DeepSeek 用量与成本计算。
// DeepSeek 的计费按 token 计，且区分“缓存命中（cache hit）”与“缓存未命中（cache miss）”
// 的输入价格（命中价远低于未命中）。本模块封装价格表与成本估算函数，供 /cost 命令、
// 状态栏成本展示与累计统计使用。多 Provider 场景委托 providers/pricing.ts。
// 制作人：Moriarty_Dox

import type { ProviderId } from '../providers/types.js'
import { calcCostForProvider } from '../providers/pricing.js'

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
 * @param model 使用的模型名称。
 * @param usage 接口返回的用量对象。
 * @param providerId Provider 标识（默认 deepseek，兼容旧调用）。
 * @returns 本次请求的成本（美元）。
 */
export function calcCost(
  model: string,
  usage: DeepSeekUsage,
  providerId: ProviderId = 'deepseek',
): number {
  return calcCostForProvider(providerId, model, usage)
}

/**
 * 将单次 usage 累加到累计统计对象上（原地返回新对象）。
 * @param totals 现有累计统计。
 * @param model 本次使用的模型。
 * @param usage 本次用量。
 * @param providerId Provider 标识（默认 deepseek）。
 * @returns 累加后的新的累计统计对象。
 */
export function accumulateUsage(
  totals: UsageTotals,
  model: string,
  usage: DeepSeekUsage,
  providerId: ProviderId = 'deepseek',
): UsageTotals {
  const cacheHit = usage.prompt_cache_hit_tokens ?? 0
  return {
    inputTokens: totals.inputTokens + (usage.prompt_tokens ?? 0),
    outputTokens: totals.outputTokens + (usage.completion_tokens ?? 0),
    cacheHitTokens: totals.cacheHitTokens + cacheHit,
    costUsd: totals.costUsd + calcCostForProvider(providerId, model, usage),
  }
}

/**
 * 将成本格式化为便于阅读的字符串。
 * 零成本显示「免费」；极小金额使用更多小数位。
 * @param costUsd 成本（美元）。
 * @returns 形如 "免费" 或 "$0.0123" 的字符串。
 */
export function formatCost(costUsd: number): string {
  if (costUsd === 0) return '免费'
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`
  return `$${costUsd.toFixed(2)}`
}
