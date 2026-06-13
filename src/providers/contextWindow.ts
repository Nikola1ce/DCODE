// 各 Provider + 模型的上下文窗口大小（context window，单位：token）。
// 用于：
//   1) 状态栏上下文进度条把「已用 / 总量」按模型真实窗口展示，而不是固定用压缩阈值；
//   2) 自动压缩阈值 = 当前生效上下文窗口 × COMPACT_THRESHOLD_RATIO（不再用固定常量，随模型切换）。
// 数据来源为各家官方文档公开的最大上下文长度（截至 2026-06），未知模型回退到按 Provider 的保守缺省值。
//
// 「多档上下文长度」说明：少数模型/后端允许在多个上下文上限之间选择
//   - 本地 Ollama：num_ctx 可由用户按显存自由设定（这里给出常见档位供选择）；
//   - 自定义 OpenAI 兼容后端：上限因部署而异，给出常见档位；
//   - 个别云端模型也提供长短两档（如智谱 glm-4-long）。
// 对这类模型，getModelContextOptions 返回「多个候选档位」，UI 可让用户选择；
// 其余绝大多数模型只有官方单一最大值（候选列表只含一项）。
// 用户选定的档位通过 config.modelContextOverrides 持久化，并由 resolveContextWindow 解析为最终生效值。
// 制作人：Moriarty_Dox

import { COMPACT_THRESHOLD_RATIO, DEFAULT_MODEL, PRO_MODEL } from '../constants.js'
import type { ProviderId } from './types.js'

// 常用上下文窗口刻度。
// 统一采用「十进制」口径（128K=128000）而非 2 的幂（131072），
// 这样状态栏以 k/m 显示时能与各厂商「128K / 200K / 400K / 1M」的官方标注完全一致，避免出现 131.1k 这类困惑值。
const K = 1000
const CTX_8K = 8 * K
const CTX_16K = 16 * K
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

// —— 多档上下文长度（同一模型可选多个上限）—— //
// 仅对「允许用户选择上下文上限」的模型/后端登记多档候选；其余模型无需登记（候选=单一最大值）。
// 约定：登记的数组应包含该模型的「最大档」（与上面的窗口表一致），其余为更小的可选档位。
// 值会在 getModelContextOptions 中统一去重、升序、过滤掉超过最大档的项。
const DEEPSEEK_OPTIONS: Record<string, number[]> = {}

const OPENAI_OPTIONS: Record<string, number[]> = {}

// 智谱 glm-4-long 支持超长上下文，但实际任务未必都需要 1M；给出长短两档便于按需选择、并据此设定压缩阈值。
const ZHIPU_OPTIONS: Record<string, number[]> = {
  'glm-4-long': [CTX_128K, CTX_200K, CTX_1M],
}

// 本地 Ollama：上下文上限取决于模型与本机显存，num_ctx 可自由设定。给出一组常见档位供选择。
// 未在表中的 Ollama 模型回退到通用档位（见 GENERIC_LOCAL_OPTIONS）。
const OLLAMA_OPTIONS: Record<string, number[]> = {}

// Ollama / custom 等「上限因部署而异」的后端通用候选档位（升序）。
const GENERIC_LOCAL_OPTIONS = [CTX_8K, CTX_16K, CTX_32K, CTX_64K, CTX_128K]

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
 * 在「模型→候选档位数组」表中按精确名与小写名查表。
 * @param table 多档候选表。
 * @param model 模型名。
 * @returns 命中的候选数组；未命中返回 undefined。
 */
function lookupOptions(
  table: Record<string, number[]>,
  model: string,
): number[] | undefined {
  if (model in table) return table[model]
  const lower = model.toLowerCase()
  if (lower in table) return table[lower]
  return undefined
}

/**
 * 返回指定 Provider + 模型的「最大/默认」上下文窗口大小（token 数）。
 * 即该模型官方公布的最大上下文长度；用作进度条上限缺省与多档候选的上界。
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

/**
 * 返回指定 Provider + 模型可供选择的「最大上下文长度」候选档位列表（升序、去重）。
 * - 多档模型/后端（如智谱 glm-4-long、本地 Ollama、自定义后端）返回多个候选，UI 可让用户选择；
 * - 其余绝大多数模型只返回单一官方最大值（列表长度为 1）。
 * 所有候选都会被裁剪到不超过该模型的最大窗口（getModelContextWindow），并确保至少包含最大档本身。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @returns 升序去重的候选档位数组（至少含 1 项，恒为正整数）。
 */
export function getModelContextOptions(providerId: ProviderId, model: string): number[] {
  const trimmed = (model ?? '').trim()
  const maxWindow = getModelContextWindow(providerId, model)

  // 1) 先取该模型显式登记的候选；2) 否则对「上限因部署而异」的本地/自定义后端给通用档位；3) 再否则只有最大档一项。
  let raw: number[] | undefined
  if (trimmed) {
    if (providerId === 'deepseek') raw = lookupOptions(DEEPSEEK_OPTIONS, trimmed)
    else if (providerId === 'openai') raw = lookupOptions(OPENAI_OPTIONS, trimmed)
    else if (providerId === 'zhipu') raw = lookupOptions(ZHIPU_OPTIONS, trimmed)
    else if (providerId === 'ollama') raw = lookupOptions(OLLAMA_OPTIONS, trimmed)
  }
  if (!raw && (providerId === 'ollama' || providerId === 'custom')) {
    raw = GENERIC_LOCAL_OPTIONS
  }

  // 合并最大档，统一去重 + 过滤非法/超过最大档的值 + 升序。
  const merged = new Set<number>([maxWindow])
  for (const v of raw ?? []) {
    if (Number.isFinite(v) && v > 0 && v <= maxWindow) merged.add(Math.floor(v))
  }
  return [...merged].sort((a, b) => a - b)
}

