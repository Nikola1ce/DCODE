// DCODE 全局配置管理。
// 负责在用户主目录下读写 ~/.dcode/config.json，集中管理 API Key、默认模型、
// UI 主题、以及权限白名单（用户勾选过“总是允许”的工具规则）。
// 环境变量优先级高于配置文件，便于 CI / 临时覆盖。
// 制作人：Moriarty_Dox

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_ZHIPU_BASE_URL,
  DEFAULT_ZHIPU_MODEL,
  ENV_API_KEY,
  ENV_BASE_URL,
  ENV_MODEL,
  ENV_PROVIDER,
  ENV_REASONING_EFFORT,
  ENV_THINKING_BUDGET,
  isValidReasoningEffort,
  parseThinkingBudget,
  type ReasoningEffort,
} from './constants.js'
import type { ProviderId, ProviderOverrides } from './providers/types.js'
import {
  getActiveProviderId,
  resolveProviderApiKey,
  resolveProviderBaseURL,
} from './providers/registry.js'

// UI 主题枚举：暗色 / 亮色。影响终端配色方案。
export type ThemeName = 'dark' | 'light'

// 权限模式：
// - default：写文件 / 执行命令前需用户确认；
// - acceptEdits：自动允许文件读写，命令仍需确认；
// - plan：只读规划模式，禁止任何写入/执行；
// - bypass：跳过所有确认（危险，谨慎使用）。
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

// 持久化到磁盘的配置结构。
export interface DCodeConfig {
  // DeepSeek API Key（敏感信息，仅存于用户本机）。
  apiKey?: string
  // API 基础地址，默认 DeepSeek 官方端点，可改为代理/中转。
  baseURL: string
  // 默认主对话模型。
  model: string
  // UI 主题。
  theme: ThemeName
  // 是否默认展示推理模型的思维链（reasoning_content）。
  showThinking: boolean
  // Thinking 模式下的推理强度（low / medium / high / max）；仅 thinking 启用时传给 API。
  reasoningEffort: ReasoningEffort
  // 思维链 token 预算（thinking.budget_tokens）；可选，仅对支持该参数的 Provider 生效。
  // 未设置时不向 API 发送该字段；DeepSeek V4 无独立预算上限会忽略此值。
  thinkingBudget?: number
  // 全局“总是允许”的权限规则集合，形如 "Bash(git status)"、"Write" 等。
  alwaysAllow: string[]
  // 累计用量统计（成本、token），用于 /cost 展示历史总览。
  totalCostUsd: number
  // 是否已完成首次引导（用于决定是否展示新手提示）。
  onboardingComplete: boolean
  // 是否启用 Hooks 钩子系统（false 时跳过 Pre/Post 与会话钩子）。
  hooksEnabled: boolean
  // 是否启用提示音效（终端响铃）：在输入发送、权限请求、异常中断、输出结束、通知等时机发声，
  // 便于用户切走窗口时也能被提醒回来审核。默认开启；可用 /sound off 关闭。
  soundEnabled: boolean
  // 当前 LLM Provider（zhipu / deepseek / openai / ollama / custom）。
  provider: ProviderId
  // 各 Provider 的独立覆盖（baseURL、apiKey、defaultModel、proxy）。
  providers?: Partial<Record<ProviderId, ProviderOverrides>>
  // 全局 HTTP(S) 代理（外国 Provider 如 OpenAI 访问 api.openai.com 时使用）。
  proxy?: string
  // 用户为「支持多档上下文长度的模型」选定的最大上下文长度（token）。
  // 键为 "providerId:小写模型名"（见 contextWindow.contextOverrideKey），值为选定窗口 token 数。
  // 影响：状态栏进度条上限 + 自动压缩阈值（= 选定窗口 × 90%），随模型/选择实时变化。
  // 未选择的模型不在此表中，按模型默认（最大）窗口计算。
  modelContextOverrides?: Record<string, number>
}

// 配置默认值：首次运行或字段缺失时回退到这里。
const DEFAULT_CONFIG: DCodeConfig = {
  baseURL: DEFAULT_ZHIPU_BASE_URL,
  model: DEFAULT_ZHIPU_MODEL,
  theme: 'dark',
  showThinking: true,
  reasoningEffort: DEFAULT_REASONING_EFFORT,
  alwaysAllow: [],
  totalCostUsd: 0,
  onboardingComplete: false,
  hooksEnabled: true,
  soundEnabled: true,
  provider: 'zhipu',
}

/**
 * 计算配置目录的绝对路径（~/.dcode）。
 * @returns 配置目录绝对路径字符串。
 */
export function getConfigDir(): string {
  return join(homedir(), CONFIG_DIR_NAME)
}

/**
 * 计算配置文件的绝对路径（~/.dcode/config.json）。
 * @returns 配置文件绝对路径字符串。
 */
export function getConfigPath(): string {
  return join(getConfigDir(), CONFIG_FILE_NAME)
}

