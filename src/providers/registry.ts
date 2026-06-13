// Provider 注册表与配置解析。
// 管理 deepseek / openai / ollama / custom 等 OpenAI 兼容后端，
// 解析 baseURL、apiKey 与切换 Provider 时的配置补丁。
// 制作人：Moriarty_Dox

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODEL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_CUSTOM_API_KEY,
  ENV_OLLAMA_API_KEY,
  ENV_OLLAMA_BASE_URL,
  ENV_OPENAI_API_KEY,
  ENV_OPENAI_BASE_URL,
  ENV_PROVIDER,
  ENV_ZHIPU_API_KEY,
  ENV_ZHIPU_BASE_URL,
  isSupportedModelName,
  PRO_MODEL,
} from '../constants.js'
import type { DCodeConfig } from '../config.js'
import type { ProviderDefinition, ProviderId, ProviderOverrides } from './types.js'
import { OPENAI_CHAT_MODELS, getOpenAIModelHint } from './openaiModels.js'
import { ZHIPU_CHAT_MODELS, formatZhipuModelLabel, getZhipuModelHint } from './zhipuModels.js'
import { renderProxyHint } from './proxy.js'
import { modelHasContextChoices } from './contextWindow.js'

// 多档上下文模型在选择器右侧 hint 追加的标记，提示用户切换后可用 /model context 调整窗口。
const MULTI_CONTEXT_BADGE = '· 多档上下文'

/** 当前可在 UI 中切换的 Provider 列表。 */
export const PROVIDER_SWITCH_OPTIONS: Array<{ id: ProviderId; description: string }> = [
  { id: 'zhipu', description: '切换到智谱AI（免费）' },
  { id: 'deepseek', description: '切换到 DeepSeek' },
  { id: 'openai', description: '切换到 OpenAI' },
]

/** provider 命令名，用于输入 /p … /provider 时的前缀补全。 */
export const PROVIDER_COMMAND_NAME = 'provider'

/** 内置 Provider 定义表。 */
export const BUILTIN_PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    defaultBaseURL: DEFAULT_BASE_URL,
    defaultModel: DEFAULT_MODEL,
    apiKeyEnv: ENV_API_KEY,
    supportsThinking: true,
    requiresApiKey: true,
    suggestedModels: [DEFAULT_MODEL, PRO_MODEL],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    apiKeyEnv: ENV_OPENAI_API_KEY,
    supportsThinking: false,
    requiresApiKey: true,
    suggestedModels: [...OPENAI_CHAT_MODELS],
  },
  zhipu: {
    id: 'zhipu',
    name: '智谱AI',
    defaultBaseURL: DEFAULT_ZHIPU_BASE_URL,
    defaultModel: DEFAULT_ZHIPU_MODEL,
    apiKeyEnv: ENV_ZHIPU_API_KEY,
    supportsThinking: false,
    requiresApiKey: true,
    suggestedModels: [...ZHIPU_CHAT_MODELS],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama（本地）',
    defaultBaseURL: 'http://127.0.0.1:11434/v1',
    defaultModel: 'llama3.2',
    apiKeyEnv: ENV_OLLAMA_API_KEY,
    supportsThinking: false,
    requiresApiKey: false,
    suggestedModels: ['llama3.2', 'qwen2.5-coder', 'deepseek-r1'],
  },
  custom: {
    id: 'custom',
    name: '自定义 OpenAI 兼容',
    defaultBaseURL: 'http://127.0.0.1:8080/v1',
    defaultModel: 'default',
    apiKeyEnv: ENV_CUSTOM_API_KEY,
    supportsThinking: false,
    requiresApiKey: true,
  },
}

/**
 * 返回 Provider 定义；未知 id 回退 custom。
 * @param id Provider 标识。
 * @returns ProviderDefinition。
 */
export function getProviderDefinition(id: ProviderId): ProviderDefinition {
  return BUILTIN_PROVIDERS[id] ?? BUILTIN_PROVIDERS.custom
}

/**
 * 判断字符串是否为合法 ProviderId。
 * @param value 待校验字符串。
 * @returns 合法返回 true。
 */
