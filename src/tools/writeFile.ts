// 文件写入工具（write_file）。
// 创建新文件或整体覆盖已有文件内容。属于写操作：
//   - plan 模式禁止执行；
//   - default 模式需用户授权（除非命中白名单）；acceptEdits/bypass 模式自动放行。
// 制作人：Moriarty_Dox

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  buildCheckpointFileDiff,
  completeCheckpointAfterWrite,
  discardPendingCheckpoint,
  saveCheckpointBeforeWrite,
} from '../core/checkpoint.js'
import type { PermissionRequest, ToolDefinition, ToolResult } from '../core/types.js'
import { convertEol, resolveWithinCwd, toDisplayPath, usesCrlf } from './util.js'

// write_file 的入参结构。
interface WriteFileInput {
  // 目标文件路径。
  path: string
  // 要写入的完整内容（会整体覆盖原文件）。
  content: string
}

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '将内容写入文件（创建新文件或整体覆盖已有文件）。会自动创建缺失的父目录。' +
    '若只是局部修改已有文件，优先使用 edit_file 以减少出错。',
  readOnly: false,
  safety: { sideEffect: 'fs_write', parallelSafe: false },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对当前工作目录或绝对路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  renderCall: (input: WriteFileInput) => `写入 ${input.path}`,
  /**
   * 权限检查：写文件默认需要授权。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 需要授权时返回权限请求，否则 null。
   */
  checkPermission: (input: WriteFileInput, ctx): PermissionRequest | null => {
    // acceptEdits / bypass 模式下文件写入自动放行。
    if (ctx.permissionMode === 'acceptEdits' || ctx.permissionMode === 'bypass') {
      return null
    }
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
    const exists = existsSync(abs)
    // 生成 diff 预览供用户确认。
    const oldText = exists ? safeRead(abs) : ''
    const diff = buildCheckpointFileDiff(oldText, matchExistingEol(oldText, input.content))
    const display = toDisplayPath(ctx.cwd, abs)
    return {
      toolName: 'write_file',
      title: `${exists ? '覆盖' : '创建'}文件 ${display}`,
      preview: diff.preview,
      ruleKey: `write_file(${input.path})`,
      details: {
        kind: 'file',
        path: display,
        operation: exists ? 'edit' : 'create',
        hunks: diff.truncated && diff.hunks.length === 0 ? undefined : diff.hunks,
        added: diff.added,
        removed: diff.removed,
      },
    }
  },
  /**
   * 执行写入：自动创建父目录，写入 UTF-8 内容。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: WriteFileInput, ctx): Promise<ToolResult> => {
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
    const exists = existsSync(abs)

    // 确保父目录存在。
    const dir = dirname(abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // 覆盖已有 CRLF 文件时沿用其换行风格，避免整文件换行变化造成大面积 diff。
    const oldText = exists ? safeRead(abs) : ''
    const content = exists ? matchExistingEol(oldText, input.content) : input.content

    const checkpoint = saveCheckpointBeforeWrite(ctx.cwd, abs, 'write_file', ctx)
    try {
      writeFileSync(abs, content, 'utf8')
    } catch (error) {
      if (checkpoint) discardPendingCheckpoint(ctx.cwd, checkpoint.id)
      return { llmContent: `错误：写入 ${input.path} 失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
    const completed = checkpoint && completeCheckpointAfterWrite(ctx.cwd, checkpoint.id, content)
    const warning = completed ? '' : '\n警告：检查点未能完整保存，此次改动无法自动回退。'
    const { added, removed } = buildCheckpointFileDiff(oldText, content)
    const lineCount = input.content.split('\n').length
    const display = toDisplayPath(ctx.cwd, abs)
    return {
      llmContent: `已${exists ? '覆盖' : '创建'}文件 ${input.path}（${lineCount} 行）。${warning}`,
      uiSummary: `${exists ? '覆盖' : '创建'} ${display}（${lineCount} 行）${completed ? '' : '（检查点不可用）'}`,
      changedFiles: [{
        path: display,
        operation: exists ? 'edit' : 'create',
        checkpointId: completed?.id,
        added,
        removed,
      }],
    }
  },
}

/**
 * 原文件使用 CRLF 且新内容为纯 LF 时，把新内容转换为 CRLF；其余情况原样返回。
 * @param oldText 原文件内容。
 * @param content 待写入内容。
 * @returns 换行风格与原文件一致的内容。
 */
function matchExistingEol(oldText: string, content: string): string {
  if (!usesCrlf(oldText) || content.includes('\r\n')) return content
  return convertEol(content, true)
}

/**
 * 安全读取文件文本，失败时返回空串（用于生成 diff 预览时容错）。
 * @param abs 绝对路径。
 * @returns 文件文本或空串。
 */
function safeRead(abs: string): string {
  try {
    return readFileSync(abs, 'utf8')
  } catch {
    return ''
  }
}
