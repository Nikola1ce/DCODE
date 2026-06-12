// DCODE 全局品牌与运行常量。
// 该文件集中定义产品名称、版本、作者署名、默认模型、API 端点等不可变常量，
// 供 UI 横幅、系统提示、配置默认值等多处复用，避免散落硬编码。
// 制作人：Moriarty_Dox

// 产品英文名（用于命令、配置目录、API user-agent 等）。
export const PRODUCT_NAME = 'DCODE'

// 命令行可执行命令名（package.json 的 bin 已注册）。
export const BIN_NAMES = ['dcode'] as const

// 产品版本号，应与 package.json 保持一致。
export const VERSION = '1.0.0'

// 制作人署名：在主界面横幅与 /about 命令中展示。
export const AUTHOR = 'Moriarty_Dox'

// 产品标语，展示在欢迎横幅下方。
export const TAGLINE = '适配 DeepSeek 的命令行 AI 编程助手'

// DeepSeek 官方 OpenAI 兼容 API 基础地址。
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

// 默认主对话模型：deepseek-v4-flash（V4 Flash，速度快、成本低，适合日常编程任务）。
export const DEFAULT_MODEL = 'deepseek-v4-flash'

// 高级模型：deepseek-v4-pro（V4 Pro，推理与编码能力更强，适合复杂任务，单价更高）。
export const PRO_MODEL = 'deepseek-v4-pro'

// DCODE 支持切换的模型清单，供 /model 命令切换与校验、模型选择器使用。
export const SUPPORTED_MODELS = [DEFAULT_MODEL, PRO_MODEL] as const

// 旧版兼容别名：deepseek-chat / deepseek-reasoner 计划于 2026/07/24 由官方弃用，
// 届时自动路由到 v4-flash。这里保留以兼容历史配置文件与历史会话，避免读取报错。
export const LEGACY_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const

/**
 * 判断模型名是否可用（含 V4 主模型与旧版兼容别名）。
 * @param model 用户或配置中的模型名。
 * @returns 可用返回 true。
 */
export function isSupportedModelName(model: string): boolean {
  return (
    (SUPPORTED_MODELS as readonly string[]).includes(model) ||
    (LEGACY_MODELS as readonly string[]).includes(model)
  )
}

// 用户级配置目录名（位于操作系统用户主目录下，例如 ~/.dcode）。
export const CONFIG_DIR_NAME = '.dcode'

// 配置文件名（存放 apiKey、默认模型、主题、权限白名单等）。
export const CONFIG_FILE_NAME = 'config.json'

// 项目级记忆文件名：类似 Claude Code 的 CLAUDE.md，存放项目约定/上下文。
export const MEMORY_FILE_NAME = 'DCODE.md'

// 单轮 Agent 主循环的最大工具调用迭代次数，防止模型陷入死循环。
export const MAX_AGENT_ITERATIONS = 50

// 触发上下文自动压缩的 token 阈值（估算值，超过则提示/执行压缩）。
export const COMPACT_TOKEN_THRESHOLD = 60000

// 读取文件时单次返回的最大字符数，超过会被截断并提示使用偏移分页读取。
export const MAX_FILE_READ_CHARS = 100000

// 命令执行（Shell/PowerShell）默认超时时间（毫秒）。
export const DEFAULT_COMMAND_TIMEOUT_MS = 120000

// 环境变量名：允许通过环境变量覆盖 API Key / BaseURL / 模型。
export const ENV_API_KEY = 'DEEPSEEK_API_KEY'
export const ENV_BASE_URL = 'DEEPSEEK_BASE_URL'
export const ENV_MODEL = 'DCODE_MODEL'
export const ENV_REASONING_EFFORT = 'DCODE_REASONING_EFFORT'

// V4 Thinking 模式下的推理强度（仅 thinking 启用时生效）。
export const REASONING_EFFORTS = ['high', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * 判断 reasoning_effort 取值是否合法。
 * @param value 用户或环境变量传入的字符串。
 * @returns 合法返回 true。
 */
export function isValidReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
}
