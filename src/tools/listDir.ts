// 目录列举工具（list_dir）。
// 列出指定目录下的文件与子目录，目录名以 / 结尾区分。属于只读工具，无需授权。
// 套用统一忽略规则（.gitignore + .dcodeignore + 默认噪声目录），保持输出聚焦。
// 制作人：Moriarty_Dox

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createIgnoreFilter } from '../core/ignore.js'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { resolveWithinCwd, toDisplayPath } from './util.js'

// list_dir 的入参结构。
interface ListDirInput {
  // 目标目录路径（默认当前工作目录）。
  path?: string
}

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    '列出某个目录下的直接子项（文件与子目录）。目录项以 / 结尾。' +
    '默认忽略 node_modules、.git、dist 等目录，并遵循 .gitignore 与 .dcodeignore。用于了解项目结构。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '要列举的目录路径，默认当前工作目录',
      },
    },
    required: [],
  },
  renderCall: (input: ListDirInput) => `列目录 ${input.path ?? '.'}`,
  /**
   * 执行列举：读取目录项并排序（目录在前，名称升序）。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: ListDirInput, ctx): Promise<ToolResult> => {
    const target = input.path ?? '.'
    const abs = resolveWithinCwd(ctx.cwd, target, ctx.extraDirs)
    if (!existsSync(abs)) {
      return { llmContent: `错误：目录不存在 ${target}`, isError: true }
    }
    const st = statSync(abs)
    if (!st.isDirectory()) {
      return { llmContent: `错误：${target} 不是目录。`, isError: true }
    }

    // 统一忽略过滤器（基于工作根的 .gitignore + .dcodeignore + 默认噪声目录）。
    const ignoreFilter = createIgnoreFilter(ctx.cwd)

    // 读取目录项并区分文件/目录，套用忽略规则。
    const entries = readdirSync(abs)
    const items: { name: string; isDir: boolean }[] = []
    for (const name of entries) {
      try {
        const childAbs = join(abs, name)
        const isDir = statSync(childAbs).isDirectory()
        // 按相对工作根的路径判断是否忽略（目录需带结尾 / 以匹配 "dir/" 规则）。
        if (ignoreFilter.ignores(childAbs, isDir)) continue
        items.push({ name, isDir })
      } catch {
        // 无法 stat 的项（如失效软链）忽略。
      }
    }

    // 排序：目录优先，然后按名称字典序。
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    if (items.length === 0) {
      return {
        llmContent: `目录 ${target} 为空（或仅含被忽略项）。`,
        uiSummary: `列目录 ${toDisplayPath(ctx.cwd, abs)}（空）`,
      }
    }

    const lines = items.map((it) => (it.isDir ? `${it.name}/` : it.name))
    return {
      llmContent: `${target} 目录内容：\n` + lines.join('\n'),
      uiSummary: `列目录 ${toDisplayPath(ctx.cwd, abs)}（${items.length} 项）`,
    }
  },
}
