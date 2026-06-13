// 行级 diff 工具。
// 基于最长公共子序列（LCS）计算两段文本的行级差异。提供两套能力：
//   1) 轻量预览：buildDiffPreview 生成带 +/- 前缀的扁平文本（向后兼容旧调用方）。
//   2) 增强视图：buildDiffView / buildDiffHunks 生成带「新旧行号 + @@ hunk 头 + 上下文折叠」
//      的结构化差异，供权限弹窗渲染更丰富的 diff（行号列、变更行高亮），并避免大文件刷屏。
// 仅用于人类查看，不追求 git 级最小编辑脚本。
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

// —— 增强 Diff 视图（带行号、变更高亮、hunk 折叠）—— //
// 以下为「终端内 Diff 查看器」增强能力：在保留上方轻量 buildDiffPreview 的同时，
// 提供结构化、带行号的 hunk 视图，供权限弹窗渲染更丰富的差异（行号列 + 变更行底色），
// 并把大文件 diff 折叠为「变更块 + 周围上下文」，避免整文件刷屏。

/**
 * 结构化 diff 行：相比 DiffLine 额外携带新旧两侧行号，便于 UI 渲染行号列与变更高亮。
 */
export interface DiffViewLine {
  // 行类型：新增 / 删除 / 未变上下文 / hunk 分隔头（@@ ... @@）。
  type: 'add' | 'del' | 'ctx' | 'hunk'
  // 旧文件中的行号（1 基）；新增行与 hunk 头为 null。
  oldLine: number | null
  // 新文件中的行号（1 基）；删除行与 hunk 头为 null。
  newLine: number | null
  // 行文本（hunk 头为形如 "@@ -a,b +c,d @@" 的串，不含前缀符号）。
  text: string
}

// 单个 hunk：一段连续的变更及其上下文。
export interface DiffHunk {
  // 旧文件起始行号（1 基）。
  oldStart: number
  // 旧文件该 hunk 覆盖的行数。
  oldCount: number
  // 新文件起始行号（1 基）。
  newStart: number
  // 新文件该 hunk 覆盖的行数。
  newCount: number
  // 该 hunk 内的结构化行（不含 hunk 头本身）。
  lines: DiffViewLine[]
}

/**
 * 为整段 diff 标注新旧两侧行号，得到结构化行序列（不折叠、不含 hunk 头）。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @returns 带行号的结构化行数组。
 */
export function annotateDiffLines(oldText: string, newText: string): DiffViewLine[] {
  const lines = diffLines(oldText, newText)
  const result: DiffViewLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const l of lines) {
    if (l.type === 'ctx') {
      oldNo++
      newNo++
      result.push({ type: 'ctx', oldLine: oldNo, newLine: newNo, text: l.text })
    } else if (l.type === 'del') {
      oldNo++
      result.push({ type: 'del', oldLine: oldNo, newLine: null, text: l.text })
    } else {
      newNo++
      result.push({ type: 'add', oldLine: null, newLine: newNo, text: l.text })
    }
  }
  return result
}

/**
 * 把结构化 diff 行折叠为 hunk 列表：仅保留变更行及其周围 context 行上下文，
 * 相邻变更若间距 ≤ 2*context 则合并到同一 hunk，避免碎片化。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @param context 每个变更块前后保留的上下文行数，默认 3。
 * @returns hunk 数组（无变更时为空数组）。
 */
export function buildDiffHunks(
  oldText: string,
  newText: string,
  context = 3,
): DiffHunk[] {
  const annotated = annotateDiffLines(oldText, newText)
  // 找出所有变更行的下标。
  const changeIdx: number[] = []
  for (let i = 0; i < annotated.length; i++) {
    if (annotated[i].type !== 'ctx') changeIdx.push(i)
  }
  if (changeIdx.length === 0) return []

  // 根据变更行下标，计算需要展示的区间（含上下文），并合并相邻区间。
  const ranges: Array<[number, number]> = []
  for (const idx of changeIdx) {
    const start = Math.max(0, idx - context)
    const end = Math.min(annotated.length - 1, idx + context)
    const last = ranges[ranges.length - 1]
    // 与上一区间重叠或紧邻（间隔 ≤ 1）则合并。
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }

  // 把每个区间转为一个 hunk，并补全 @@ 头所需的起止行号与计数。
  const hunks: DiffHunk[] = []
  for (const [start, end] of ranges) {
    const slice = annotated.slice(start, end + 1)
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    for (const line of slice) {
      if (line.oldLine !== null) {
        if (oldStart === 0) oldStart = line.oldLine
        oldCount++
      }
      if (line.newLine !== null) {
        if (newStart === 0) newStart = line.newLine
        newCount++
      }
    }
    hunks.push({
      // 当一侧整段为空（如纯新增）时起始行号回退为 0。
      oldStart: oldStart || 0,
      oldCount,
      newStart: newStart || 0,
      newCount,
      lines: slice,
    })
  }
  return hunks
}

