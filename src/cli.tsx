// DCODE CLI 入口。
// 负责：解析命令行参数、加载配置、初始化 Agent 与会话，然后根据模式分流：
//   - 交互模式：渲染 Ink 全屏 TUI（默认）；
//   - 无头模式（-p / --print）：跑完一轮对话并打印结果后退出。
// 同时处理 --version / --help / -c 继续会话 / -r 恢复会话 / --model / --cwd / 权限模式等。
// 安装后通过 dcode 命令启动。
// 制作人：Moriarty_Dox

import { spawnSync } from 'node:child_process'
import React from 'react'
import { render } from 'ink'
import { existsSync } from 'node:fs'
import path from 'node:path'
import {
  PRODUCT_NAME,
  AUTHOR,
  VERSION,
  TAGLINE,
  BIN_NAMES,
  SUPPORTED_MODELS,
  LEGACY_MODELS,
  REASONING_EFFORTS,
  isValidReasoningEffort,
  parseThinkingBudget,
  MIN_THINKING_BUDGET,
  MAX_THINKING_BUDGET,
  type ReasoningEffort,
} from './constants.js'
import { loadConfig, ensureConfigDir, type PermissionMode } from './config.js'
import {
  getActiveProviderId,
  getProviderDefinition,
  getSuggestedModelsForProvider,
  isModelAllowedForProvider,
} from './providers/registry.js'
import { Agent } from './core/agent.js'
import {
  SessionRecorder,
  getLatestSessionId,
  loadSessionMessages,
} from './core/session.js'
import { runHeadless } from './headless.js'
import { runIdeServer } from './ide/server.js'
import { initMcp, shutdownMcp } from './mcp/client.js'
import { initHooks, shutdownHooks, getHookManager } from './core/hooks.js'
import { ensureBuiltinSkills } from './core/skills.js'
import { getCheckpointExitHint } from './core/checkpoint.js'
import { App } from './ui/App.js'
import { messagesToItems } from './ui/messagesToItems.js'
import { installStdoutTrace, traceEvent } from './trace.js'

// 解析后的命令行选项。
interface CliOptions {
  // 是否显示帮助。
  help: boolean
  // 是否显示版本。
  version: boolean
  // 是否无头模式。
  print: boolean
  // 继续最近一次会话。
  continueSession: boolean
  // 恢复指定会话 id（--resume <id>）；为 true 表示 -r 但未指定 id。
  resume: string | boolean
  // 指定模型。
  model?: string
  // 指定工作目录。
  cwd?: string
  // 权限模式覆盖。
  permissionMode?: PermissionMode
  // IDE 服务端模式：以 NDJSON over stdio 与 VSCode 扩展通信（dcode --ide-server）。
  ideServer?: boolean
  // 无头模式：显式自动批准所有权限请求（默认拒绝，需 -y/--yes）。
  autoApprove?: boolean
  // 推理强度覆盖（low / medium / high / max）。
  reasoningEffort?: ReasoningEffort
  // 思维链 token 预算覆盖（thinking.budget_tokens）；原始字符串，main 中再校验。
  thinkingBudget?: string
  // 位置参数拼成的 prompt（无头模式使用）。
  prompt: string
}

/**
 * 解析 process.argv。
 * @param argv 原始参数数组（不含 node 与脚本路径）。
 * @returns 解析后的选项。
 */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    version: false,
    print: false,
    continueSession: false,
    resume: false,
    prompt: '',
  }
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-h':
      case '--help':
        opts.help = true
        break
      case '-v':
      case '--version':
        opts.version = true
        break
      case '-p':
      case '--print':
        opts.print = true
        break
      case '-c':
      case '--continue':
        opts.continueSession = true
        break
      case '-r':
      case '--resume':
        // 下一个参数若不是选项，则作为会话 id。
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.resume = argv[++i]
        } else {
          opts.resume = true
        }
        break
      case '-m':
      case '--model':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.model = argv[++i]
        }
        break
      case '--cwd':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.cwd = argv[++i]
        }
        break
      case '--plan':
        opts.permissionMode = 'plan'
        break
      case '--auto':
      case '--accept-edits':
        opts.permissionMode = 'acceptEdits'
        break
      case '--yolo':
      case '--bypass':
      case '--dangerously-skip-permissions':
        opts.permissionMode = 'bypass'
        break
      case '--ide-server':
        // IDE 集成：与 VSCode 扩展通过 stdio 上的 NDJSON 协议双向通信。
        opts.ideServer = true
        break
      case '--reasoning-effort':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.reasoningEffort = argv[++i] as ReasoningEffort
        }
        break
      case '--thinking-budget':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
          opts.thinkingBudget = argv[++i]
        }
        break
      case '-y':
      case '--yes':
      case '--dangerously-auto-approve':
        opts.autoApprove = true
        break
      default:
        // 未识别的非选项参数视为 prompt 的一部分。
        if (!a.startsWith('-')) positionals.push(a)
        break
    }
  }

  opts.prompt = positionals.join(' ').trim()
  return opts
}

