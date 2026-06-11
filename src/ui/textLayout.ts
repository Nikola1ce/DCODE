// 终端文本布局工具（纯函数，便于单测）。
// 核心职责：按「视觉行」（计入自动换行 + 东亚全角宽度）截取流式文本的末尾，
// 确保实时区（非 Static）高度始终矮于视口——否则 Ink 5.2.1 重绘时无法擦除旧帧，
// 旧帧会泄漏进终端 scrollback，表现为「思考过程」被刷屏几十遍。
// 制作人：Moriarty_Dox

/**
 * 估算单个字符在终端中的显示宽度（列数）。
 * 东亚全角/CJK、全角标点、常见 emoji 记 2 列，其余记 1 列。
 * 中文为全角，若按字符个数当作 1 列会严重低估换行行数，故必须区分。
 * @param code 字符码点。
 * @returns 1 或 2。
 */
export function charCols(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首/汉字/假名/注音等
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角 ASCII/标点
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || // 多数 emoji
    (code >= 0x20000 && code <= 0x3fffd) // CJK 扩展 B 及以上
  ) {
    return 2
  }
  return 1
}

/**
 * 计算字符串的显示宽度（列数）。
 * @param s 字符串。
 * @returns 总列数。
 */
export function strCols(s: string): number {
  let w = 0
  for (const ch of s) w += charCols(ch.codePointAt(0) ?? 0)
  return w
}

/**
 * 计算一行文本在给定终端宽度下、自动换行后占用的视觉行数。
 * @param line 单行文本（不含换行符）。
 * @param cols 终端列宽。
 * @returns 视觉行数（至少 1）。
 */
export function wrappedRows(line: string, cols: number): number {
  const w = strCols(line)
  if (w === 0) return 1
  return Math.max(1, Math.ceil(w / Math.max(1, cols)))
}

/**
 * 保留字符串末尾，使其显示宽度不超过 maxCols 列。
 * @param line 单行文本。
 * @param maxCols 允许的最大列数。
 * @returns 截取后的尾部子串。
 */
export function sliceTailByCols(line: string, maxCols: number): string {
  const chars = [...line]
  let w = 0
  let i = chars.length
  while (i > 0) {
    const c = charCols(chars[i - 1].codePointAt(0) ?? 0)
    if (w + c > maxCols) break
    w += c
    i--
  }
  return chars.slice(i).join('')
}

/**
 * 取文本「末尾」，使其在给定终端宽度下「自动换行后」的视觉行数不超过 maxRows。
 *
 * 这是修复「动态区比视口高 → Ink 5.2.1 重绘无法擦除旧帧、旧帧泄漏进 scrollback、
 * 思考过程被刷屏」的关键：必须按视觉行（计入换行与 CJK 全角宽度）限高，
 * 而非按逻辑行（\n 分隔）——后者会把一条长中文行严重低估为 1 行。
 *
 * @param text 原始（可能很长的）流式文本。
 * @param maxRows 最多保留的视觉行数。
 * @param cols 终端列宽。
 * @returns 适合固定高度实时区显示的尾部文本；发生截断时在开头加省略标记。
 */
export function tailByVisualRows(text: string, maxRows: number, cols: number): string {
  if (maxRows <= 0) return ''
  const logical = text.split('\n')
  const kept: string[] = []
  let rows = 0
  let truncated = false
  // 从最后一行向上累计，直到填满 maxRows 个视觉行。
  for (let i = logical.length - 1; i >= 0; i--) {
    const line = logical[i]
    const r = wrappedRows(line, cols)
    if (rows + r > maxRows) {
      // 该行放不下：若仍有剩余视觉行，则截取这一行的尾部填满，保证不溢出。
      const remaining = maxRows - rows
      if (remaining > 0) kept.unshift(sliceTailByCols(line, remaining * cols))
      truncated = true
      break
    }
    kept.unshift(line)
    rows += r
  }
  if (!truncated) return kept.join('\n')
  // 截断标记「… 」自身占列宽，直接前置可能把首行多挤出一视觉行、从而超出 maxRows。
  // 因此把标记宽度计入首行预算：将首行尾部再裁掉标记所占列数，保证总视觉行数不变。
  const marker = '… '
  const markerCols = strCols(marker)
  if (kept.length > 0) {
    const firstRows = wrappedRows(kept[0], cols)
    kept[0] = sliceTailByCols(kept[0], firstRows * cols - markerCols)
  }
  return marker + kept.join('\n')
}
