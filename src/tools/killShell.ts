// kill_shell 工具。
// 通过 shell_id 终止仍在运行的后台 Shell 进程。
// 制作人：Moriarty_Dox

import { shellManager } from '../core/shellManager.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'

/** kill_shell 入参。 */
interface KillShellInput {
  /** 要终止的后台 Shell id。 */
  shell_id: string
}

export const killShellTool: ToolDefinition = {
  name: 'kill_shell',
  description:
    '终止指定 shell_id 的后台 Shell 进程。仅对 status=running 的进程有效；' +
    '已结束的 Shell 无需 kill。终止前请确认该进程可以安全停止。',
  readOnly: false,
  parameters: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: '要终止的后台 Shell id',
      },
    },
    required: ['shell_id'],
  },
  renderCall: (input: KillShellInput) => `终止后台 Shell ${input.shell_id}`,
  /**
   * 终止后台 Shell 需用户授权（与 run_command 同级敏感操作）。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 权限请求或 null。
   */
  checkPermission: (input: KillShellInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'bypass') return null
    const record = shellManager.getShell(input.shell_id?.trim() ?? '')
    const cmd = record?.command ?? input.shell_id
    return {
      toolName: 'kill_shell',
      title: `终止后台进程 ${input.shell_id}`,
      preview: record ? `$ ${cmd}` : `shell_id: ${input.shell_id}`,
      ruleKey: `kill_shell(${input.shell_id})`,
    }
  },
  /**
   * 执行终止操作。
   * @param input 入参。
   * @returns 工具结果。
   */
  run: async (input: KillShellInput): Promise<ToolResult> => {
    const id = input.shell_id?.trim()
    if (!id) {
      return { llmContent: '错误：shell_id 不能为空。', isError: true }
    }

    const result = shellManager.kill(id)
    const snap = await shellManager.getOutput(id)

    return {
      llmContent: result.ok
        ? `${result.message}\n\n${snap.formatted}`
        : result.message,
      uiSummary: result.ok ? `已终止 ${id}` : `终止失败: ${id}`,
      isError: !result.ok,
    }
  },
}
