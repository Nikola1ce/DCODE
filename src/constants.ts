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

// 用户自定义忽略文件名：格式同 .gitignore，供 glob/grep/list_dir 统一套用。
// 放在项目根（cwd）下；优先级高于 .gitignore，可用 ! 前缀对 .gitignore 规则做反忽略。
export const DCODE_IGNORE_FILE_NAME = '.dcodeignore'

// 文件检索工具（glob/grep/list_dir）默认始终忽略的噪声目录（即便未配置忽略文件也生效）。
// 集中定义避免在多个工具里散落硬编码；这些是绝大多数项目都不希望检索的产物/元数据目录。
export const DEFAULT_IGNORED_DIRS = [
  'node_modules',
  '.git',
  'dist',
  '.cache',
  '.next',
] as const

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
// 说明：自 v1.x 起，压缩阈值不再使用此固定值，而是「当前生效模型最大上下文长度 × COMPACT_THRESHOLD_RATIO」，
// 随模型切换动态变化（见 providers/contextWindow.ts 的 getCompactThreshold）。
// 此常量仅作为兜底：当无法解析模型上下文窗口时（理论上不会发生）回退使用。
export const COMPACT_TOKEN_THRESHOLD = 60000

// 自动压缩触发比率：当估算已用上下文 token 超过「模型最大上下文长度 × 该比率」时触发压缩。
// 取 0.9 是为了在接近上限前留出约 10% 余量给「本轮新输出 + 摘要生成」，避免请求真正超限被 API 拒绝。
export const COMPACT_THRESHOLD_RATIO = 0.9

// 自动压缩触发的「绝对 token 上限」（成本护栏，可由环境变量 DCODE_COMPACT_MAX_TOKENS 覆盖）。
// 背景：DeepSeek V4 等模型上下文窗口高达 1M，若仅用「窗口 × 90%」做阈值，历史会一路膨胀到
// 约 90 万 token 才压缩——而每一轮请求都要把全部历史作为输入 token 重新发送，成本随对话线性飙升。
// 因此对大窗口模型再叠加一个绝对上限：实际阈值 = min(窗口 × 比率, 本上限)。
// 取 120000（12 万）兼顾「足够容纳大量代码与多轮历史」与「单轮输入成本可控」；
// 小窗口模型（< 13 万）本就低于该上限，不受影响，仍按窗口 × 90% 触发。
export const COMPACT_MAX_ABS_THRESHOLD = 120_000

// 绝对上限允许的最小值：防止用户把上限设得过低导致频繁压缩、反而因反复摘要更费 token。
export const MIN_COMPACT_ABS_THRESHOLD = 8_000

// 环境变量：覆盖自动压缩的绝对 token 上限（正整数；低于 MIN_COMPACT_ABS_THRESHOLD 则忽略）。
// 设为 0 或负数可显式关闭绝对上限封顶，退回纯「窗口 × 比率」行为（适合确实想吃满超大窗口的用户）。
export const ENV_COMPACT_MAX_TOKENS = 'DCODE_COMPACT_MAX_TOKENS'

/**
 * 解析自动压缩绝对上限：优先读环境变量 DCODE_COMPACT_MAX_TOKENS，否则用默认 COMPACT_MAX_ABS_THRESHOLD。
 * - 值为有效正整数且 ≥ MIN_COMPACT_ABS_THRESHOLD：采用该值；
 * - 值可解析为 ≤ 0：表示关闭封顶，返回 0（调用方据此跳过绝对上限）；
 * - 其余非法输入：回退默认值。
 * @returns 绝对上限 token 数；返回 0 表示不启用封顶。
 */
export function resolveCompactMaxAbsThreshold(): number {
  const raw = process.env[ENV_COMPACT_MAX_TOKENS]
  if (raw === undefined || raw.trim() === '') return COMPACT_MAX_ABS_THRESHOLD
  const trimmed = raw.trim()
  // 允许显式关闭：0 / 负数。
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10)
    if (n <= 0) return 0
    if (n >= MIN_COMPACT_ABS_THRESHOLD) return n
  }
  // 非法或过小：回退默认。
  return COMPACT_MAX_ABS_THRESHOLD
}

// 读取文件时单次返回的最大字符数，超过会被截断并提示使用偏移分页读取。
export const MAX_FILE_READ_CHARS = 100000

// —— 历史「发送前瘦身」相关常量（见 core/historyTrim.ts）—— //
// 每轮请求都会把完整历史作为输入 token 重发，旧的大工具结果（read_file/grep 等）反复计费。
// 瘦身只作用于发送副本，不影响磁盘会话记录与 /resume。

// 保留最近多少条消息「绝对不瘦身」（保证模型当前推理可见最新工具结果全文）。
// 取 8 略大于压缩保留的 KEEP_RECENT(6)，确保「即将被压缩保留的最近若干轮」原文不被截断。
export const HISTORY_TRIM_KEEP_RECENT = 8

