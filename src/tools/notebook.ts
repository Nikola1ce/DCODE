// Jupyter Notebook（.ipynb）解析与序列化公共模块。
// 为 notebook_read / notebook_edit 两个工具提供共享能力：解析 nbformat v4 结构、
// 规整 cell.source（字符串 ↔ 字符串数组）、提取 cell 文本输出、渲染人类可读视图、
// 以及在保持原始 JSON 其它字段不变的前提下回写单个 cell。
// 设计取舍：只关心做 AI 编辑所必需的字段（cells/cell_type/source/outputs），
// 其余顶层与 cell 级字段（metadata、nbformat、execution_count 等）一律原样保留，
// 避免重写 notebook 时丢失用户的元数据或 kernel 信息。
// 制作人：Moriarty_Dox

import {
  MAX_NOTEBOOK_CELL_CHARS,
  MAX_NOTEBOOK_READ_CHARS,
} from '../constants.js'

// notebook 支持的 cell 类型（nbformat v4）。
export type NotebookCellType = 'code' | 'markdown' | 'raw'

// 合法的 cell 类型集合，供入参校验复用。
export const NOTEBOOK_CELL_TYPES: readonly NotebookCellType[] = [
  'code',
  'markdown',
  'raw',
] as const

/**
 * 单个 notebook cell 的原始结构（保留未知字段）。
 * source 在磁盘上可能是字符串或「按行字符串数组」，本类型不强制，统一交由解析函数规整。
 */
export interface RawNotebookCell {
  cell_type: string
  // 磁盘表示：字符串或字符串数组（每段通常以 \n 结尾，最后一段可无）。
  source: string | string[]
  // code cell 的执行输出（保留原样，仅用于只读展示）。
  outputs?: RawCellOutput[]
  // 其余字段（metadata、execution_count、id 等）原样保留。
  [key: string]: unknown
}

// cell 输出项（仅取展示所需字段，其余原样保留）。
export interface RawCellOutput {
  // 输出类型：stream / execute_result / display_data / error。
  output_type?: string
  // stream 输出文本（字符串或字符串数组）。
  text?: string | string[]
  // execute_result / display_data 的数据字典（如 text/plain）。
  data?: Record<string, unknown>
  // error 输出的异常名、消息与回溯。
  ename?: string
  evalue?: string
  traceback?: string[]
  [key: string]: unknown
}

/**
 * 解析后的整本 notebook（保留原始顶层字段，便于无损回写）。
 */
export interface ParsedNotebook {
  // cell 列表（引用自原始对象，可就地修改后再 stringify）。
  cells: RawNotebookCell[]
  // 原始 JSON 根对象（含 metadata / nbformat 等，回写时整体序列化）。
  raw: Record<string, unknown>
}

/**
 * 把 cell.source 的磁盘表示（字符串或字符串数组）规整为单个字符串。
 * nbformat 允许 source 为「按行切分的字符串数组」，各元素通常自带换行符，直接拼接即可还原原文。
 * @param source 原始 source 字段。
 * @returns 规整后的完整源码字符串。
 */
export function normalizeSource(source: string | string[] | undefined): string {
  if (source === undefined || source === null) return ''
  if (Array.isArray(source)) return source.join('')
  return String(source)
}

/**
 * 把单个字符串源码切回 nbformat 推荐的「按行字符串数组」表示。
 * 规则：除最后一行外，每行末尾补回 \n；空字符串返回空数组（与 Jupyter 写出的格式一致）。
 * 这样回写的 .ipynb 与 Jupyter / nbformat 工具产出的 diff 更小、更规范。
 * @param text 完整源码字符串。
 * @returns 按行切分且保留换行的字符串数组。
 */
export function splitSourceToLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line))
}

/**
 * 解析 .ipynb 文本为结构化对象。
 * 仅做最小校验：必须是对象且含 cells 数组；不强制 nbformat 版本，最大化兼容性。
 * @param text .ipynb 文件文本内容。
 * @returns 解析结果。
 * @throws 当 JSON 非法或缺少 cells 数组时抛出可读错误。
 */
export function parseNotebook(text: string): ParsedNotebook {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e: any) {
    throw new Error(`不是合法的 JSON（.ipynb 解析失败）：${e.message}`)
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('不是合法的 notebook：顶层应为 JSON 对象。')
  }
  const root = json as Record<string, unknown>
  const cells = root.cells
  if (!Array.isArray(cells)) {
    throw new Error('不是合法的 notebook：缺少 cells 数组。')
  }
  return { cells: cells as RawNotebookCell[], raw: root }
}

/**
 * 将解析后的 notebook 序列化回 .ipynb 文本。
 * 使用 2 空格缩进并保留末尾换行，贴近 Jupyter 默认写出风格，减小版本控制 diff。
 * @param nb 解析后的 notebook。
 * @returns 可写入磁盘的 JSON 文本。
 */
