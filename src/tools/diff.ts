// 轻量行级 diff 工具。
// 基于最长公共子序列（LCS）计算两段文本的行级差异，生成带 +/- 前缀的统一风格预览，
// 供写入/编辑工具在权限确认弹窗中展示变更内容。仅用于人类查看，不追求 git 级精确。
// 制作人：Moriarty_Dox

// 单行差异条目。
export interface DiffLine {
  // 差异类型：新增 / 删除 / 未变。
  type: 'add' | 'del' | 'ctx'
  // 行文本。
  text: string
}

/**
 * 计算两段文本的行级差异序列。
 * 使用 LCS 动态规划求最长公共子序列，再回溯生成 add/del/ctx 序列。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @returns 差异行数组。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')
  const n = a.length
  const m = b.length

  // dp[i][j] 表示 a[i..] 与 b[j..] 的 LCS 长度。
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯生成差异序列。
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'ctx', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'del', text: a[i] })
      i++
    } else {
      result.push({ type: 'add', text: b[j] })
      j++
    }
  }
  // 处理剩余未匹配的行。
  while (i < n) result.push({ type: 'del', text: a[i++] })
  while (j < m) result.push({ type: 'add', text: b[j++] })

  return result
}

/**
 * 生成纯文本 diff 预览（最多展示有限行，避免刷屏）。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @param maxLines 最多展示的差异行数，默认 60。
 * @returns 带 +/-/空格 前缀的多行字符串。
 */
export function buildDiffPreview(
  oldText: string,
  newText: string,
  maxLines = 60,
): string {
  const lines = diffLines(oldText, newText)
  // 仅保留有变化的行及其少量上下文，避免对大文件输出过长。
  const rendered = lines.map((l) => {
    const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '
    return `${prefix} ${l.text}`
  })
  if (rendered.length <= maxLines) return rendered.join('\n')
  const omitted = rendered.length - maxLines
  return rendered.slice(0, maxLines).join('\n') + `\n... 省略 ${omitted} 行 ...`
}

/**
 * 统计新增/删除的行数，用于 UI 摘要（如 “+12 -3”）。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @returns 新增与删除行数。
 */
export function countDiff(oldText: string, newText: string): {
  added: number
  removed: number
} {
  const lines = diffLines(oldText, newText)
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added++
    else if (l.type === 'del') removed++
  }
  return { added, removed }
}