/**
 * 打印帮助信息。
 */
function printHelp(): void {
  const cmd = BIN_NAMES[0]
  const lines = [
    `${PRODUCT_NAME} v${VERSION} — ${TAGLINE}`,
    `制作人：${AUTHOR}`,
    '',
    '用法：',
    `  ${cmd} [选项] [任务]`,
    '',
    '选项：',
    '  -p, --print                 无头模式：执行一轮任务并打印结果后退出',
    '  -y, --yes                   无头模式下自动批准权限请求（默认拒绝需授权操作）',
    '  -c, --continue              继续当前目录最近一次会话',
    '  -r, --resume [会话id]       恢复指定（或最近）历史会话',
    '  -m, --model <模型>          指定模型（' + SUPPORTED_MODELS.join(' / ') + '）',
    '      --cwd <目录>            指定工作目录',
    '      --plan                  以规划模式启动（只读，不修改文件/不执行命令）',
    '      --auto                  以自动接受编辑模式启动',
    '      --bypass                跳过所有权限确认（危险，同 --dangerously-skip-permissions）',
    '      --dangerously-skip-permissions  跳过所有权限确认（危险）',
    '      --reasoning-effort <low|medium|high|max>  推理强度（Thinking 模式下生效；DeepSeek 将 low/medium 归并为 high）',
    '      --thinking-budget <整数>  思维链 token 预算（如 16000；仅支持该参数的 Provider 生效）',
    '      --ide-server            IDE 集成：以 NDJSON over stdio 与 VSCode 扩展通信（一般由扩展自动启动）',
    '  -v, --version               显示版本',
    '  -h, --help                  显示帮助',
    '',
    '示例：',
    `  ${cmd}                                  # 启动交互式界面`,
    `  ${cmd} -p "用 python 写一个快排并测试"   # 无头执行一次任务`,
    `  ${cmd} -c                               # 继续上次对话`,
    `  ${cmd} --model deepseek-v4-pro          # 用更强的 V4 Pro 模型启动`,
    '',
    '环境变量：',
    '  DEEPSEEK_API_KEY    DeepSeek API 密钥',
    '  DEEPSEEK_BASE_URL   API 端点（默认 https://api.deepseek.com）',
    '  DCODE_MODEL         默认模型',
    '  DCODE_REASONING_EFFORT  推理强度 low | medium | high | max',
    '  DCODE_THINKING_BUDGET   思维链 token 预算（整数）',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * 创建一个「不清屏」的 stdout 代理：除 rows 外全部透传给真实流，rows 恒为极大值。
 *
 * 背景：Ink 在 onRender 时，若「动态区高度 outputHeight >= stdout.rows」，会改用
 * clearTerminal（清屏 + 重写全部 Static 历史）而非局部增量擦除。在小终端里，权限弹窗等
 * 较高的动态区会持续命中该分支，表现为滚动条被强制拉回顶部、内容在顶/底之间闪烁（Bug 2）。
 *
 * 让 Ink 读到的 rows 恒为极大值后，该判断恒为 false，Ink 始终走增量渲染：动态区超过可视
 * 高度时像普通命令输出一样自然向下滚动、保留在 scrollback，不再回弹清屏。
 *
 * 注意：仅 Ink 内部渲染读取此代理的 rows；App 业务逻辑（限高等）仍直接读 process.stdout.rows
 * 获取真实终端行数，因此不受影响。columns / isTTY / write / on(resize) 等均原样透传。
 *
 * @param real 真实的 stdout 流（通常是 process.stdout）。
 * @returns 行数被「放大」的 stdout 代理。
 */
function createNonClearingStdout(real: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(real, {
    get(target, prop, receiver) {
      // 仅伪装行数：让 Ink 永远认为终端「足够高」，从而不触发 clearTerminal 全屏重绘。
      if (prop === 'rows') return Number.MAX_SAFE_INTEGER
      const value = Reflect.get(target, prop, receiver)
      // 方法需绑定回真实流，避免 Proxy 作为 this 导致内部状态访问异常。
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as NodeJS.WriteStream
}

/**
 * 在 Windows 交互终端上尽量切换到 UTF-8 代码页，避免中文/框线字符乱码。
 * 通过 .bat 启动时已 chcp 65001；直接 `dcode` / `node dist/cli.js` 时此处兜底。
 */
function ensureWindowsConsoleUtf8(): void {
  if (process.platform !== 'win32' || !process.stdout.isTTY) return
  try {
    spawnSync('cmd.exe', ['/d', '/s', '/c', 'chcp 65001 >nul'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    // 非 TTY 或权限受限时忽略。
  }
}

/**
 * CLI 主流程。
 */
async function main(): Promise<void> {
  ensureWindowsConsoleUtf8()
  const opts = parseArgs(process.argv.slice(2))
  // IDE 服务端模式下 stdout 是「纯协议通道」，绝不能写入 trace 文本，否则会破坏 NDJSON 帧。
  // 其余模式正常安装 stdout trace（trace 默认仍走 stderr/文件，此处仅为可观测性入口）。
  if (!opts.ideServer) {
    installStdoutTrace()
  }
  traceEvent('app', 'cli_start', {
    print: opts.print,
    continueSession: opts.continueSession,
    resume: opts.resume,
    model: opts.model,
    cwd: opts.cwd,
  })

  // 处理 --help / --version 短路退出。
  if (opts.help) {
    printHelp()
    return
  }
  if (opts.version) {
    process.stdout.write(`${PRODUCT_NAME} v${VERSION}（制作人：${AUTHOR}）\n`)
    return
  }

  // 确保配置目录存在并加载配置。
  ensureConfigDir()
  ensureBuiltinSkills()
  const config = loadConfig()

  // 命令行覆盖：模型。
  if (opts.model) {
    if (!isModelAllowedForProvider(opts.model, config)) {
      const suggested = getSuggestedModelsForProvider(config).join('、')
      process.stderr.write(
        `不支持的模型：${opts.model}\n当前 Provider（${getActiveProviderId(config)}）可用：${suggested}\n`,
      )
      process.exit(1)
    }
    config.model = opts.model
  }

  // 命令行覆盖：推理强度。
  if (opts.reasoningEffort) {
    if (!isValidReasoningEffort(opts.reasoningEffort)) {
      process.stderr.write(
        `无效的推理强度：${opts.reasoningEffort}\n可用：${REASONING_EFFORTS.join('、')}\n`,
      )
      process.exit(1)
    }
    config.reasoningEffort = opts.reasoningEffort
  }

  // 命令行覆盖：思维链 token 预算。
  if (opts.thinkingBudget !== undefined) {
    const budget = parseThinkingBudget(opts.thinkingBudget)
    if (budget === undefined) {
      process.stderr.write(
        `无效的思维链预算：${opts.thinkingBudget}\n` +
          `请传入 ${MIN_THINKING_BUDGET}~${MAX_THINKING_BUDGET} 之间的整数（如 --thinking-budget 16000）\n`,
      )
      process.exit(1)
    }
    config.thinkingBudget = budget
  }

  // 确定工作目录。
  const cwd = opts.cwd ? resolveCwd(opts.cwd) : process.cwd()

  // 初始化 MCP Client（连接 mcp.json 中的 server 并注册动态工具）。
  await initMcp(cwd)
  registerMcpShutdownHook()

  // 初始化 Hooks 系统（加载 ~/.dcode/hooks.json 与项目 .dcode/hooks.json）。
  initHooks(cwd, config.hooksEnabled !== false)
  registerHooksShutdownHook(cwd)

  // 权限模式：命令行覆盖 > 默认。
  const permissionMode: PermissionMode = opts.permissionMode ?? 'default'

  // —— 处理会话恢复/继续 —— //
  let initialMessages = undefined
  let resumedSessionId: string | null = null
  if (opts.continueSession) {
    resumedSessionId = getLatestSessionId(cwd)
  } else if (typeof opts.resume === 'string') {
    resumedSessionId = opts.resume
  } else if (opts.resume === true) {
    // -r 未指定 id：取最近会话。
    resumedSessionId = getLatestSessionId(cwd)
  }
  if (resumedSessionId) {
    const msgs = loadSessionMessages(resumedSessionId)
    if (msgs.length > 0) initialMessages = msgs
  }

  // —— IDE 服务端模式（dcode --ide-server）—— //
  // 以 NDJSON over stdio 与 VSCode 扩展双向通信，复用整套 Agent 内核（工具/MCP/Hooks/检查点等）。
  // stdout 是纯协议通道；所有日志走 stderr。会话同样持久化，便于在终端 dcode -c 续聊同一项目。
  if (opts.ideServer) {
    const recorder = resumedSessionId
      ? new SessionRecorder(resumedSessionId)
      : SessionRecorder.create(cwd, config.model)
    const agent = new Agent({
      config,
      cwd,
      recorder,
      initialMessages,
      // 扩展默认以 acceptEdits 启动（自动允许文件读写、命令仍需确认）；
      // 若用户通过 --plan/--auto/--bypass 显式覆盖则尊重之。
      permissionMode: opts.permissionMode ?? 'acceptEdits',
    })
    hooksSessionIdProvider = () => agent.getSessionId()
    await triggerSessionStartHooks(cwd, agent.getSessionId())

    // 缺 API Key 不直接退出：通过 ready.hasApiKey=false 告知扩展，由扩展引导用户配置。
    // 传入 config 让斜杠命令（/model、/provider、/commit、/review 等）可在 IDE 模式下复用并持久化。
    await runIdeServer(agent, config)
    await shutdownHooks(cwd, agent.getSessionId())
    await shutdownMcp()
    process.exit(0)
  }

  // —— 无头模式 —— //
  if (opts.print) {
    // 无头模式也会持久化会话，便于后续 dcode -c 继续同一项目对话。
    const recorder = resumedSessionId
      ? new SessionRecorder(resumedSessionId)
      : SessionRecorder.create(cwd, config.model)
    const agent = new Agent({
      config,
      cwd,
      recorder,
      initialMessages,
      permissionMode,
    })
    hooksSessionIdProvider = () => agent.getSessionId()
    await triggerSessionStartHooks(cwd, agent.getSessionId())

    // 缺少 API Key 直接报错退出。
    if (!agent.hasApiKey()) {
      const def = getProviderDefinition(getActiveProviderId(config))
      process.stderr.write(
        `错误：未设置 ${def.name} API Key。请设置环境变量 ${def.apiKeyEnv}，或交互模式执行 /login。\n`,
      )
      process.exit(1)
    }

    // prompt 来源：位置参数；为空则从标准输入读取。
    let prompt = opts.prompt
    if (!prompt) prompt = await readStdin()
    if (!prompt.trim()) {
      process.stderr.write('错误：无头模式需要提供任务文本（位置参数或标准输入）。\n')
      process.exit(1)
    }

    // 无头模式：plan 保持只读；bypass 跳过确认；其余模式默认拒绝，需 -y/--yes 才自动批准。
    const code = await runHeadless(agent, prompt.trim(), {
      autoApprove: !!opts.autoApprove || permissionMode === 'bypass',
    })
    await shutdownHooks(cwd, agent.getSessionId())
    await shutdownMcp()
    printCheckpointExitHint(cwd)
    process.exit(code)
  }

  // —— 交互模式 —— //
  // 新会话则创建记录器；恢复会话则绑定到原会话文件继续追加。
  const recorder = resumedSessionId
    ? new SessionRecorder(resumedSessionId)
    : SessionRecorder.create(cwd, config.model)

  const agent = new Agent({
    config,
    cwd,
    recorder,
    initialMessages,
    permissionMode,
  })
  hooksSessionIdProvider = () => agent.getSessionId()
  await triggerSessionStartHooks(cwd, agent.getSessionId())

  // 构建恢复会话时的回放展示项。
  const initialItems =
    initialMessages && initialMessages.length > 0
      ? [
          {
            id: 'banner',
            kind: 'banner' as const,
            model: agent.getModel(),
            cwd,
          },
          ...messagesToItems(initialMessages),
        ]
      : undefined

  // 缺少 API Key 时，启动后自动打开登录流程。
  const needLogin = !agent.hasApiKey()

  // 渲染 Ink 应用，并等待退出（启动更新检测在 App 内异步进行，不阻塞首屏）。
  // 关键：用「不清屏」stdout 代理喂给 Ink。Ink 在「动态区高度 >= 终端行数」时会用
  // clearTerminal 清屏并重写全部历史（表现为滚动条被强制回到顶部 / 闪烁，即 Bug 2）。
  // 通过让 Ink 读到的 rows 恒为极大值，使该分支永不触发——动态区超过视口时改为像普通
  // 输出一样自然滚动，不再回弹。App 自身的限高逻辑仍读真实 process.stdout.rows。
  const app = render(
    <App
      agent={agent}
      config={config}
      initialItems={initialItems}
      needLogin={needLogin}
      checkUpdateOnStart
    />,
    // exitOnCtrlC:false —— 关闭 Ink 默认的「Ctrl+C 立即退出」：
    // 应用户需求，Ctrl+C 改作「复制」（见 InputPrompt），退出改用 Ctrl+D 或 /exit 命令。
    { stdout: createNonClearingStdout(process.stdout), exitOnCtrlC: false },
  )
  await app.waitUntilExit()
  await shutdownHooks(cwd, agent.getSessionId())
  await shutdownMcp()
  printCheckpointExitHint(cwd)
}

/** 是否已注册 MCP 退出清理（避免重复绑定）。 */
let mcpShutdownHookRegistered = false
/** 是否已注册 Hooks 退出清理。 */
let hooksShutdownHookRegistered = false
/** Hooks 关闭时使用的 cwd（main 中设置）。 */
let hooksShutdownCwd = ''
/** Hooks 关闭时获取 sessionId 的回调（main 中设置）。 */
let hooksSessionIdProvider: (() => string | null) | null = null

/**
 * 注册进程退出时断开 MCP 连接（SIGINT/SIGTERM/exit）。
 */
function registerMcpShutdownHook(): void {
  if (mcpShutdownHookRegistered) return
  mcpShutdownHookRegistered = true
  const cleanup = () => {
    void shutdownMcp()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

/**
 * 注册进程退出时触发 OnSessionEnd 钩子。
 * @param cwd 工作目录。
 */
function registerHooksShutdownHook(cwd: string): void {
  if (hooksShutdownHookRegistered) return
  hooksShutdownHookRegistered = true
  hooksShutdownCwd = cwd
  const cleanup = () => {
    const sessionId = hooksSessionIdProvider?.() ?? null
    void shutdownHooks(hooksShutdownCwd, sessionId)
  }
  process.on('exit', cleanup)
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

/**
 * 触发 OnSessionStart 钩子（Agent 创建后）。
 * @param cwd 工作目录。
 * @param sessionId 会话 id。
 */
async function triggerSessionStartHooks(
  cwd: string,
  sessionId: string | null,
): Promise<void> {
  const mgr = getHookManager()
  if (!mgr) return
  await mgr.runSessionStart({ cwd, sessionId })
}

/**
 * 退出时若有未清理检查点，向 stderr 打印提示。
 * @param cwd 工作目录。
 */
function printCheckpointExitHint(cwd: string): void {
  const hint = getCheckpointExitHint(cwd)
  if (hint) process.stderr.write(hint + '\n')
}

/**
 * 解析工作目录参数为绝对路径并校验存在性。
 * @param dir 用户给定目录。
 * @returns 绝对路径。
 */
function resolveCwd(dir: string): string {
  const abs = path.isAbsolute(dir) ? dir : path.resolve(process.cwd(), dir)
  if (!existsSync(abs)) {
    process.stderr.write(`错误：目录不存在 ${dir}\n`)
    process.exit(1)
  }
  return abs
}

/**
 * 从标准输入读取全部文本（用于无头模式管道输入）。
 * @returns 读取到的字符串。
 */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    // 标准输入是 TTY（无管道）时直接返回空串，避免阻塞。
    if (process.stdin.isTTY) {
      resolve('')
      return
    }
    let data = ''
    let settled = false
    let receivedAny = false
    /** 结束读取；重复调用会被忽略。 */
    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      resolve(value)
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      receivedAny = true
      data += chunk
      // 一旦收到管道数据，取消空闲超时，等待 end 收集完整输入。
      clearTimeout(idleTimer)
    })
    process.stdin.on('end', () => finish(data))
    // 读取异常时返回已有数据。
    process.stdin.on('error', () => finish(data))
    process.stdin.resume()
    // 非 TTY 且未挂载管道时 stdin 可能永不触发 end；空闲超时视为无输入。
    const idleTimer = setTimeout(() => {
      if (!receivedAny) finish(data)
    }, 150)
  })
}

// 启动主流程；捕获顶层异常以友好退出。
main().catch(async (err) => {
  process.stderr.write(`\n[${PRODUCT_NAME}] 启动失败：${err?.message ?? String(err)}\n`)
  if (hooksShutdownCwd) {
    await shutdownHooks(hooksShutdownCwd, hooksSessionIdProvider?.() ?? null)
  }
  await shutdownMcp()
  process.exit(1)
})