/**
 * 确保配置目录存在，不存在则递归创建。
 * 在写配置、写会话、写日志前调用，避免 ENOENT。
 */
export function ensureConfigDir(): void {
  const dir = getConfigDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * 从磁盘读取配置并与默认值、环境变量合并。
 * 读取失败（文件损坏/不存在）时回退到默认配置，保证程序始终可启动。
 * @returns 合并后的完整配置对象。
 */
export function loadConfig(): DCodeConfig {
  let fileConfig: Partial<DCodeConfig> = {}
  const path = getConfigPath()
  if (existsSync(path)) {
    try {
      // 解析磁盘上的 JSON 配置；若损坏则忽略并使用默认值。
      fileConfig = JSON.parse(readFileSync(path, 'utf8')) as Partial<DCodeConfig>
    } catch {
      fileConfig = {}
    }
  }

  // 合并顺序：默认值 < 文件配置 < 环境变量。环境变量优先级最高。
  const merged: DCodeConfig = { ...DEFAULT_CONFIG, ...fileConfig }

  // 环境变量覆盖：便于在不写入磁盘的情况下临时指定密钥/端点/模型。
  if (process.env[ENV_API_KEY]) merged.apiKey = process.env[ENV_API_KEY]
  if (process.env[ENV_BASE_URL]) merged.baseURL = process.env[ENV_BASE_URL] as string
  if (process.env[ENV_MODEL]) merged.model = process.env[ENV_MODEL] as string
  // 推理强度：仅接受四档合法值，非法值忽略以免写入坏配置。
  const envEffort = process.env[ENV_REASONING_EFFORT]
  if (envEffort && isValidReasoningEffort(envEffort)) {
    merged.reasoningEffort = envEffort
  }
  // 思维链 token 预算：仅接受区间内的整数，非法值忽略。
  const envBudget = process.env[ENV_THINKING_BUDGET]
  if (envBudget) {
    const parsed = parseThinkingBudget(envBudget)
    if (parsed !== undefined) merged.thinkingBudget = parsed
  }
  if (process.env[ENV_PROVIDER] && isValidProviderEnv(process.env[ENV_PROVIDER])) {
    merged.provider = process.env[ENV_PROVIDER] as ProviderId
  }

  return merged
}

/**
 * 校验环境变量中的 Provider id。
 * @param value 环境变量值。
 * @returns 合法返回 true。
 */
function isValidProviderEnv(value: string): boolean {
  return ['zhipu', 'deepseek', 'openai', 'ollama', 'custom'].includes(value)
}

/**
 * 将配置写回磁盘（~/.dcode/config.json）。
 * 注意：不会把通过环境变量临时注入的值额外清洗，调用方应传入期望持久化的完整对象。
 * @param config 待持久化的完整配置对象。
 */
export function saveConfig(config: DCodeConfig): void {
  ensureConfigDir()
  // 以 2 空格缩进美化输出，便于用户手动查看/编辑。
  const path = getConfigPath()
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  // 限制配置文件权限，降低同机其它用户读取 API Key 的风险。
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 等平台可能不支持 chmod，忽略。
  }
}

/**
 * 更新部分配置字段并立即持久化。
 * 先加载最新磁盘配置，合并补丁后写回，避免并发覆盖丢失字段。
 * @param patch 要更新的字段子集。
 * @returns 更新后的完整配置。
 */
export function updateConfig(patch: Partial<DCodeConfig>): DCodeConfig {
  const current = loadConfig()
  const next: DCodeConfig = { ...current, ...patch }
  // providers 按 Provider id 深合并，避免 /login 覆盖其它供应商已存 Key。
  if (patch.providers) {
    next.providers = { ...current.providers }
    for (const [id, overrides] of Object.entries(patch.providers)) {
      const pid = id as ProviderId
      next.providers[pid] = { ...current.providers?.[pid], ...overrides }
    }
  }
  // 模型上下文长度选择按键深合并，避免为某个模型设档位时覆盖其它模型的已存选择。
  if (patch.modelContextOverrides) {
    next.modelContextOverrides = {
      ...current.modelContextOverrides,
      ...patch.modelContextOverrides,
    }
  }
  saveConfig(next)
  return next
}

/**
 * 解析最终生效的 API Key：环境变量优先，其次 Provider 覆盖与顶层 apiKey。
 * @param config 已加载的配置对象。
 * @returns API Key 字符串；未配置则返回 undefined。
 */
export function resolveApiKey(config: DCodeConfig): string | undefined {
  return resolveProviderApiKey(config)
}

/**
 * 解析最终生效的 API baseURL。
 * @param config 已加载的配置对象。
 * @returns baseURL 字符串。
 */
export function resolveBaseURL(config: DCodeConfig): string {
  return resolveProviderBaseURL(config)
}

/**
 * 获取当前 Provider id。
 * @param config 配置对象。
 * @returns ProviderId。
 */
export function getConfigProviderId(config: DCodeConfig): ProviderId {
  return getActiveProviderId(config)
}
