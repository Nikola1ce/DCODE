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
export const TAGLINE = 'DCode AI 助手'

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

// Hooks 配置文件名（~/.dcode/hooks.json 与项目 .dcode/hooks.json）。
export const HOOKS_CONFIG_FILE_NAME = 'hooks.json'

// 额外工作目录配置文件名（项目 .dcode/workspace.json，存放 /add-dir 添加的目录）。
export const WORKSPACE_DIRS_FILE_NAME = 'workspace.json'

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

// —— Notebook（Jupyter .ipynb）相关常量 —— //
// notebook_read 渲染单个 cell 源码/输出时的最大字符数，超出截断，避免大输出撑爆上下文。
export const MAX_NOTEBOOK_CELL_CHARS = 8000

// notebook_read 渲染整本 notebook 时的总字符上限，超出后提示用其它参数分段查看。
export const MAX_NOTEBOOK_READ_CHARS = 60000

// notebook_edit 单个 cell 源码允许写入的最大字符数，防止异常超大内容。
export const MAX_NOTEBOOK_EDIT_CHARS = 100000

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

// GitHub 仓库标识（用于自动更新检测）。
export const GITHUB_REPO = 'Nikola1ce/DCODE'

// 环境变量：设为 1 时跳过启动时的更新检测提示。
export const ENV_SKIP_UPDATE_CHECK = 'DCODE_SKIP_UPDATE_CHECK'

// 环境变量名：允许通过环境变量覆盖 API Key / BaseURL / 模型。
export const ENV_API_KEY = 'DEEPSEEK_API_KEY'
export const ENV_BASE_URL = 'DEEPSEEK_BASE_URL'
export const ENV_MODEL = 'DCODE_MODEL'
export const ENV_REASONING_EFFORT = 'DCODE_REASONING_EFFORT'
// 环境变量：思维链 token 预算（整数，落在 MIN/MAX_THINKING_BUDGET 区间内方生效）。
export const ENV_THINKING_BUDGET = 'DCODE_THINKING_BUDGET'
export const ENV_PROVIDER = 'DCODE_PROVIDER'

// OpenAI Provider 环境变量。
export const ENV_OPENAI_API_KEY = 'OPENAI_API_KEY'
export const ENV_OPENAI_BASE_URL = 'OPENAI_BASE_URL'

// 智谱 AI Provider 环境变量（GLM-4-Flash 等永久免费模型）。
export const ENV_ZHIPU_API_KEY = 'ZHIPU_API_KEY'
export const ENV_ZHIPU_BASE_URL = 'ZHIPU_BASE_URL'
export const DEFAULT_ZHIPU_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
export const DEFAULT_ZHIPU_MODEL = 'glm-4-flash'

// Ollama Provider 环境变量。
export const ENV_OLLAMA_BASE_URL = 'OLLAMA_BASE_URL'
export const ENV_OLLAMA_API_KEY = 'OLLAMA_API_KEY'

// 自定义 OpenAI 兼容 Provider 环境变量。
export const ENV_CUSTOM_API_KEY = 'DCODE_API_KEY'

// HTTP(S) 代理环境变量（外国 Provider 如 OpenAI 需配置方可直连）。
export const ENV_DCODE_PROXY = 'DCODE_PROXY'
export const ENV_HTTPS_PROXY = 'HTTPS_PROXY'
export const ENV_HTTP_PROXY = 'HTTP_PROXY'

// Thinking 模式下面向用户的推理强度档位（仅 thinking 启用时生效）。
// 提供 low / medium / high / max 四级精细控制，对齐 Claude / o 系列等主流推理模型的强度语义；
// 不同 Provider 的真实可用值不一，由 mapEffortToDeepSeek 等映射函数在请求前归一化。
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

// 默认推理强度：兼顾质量与成本，作为配置缺省与请求兜底。
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = 'high'

/**
 * 判断 reasoning_effort 取值是否合法。
 * @param value 用户或环境变量传入的字符串。
 * @returns 合法返回 true。
 */
export function isValidReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * 将统一的四级推理强度映射为 DeepSeek V4 实际接受的取值。
 * DeepSeek API 当前仅认 high / max：为兼容性，low / medium 自动归并到 high，
 * 这样上层可以始终暴露四档体验，而底层请求不会因非法取值而 400。
 * @param effort 面向用户的四级强度。
 * @returns DeepSeek 兼容的 reasoning_effort 值（'high' | 'max'）。
 */
export function mapEffortToDeepSeek(effort: ReasoningEffort): 'high' | 'max' {
  return effort === 'max' ? 'max' : 'high'
}

// —— Thinking budget（思维链 token 预算）—— //
// 部分 Provider（如 Claude 兼容端点）支持以 token 数精细约束思维链长度（thinking.budget_tokens）。
// DeepSeek V4 不提供独立的预算上限参数（模型推理至收敛或输出截断），此值对其不生效但仍可配置，
// 便于切换到支持该参数的 Provider 时复用同一套设置。

// thinking budget 允许的最小 token 数（过小会导致推理被立刻截断，失去意义）。
export const MIN_THINKING_BUDGET = 1024

// thinking budget 允许的最大 token 数（防止单次推理预算设置过大导致成本失控）。
export const MAX_THINKING_BUDGET = 120000

/**
 * 校验 thinking budget 取值是否为合法的正整数且落在允许区间内。
 * @param value 待校验的 token 预算（任意类型，便于解析命令行/环境变量原始值）。
 * @returns 合法返回 true。
 */
export function isValidThinkingBudget(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_THINKING_BUDGET &&
    value <= MAX_THINKING_BUDGET
  )
}

/**
 * 解析字符串形式的 thinking budget（来自 CLI 参数或环境变量）。
 * 仅接受落在 [MIN_THINKING_BUDGET, MAX_THINKING_BUDGET] 区间内的整数，其余一律视为非法。
 * @param raw 原始字符串（如 "16000"）。
 * @returns 合法时返回数字，否则返回 undefined。
 */
export function parseThinkingBudget(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number.parseInt(trimmed, 10)
  return isValidThinkingBudget(n) ? n : undefined
}
