// 文件读取工具（read_file）。
// 读取工作目录内的文本文件，可选行偏移与行数限制，返回带行号的内容，便于模型精确引用。
// 属于只读工具：在 plan 模式下仍允许执行，且无需用户授权。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, statSync } from 'node:fs'
import { MAX_FILE_READ_CHARS } from '../constants.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { addLineNumbers, resolveWithinCwd, toDisplayPath } from './util.js'

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
  safety: { sideEffect: 'none', parallelSafe: true },
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
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
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
    // 含 NUL 字符的大概率是二进制文件，按文本输出只会是乱码并浪费上下文。
    if (content.includes('\u0000')) {
      return {
        llmContent: `错误：${input.path} 是二进制文件（${st.size} 字节），无法按文本读取。`,
        isError: true,
      }
    }

    // 处理可选的行范围切片。
    let startLine = 1
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = content.split(/\r?\n/)
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

    // 超长内容按整行截断，防止撑爆上下文，并告诉模型从哪一行继续读。
    const numbered = addLineNumbers(content, startLine)
    const finalText = truncateByLines(numbered, MAX_FILE_READ_CHARS, startLine)

    return {
      llmContent: finalText,
      uiSummary: `读取 ${toDisplayPath(ctx.cwd, abs)}（${content.split(/\r?\n/).length} 行）`,
    }
  },
}

/**
 * 按整行截断带行号的文本：不在行中间切断，并提示下一次读取的 offset。
 * @param numbered 带行号的文本。
 * @param maxChars 最大字符数。
 * @param startLine 本次读取的起始行号（1 基）。
 * @returns 截断后的文本（未超限时原样返回）。
 */
function truncateByLines(numbered: string, maxChars: number, startLine: number): string {
  if (numbered.length <= maxChars) return numbered
  const cut = numbered.lastIndexOf('\n', maxChars)
  // 单行就超限（如压缩文件）时只能按字符截断。
  const head = cut > 0 ? numbered.slice(0, cut) : numbered.slice(0, maxChars)
  const shownLines = head.split('\n').length
  const nextOffset = startLine + shownLines
  return (
    `${head}\n\n... [内容过长已截断：本次显示到第 ${nextOffset - 1} 行。` +
    `如需后续内容，请用 offset=${nextOffset} 继续读取，或先用 grep 定位目标位置] ...`
  )
}
