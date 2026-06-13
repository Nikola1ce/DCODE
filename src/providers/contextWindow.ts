// 各 Provider + 模型的上下文窗口大小（context window，单位：token）。
// 用于状态栏上下文进度条把「已用 / 总量」按模型真实窗口展示，而不是固定用压缩阈值。
// 数据来源为各家官方文档公开的最大上下文长度（截至 2026-06），未知模型回退到按 Provider 的保守缺省值。
// 制作人：Moriarty_Dox

import { DEFAULT_MODEL, PRO_MODEL } from '../constants.js'
import type { ProviderId } from './types.js'

// 常用上下文窗口刻度。
// 统一采用「十进制」口径（128K=128000）而非 2 的幂（131072），
// 这样状态栏以 k/m 显示时能与各厂商「128K / 200K / 400K / 1M」的官方标注完全一致，避免出现 131.1k 这类困惑值。
const K = 1000
const CTX_32K = 32 * K
const CTX_64K = 64 * K
const CTX_128K = 128 * K
const CTX_200K = 200 * K
const CTX_400K = 400 * K
const CTX_1M = 1000 * K

// 未知模型时，按 Provider 给出的保守缺省上下文窗口（避免进度条上限过大或过小失真）。
const PROVIDER_DEFAULT_CONTEXT: Record<ProviderId, number> = {
  deepseek: CTX_128K,
  openai: CTX_128K,
  zhipu: CTX_128K,
  ollama: CTX_32K,
  custom: CTX_32K,
}

// 所有 Provider 通用的兜底上下文窗口（连 Provider 缺省都取不到时使用）。
const FALLBACK_CONTEXT = CTX_64K

// DeepSeek 各模型上下文窗口。DeepSeek V4 系列官方为 128K；旧版 chat/reasoner 同为 128K。
const DEEPSEEK_CONTEXT: Record<string, number> = {
  [DEFAULT_MODEL]: CTX_128K,
  [PRO_MODEL]: CTX_128K,
  'deepseek-chat': CTX_128K,
  'deepseek-reasoner': CTX_128K,
}

// OpenAI 各模型上下文窗口。gpt-5 系列与 o3 为 400K；gpt-4.1 系列为 1M；gpt-4o 系列为 128K。
const OPENAI_CONTEXT: Record<string, number> = {
  'gpt-5.5': CTX_400K,
  'gpt-5.5-pro': CTX_400K,
  'gpt-5.4': CTX_400K,
  'gpt-5.4-pro': CTX_400K,
  'gpt-5.4-mini': CTX_400K,
  'gpt-5.4-nano': CTX_400K,
  'gpt-5.3-codex': CTX_400K,
  'gpt-5.2': CTX_400K,
  'gpt-5.2-pro': CTX_400K,
  'gpt-5.1': CTX_400K,
  'gpt-5.1-mini': CTX_400K,
  'gpt-5': CTX_400K,
  'gpt-5-mini': CTX_400K,
  'gpt-5-nano': CTX_400K,
  'gpt-5-pro': CTX_400K,
  o3: CTX_200K,
  'o3-pro': CTX_200K,
  'gpt-4.1': CTX_1M,
  'gpt-4.1-mini': CTX_1M,
  'gpt-4.1-nano': CTX_1M,
  'gpt-4o': CTX_128K,
  'gpt-4o-mini': CTX_128K,
}

// 智谱 GLM 各模型上下文窗口。GLM-5/4.7/4.6/4.5 系列为 200K；4-flash/4.5-air 系列为 128K；glm-4-long 为 1M。
const ZHIPU_CONTEXT: Record<string, number> = {
  'glm-5.1': CTX_200K,
  'glm-5': CTX_200K,
  'glm-5-turbo': CTX_200K,
  'glm-4.7': CTX_200K,
  'glm-4.7-flash': CTX_200K,
  'glm-4.7-flashx': CTX_200K,
  'glm-4.6': CTX_200K,
  'glm-4.5': CTX_200K,
  'glm-4.5-x': CTX_200K,
  'glm-5-air': CTX_200K,
  'glm-4-flash': CTX_128K,
  'glm-4.5-air': CTX_128K,
  'glm-4.5-airx': CTX_128K,
  'glm-4-flashx-250414': CTX_128K,
  'glm-4-long': CTX_1M,
}

/**
 * 在给定的「模型→窗口」表中按精确名与小写名两种方式查表。
 * 兼容用户输入大小写不一致的模型名（如 O3、GPT-4O）。
 * @param table 模型上下文窗口表。
 * @param model 模型名。
 * @returns 命中的窗口 token 数；未命中返回 undefined。
 */
function lookup(table: Record<string, number>, model: string): number | undefined {
  if (model in table) return table[model]
  const lower = model.toLowerCase()
  if (lower in table) return table[lower]
  return undefined
}

/**
 * 返回指定 Provider + 模型的上下文窗口大小（token 数），用于状态栏进度条上限。
 * 优先精确匹配模型；未知模型回退到该 Provider 的保守缺省值，再回退到全局兜底值。
 * @param providerId Provider 标识（deepseek / openai / zhipu / ollama / custom）。
 * @param model 模型名（可能为空或大小写不规范）。
 * @returns 上下文窗口 token 数（恒为正整数）。
 */
export function getModelContextWindow(providerId: ProviderId, model: string): number {
  const trimmed = (model ?? '').trim()

  let hit: number | undefined
  if (trimmed) {
    if (providerId === 'deepseek') hit = lookup(DEEPSEEK_CONTEXT, trimmed)
    else if (providerId === 'openai') hit = lookup(OPENAI_CONTEXT, trimmed)
    else if (providerId === 'zhipu') hit = lookup(ZHIPU_CONTEXT, trimmed)
  }

  if (hit && hit > 0) return hit

  return PROVIDER_DEFAULT_CONTEXT[providerId] ?? FALLBACK_CONTEXT
}
