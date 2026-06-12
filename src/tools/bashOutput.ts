// bash_output 工具。
// 通过 shell_id 获取后台 Shell 的当前输出与状态；可选 block_until_ms 阻塞等待、tail 增量输出。
// 制作人：Moriarty_Dox

import { DEFAULT_BASH_OUTPUT_BLOCK_MS } from '../constants.js'
import { shellManager } from '../core/shellManager.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'

/** bash_output 入参。 */
interface BashOutputInput {
  /** 后台 Shell 的 shell_id。 */
  shell_id: string
  /** 阻塞等待毫秒数；0 立即返回当前快照。 */
  block_until_ms?: number
  /** true 时仅返回自上次 tail 查询以来的新增输出。 */
  tail?: boolean
}

export const bashOutputTool: ToolDefinition = {
  name: 'bash_output',
  description:
    '获取后台 Shell 的输出与状态。先用 run_command(background=true) 获得 shell_id，' +
    '再用本工具轮询输出；进程仍在运行时 block_until_ms 可短暂阻塞等待。' +
    '设 tail=true 可只获取自上次查询以来的增量输出，适合长构建日志轮询。' +
    '长任务（构建、训练）应后台启动并周期性查询，避免阻塞主 Agent。',
  readOnly: true,
  safety: { sideEffect: 'none', parallelSafe: true },
  parameters: {
    type: 'object',
    properties: {
      shell_id: {
        type: 'string',
        description: 'run_command(background=true) 返回的 shell_id',
      },
      block_until_ms: {
        type: 'number',
        description: '可选：阻塞等待毫秒数，默认 0（立即返回）',
      },
      tail: {
        type: 'boolean',
        description: '可选：true 时仅返回自上次 tail 查询以来的新增输出',
      },
    },
    required: ['shell_id'],
  },
  renderCall: (input: BashOutputInput) =>
    input.tail ? `增量查询 ${input.shell_id}` : `查询后台输出 ${input.shell_id}`,
  /**
   * 查询后台 Shell 输出快照。
   * @param input 入参。
   * @returns 工具结果。
   */
  run: async (input: BashOutputInput): Promise<ToolResult> => {
    const id = input.shell_id?.trim()
    if (!id) {
      return { llmContent: '错误：shell_id 不能为空。', isError: true }
    }

    const blockMs = input.block_until_ms ?? DEFAULT_BASH_OUTPUT_BLOCK_MS
    const snap = await shellManager.getOutput(id, blockMs, { tail: input.tail })

    return {
      llmContent: snap.formatted,
      uiSummary: snap.found
        ? `Shell ${id}: ${snap.record?.status ?? 'unknown'}${input.tail ? ' (tail)' : ''}`
        : `Shell ${id}: 未找到`,
      isError: snap.isError,
    }
  },
}