export function isValidProviderId(value: string): value is ProviderId {
  return value in BUILTIN_PROVIDERS
}

/**
 * 获取当前生效的 Provider id（默认 zhipu）。
 * @param config 配置对象。
 * @returns ProviderId。
 */
export function getActiveProviderId(config: DCodeConfig): ProviderId {
  const id = config.provider ?? 'zhipu'
  return isValidProviderId(id) ? id : 'zhipu'
}

/**
 * 当前 Provider 是否支持 thinking 扩展字段。
 * @param config 配置对象。
 * @returns 支持返回 true。
 */
export function providerSupportsThinking(config: DCodeConfig): boolean {
  return getProviderDefinition(getActiveProviderId(config)).supportsThinking
}

/**
 * 读取 Provider 级覆盖配置。
 * @param config 配置对象。
 * @param id Provider 标识。
 * @returns 覆盖项或空对象。
 */
export function getProviderOverrides(
  config: DCodeConfig,
  id: ProviderId,
): ProviderOverrides {
  return config.providers?.[id] ?? {}
}

/**
 * 解析当前 Provider 的 API Key（环境变量 > providers 覆盖 > 旧版 config.apiKey）。
 * @param config 配置对象。
 * @returns API Key；Ollama 无 Key 时返回占位符 ollama。
 */
export function resolveProviderApiKey(config: DCodeConfig): string | undefined {
  const id = getActiveProviderId(config)
  const def = getProviderDefinition(id)
  const envVal = process.env[def.apiKeyEnv]
  if (envVal) return envVal

  const override = getProviderOverrides(config, id).apiKey
  if (override) return override

  // 兼容旧配置：deepseek 使用顶层 apiKey。
  if (id === 'deepseek' && config.apiKey) return config.apiKey

  if (!def.requiresApiKey) return 'ollama'

  return undefined
}

/**
 * 解析当前 Provider 的 baseURL。
 * @param config 配置对象。
 * @returns API 基础地址。
 */
export function resolveProviderBaseURL(config: DCodeConfig): string {
  const id = getActiveProviderId(config)

  // DEEPSEEK_BASE_URL 仅作用于 deepseek Provider，避免切换智谱/OpenAI 后仍指向 DeepSeek。
  if (process.env[ENV_BASE_URL] && id === 'deepseek') {
    return process.env[ENV_BASE_URL]
  }

  const def = getProviderDefinition(id)
  const override = getProviderOverrides(config, id).baseURL
  if (override) return override

  // Provider 专属环境变量。
  if (id === 'openai' && process.env[ENV_OPENAI_BASE_URL]) {
    return process.env[ENV_OPENAI_BASE_URL]
  }
  if (id === 'zhipu' && process.env[ENV_ZHIPU_BASE_URL]) {
    return process.env[ENV_ZHIPU_BASE_URL]
  }
  if (id === 'ollama' && process.env[ENV_OLLAMA_BASE_URL]) {
    return process.env[ENV_OLLAMA_BASE_URL]
  }

  // 顶层 baseURL：若仍是其它 Provider 的默认端点，视为未切换的残留配置，忽略。
  if (config.baseURL) {
    const isStaleOtherDefault = Object.values(BUILTIN_PROVIDERS).some(
      (p) => p.id !== id && p.defaultBaseURL === config.baseURL,
    )
    if (!isStaleOtherDefault) return config.baseURL
  }

  return def.defaultBaseURL
}

/**
 * 判断模型名对当前 Provider 是否允许。
 * @param model 模型名。
 * @param config 配置对象。
 * @returns 允许返回 true。
 */
export function isModelAllowedForProvider(model: string, config: DCodeConfig): boolean {
  const trimmed = model.trim()
  if (!trimmed) return false
  const id = getActiveProviderId(config)
  if (id === 'deepseek') return isSupportedModelName(trimmed)
  // 其它 Provider：非空即可；若 suggestedModels 存在且用户严格匹配可选校验——此处放宽。
  return trimmed.length <= 128
}

/** 模型选择器单项（供 /model 交互菜单与补全复用）。 */
export interface ModelSelectOption {
  label: string
  value: string
  hint?: string
}

