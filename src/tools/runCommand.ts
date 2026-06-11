// 命令执行工具（run_command）。
// 在当前工作目录下执行 Shell 命令，跨平台自动选择解释器（Windows → PowerShell，类 Unix → /bin/sh）。
// 这是最敏感的工具：
//   - plan 模式禁止执行；
//   - 任何非只读命令默认都需要用户授权（除非命中白名单或处于 bypass 模式）；
//   - 通过 onProgress 实时回传输出，便于 UI 展示长命令进度；
//   - 支持超时与用户中断（abortSignal）。
// 制作人：Moriarty_Dox

import { spawn } from 'node:child_process'
import { DEFAULT_COMMAND_TIMEOUT_MS } from '../constants.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { truncate } from './util.js'

// run_command 的入参结构。
interface RunCommandInput {
  // 要执行的命令字符串。
  command: string
  // 一句话说明该命令的用途（便于在授权弹窗中展示）。
  description?: string
  // 超时时间（毫秒），可选。
  timeout?: number
}

// 命令输出回传给模型的最大字符数。
const MAX_OUTPUT_CHARS = 30000

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
    '注意：不要用它来读写文件（请用 read_file/write_file/edit_file）。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      description: { type: 'string', description: '命令用途的简短说明（5-10 字）' },
      timeout: { type: 'number', description: '超时毫秒数，默认 120000' },
    },
    required: ['command'],
  },
  renderCall: (input: RunCommandInput) => `$ ${input.command}`,
  /**
   * 权限检查：命令执行默认需要授权；bypass 模式放行。
   */
  checkPermission: (input: RunCommandInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'bypass') return null
    // 判断是否为危险命令，用于在标题中提示。
    const dangerous = DANGEROUS_PATTERNS.some((re) => re.test(input.command))
    return {
      toolName: 'run_command',
      title:
        (dangerous ? '⚠ 危险命令 ' : '执行命令') +
        (input.description ? `：${input.description}` : ''),
      preview: `$ ${input.command}`,
      // 规则键精确到具体命令，便于“总是允许某条命令”。
      ruleKey: `run_command(${input.command})`,
    }
  },
  /**
   * 执行命令：spawn 子进程，合并捕获输出，处理超时与中断。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果（含退出码与输出）。
   */
  run: async (input: RunCommandInput, ctx): Promise<ToolResult> => {
    const timeoutMs = input.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS

    // 根据平台选择解释器与参数。
    const isWindows = process.platform === 'win32'
    const shell = isWindows ? 'powershell.exe' : '/bin/sh'
    const args = isWindows
      ? ['-NoProfile', '-NonInteractive', '-Command', input.command]
      : ['-c', input.command]

    return await new Promise<ToolResult>((resolvePromise) => {
      // 启动子进程；cwd 固定为工作目录。
      const child = spawn(shell, args, {
        cwd: ctx.cwd,
        env: process.env,
        windowsHide: true,
      })

      let output = ''
      let killedByTimeout = false
      let killedByAbort = false

      // 超时定时器：到点强制终止子进程。
      const timer = setTimeout(() => {
        killedByTimeout = true
        child.kill('SIGKILL')
      }, timeoutMs)

      // 中断处理：用户取消时杀掉子进程。
      const onAbort = () => {
        killedByAbort = true
        child.kill('SIGKILL')
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      // 收集 stdout，并通过 onProgress 实时回传。
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        ctx.onProgress?.(text)
      })
      // stderr 与 stdout 合并（很多工具把进度打到 stderr）。
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        output += text
        ctx.onProgress?.(text)
      })

      // 子进程结束：清理定时器与监听器，组装结果。
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
            uiSummary: `命令超时`,
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

      // 启动失败（如解释器不存在）。
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
  },
}
