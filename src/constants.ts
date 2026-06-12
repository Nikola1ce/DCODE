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

// MCP Server 配置文件名（~/.dcode/mcp.json，格式与 Cursor mcp.json 兼容）。
export const MCP_CONFIG_FILE_NAME = 'mcp.json'

// 项目级记忆文件名：类似 Claude Code 的 CLAUDE.md，存放项目约定/上下文。
export const MEMORY_FILE_NAME = 'DCODE.md'

// 单轮 Agent 主循环的最大工具调用迭代次数，防止模型陷入死循环。
export const MAX_AGENT_ITERATIONS = 50

// 子代理同时运行的最大数量（Task 工具并发上限）。
export const MAX_CONCURRENT_SUBAGENTS = 5

// 单个子代理主循环的最大工具调用迭代次数（低于主 Agent，控制成本）。
export const MAX_SUBAGENT_ITERATIONS = 30

/** 内置子代理类型标识。 */
export const SUBAGENT_TYPE_NAMES = ['generalPurpose', 'explore', 'shell'] as const
export type SubAgentType = (typeof SUBAGENT_TYPE_NAMES)[number]

/** 子代理类型元数据：说明、专用系统提示、是否默认只读。 */
export const SUBAGENT_TYPES: Record<
  SubAgentType,
  { description: string; systemPrompt: string; readonlyDefault: boolean }
> = {
  generalPurpose: {
    description: '通用子代理：研究、多步骤任务与综合编码',
    readonlyDefault: false,
    systemPrompt:
      '你是通用子代理，可读写文件、运行命令、检索代码库。' +
      '专注完成父 Agent 委托的子任务，返回清晰可操作的结论。',
  },
  explore: {
    description: '快速探索子代理：只读检索代码库、搜索文件与 API',
    readonlyDefault: true,
    systemPrompt:
      '你是代码库探索子代理，只能使用只读工具（read_file、grep、glob、list_dir）。' +
      '快速定位相关文件、符号与模式，返回结构化发现列表，不要修改任何文件。',
  },
  shell: {
    description: '命令执行子代理：git、构建、测试等终端操作',
    readonlyDefault: false,
    systemPrompt:
      '你是命令执行子代理，擅长 git 操作、构建、测试与脚本执行。' +
      '用 run_command 完成任务，解释命令输出中的关键信息，避免交互式命令。',
  },
}

/**
 * 判断子代理类型名是否合法。
 * @param value 类型字符串。
 * @returns 合法返回 true。
 */
export function isValidSubAgentType(value: string): value is SubAgentType {
  return (SUBAGENT_TYPE_NAMES as readonly string[]).includes(value)
}

// 触发上下文自动压缩的 token 阈值（估算值，超过则提示/执行压缩）。
export const COMPACT_TOKEN_THRESHOLD = 60000

// 读取文件时单次返回的最大字符数，超过会被截断并提示使用偏移分页读取。
export const MAX_FILE_READ_CHARS = 100000

// 命令执行（Shell/PowerShell）默认超时时间（毫秒）。
export const DEFAULT_COMMAND_TIMEOUT_MS = 120000

// 后台 Shell 最大同时记录数（超出时 purge 最早已结束的记录）。
export const MAX_BACKGROUND_SHELL_RECORDS = 30

// 后台 Shell 最大运行时长（毫秒），超时自动 kill。
export const MAX_BACKGROUND_SHELL_RUNTIME_MS = 30 * 60 * 1000

// bash_output 单次返回的最大输出字符数。
export const MAX_SHELL_OUTPUT_CHARS = 30000

// bash_output 默认阻塞等待毫秒数（0 表示立即返回当前快照）。
export const DEFAULT_BASH_OUTPUT_BLOCK_MS = 0

// web_fetch 单次返回的最大字符数（约 50KB）。
export const MAX_WEB_FETCH_CHARS = 50_000

// web_fetch 请求超时（毫秒）。
export const WEB_FETCH_TIMEOUT_MS = 15_000

// web_search 请求超时（毫秒）。
export const WEB_SEARCH_TIMEOUT_MS = 15_000

// Bing Web Search API v7 端点。
export const BING_SEARCH_ENDPOINT = 'https://api.bing.microsoft.com/v7.0/search'

// 环境变量：Bing Search API Key。
export const ENV_BING_SEARCH_KEY = 'BING_SEARCH_API_KEY'

// 环境变量：SerpAPI Key（优先于 Bing）。
export const ENV_SERPAPI_KEY = 'SERPAPI_API_KEY'

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
