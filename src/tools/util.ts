// 工具公共辅助函数。
// 提供路径解析与安全校验、文本截断、相对路径展示等被多个工具复用的逻辑。
// 安全性要点：所有文件类工具都应通过 resolveWithinCwd 把模型给出的路径限制在工作目录内，
// 防止越权访问工作目录之外的系统文件。
// 制作人：Moriarty_Dox

import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 将用户/模型提供的路径解析为绝对路径，并校验其位于工作目录内部。
 * 相对路径基于 cwd 解析；绝对路径需仍处于 cwd 子树内，否则抛错。
 * @param cwd 当前工作目录（绝对路径）。
 * @param inputPath 待解析的路径（可为相对或绝对）。
 * @returns 解析后的绝对路径。
 * @throws 当目标路径越出工作目录时抛出错误。
 */
export function resolveWithinCwd(cwd: string, inputPath: string): string {
  // 统一解析为绝对路径。
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath)
  // 计算相对 cwd 的路径；若以 ".." 开头说明越出了工作目录。
  const rel = relative(cwd, abs)
  if (rel.startsWith('..') || (isAbsolute(rel) && rel !== '')) {
    throw new Error(
      `路径越界：出于安全考虑，只能访问当前工作目录内的文件（${inputPath}）。`,
    )
  }
  return abs
}

/**
 * 计算路径相对工作目录的展示形式（用于 UI 简洁显示）。
 * @param cwd 当前工作目录。
 * @param abs 绝对路径。
 * @returns 相对路径字符串；位于 cwd 之外时回退为原绝对路径。
 */
export function toDisplayPath(cwd: string, abs: string): string {
  const rel = relative(cwd, abs)
  if (rel === '') return '.'
  if (rel.startsWith('..')) return abs
  return rel.split(sep).join('/')
}

/**
 * 将文本按最大字符数截断，超出部分以提示行替代。
 * @param text 原始文本。
 * @param maxChars 允许的最大字符数。
 * @returns 截断后的文本（可能附带省略提示）。
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const omitted = text.length - maxChars
  return `${head}\n\n... [已截断，省略 ${omitted} 个字符。请使用更精确的参数分段读取] ...`
}

/**
 * 为多行文本添加从指定起始值开始的行号（便于读取/编辑工具定位）。
 * @param text 原始文本。
 * @param startLine 起始行号（1 基）。
 * @returns 带行号前缀的文本。
 */
export function addLineNumbers(text: string, startLine = 1): string {
  const lines = text.split('\n')
  // 计算行号宽度以右对齐，提升可读性。
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`)
    .join('\n')
}
