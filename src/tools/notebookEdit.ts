// Notebook 编辑工具（notebook_edit）。
// 对 Jupyter .ipynb 做 cell 级别的增删改，避免模型手工拼接 JSON 造成结构损坏。
// 支持三种模式（mode）：
//   - replace（默认）：用 source 覆盖指定 cell 的源码（保留其原 cell_type 与其它字段）。
//   - insert：在 cell 指定位置前插入一个新 cell（需 source；cell_type 默认 code）。
//   - delete：删除指定 cell（忽略 source）。
// 写操作约束（与 write_file / edit_file 一致）：
//   - plan 模式禁止执行；default 模式需用户授权（附 diff 预览）；acceptEdits/bypass 自动放行；
//   - 写回前创建检查点（checkpoint 工具名 notebook_edit），支持 /undo 回退。
// 解析/序列化/渲染等公共能力复用 ./notebook.js，回写时尽量保留 notebook 其它字段不丢失。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { saveCheckpointBeforeWrite } from '../core/checkpoint.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { buildDiffPreviewView } from './diff.js'
import {
  makeCell,
  NOTEBOOK_CELL_TYPES,
  type NotebookCellType,
  normalizeSource,
  parseNotebook,
  splitSourceToLines,
  stringifyNotebook,
} from './notebook.js'
import { resolveWithinCwd, toDisplayPath } from './util.js'

// notebook_edit 编辑模式。
export type NotebookEditMode = 'replace' | 'insert' | 'delete'

// notebook_edit 的入参结构（同时用于工具入参与内部 applyNotebookEdit）。
export interface NotebookEditInput {
  // 目标 .ipynb 文件路径。
  path: string
  // 编辑模式，默认 replace。
  mode?: NotebookEditMode
  // 目标 cell 序号（0 基）。replace/delete 必填；insert 省略则追加到末尾。
  cell?: number
  // 新的源码/文本内容（replace 与 insert 必填；delete 忽略）。
  source?: string
  // 新 cell 类型（仅 insert 使用；省略默认 code）。
  cell_type?: NotebookCellType
}

export const notebookEditTool: ToolDefinition = {
  name: 'notebook_edit',
  description:
    '对 Jupyter Notebook（.ipynb）做 cell 级编辑，比手工改 JSON 更安全。' +
    'mode=replace（默认）用 source 覆盖第 cell 个 cell 的源码；' +
    'mode=insert 在第 cell 个位置前插入新 cell（需 source，cell_type 默认 code；省略 cell 则追加到末尾）；' +
    'mode=delete 删除第 cell 个 cell。cell 为 0 基序号。' +
    '编辑前请先用 notebook_read 查看 cell 序号与内容。',
  readOnly: false,
  safety: { sideEffect: 'fs_write', parallelSafe: false },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '.ipynb 文件路径，相对当前工作目录或绝对路径' },
      mode: {
        type: 'string',
        enum: ['replace', 'insert', 'delete'],
        description: '编辑模式：replace（默认）/ insert / delete',
      },
      cell: {
        type: 'number',
        description: '目标 cell 序号（0 基）。replace/delete 必填；insert 省略则追加到末尾',
      },
      source: {
        type: 'string',
        description: '新的 cell 源码/文本（replace 与 insert 必填，delete 忽略）',
      },
      cell_type: {
        type: 'string',
        enum: ['code', 'markdown', 'raw'],
        description: '新 cell 类型，仅 insert 使用；省略默认 code',
      },
    },
    required: ['path'],
  },
  renderCall: (input: NotebookEditInput) => {
    const mode = input.mode ?? 'replace'
    const at = input.cell !== undefined ? ` #${input.cell}` : ''
    return `编辑 Notebook ${input.path} [${mode}${at}]`
  },
  /**
   * 权限检查：写 notebook 默认需要授权，并尽量附带 diff 预览。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 需要授权时返回权限请求，否则 null。
   */
  checkPermission: (input: NotebookEditInput, ctx): PermissionRequest | null => {
    if (ctx.permissionMode === 'acceptEdits' || ctx.permissionMode === 'bypass') {
      return null
    }
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
    // 预先计算编辑后的文本以生成 diff；任何失败都不附预览（不阻断授权流程）。
    let preview: string | undefined
    try {
      const oldRaw = readFileSync(abs, 'utf8')
      const { newText } = applyNotebookEdit(oldRaw, input)
      // 使用增强 diff 视图（带行号 + hunk 头 + 折叠），与 write_file/edit_file 的「终端 Diff 查看器」一致。
      preview = buildDiffPreviewView(oldRaw, newText)
    } catch {
      preview = undefined
    }
    const mode = input.mode ?? 'replace'
    return {
      toolName: 'notebook_edit',
      title: `编辑 Notebook ${toDisplayPath(ctx.cwd, abs)}（${mode}${input.cell !== undefined ? ` cell #${input.cell}` : ''}）`,
      preview,
      ruleKey: `notebook_edit(${input.path})`,
    }
  },
  /**
   * 执行编辑：读取并解析 notebook、应用增删改、写回并创建检查点。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: NotebookEditInput, ctx): Promise<ToolResult> => {
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
    if (!existsSync(abs)) {
      return { llmContent: `错误：文件不存在 ${input.path}`, isError: true }
    }

    const oldRaw = readFileSync(abs, 'utf8')

    // 应用编辑：内部以抛错形式返回校验失败，这里统一转成 isError 结果。
    let newText: string
    let summary: string
    try {
      const applied = applyNotebookEdit(oldRaw, input)
      newText = applied.newText
      summary = applied.summary
    } catch (e: any) {
      return { llmContent: `错误：${e.message}`, isError: true }
    }

    // 写回前创建检查点，供 /undo 回退。
    saveCheckpointBeforeWrite(ctx.cwd, abs, 'notebook_edit')
    writeFileSync(abs, newText, 'utf8')

    const display = toDisplayPath(ctx.cwd, abs)
    return {
      llmContent: `${summary}（${display}）`,
      uiSummary: `编辑 Notebook ${display}（${summary}）`,
    }
  },
}

/**
 * 在 .ipynb 文本上应用一次增删改，返回写回文本与人类可读摘要。
 * 纯函数（不触磁盘）：既被工具的权限预览复用，也被实际写入复用，保证「预览==结果」。
 * 校验失败一律抛出带中文说明的 Error，方便上层转成工具错误或模型自我纠正。
 * @param jsonText 现有 .ipynb 文件文本。
 * @param input 编辑入参（path 仅用于消息，不参与计算）。
 * @returns { newText: 写回文本; summary: 操作摘要 }。
 */
