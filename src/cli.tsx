// DCODE CLI 入口。
// 负责：解析命令行参数、加载配置、初始化 Agent 与会话，然后根据模式分流：
//   - 交互模式：渲染 Ink 全屏 TUI（默认）；
//   - 无头模式（-p / --print）：跑完一轮对话并打印结果后退出。
// 同时处理 --version / --help / -c 继续会话 / -r 恢复会话 / --model / --cwd / 权限模式等。
// 安装后通过 dcode 命令启动。
// 制作人：Moriarty_Dox

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
} from './constants.js'
import { loadConfig, ensureConfigDir, type PermissionMode } from './config.js'
import { Agent } from './core/agent.js'
import {
  SessionRecorder,
  getLatestSessionId,
  loadSessionMessages,
} from './core/session.js'
import { runHeadless } from './headless.js'
import { App } from './ui/App.js'
import { messagesToItems } from './ui/messagesToItems.js'

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
        opts.model = argv[++i]
        break
      case '--cwd':
        opts.cwd = argv[++i]
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
    '  -c, --continue              继续当前目录最近一次会话',
    '  -r, --resume [会话id]       恢复指定（或最近）历史会话',
    '  -m, --model <模型>          指定模型（' + SUPPORTED_MODELS.join(' / ') + '）',
    '      --cwd <目录>            指定工作目录',
    '      --plan                  以规划模式启动（只读，不修改文件/不执行命令）',
    '      --auto                  以自动接受编辑模式启动',
    '      --bypass                跳过所有权限确认（危险，同 --dangerously-skip-permissions）',
    '      --dangerously-skip-permissions  跳过所有权限确认（危险）',
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
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

/**
 * CLI 主流程。
 */
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

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
  const config = loadConfig()

  // 命令行覆盖：模型。
  if (opts.model) {
    if (!SUPPORTED_MODELS.includes(opts.model as any)) {
      process.stderr.write(
        `不支持的模型：${opts.model}\n可用模型：${SUPPORTED_MODELS.join('、')}\n`,
      )
      process.exit(1)
    }
    config.model = opts.model
  }

  // 确定工作目录。
  const cwd = opts.cwd ? resolveCwd(opts.cwd) : process.cwd()

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

  // —— 无头模式 —— //
  if (opts.print) {
    // 无头模式不持久化新会话（除非是继续已有会话）。
    const recorder = resumedSessionId
      ? new SessionRecorder(resumedSessionId)
      : null
    const agent = new Agent({
      config,
      cwd,
      recorder,
      initialMessages,
      permissionMode,
    })

    // 缺少 API Key 直接报错退出。
    if (!agent.hasApiKey()) {
      process.stderr.write(
        '错误：未设置 API Key。请设置环境变量 DEEPSEEK_API_KEY，或先以交互模式运行 dcode 并执行 /login。\n',
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

    // 非交互场景默认自动批准操作；--plan/默认模式下工具本身受限。
    const code = await runHeadless(agent, prompt.trim(), {
      autoApprove: permissionMode !== 'default',
    })
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

  // 渲染 Ink 应用，并等待退出。
  const app = render(
    <App
      agent={agent}
      config={config}
      initialItems={initialItems}
      needLogin={needLogin}
    />,
  )
  await app.waitUntilExit()
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
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
    // 读取异常时返回已有数据。
    process.stdin.on('error', () => resolve(data))
  })
}

// 启动主流程；捕获顶层异常以友好退出。
main().catch((err) => {
  process.stderr.write(`\n[${PRODUCT_NAME}] 启动失败：${err?.message ?? String(err)}\n`)
  process.exit(1)
})