/**
 * 判断指定模型是否提供「多个」上下文长度档位（即值得向用户展示选择项）。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @returns 候选档位多于 1 个时返回 true。
 */
export function modelHasContextChoices(providerId: ProviderId, model: string): boolean {
  return getModelContextOptions(providerId, model).length > 1
}

/**
 * 解析「当前生效」的最大上下文长度（token）。
 * 规则：若用户为该 provider+model 选过档位且该档位仍是合法候选，则用用户选择；否则用模型默认（最大）窗口。
 * 这样既尊重用户选择，又能在模型切换 / 候选变化后自动回退到安全值。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @param overrides 用户持久化的「provider:model → 选定窗口」映射（config.modelContextOverrides）。
 * @returns 生效的上下文窗口 token 数（恒为正整数）。
 */
export function resolveContextWindow(
  providerId: ProviderId,
  model: string,
  overrides?: Record<string, number>,
): number {
  const fallback = getModelContextWindow(providerId, model)
  const key = contextOverrideKey(providerId, model)
  const chosen = overrides?.[key]
  if (typeof chosen === 'number' && chosen > 0) {
    // 仅当用户选择仍是当前模型的合法候选时才采用，避免模型变更后沿用失效档位。
    const options = getModelContextOptions(providerId, model)
    if (options.includes(chosen)) return chosen
  }
  return fallback
}

/**
 * 生成 modelContextOverrides 的存储键：统一为「providerId:小写模型名」。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @returns 存储键字符串。
 */
export function contextOverrideKey(providerId: ProviderId, model: string): string {
  return `${providerId}:${(model ?? '').trim().toLowerCase()}`
}

/**
 * 根据「当前生效的最大上下文长度」计算自动压缩触发阈值。
 * 阈值 = floor(contextWindow × COMPACT_THRESHOLD_RATIO)，预留约 10% 余量给本轮新输出与摘要生成。
 * @param contextWindow 当前生效的上下文窗口 token 数。
 * @returns 压缩触发阈值（token 数，正整数）。
 */
export function getCompactThreshold(contextWindow: number): number {
  const safe = contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT
  return Math.max(1, Math.floor(safe * COMPACT_THRESHOLD_RATIO))
}

/**
 * 把上下文窗口 token 数格式化为简洁档位标签（如 8000→"8K"、128000→"128K"、1000000→"1M"）。
 * 用于 /model context 列表与选择器展示，与各厂商标注口径（K/M，1000 进制）一致。
 * @param n token 数。
 * @returns 形如 "128K" / "1M" 的标签。
 */
export function formatContextWindowLabel(n: number): string {
  const v = Math.max(0, Math.floor(n))
  if (v >= 1_000_000 && v % 1_000_000 === 0) return `${v / 1_000_000}M`
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (v >= 1000) return `${Math.round(v / 1000)}K`
  return String(v)
}

/**
 * 解析用户输入的上下文长度（支持 "128k" / "128K" / "1m" / 纯数字 "128000"）。
 * 仅用于 /model context <值> 的参数解析；非法输入返回 undefined。
 * @param raw 原始输入字符串。
 * @returns 解析出的 token 数（正整数）；非法返回 undefined。
 */
export function parseContextWindowInput(raw: string): number | undefined {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return undefined
  const m = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(s)
  if (!m) return undefined
  const num = Number.parseFloat(m[1])
  if (!Number.isFinite(num) || num <= 0) return undefined
  const unit = m[2]
  const mult = unit === 'm' ? 1_000_000 : unit === 'k' ? 1000 : 1
  return Math.floor(num * mult)
}

/**
 * 为「刚切换到的模型」生成一句上下文档位提示，引导用户按需选择最大上下文长度。
 * 设计目的：当目标模型支持多档上下文（如智谱 glm-4-long、本地 Ollama）时，用户切换后
 * 往往不知道还能调小窗口以更早触发压缩 / 控制成本；这里在切换成功消息后追加一行引导。
 * - 多档模型：返回「当前窗口 + 可选档位 + /model context 用法」一行提示；
 * - 单档模型：返回 undefined（无需打扰，窗口固定）。
 * @param providerId Provider 标识。
 * @param model 模型名。
 * @param overrides 用户持久化的档位选择（用于显示当前生效窗口）。
 * @returns 提示文本；单档模型返回 undefined。
 */
export function renderModelSwitchContextHint(
  providerId: ProviderId,
  model: string,
  overrides?: Record<string, number>,
): string | undefined {
  const options = getModelContextOptions(providerId, model)
  if (options.length <= 1) return undefined
  const current = resolveContextWindow(providerId, model, overrides)
  const labels = options.map((o) => formatContextWindowLabel(o)).join(' / ')
  return (
    `该模型支持多档最大上下文长度（${labels}），当前 ${formatContextWindowLabel(current)}。\n` +
    `可用 /model context <档位> 调整（影响自动压缩阈值＝窗口×90%）。`
  )
}