/**
 * 生成单个 hunk 的 @@ 头文本，形如 "@@ -12,5 +12,7 @@"。
 * @param hunk 目标 hunk。
 * @returns hunk 头字符串。
 */
export function formatHunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
}

/**
 * 把整段 diff 渲染为「带行号 + hunk 头」的结构化行序列（用于 UI 精细渲染）。
 * 每个 hunk 之前插入一条 type='hunk' 的分隔行。整体行数超过 maxLines 时尾部截断并附提示行。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @param opts 选项：context 上下文行数；maxLines 最多输出行数（含 hunk 头）。
 * @returns 结构化行数组（可直接交由 UI 着色渲染）。
 */
export function buildDiffView(
  oldText: string,
  newText: string,
  opts: { context?: number; maxLines?: number } = {},
): DiffViewLine[] {
  const { context = 3, maxLines = 200 } = opts
  const hunks = buildDiffHunks(oldText, newText, context)
  const out: DiffViewLine[] = []
  for (const hunk of hunks) {
    out.push({ type: 'hunk', oldLine: null, newLine: null, text: formatHunkHeader(hunk) })
    for (const line of hunk.lines) out.push(line)
  }
  if (out.length <= maxLines) return out
  const omitted = out.length - maxLines
  const head = out.slice(0, maxLines)
  head.push({
    type: 'hunk',
    oldLine: null,
    newLine: null,
    text: `… 省略 ${omitted} 行差异（变更较多，建议直接查看文件） …`,
  })
  return head
}

/**
 * 便捷函数：直接由新旧文本生成「增强 diff 预览文本」（带行号 + hunk 头 + 折叠）。
 * 作为 buildDiffPreview 的升级版，供写入/编辑工具填充权限弹窗的 preview 字段；
 * UI 会据 @@ 头与行号列做高亮渲染（见 MessageView 的 permission 分支）。
 * @param oldText 旧文本。
 * @param newText 新文本。
 * @param opts 选项：context 上下文行数；maxLines 最多输出行数。
 * @returns 多行预览文本（无变更时返回空串）。
 */
export function buildDiffPreviewView(
  oldText: string,
  newText: string,
  opts: { context?: number; maxLines?: number } = {},
): string {
  const lines = buildDiffView(oldText, newText, opts)
  if (lines.length === 0) return ''
  return renderDiffViewText(lines)
}

/**
 * 把结构化 diff 视图渲染为纯文本（带行号列与 +/-/空格 前缀），供 headless / 文本预览使用。
 * 行号列右对齐，形如：
 *   @@ -1,3 +1,4 @@
 *      1    1   unchanged
 *      2      - removed line
 *           2 + added line
 * @param lines 结构化 diff 行（来自 buildDiffView）。
 * @returns 多行文本。
 */
export function renderDiffViewText(lines: DiffViewLine[]): string {
  // 计算行号列宽度（取新旧两侧出现过的最大行号）。
  let maxNo = 1
  for (const l of lines) {
    if (l.oldLine && l.oldLine > maxNo) maxNo = l.oldLine
    if (l.newLine && l.newLine > maxNo) maxNo = l.newLine
  }
  const width = String(maxNo).length
  const pad = (n: number | null): string =>
    n === null ? ' '.repeat(width) : String(n).padStart(width, ' ')

  return lines
    .map((l) => {
      if (l.type === 'hunk') return l.text
      const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '
      return `${pad(l.oldLine)} ${pad(l.newLine)} ${sign} ${l.text}`
    })
    .join('\n')
}

// 单行 diff 预览文本的语义分类（供 UI 着色与高亮决策）。
export type DiffPreviewLineKind = 'hunk' | 'add' | 'del' | 'ctx'

/**
 * 判断一行「增强 diff 预览文本」的语义类型，供 UI 决定配色与背景高亮。
 * 兼容两种格式：
 *   - 增强格式（renderDiffViewText）：以 @@ 开头为 hunk 头；行号列后紧跟 +/-/空格 标记变更。
 *   - 旧扁平格式（buildDiffPreview）：以 +/- 开头表示增删，其余为上下文。
 * 省略提示行（含「省略」字样）归为 hunk（弱化展示）。
 * @param line 单行文本。
 * @returns 语义类型。
 */
export function classifyDiffPreviewLine(line: string): DiffPreviewLineKind {
  if (line.startsWith('@@') || line.includes('省略')) return 'hunk'
  // 增强格式：行号列（数字/空格）后跟空格与单个符号。匹配该符号判定增删。
  const m = /^[\d ]+ [\d ]* ?([+\-]) /.exec(line)
  if (m) return m[1] === '+' ? 'add' : 'del'
  // 旧扁平格式：直接以 +/- 起始。
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}
