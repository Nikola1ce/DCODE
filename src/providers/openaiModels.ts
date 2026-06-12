// OpenAI Chat Completions 官方模型清单。
// 仅收录 OpenAI 文档中当前对外提供、未标记 Deprecated 的文本对话模型；
// 不含历史快照 id（如 gpt-4-0613）与已下线型号。
// 制作人：Moriarty_Dox

/**
 * 当前可用的 OpenAI Chat Completions 模型（按推荐优先级排序）。
 * 来源：https://developers.openai.com/api/docs/models （2026-06，排除 Deprecated）。
 */
export const OPENAI_CHAT_MODELS: readonly string[] = [
  // —— 前沿 GPT-5.5 / 5.4 ——
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-pro',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  // —— GPT-5 系列 ——
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.2-pro',
  'gpt-5.1',
  'gpt-5.1-mini',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5-pro',
  // —— o 系列推理 ——
  'o3-pro',
  'o3',
  // —— GPT-4.1 / 4o ——
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4o-mini',
] as const

/** 主要模型的简短说明。 */
const OPENAI_MODEL_HINTS: Readonly<Record<string, string>> = {
  'gpt-5.5': '前沿 · 复杂推理与编码',
  'gpt-5.5-pro': '前沿 Pro · 更强精度',
  'gpt-5.4': '前沿 · 专业工作',
  'gpt-5.4-pro': '前沿 Pro · 高难度任务',
  'gpt-5.4-mini': 'GPT-5.4 级 · 高性价比',
  'gpt-5.4-nano': 'GPT-5.4 级 · 极速低成本',
  'gpt-5.3-codex': 'Agentic 编码',
  'gpt-5.2': '上一代前沿',
  'gpt-5.2-pro': '上一代 Pro',
  'gpt-5.1': '编码与 Agent · 可调推理',
  'gpt-5.1-mini': '5.1 轻量',
  'gpt-5': 'GPT-5 旗舰',
  'gpt-5-mini': 'GPT-5 轻量',
  'gpt-5-nano': 'GPT-5 极速',
  'gpt-5-pro': 'GPT-5 Pro',
  'o3-pro': 'o 系列 Pro · 强推理',
  o3: 'o 系列 · 强推理',
  'gpt-4.1': 'GPT-4.1 旗舰',
  'gpt-4.1-mini': 'GPT-4.1 轻量',
  'gpt-4o-mini': '多模态 · 经济默认',
}

/**
 * 判断 OpenAI 模型是否允许自定义 temperature（非 API 默认值 1）。
 * GPT-5+ 前沿模型与 o 系列推理模型传 temperature=0.2 会返回 400。
 * @param modelId 模型 id。
 * @returns 允许自定义返回 true。
 */
export function openaiModelSupportsCustomTemperature(modelId: string): boolean {
  const id = modelId.toLowerCase()
  // o 系列推理模型。
  if (/^o\d/.test(id) || id.startsWith('o1') || id.startsWith('o3')) return false
  // GPT-5 及更新前沿系列（含 gpt-5.5、gpt-5.4-mini 等）。
  if (/^gpt-5(\.|$|-)/.test(id)) return false
  // Codex 专用模型。
  if (id.includes('codex')) return false
  return true
}

/**
 * 返回 OpenAI 模型在 /model 菜单中的 hint 文案。
 * @param modelId 模型 id。
 * @param defaultModelId 当前 Provider 默认模型（DCODE 配置默认）。
 * @returns hint 或 undefined。
 */
export function getOpenAIModelHint(modelId: string, defaultModelId: string): string | undefined {
  if (modelId === defaultModelId) return 'DCODE 默认 · 推荐'
  return OPENAI_MODEL_HINTS[modelId]
}
