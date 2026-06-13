// 文件名匹配工具（glob）。
// 使用 fast-glob 按 glob 模式查找文件路径，并套用统一忽略规则（.gitignore + .dcodeignore）过滤。
// 属于只读工具。例如 "src/**/*.ts" 可列出所有 TypeScript 源文件。
// 结果按修改时间倒序，便于优先看最新改动。
// 制作人：Moriarty_Dox

import fg from 'fast-glob'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { createIgnoreFilter } from '../core/ignore.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { toDisplayPath, resolveWithinCwd } from './util.js'

// glob 的入参结构。
interface GlobInput {
  // glob 匹配模式，例如 "**/*.ts"。
  pattern: string
  // 搜索的基准目录（默认当前工作目录）。
  path?: string
}

// 返回结果的最大条数，防止超大仓库刷屏。
const MAX_RESULTS = 200

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    '按 glob 模式查找文件，返回匹配的文件路径列表（按最近修改时间排序）。' +
    '例如 pattern="src/**/*.ts" 查找所有 ts 文件。会自动遵循 .gitignore 与 .dcodeignore 过滤。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 匹配模式，如 **/*.ts' },
      path: { type: 'string', description: '搜索基准目录，默认当前工作目录' },
    },
    required: ['pattern'],
  },
  renderCall: (input: GlobInput) => `查找 ${input.pattern}`,
  /**
   * 执行匹配：调用 fast-glob 搜索，套用 .gitignore/.dcodeignore 过滤，按 mtime 排序后截断。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: GlobInput, ctx): Promise<ToolResult> => {
    let searchCwd: string
    try {
      searchCwd = input.path ? resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs) : ctx.cwd
    } catch (e: any) {
      return { llmContent: `错误：${e.message}`, isError: true }
    }

    // 统一忽略过滤器（基于工作根的 .gitignore + .dcodeignore + 默认噪声目录）。
    const ignoreFilter = createIgnoreFilter(ctx.cwd)

    // 执行 glob 搜索：fast-glob 阶段用默认噪声目录做快速粗过滤。
    const matches = await fg(input.pattern, {
      cwd: searchCwd,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ignoreFilter.globIgnorePatterns(),
      absolute: false,
    })

    // 精确过滤：将相对 searchCwd 的结果换算为相对工作根的路径后套用忽略规则。
    const filtered = matches.filter((rel) => {
      const abs = join(searchCwd, rel)
      return !ignoreFilter.ignores(abs)
    })

    if (filtered.length === 0) {
      return {
        llmContent: `没有匹配 "${input.pattern}" 的文件。`,
        uiSummary: `查找 ${input.pattern}（0 个结果）`,
      }
    }

    // 按修改时间倒序排序，优先展示最近改动的文件。
    const withMtime = filtered.map((rel) => {
      let mtime = 0
      try {
        mtime = statSync(join(searchCwd, rel)).mtimeMs
      } catch {
        // 忽略 stat 失败。
      }
      return { rel, mtime }
    })
    withMtime.sort((a, b) => b.mtime - a.mtime)

    const total = withMtime.length
    const shown = withMtime.slice(0, MAX_RESULTS).map((x) => x.rel)
    const note =
      total > MAX_RESULTS ? `\n（共 ${total} 个，仅显示前 ${MAX_RESULTS} 个）` : ''

    return {
      llmContent: shown.join('\n') + note,
      uiSummary: `查找 ${input.pattern}（${total} 个结果）`,
    }
  },
}