export function stringifyNotebook(nb: ParsedNotebook): string {
  return `${JSON.stringify(nb.raw, null, 2)}\n`
}

/**
 * 从单个 cell 输出项提取纯文本（用于只读展示），未知类型返回空串。
 * @param output 输出项。
 * @returns 该输出的纯文本表示。
 */
export function extractOutputText(output: RawCellOutput): string {
  const type = output.output_type
  if (type === 'stream') {
    return normalizeSource(output.text)
  }
  if (type === 'execute_result' || type === 'display_data') {
    const data = output.data
    if (data && typeof data === 'object') {
      // 优先取 text/plain；图像等富媒体仅提示类型，不内联二进制。
      const plain = (data as Record<string, unknown>)['text/plain']
      if (plain !== undefined) return normalizeSource(plain as string | string[])
      const mimeTypes = Object.keys(data)
      if (mimeTypes.length > 0) return `[非文本输出：${mimeTypes.join(', ')}]`
    }
    return ''
  }
  if (type === 'error') {
    const name = output.ename ?? 'Error'
    const value = output.evalue ?? ''
    return `${name}: ${value}`
  }
  return ''
}

/**
 * 汇总单个 code cell 的全部输出为一段纯文本（截断到合理长度）。
 * @param outputs 输出数组。
 * @returns 汇总文本（可能为空串）。
 */
export function summarizeOutputs(outputs: RawCellOutput[] | undefined): string {
  if (!outputs || outputs.length === 0) return ''
  const parts = outputs.map(extractOutputText).filter((t) => t.length > 0)
  return parts.join('\n')
}

/**
 * 按最大字符数截断文本，超出部分以中文提示替代（用于单 cell 展示）。
 * @param text 原始文本。
 * @param maxChars 最大字符数。
 * @returns 截断后的文本。
 */
function clampCellText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… [内容过长已截断，省略 ${text.length - maxChars} 个字符] …`
}

// 渲染单个 cell 为人类可读视图时的可选项。
export interface RenderCellOptions {
  // cell 在 notebook 中的索引（0 基）。
  index: number
  // 是否包含 code cell 的执行输出，默认 true。
  includeOutputs?: boolean
}

/**
 * 将单个 cell 渲染为带标题的可读文本块（Markdown 风格围栏）。
 * 形如：
 *   [cell 2] code
 *   ```
 *   print("hi")
 *   ```
 *   输出：
 *   hi
 * @param cell 目标 cell。
 * @param opts 渲染选项。
 * @returns 渲染后的多行字符串。
 */
export function renderCell(cell: RawNotebookCell, opts: RenderCellOptions): string {
  const { index, includeOutputs = true } = opts
  const type = cell.cell_type
  const src = clampCellText(normalizeSource(cell.source), MAX_NOTEBOOK_CELL_CHARS)
  const lines: string[] = []
  lines.push(`[cell ${index}] ${type}`)
  // code/raw 用代码围栏；markdown 直接展示原文，避免双重转义。
  if (type === 'markdown') {
    lines.push(src)
  } else {
    lines.push('```')
    lines.push(src)
    lines.push('```')
  }
  if (includeOutputs && type === 'code') {
    const out = summarizeOutputs(cell.outputs)
    if (out) {
      lines.push('输出：')
      lines.push(clampCellText(out, MAX_NOTEBOOK_CELL_CHARS))
    }
  }
  return lines.join('\n')
}

/**
 * 渲染整本 notebook 为可读文本（拼接所有 cell，并施加总字符上限）。
 * @param nb 解析后的 notebook。
 * @param includeOutputs 是否包含输出，默认 true。
 * @returns 渲染文本与是否被截断的标记。
 */
export function renderNotebook(
  nb: ParsedNotebook,
  includeOutputs = true,
): { text: string; truncated: boolean } {
  const blocks = nb.cells.map((cell, i) =>
    renderCell(cell, { index: i, includeOutputs }),
  )
  const full = blocks.join('\n\n')
  if (full.length <= MAX_NOTEBOOK_READ_CHARS) {
    return { text: full, truncated: false }
  }
  const head = full.slice(0, MAX_NOTEBOOK_READ_CHARS)
  return {
    text: `${head}\n\n… [notebook 过长已截断，请用 cell 参数按单元查看] …`,
    truncated: true,
  }
}

/**
 * 构造一个新的 cell 对象（用于插入）。
 * code cell 附带空 outputs 与 execution_count=null，符合 nbformat 期望。
 * @param cellType cell 类型。
 * @param source 源码字符串。
 * @returns 新的 cell 对象。
 */
export function makeCell(
  cellType: NotebookCellType,
  source: string,
): RawNotebookCell {
  const cell: RawNotebookCell = {
    cell_type: cellType,
    metadata: {},
    source: splitSourceToLines(source),
  }
  if (cellType === 'code') {
    cell.execution_count = null
    cell.outputs = []
  }
  return cell
}