function applyNotebookEdit(
  jsonText: string,
  input: NotebookEditInput,
): { newText: string; summary: string } {
  const mode: NotebookEditMode = input.mode ?? 'replace'
  const nb = parseNotebook(jsonText)
  const total = nb.cells.length

  if (mode === 'delete') {
    const idx = requireCellIndex(input.cell)
    assertInRange(idx, total, '删除')
    const removed = nb.cells[idx]
    nb.cells.splice(idx, 1)
    return {
      newText: stringifyNotebook(nb),
      summary: `删除 cell ${idx}（原类型 ${removed.cell_type}），剩余 ${nb.cells.length} 个 cell`,
    }
  }

  if (mode === 'insert') {
    // 源码必填。
    if (input.source === undefined) {
      throw new Error('insert 模式需要提供 source（cell 源码）。')
    }
    // cell_type 默认 code，并校验合法性。
    const cellType = input.cell_type ?? 'code'
    if (!NOTEBOOK_CELL_TYPES.includes(cellType)) {
      throw new Error(`非法 cell_type：${cellType}（应为 ${NOTEBOOK_CELL_TYPES.join('/')}）。`)
    }
    // 插入位置：省略则追加到末尾；给定则校验非负并夹紧到 [0,total]。
    let at: number
    if (input.cell === undefined) {
      at = total
    } else {
      if (!Number.isInteger(input.cell) || input.cell < 0) {
        throw new Error(`非法的插入位置 cell=${input.cell}（应为非负整数）。`)
      }
      at = Math.min(input.cell, total)
    }
    const newCell = makeCell(cellType, input.source)
    nb.cells.splice(at, 0, newCell)
    return {
      newText: stringifyNotebook(nb),
      summary: `在位置 ${at} 插入 ${cellType} cell，现共 ${nb.cells.length} 个 cell`,
    }
  }

  // mode === 'replace'
  const idx = requireCellIndex(input.cell)
  if (input.source === undefined) {
    throw new Error('replace 模式需要提供 source（cell 源码）。')
  }
  assertInRange(idx, total, '替换')

  // 在原 cell 上就地更新，保留其 cell_type、metadata、id 等其它字段。
  const cell = nb.cells[idx]
  cell.source = splitSourceToLines(input.source)
  // 改了源码后，code cell 的旧输出与执行计数已失效，清空以免误导。
  if (cell.cell_type === 'code') {
    cell.outputs = []
    cell.execution_count = null
  }
  // 复用 normalizeSource 计算行数，便于摘要展示（也避免该导入未被使用）。
  const lineCount = normalizeSource(cell.source).split('\n').length
  return {
    newText: stringifyNotebook(nb),
    summary: `替换 cell ${idx}（${cell.cell_type}，${lineCount} 行）`,
  }
}

/**
 * 校验并返回 cell 索引；缺失时抛出「索引」相关错误。
 * @param cell 入参中的 cell 序号。
 * @returns 合法的 cell 索引。
 */
function requireCellIndex(cell: number | undefined): number {
  if (cell === undefined) {
    throw new Error('该操作需要提供 cell 索引（0 基序号）。')
  }
  if (!Number.isInteger(cell) || cell < 0) {
    throw new Error(`非法的 cell 索引：${cell}（应为非负整数）。`)
  }
  return cell
}

/**
 * 校验索引落在 [0, total) 内，否则抛出「超出范围」错误。
 * @param idx cell 索引。
 * @param total cell 总数。
 * @param action 操作名（用于错误文案，如「替换」「删除」）。
 */
function assertInRange(idx: number, total: number, action: string): void {
  if (idx >= total) {
    throw new Error(`cell 索引 ${idx} 超出范围（可${action}范围 0~${total - 1}）。`)
  }
}

// 供单元测试访问内部纯函数（不对外作为公共 API）。
export const __test = { applyNotebookEdit }
