// 智谱 AI Chat Completions 官方模型清单（免费 + 按量计费）。
// 供 /model 选择器、命令补全、Provider 状态展示与成本估算复用。
// 模型 id 与定价参考：https://docs.bigmodel.cn/cn/guide/start/model-overview
// 制作人：Moriarty_Dox

import { DEFAULT_ZHIPU_MODEL } from '../constants.js'

/** 免费模型在 UI 中的醒目标记（选择器 label 前缀与 hint 共用）。 */
export const ZHIPU_FREE_MODEL_BADGE = '★ 永久免费'

/**
 * 智谱永久免费对话模型（按推荐优先级排序）。
 */
export const ZHIPU_FREE_MODELS: readonly string[] = [
  DEFAULT_ZHIPU_MODEL,
  'glm-4.7-flash',
] as const

/**
 * 智谱按量计费对话模型（按推荐优先级排序：旗舰 → 高性价比）。
 */
export const ZHIPU_PAID_MODELS: readonly string[] = [
  'glm-5.1',
  'glm-5',
  'glm-5-turbo',
  'glm-4.7',
  'glm-4.6',
  'glm-4.5-air',
  'glm-4.5-airx',
  'glm-4.7-flashx',
  'glm-4-flashx-250414',
  'glm-4-long',
  'glm-4.5',
  'glm-4.5-x',
] as const

/**
 * 智谱 AI 全部可选 Chat 模型（免费在前，收费在后）。
 */
export const ZHIPU_CHAT_MODELS: readonly string[] = [
  ...ZHIPU_FREE_MODELS,
  ...ZHIPU_PAID_MODELS,
] as const

/** 主要模型的简短说明（/model 菜单 hint，免费项均带 ★ 标记）。 */
const ZHIPU_MODEL_HINTS: Readonly<Record<string, string>> = {
  'glm-4-flash': `${ZHIPU_FREE_MODEL_BADGE} · 128K · 工具调用`,
  'glm-4.7-flash': `${ZHIPU_FREE_MODEL_BADGE} · 200K · 编程更强`,
  'glm-5.1': '按量计费 · 旗舰 · 200K · Coding 对齐 Opus 4.6',
  'glm-5': '按量计费 · 高智能 · 200K · Agent 长程规划',
  'glm-5-turbo': '按量计费 · 旗舰增强 · 200K · 复杂长任务',
  'glm-4.7': '按量计费 · 高智能 · 200K · 推理与编程',
  'glm-4.6': '按量计费 · 超强性能 · 200K · 工具调用',
  'glm-4.5-air': '按量计费 · 高性价比 · 128K · 推理编码',
  'glm-4.5-airx': '按量计费 · 高性价比极速 · 128K',
  'glm-4.7-flashx': '按量计费 · 轻量高速 · 200K · 低价',
  'glm-4-flashx-250414': '按量计费 · Flash 增强 · 128K · 高并发',
  'glm-4-long': '按量计费 · 超长输入 · 1M 上下文',
  'glm-4.5': '按量计费 · 旗舰上一代 · 200K',
  'glm-4.5-x': '按量计费 · 旗舰上一代极速 · 200K',
}

/**
 * 判断是否为智谱永久免费模型。
 * @param modelId 模型 id。
 * @returns 免费模型返回 true。
 */
export function isZhipuFreeModel(modelId: string): boolean {
  return ZHIPU_FREE_MODELS.includes(modelId)
}

/**
 * 返回智谱免费模型在选择器中的 label（带 ★ 前缀）。
 * @param modelId 模型 id。
 * @returns 带标记的展示名。
 */
export function formatZhipuModelLabel(modelId: string): string {
  return isZhipuFreeModel(modelId) ? `★ ${modelId}` : modelId
}

/**
 * 返回智谱模型在 /model 菜单中的 hint 文案。
 * @param modelId 模型 id。
 * @param defaultModelId 当前 Provider 默认模型（DCODE 配置默认）。
 * @returns hint 或 undefined。
 */
export function getZhipuModelHint(modelId: string, defaultModelId: string): string | undefined {
  if (modelId === defaultModelId && isZhipuFreeModel(modelId)) {
    return `★ DCODE 默认 · 永久免费`
  }
  const hint = ZHIPU_MODEL_HINTS[modelId]
  if (hint) return hint
  if (ZHIPU_PAID_MODELS.includes(modelId)) return '按量计费'
  return undefined
}