// 单条工具结果超过该字符数，且已滚出最近窗口时，才会被瘦身（小结果保持原样，避免误伤）。
export const HISTORY_TRIM_MAX_TOOL_RESULT_CHARS = 4000

// 瘦身时为旧的大工具结果保留的「头部字符数」（保留开头便于模型回忆该结果大致内容）。
export const HISTORY_TRIM_HEAD_CHARS = 800

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

// 网络读取「整体硬超时」（毫秒）：不依赖底层 AbortSignal 能否中断，到时一定让上层返回。
// 背景：某些服务器接受连接后 body 慢/挂起/不结束，导致 reader.read() 永久阻塞，
// 而 controller.abort() 在这种情况下未必能让已挂起的读取 settle —— 表现为工具「一直转圈」。
// 用 Promise.race 叠加该硬超时作为最终护栏，确保无论如何都能按时失败返回。
// 取 30s 略大于单请求超时（15s），给正常但偏慢的下载留余量，又远小于让用户以为「卡死」的时长。
export const NETWORK_HARD_TIMEOUT_MS = 30_000

// 网络读取「停顿（stall）超时」（毫秒）：单次 reader.read() 超过该时长仍无任何新数据到达，
// 判定为连接挂起并主动中断。用于尽早发现「连接已建立但服务器迟迟不发数据」的僵死下载。
export const NETWORK_STALL_TIMEOUT_MS = 20_000

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

// 提示音音量允许的最小值（0 = 静音，等效于不出声）。
export const MIN_SOUND_VOLUME = 0

// 提示音音量允许的最大值（100 = 原始音量，不做衰减）。
export const MAX_SOUND_VOLUME = 100

// 提示音默认音量（百分比）：缺省配置或非法值时回退到此值。
export const DEFAULT_SOUND_VOLUME = 100

/**
 * 将任意输入夹紧为合法的提示音音量（0–100 的整数）。
 * 用于「读配置（旧配置可能缺字段或被手改成非法值）」与「/sound volume 设值」两处，
 * 保证运行时音量永远落在区间内，避免把非法值传给系统播放器。
 * @param value 待夹紧的值（数字或可转数字的内容；非数字回退默认）。
 * @returns 落在 [MIN_SOUND_VOLUME, MAX_SOUND_VOLUME] 内的整数。
 */
export function clampSoundVolume(value: unknown): number {
  // 允许传入字符串数字（如配置被手改为 "80"），统一转成 number 再判定。
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_SOUND_VOLUME
  // 四舍五入到整数后夹紧，避免出现 80.5 这类小数音量。
  const rounded = Math.round(n)
  if (rounded < MIN_SOUND_VOLUME) return MIN_SOUND_VOLUME
  if (rounded > MAX_SOUND_VOLUME) return MAX_SOUND_VOLUME
  return rounded
}

/**
 * 解析字符串形式的提示音音量（来自 /sound volume 命令参数）。
 * 仅接受 0–100 的纯整数（可含首尾空白与可选百分号），其余一律视为非法。
 * 与 clampSoundVolume 的区别：本函数对非法输入返回 undefined（供命令层给出错误提示），
 * 而非静默夹紧——避免用户把 "abc" 或 "500" 误当作有效设置。
 * @param raw 原始字符串（如 "80"、"80%"、" 100 "）。
 * @returns 合法时返回 0–100 的整数，否则返回 undefined。
 */
export function parseSoundVolume(raw: string): number | undefined {
  // 去除首尾空白与可选的结尾百分号（用户可能输入 "80%"）。
  const trimmed = raw.trim().replace(/%$/, '').trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const n = Number.parseInt(trimmed, 10)
  if (n < MIN_SOUND_VOLUME || n > MAX_SOUND_VOLUME) return undefined
  return n
}

// 感知响度曲线指数：>1 时低档位衰减更狠，使 50 与 100 等档位更易听出差异。
// 线性 50% 振幅仅约 -6dB，短促提示音上听感接近全音量；2.0 时 50→25% 振幅（约 -12dB）。
const SOUND_VOLUME_GAIN_EXPONENT = 2

/**
 * 将用户音量 0–100 映射为播放器线性增益 0.0–1.0（感知响度，而非物理线性）。
 * 人耳对响度近似对数感知：配置 50 若直接折半振幅（0.5）仅约 -6dB，短促提示音上仍接近全音量；
 * 采用幂曲线（默认平方）使 50→0.25（约 -12dB）、30→0.09（约 -21dB），档位差异更易分辨。
 * 100 仍为 1.0（不衰减）；0 为 0（静音）。
 * @param volume 用户音量 0–100（会先经 clampSoundVolume 夹紧）。
 * @returns 0.0–1.0 的增益，供 MediaPlayer / afplay / paplay 使用。
 */
export function mapSoundVolumeToGain(volume: number): number {
  const v = clampSoundVolume(volume) / 100
  if (v <= 0) return 0
  return Math.pow(v, SOUND_VOLUME_GAIN_EXPONENT)
}
