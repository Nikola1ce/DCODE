// 文件读取工具（read_file）。
// 读取工作目录内的文本文件，可选行偏移与行数限制，返回带行号的内容，便于模型精确引用。
// 属于只读工具：在 plan 模式下仍允许执行，且无需用户授权。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, statSync } from 'node:fs'
import { MAX_FILE_READ_CHARS } from '../constants.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { addLineNumbers, resolveWithinCwd, toDisplayPath, truncate } from './util.js'

// read_file 的入参结构。
interface ReadFileInput {
  // 目标文件路径（相对工作目录或绝对路径，需在工作目录内）。
  path: string
  // 起始行（1 基，可选）。
  offset?: number
  // 读取行数上限（可选）。
  limit?: number
}

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    '读取工作目录内某个文本文件的内容，返回带行号的文本。适合在编辑前先查看文件。' +
    '可用 offset/limit 分段读取超大文件。无法读取目录（请用 list_dir）。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对当前工作目录或绝对路径' },
      offset: { type: 'number', description: '起始行号（1 基），用于分段读取大文件' },
      limit: { type: 'number', description: '最多读取的行数' },
    },
    required: ['path'],
  },
  // 生成调用摘要，例如 “读取 src/index.ts”。
  renderCall: (input: ReadFileInput) => `读取 ${input.path}`,
  /**
   * 执行读取：校验路径与存在性，按需切片行范围，返回带行号文本。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: ReadFileInput, ctx): Promise<ToolResult> => {
    const abs = resolveWithinCwd(ctx.cwd, input.path)
    if (!existsSync(abs)) {
      return { llmContent: `错误：文件不存在 ${input.path}`, isError: true }
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      return {
        llmContent: `错误：${input.path} 是目录，请使用 list_dir 工具列出目录内容。`,
        isError: true,
      }
    }

    // 读取全文（文本模式）。
    let content = readFileSync(abs, 'utf8')

    // 处理可选的行范围切片。
    let startLine = 1
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = content.split('\n')
      const totalLines = lines.length
      const start = Math.max(0, (input.offset ?? 1) - 1)
      if (start >= totalLines) {
        return {
          llmContent: `错误：offset ${input.offset ?? 1} 超出文件范围（共 ${totalLines} 行）。`,
          isError: true,
        }
      }
      const end =
        input.limit !== undefined
          ? Math.min(start + input.limit, totalLines)
          : lines.length
      content = lines.slice(start, end).join('\n')
      startLine = start + 1
    }

    // 空文件给出明确提示，避免模型误判读取失败。
    if (content.length === 0) {
      return { llmContent: '（文件为空）', uiSummary: `读取 ${toDisplayPath(ctx.cwd, abs)}（空文件）` }
    }

    // 超长内容截断，防止撑爆上下文。
    const numbered = addLineNumbers(content, startLine)
    const finalText = truncate(numbered, MAX_FILE_READ_CHARS)

    return {
      llmContent: finalText,
      uiSummary: `读取 ${toDisplayPath(ctx.cwd, abs)}（${content.split('\n').length} 行）`,
    }
  },
}