/**
 * 返回当前 Provider 的建议模型名列表（/model 补全与选择器数据源）。
 * @param config 配置对象。
 * @returns 模型 id 数组；无 suggestedModels 时回退 defaultModel。
 */
export function getSuggestedModelsForProvider(config: DCodeConfig): string[] {
  const def = getProviderDefinition(getActiveProviderId(config))
  if (def.suggestedModels && def.suggestedModels.length > 0) {
    return [...def.suggestedModels]
  }
  return [def.defaultModel]
}

/**
 * 构建 /model 交互选择器的选项（含右侧 hint 文案）。
 * @param config 配置对象。
 * @returns Select 组件可用的选项列表。
 */
export function getModelSelectOptions(config: DCodeConfig): ModelSelectOption[] {
  const id = getActiveProviderId(config)
  const def = getProviderDefinition(id)
  const models = getSuggestedModelsForProvider(config)

  // 为多档上下文模型在 hint 末尾追加「· 多档上下文」标记，提示切换后可 /model context 调整。
  const withContextBadge = (model: string, hint?: string): string | undefined => {
    if (!modelHasContextChoices(id, model)) return hint
    return hint ? `${hint} ${MULTI_CONTEXT_BADGE}` : MULTI_CONTEXT_BADGE.replace(/^· /, '')
  }

  if (id === 'deepseek') {
    return models.map((m) => ({
      label: m,
      value: m,
      hint: withContextBadge(m, m === PRO_MODEL ? '高级模型 · 推理/编码更强' : '默认 · 快速且经济'),
    }))
  }

  if (id === 'zhipu') {
    return models.map((m) => ({
      label: formatZhipuModelLabel(m),
      value: m,
      hint: withContextBadge(m, getZhipuModelHint(m, def.defaultModel)),
    }))
  }

  return models.map((m) => ({
    label: m,
    value: m,
    hint: withContextBadge(m, getOpenAIModelHint(m, def.defaultModel)),
  }))
}

/**
 * 判断模型是否属于某 Provider 的建议/内置模型目录。
 * 用于切换 Provider 时决定是否保留当前 model。
 * @param model 模型名。
 * @param providerId Provider 标识。
 * @returns 属于该 Provider 目录返回 true。
 */
export function isModelInProviderCatalog(model: string, providerId: ProviderId): boolean {
  const trimmed = model.trim()
  if (!trimmed) return false
  const def = getProviderDefinition(providerId)
  if (providerId === 'deepseek') return isSupportedModelName(trimmed)
  if (def.suggestedModels && def.suggestedModels.length > 0) {
    return def.suggestedModels.includes(trimmed)
  }
  return true
}

/**
 * 切换 Provider 时生成配置补丁（含 baseURL、provider、必要时切换默认模型）。
 * @param config 当前配置。
 * @param target Provider 目标 id。
 * @returns 配置补丁。
 */
export function buildProviderSwitchPatch(
  config: DCodeConfig,
  target: ProviderId,
): Partial<DCodeConfig> {
  const def = getProviderDefinition(target)
  const override = getProviderOverrides(config, target)
  const baseURL = override.baseURL ?? def.defaultBaseURL
  const defaultModel = override.defaultModel ?? def.defaultModel

  const patch: Partial<DCodeConfig> = {
    provider: target,
    baseURL,
  }

  // 当前模型不属于目标 Provider 目录时，改用目标默认模型（如 zhipu→openai）。
  if (!isModelInProviderCatalog(config.model, target)) {
    patch.model = defaultModel
  }

  return patch
}

/** 各 Provider 的 Key 获取页面（用于 /login 提示）。 */
const PROVIDER_KEY_PLATFORM_URL: Partial<Record<ProviderId, string>> = {
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  deepseek: 'https://platform.deepseek.com',
  openai: 'https://platform.openai.com/api-keys',
}

/**
 * 获取 /login 弹窗展示的 Provider 元信息。
 * @param id Provider 标识。
 * @returns 标题、平台链接、端点与环境变量名。
 */
