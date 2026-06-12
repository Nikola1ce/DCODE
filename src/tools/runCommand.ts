// 命令执行工具（run_command）。
// 在当前工作目录下执行 Shell 命令，跨平台自动选择解释器（Windows → PowerShell，类 Unix → /bin/sh）。
// 支持 foreground（阻塞等待）与 background（立即返回 shell_id）两种模式。
// 这是最敏感的工具：
//   - plan 模式禁止执行；
//   - 任何非只读命令默认都需要用户授权（除非命中白名单或处于 bypass 模式）；
//   - 通过 onProgress 实时回传输出，便于 UI 展示长命令进度；
//   - 支持超时与用户中断（abortSignal）。
// 制作人：Moriarty_Dox

import { DEFAULT_COMMAND_TIMEOUT_MS } from '../constants.js'
import { shellManager, spawnShellProcess } from '../core/shellManager.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { truncate } from './util.js'

// run_command 的入参结构。
interface RunCommandInput {
  // 要执行的命令字符串。
  command: string
  // 一句话说明该命令的用途（便于在授权弹窗中展示）。
  description?: string
  // 超时时间（毫秒），可选；仅 foreground 模式生效。
  timeout?: number
  // 后台运行：立即返回 shell_id，不阻塞主 Agent。
  background?: boolean
}

// 命令输出回传给模型的最大字符数。
const MAX_OUTPUT_CHARS = 30000
// 子进程运行期间内存中允许累积的最大输出字符数（超出后丢弃后续增量）。
const MAX_IN_MEMORY_OUTPUT_CHARS = MAX_OUTPUT_CHARS * 4

// 一组明显危险的命令模式，命中时在授权标题中加红色警示词。
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bRemove-Item\b.*-Recurse/i,
  /\bformat\b/i,
  /\bmkfs\b/,
  /:\s*\(\)\s*\{/, // fork bomb
  /\bdd\s+if=/,
  /\b(shutdown|reboot)\b/i,
]

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    '在当前工作目录执行一条 Shell 命令并返回其输出（stdout/stderr 合并）。' +
    'Windows 上使用 PowerShell，类 Unix 上使用 /bin/sh。' +
    '适合运行测试、构建、git、安装依赖等。请在 description 中简要说明命令用途。' +
    '长耗时任务（构建、训练）请设 background=true，获得 shell_id 后用 bash_output 轮询、kill_shell 终止。' +
    '注意：不要用它来读写文件（请用 read_file/write_file/edit_file）。',
  readOnly: false,
  safety: { sideEffect: 'shell', parallelSafe: false },
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      description: { type: 'string', description: '命令用途的简短说明（5-10 字）' },
      timeout: { type: 'number', description: '超时毫秒数（foreground），默认 120000' },
      background: {
        type: 'boolean',
        description: 'true 时后台运行，立即返回 shell_id',
      },
    },
    required: ['command'],
  },
  renderCall: (input: RunCommandInput) =>
    input.background ? `[后台] $ ${input.command}` : `$ ${input.command}`,
  /**
   * 权限检查：命令执行默认需要授权；bypass 模式放行。
   */
  checkPermission: (input: RunCommandInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'bypass') return null
    const dangerous = DANGEROUS_PATTERNS.some((re) => re.test(input.command))
    const bg = input.background ? '[后台] ' : ''
    return {
      toolName: 'run_command',
      title:
        (dangerous ? '⚠ 危险命令 ' : '执行命令') +
        (input.description ? `：${input.description}` : ''),
      preview: `${bg}$ ${input.command}`,
      ruleKey: `run_command(${input.command})`,
    }
  },
  /**
   * 执行命令：foreground 阻塞等待，background 立即返回 shell_id。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: RunCommandInput, ctx): Promise<ToolResult> => {
    if (input.background) {
      const shellId = shellManager.spawnBackground({
        command: input.command,
        cwd: ctx.cwd,
        description: input.description,
        onOutput: (text) => ctx.onProgress?.(text),
      })
      return {
        llmContent:
          `后台命令已启动。\n` +
          `shell_id: ${shellId}\n` +
          `命令: $ ${input.command}\n\n` +
          `使用 bash_output(shell_id="${shellId}") 获取输出；` +
          `kill_shell(shell_id="${shellId}") 可终止进程。`,
        uiSummary: `[后台] $ ${input.command} → ${shellId}`,
      }
    }

    return runForegroundCommand(input, ctx)
  },
}

/**
 * 前台阻塞执行命令：spawn 子进程，合并捕获输出，处理超时与中断。
 * @param input 入参。
 * @param ctx 运行上下文。
 * @returns 工具结果。
 */
async function runForegroundCommand(
  input: RunCommandInput,
  ctx: { cwd: string; abortSignal: AbortSignal; onProgress?: (text: string) => void },
): Promise<ToolResult> {
  const timeoutMs = input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS
  const child = spawnShellProcess(input.command, ctx.cwd)

  return await new Promise<ToolResult>((resolvePromise) => {
    let output = ''
    let killedByTimeout = false
    let killedByAbort = false

    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const onAbort = () => {
      killedByAbort = true
      child.kill('SIGKILL')
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (output.length < MAX_IN_MEMORY_OUTPUT_CHARS) {
        const room = MAX_IN_MEMORY_OUTPUT_CHARS - output.length
        output += text.slice(0, room)
      }
      ctx.onProgress?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      if (output.length < MAX_IN_MEMORY_OUTPUT_CHARS) {
        const room = MAX_IN_MEMORY_OUTPUT_CHARS - output.length
        output += text.slice(0, room)
      }
      ctx.onProgress?.(text)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)

      const trimmed = truncate(output.trim(), MAX_OUTPUT_CHARS)

      if (killedByAbort) {
        resolvePromise({
          llmContent: `命令被用户中断。\n已捕获的输出：\n${trimmed}`,
          isError: true,
          uiSummary: '命令已中断',
        })
        return
      }
      if (killedByTimeout) {
        resolvePromise({
          llmContent: `命令超时（${timeoutMs}ms）被终止。\n已捕获的输出：\n${trimmed}`,
          isError: true,
          uiSummary: '命令超时',
        })
        return
      }

      const ok = code === 0
      const header = ok
        ? `命令执行成功（退出码 0）。`
        : `命令退出码为 ${code}（可能失败）。`
      resolvePromise({
        llmContent: `${header}\n输出：\n${trimmed || '（无输出）'}`,
        isError: !ok,
        uiSummary: `$ ${input.command}  → 退出码 ${code}`,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      resolvePromise({
        llmContent: `无法启动命令：${err.message}`,
        isError: true,
        uiSummary: '命令启动失败',
      })
    })
  })
}
