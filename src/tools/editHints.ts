// edit_file 匹配失败时的定位线索。
// 模型构造 old_string 最常见的失误：缩进/空白不一致、误带 read_file 的行号前缀、
// 基于过期内容编辑。仅回复“未找到”会让模型盲目重读重试；这里给出实际内容与行号，
// 使其通常一次就能修正。
// 制作人：Moriarty_Dox

// 线索中展示实际内容的最大行数，避免错误信息本身撑爆上下文。
const MAX_HINT_LINES = 30
// 最多列出的候选位置数。
const MAX_LOCATIONS = 5

/** read_file 输出的行号前缀（右对齐行号 + 制表符）。 */
const LINE_NUMBER_PREFIX = /^\s*\d+\t/

/**
 * 计算子串每次出现所在的起始行号（1 基）。
 * @param content 文件内容。
 * @param sub 子串。
 * @returns 行号数组（按出现顺序）。
 */
export function lineNumbersOf(content: string, sub: string): number[] {
  const result: number[] = []
  if (!sub) return result
  let idx = content.indexOf(sub)
  while (idx !== -1) {
    result.push(content.slice(0, idx).split('\n').length)
    idx = content.indexOf(sub, idx + sub.length)
  }
  return result
}

/** 归一化单行：去首尾空白并把连续空白折叠为一个空格。 */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/**
 * 去掉首尾的空行，返回剩余行（用于比较时忽略模型多带的空行）。
 * @param lines 行数组。
 * @returns 去掉首尾空行后的数组。
 */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/**
 * 以带行号的形式展示文件片段。
 * @param lines 文件全部行。
 * @param start 起始下标（0 基，含）。
 * @param end 结束下标（0 基，不含）。
 * @returns 带行号的文本，超长时截断。
 */
function excerpt(lines: string[], start: number, end: number): string {
  const stop = Math.min(end, start + MAX_HINT_LINES)
  const body = lines
    .slice(start, stop)
    .map((line, i) => `${start + i + 1}\t${line}`)
    .join('\n')
  return stop < end ? `${body}\n…（其余 ${end - stop} 行省略）` : body
}

/**
 * 生成“未找到 old_string”时的错误说明，附带尽可能具体的定位线索。
 * 依次检查：误带行号前缀 → 忽略空白后可匹配 → 首行可定位 → 兜底提示。
 * @param content 文件内容（已统一为 LF 或保持原样均可）。
 * @param oldString 模型给出的 old_string。
 * @returns 给模型的错误文本。
 */
export function describeMissingMatch(content: string, oldString: string): string {
  const base = '错误：在文件中未找到 old_string。'
  const fileLines = content.split(/\r?\n/)
  const oldLines = trimBlankEdges(oldString.split(/\r?\n/))

  if (oldLines.length > 0 && oldLines.every((l) => l.trim() === '' || LINE_NUMBER_PREFIX.test(l))) {
    return (
      `${base}old_string 每行都带有 read_file 输出的“行号+制表符”前缀，这些前缀不是文件内容。` +
      '请去掉行号前缀后重试（new_string 同理）。'
    )
  }

  const target = oldLines.map(normalizeLine)
  if (target.length > 0 && target.some((l) => l !== '')) {
    // 忽略缩进与空白差异的滑窗匹配。
    const matches: number[] = []
    for (let i = 0; i + target.length <= fileLines.length; i++) {
      let ok = true
      for (let j = 0; j < target.length; j++) {
        if (normalizeLine(fileLines[i + j]) !== target[j]) {
          ok = false
          break
        }
      }
      if (ok) matches.push(i)
    }
    if (matches.length === 1) {
      const start = matches[0]
      return (
        `${base}但第 ${start + 1}-${start + target.length} 行在忽略缩进/空白差异后与之相同，` +
        '可能是缩进（空格/Tab）或行内空白不一致。文件实际内容如下（行号前缀不属于内容）：\n' +
        `${excerpt(fileLines, start, start + target.length)}\n` +
        '请按实际内容逐字符构造 old_string，并让 new_string 使用相同的缩进风格。'
      )
    }
    if (matches.length > 1) {
      const where = matches.slice(0, MAX_LOCATIONS).map((i) => `第 ${i + 1} 行`).join('、')
      return `${base}忽略空白后有 ${matches.length} 处相似内容（${where}），请用 read_file 查看这些位置，按实际缩进并补充上下文后重试。`
    }

    // 用首个非空行定位，帮助模型发现内容已被改动或记错。
    const firstLine = target.find((l) => l !== '')!
    const firstIdx = target.indexOf(firstLine)
    const hits: number[] = []
    fileLines.forEach((line, i) => {
      if (normalizeLine(line) === firstLine) hits.push(i)
    })
    if (hits.length > 0 && hits.length <= MAX_LOCATIONS) {
      const at = Math.max(0, hits[0] - firstIdx)
      return (
        `${base}其首行出现在${hits.map((i) => `第 ${i + 1} 行`).join('、')}，但后续行不一致（文件可能已被修改或 old_string 记错）。` +
        `第 ${hits[0] + 1} 行附近的实际内容：\n${excerpt(fileLines, at, at + target.length + 2)}\n` +
        '请依据实际内容重新构造 old_string。'
      )
    }
  }

  return `${base}请先用 read_file 查看最新内容（注意缩进与空白），再按实际内容构造 old_string。`
}