export function getProviderLoginMeta(id: ProviderId): {
  providerId: ProviderId
  providerName: string
  platformUrl: string
  baseURL: string
  apiKeyEnv: string
} {
  const def = getProviderDefinition(id)
  return {
    providerId: id,
    providerName: def.name,
    platformUrl: PROVIDER_KEY_PLATFORM_URL[id] ?? '',
    baseURL: def.defaultBaseURL,
    apiKeyEnv: def.apiKeyEnv,
  }
}

/**
 * 构建 /login 保存 API Key 的配置补丁（写入 providers[id].apiKey，各 Provider 独立保留）。
 * @param config 当前配置。
 * @param providerId 目标 Provider。
 * @param apiKey 用户输入的 Key。
 * @returns 可传给 updateConfig / applyConfig 的补丁。
 */
export function buildProviderLoginPatch(
  config: DCodeConfig,
  providerId: ProviderId,
  apiKey: string,
): Partial<DCodeConfig> {
  const providers: Partial<Record<ProviderId, ProviderOverrides>> = {
    ...config.providers,
    [providerId]: {
      ...getProviderOverrides(config, providerId),
      apiKey,
    },
  }
  const patch: Partial<DCodeConfig> = { providers }
  // 兼容旧版：DeepSeek Key 同步写入顶层 apiKey。
  if (providerId === 'deepseek') {
    patch.apiKey = apiKey
  }
  return patch
}

/**
 * 读取某 Provider 已保存的 Key（不含环境变量，仅 config 内）。
 * @param config 配置对象。
 * @param id Provider 标识。
 * @returns 已保存 Key 或 undefined。
 */
export function getStoredProviderApiKey(
  config: DCodeConfig,
  id: ProviderId,
): string | undefined {
  const fromProviders = getProviderOverrides(config, id).apiKey
  if (fromProviders) return fromProviders
  if (id === 'deepseek' && config.apiKey) return config.apiKey
  return undefined
}

/**
 * 渲染 /provider 列表文本。
 * @param config 当前配置。
 * @returns 多行文本。
 */
export function renderProviderList(config: DCodeConfig): string {
  const active = getActiveProviderId(config)
  const lines = ['可用 Provider：']
  for (const opt of PROVIDER_SWITCH_OPTIONS) {
    const def = getProviderDefinition(opt.id)
    const mark = def.id === active ? ' ✓当前' : ''
    lines.push(`  ${def.id.padEnd(8)} ${def.name}${mark}`)
    lines.push(`           端点：${resolveProviderBaseURL({ ...config, provider: def.id })}`)
    lines.push(
      `           默认模型：${getProviderOverrides(config, def.id).defaultModel ?? def.defaultModel}`,
    )
  }
  lines.push('')
  lines.push('用法：/provider <id>  例如 /provider zhipu、/provider deepseek')
  lines.push('外国 Provider 需代理：/proxy http://127.0.0.1:10793  或 export HTTPS_PROXY=...')
  lines.push('环境变量：ZHIPU_API_KEY、DEEPSEEK_API_KEY、OPENAI_API_KEY、DCODE_PROXY 等')
  return lines.join('\n')
}

/**
 * 渲染当前 Provider 详情。
 * @param config 配置对象。
 * @returns 多行文本。
 */
export function renderProviderStatus(config: DCodeConfig): string {
  const id = getActiveProviderId(config)
  const def = getProviderDefinition(id)
  const key = resolveProviderApiKey(config)
  const masked = key
    ? key === 'ollama'
      ? '(本地无需 Key)'
      : key.slice(0, 4) + '****' + key.slice(-2)
    : '(未设置)'
  const models =
    def.suggestedModels?.join('、') ?? '（任意 OpenAI 兼容模型名）'
  return [
    `当前 Provider：${def.name} (${id})`,
    `  API 端点：${resolveProviderBaseURL(config)}`,
    `  API Key：${masked}`,
    `  当前模型：${config.model}`,
    `  思维链/thinking：${def.supportsThinking ? '支持' : '不支持'}`,
    `  建议模型：${models}`,
    renderProxyHint(config),
    '',
    '切换：/provider zhipu | deepseek | openai',
    '代理：/proxy http://127.0.0.1:10793',
  ].join('\n')
}
