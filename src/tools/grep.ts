// 内容搜索工具（grep）。
// 在工作目录内按正则表达式搜索文件内容，返回匹配的文件、行号与行文本。属于只读工具。
// 为保证跨平台一致性，使用纯 JS（fast-glob 收集文件 + RegExp 逐行匹配），不依赖系统 ripgrep。
// 制作人：Moriarty_Dox

import fg from 'fast-glob'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createIgnoreFilter } from '../core/ignore.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { resolveWithinCwd } from './util.js'

// grep 的入参结构。
interface GrepInput {
  // 要搜索的正则表达式（JavaScript 语法）。
  pattern: string
  // 限定文件的 glob（如 "*.ts"），可选。
  include?: string
  // 搜索基准目录，默认工作目录。
  path?: string
  // 是否忽略大小写，默认 false。
  ignore_case?: boolean
}

// 最多扫描的文件数与匹配结果数，避免大仓库卡顿/刷屏。
const MAX_FILES = 2000
const MAX_MATCHES = 200
// 单文件大小上限（字节）：超过则跳过，避免读超大二进制/日志。
const MAX_FILE_SIZE = 1024 * 1024

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    '在工作目录内按正则表达式搜索文件内容，返回 文件:行号:内容 形式的匹配。' +
    '可用 include 限定文件类型（如 "*.ts"）。适合查找函数定义、字符串引用等。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（JavaScript 语法）' },
      include: { type: 'string', description: '限定文件的 glob，如 *.ts 或 src/**/*.js' },
      path: { type: 'string', description: '搜索基准目录，默认当前工作目录' },
      ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
    },
    required: ['pattern'],
  },
  renderCall: (input: GrepInput) => `搜索 /${input.pattern}/`,
  /**
   * 执行搜索：编译正则 -> 收集候选文件 -> 逐行匹配 -> 截断结果。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: GrepInput, ctx): Promise<ToolResult> => {
    // 编译正则；非法表达式给出明确错误。
    let regex: RegExp
    try {
      regex = new RegExp(input.pattern, input.ignore_case ? 'i' : '')
    } catch (e: any) {
      return { llmContent: `错误：无效的正则表达式：${e.message}`, isError: true }
    }

    let searchRoot: string
    try {
      searchRoot = input.path ? resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs) : ctx.cwd
    } catch (e: any) {
      return { llmContent: `错误：${e.message}`, isError: true }
    }
    const pattern = input.include ?? '**/*'

    // 统一忽略过滤器（基于工作根的 .gitignore + .dcodeignore + 默认噪声目录）。
    const ignoreFilter = createIgnoreFilter(ctx.cwd)

    // 收集候选文件列表（fast-glob 阶段先用默认噪声目录粗过滤）。
    const files = await fg(pattern, {
      cwd: searchRoot,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      ignore: ignoreFilter.globIgnorePatterns(),
      absolute: false,
    })

    const results: string[] = []
    let matchedFiles = 0
    let scanned = 0

    for (const rel of files) {
      if (scanned >= MAX_FILES) break
      if (results.length >= MAX_MATCHES) break

      const abs = join(searchRoot, rel)
      // 精确过滤：套用 .gitignore/.dcodeignore（被忽略的文件不计入扫描配额）。
      if (ignoreFilter.ignores(abs)) continue
      scanned++

      try {
        // 跳过超大文件，避免读取二进制/巨型日志。
        if (statSync(abs).size > MAX_FILE_SIZE) continue
        const content = readFileSync(abs, 'utf8')
        // 含 NUL 字符的大概率是二进制，跳过。
        if (content.includes('\u0000')) continue

        const lines = content.split('\n')
        let fileHasMatch = false
        for (let i = 0; i < lines.length; i++) {
          if (results.length >= MAX_MATCHES) break
          // 每行独立测试，重置 lastIndex（此处未用 g 标志，无需重置）。
          if (regex.test(lines[i])) {
            results.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
            fileHasMatch = true
          }
        }
        if (fileHasMatch) matchedFiles++
      } catch {
        // 读取失败的文件忽略。
      }
    }

    if (results.length === 0) {
      return {
        llmContent: `没有匹配 /${input.pattern}/ 的内容。`,
        uiSummary: `搜索 /${input.pattern}/（0 处匹配）`,
      }
    }

    const note =
      results.length >= MAX_MATCHES
        ? `\n（结果过多，仅显示前 ${MAX_MATCHES} 处）`
        : ''
    return {
      llmContent: results.join('\n') + note,
      uiSummary: `搜索 /${input.pattern}/（${results.length} 处，${matchedFiles} 个文件）`,
    }
  },
}
