// 无头（非交互）模式执行器。
// 对应 dcode -p "任务"：在不启动 TUI 的情况下跑完一轮 Agent 对话，把结果打印到标准输出，
// 适合脚本、CI、管道等自动化场景。工具进度打印到 stderr，最终回答打印到 stdout。
// 制作人：Moriarty_Dox

import type { Agent } from './core/agent.js'
import type { PermissionDecision, PermissionRequest } from './core/types.js'

// 无头执行选项。
export interface HeadlessOptions {
  // 是否自动批准所有权限请求（默认 true：非交互场景直接执行）。
  autoApprove: boolean
}

/**
 * 在无头模式下执行一轮对话。
 * @param agent Agent 实例。
 * @param prompt 用户任务文本。
 * @param options 执行选项。
 * @returns 退出码（0 成功，1 失败）。
 */
export async function runHeadless(
  agent: Agent,
  prompt: string,
  options: HeadlessOptions,
): Promise<number> {
  // 权限策略：自动批准则放行，否则一律拒绝（避免脚本卡住等待输入）。
  const requestPermission = async (
    req: PermissionRequest,
  ): Promise<PermissionDecision> => {
    if (options.autoApprove) return 'allow_once'
    process.stderr.write(`[已拒绝需授权的操作] ${req.title}\n`)
    return 'deny'
  }

  // 无头模式不响应键盘中断信号到 abort（保持简单）；仍提供一个未触发的控制器。
  const ac = new AbortController()
  // 支持 Ctrl+C 中断。
  const onSigint = () => ac.abort()
  process.on('SIGINT', onSigint)

  try {
    await agent.runTurn(prompt, {
      // 正文直接流式打印到 stdout。
      onText: (d) => process.stdout.write(d),
      // 工具调用信息打印到 stderr，不污染 stdout 的结果。
      onToolStart: (info) => process.stderr.write(`\n[工具] ${info.summary}\n`),
      onToolEnd: (info) => {
        if (info.result.isError) {
          process.stderr.write(`[工具失败] ${info.result.uiSummary ?? ''}\n`)
        } else if (info.result.uiSummary) {
          process.stderr.write(`[完成] ${info.result.uiSummary}\n`)
        }
      },
      onCompacting: () => process.stderr.write('[压缩上下文中…]\n'),
      requestPermission,
      abortSignal: ac.signal,
    })
    // 收尾换行，保证输出整洁。
    process.stdout.write('\n')
    return 0
  } catch (e: any) {
    process.stderr.write(`\n错误：${e?.message ?? String(e)}\n`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
  }
}
