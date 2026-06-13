// Notebook 读取工具（notebook_read）。
// 读取工作目录内的 Jupyter .ipynb 文件，解析其 cell 结构并渲染为「Markdown + Code 混合视图」，
// 便于模型在不被原始 JSON 噪声干扰的情况下理解内容、定位需要修改的 cell。
// 与 read_file 的区别：read_file 会原样返回 .ipynb 的冗长 JSON；本工具做结构化解析与精炼渲染，
// 并支持只看单个 cell（cell 参数）、隐藏 code 输出（include_outputs=false）。
// 属于只读工具：plan 模式下仍可执行，且无需用户授权。
// 解析/渲染等公共能力复用 ./notebook.js。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync, statSync } from 'node:fs'
import type { ToolDefinition, ToolResult } from '../core/types.js'
import { parseNotebook, renderCell, renderNotebook } from './notebook.js'
import { resolveWithinCwd, toDisplayPath } from './util.js'

// notebook_read 的入参结构。
interface NotebookReadInput {
  // 目标 .ipynb 文件路径（相对工作目录或绝对路径，需在授权目录内）。
  path: string
  // 仅查看指定序号的单个 cell（0 基）；省略则渲染全部 cell。
  cell?: number
  // 是否包含 code cell 的输出（默认 true）。设为 false 可只看源码、节省上下文。
  include_outputs?: boolean
}

export const notebookReadTool: ToolDefinition = {
  name: 'notebook_read',
  description:
    '读取并解析 Jupyter Notebook（.ipynb）文件，按「Markdown + Code 混合视图」展示各 cell 的类型、' +
    '源码与执行输出，比直接用 read_file 读取原始 JSON 更易理解。' +
    '可用 cell 参数只查看某个序号（0 基）的 cell；用 include_outputs=false 隐藏输出仅看源码。' +
    '编辑 notebook 前应先用本工具查看结构与 cell 序号。',
  readOnly: true,
  safety: { sideEffect: 'none', parallelSafe: true },
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '.ipynb 文件路径，相对当前工作目录或绝对路径' },
      cell: {
        type: 'number',
        description: '仅查看该序号（0 基）的单个 cell；省略则展示全部',
      },
      include_outputs: {
        type: 'boolean',
        description: '是否包含 code cell 的输出，默认 true；设为 false 仅看源码',
      },
    },
    required: ['path'],
  },
  renderCall: (input: NotebookReadInput) =>
    input.cell !== undefined
      ? `读取 Notebook ${input.path} #${input.cell}`
      : `读取 Notebook ${input.path}`,
  /**
   * 执行读取：校验路径与存在性，解析 .ipynb，渲染为混合视图文本。
   * @param input 入参。
   * @param ctx 运行上下文。
   * @returns 工具结果。
   */
  run: async (input: NotebookReadInput, ctx): Promise<ToolResult> => {
    const abs = resolveWithinCwd(ctx.cwd, input.path, ctx.extraDirs)
    if (!existsSync(abs)) {
      return { llmContent: `错误：文件不存在 ${input.path}`, isError: true }
    }
    if (statSync(abs).isDirectory()) {
      return { llmContent: `错误：${input.path} 是目录，请指定具体的 .ipynb 文件。`, isError: true }
    }

    // 读取并解析 notebook（解析失败给出可读错误）。
    const raw = readFileSync(abs, 'utf8')
    let nb
    try {
      nb = parseNotebook(raw)
    } catch (e: any) {
      return { llmContent: `错误：${e.message}`, isError: true }
    }

    const includeOutputs = input.include_outputs ?? true
    const display = toDisplayPath(ctx.cwd, abs)

    // 分支一：仅查看单个 cell。
    if (input.cell !== undefined) {
      const idx = input.cell
      if (!Number.isInteger(idx) || idx < 0 || idx >= nb.cells.length) {
        return {
          llmContent: `错误：cell 序号 ${idx} 超出范围（有效范围 0~${nb.cells.length - 1}）。`,
          isError: true,
        }
      }
      const text = renderCell(nb.cells[idx], { index: idx, includeOutputs })
      return {
        llmContent: `Notebook ${display}（共 ${nb.cells.length} 个 cell）\n\n${text}`,
        uiSummary: `读取 Notebook ${display} cell #${idx}`,
      }
    }

    // 分支二：渲染整本 notebook。
    const { text, truncated } = renderNotebook(nb, includeOutputs)
    const header = `Notebook ${display}（共 ${nb.cells.length} 个 cell${truncated ? '，已截断' : ''}）`
    return {
      llmContent: `${header}\n\n${text}`,
      uiSummary: `读取 Notebook ${display}（${nb.cells.length} 个 cell）`,
    }
  },
}
