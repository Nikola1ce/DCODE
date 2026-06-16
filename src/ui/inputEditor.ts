// 输入框编辑模型（纯函数，便于单测）。
//
// 背景：输入框原先只有「文本 + 光标」，按 Ctrl+A 是「移到行首」（终端 readline 习惯），
// 且不支持选区、撤销、剪切——用户反馈 Ctrl+A 无法全选、Ctrl+Z 无法撤销、Ctrl+X 无法剪切。
// 本模块把编辑状态扩展为「文本 + 光标 + 选区」，并以纯函数实现各类编辑操作，使行为可预测、可单测；
// 撤销/重做与剪贴板由调用方（InputPrompt）以栈/ref 承载，本模块只提供产生新状态的纯变换。
// 制作人：Moriarty_Dox

// 编辑器状态：文本、光标位置、可选选区。
export interface EditorState {
  // 当前文本。
  value: string
  // 光标位置（0..value.length）。选区存在时，光标约定落在选区的「活动端」。
  cursor: number
  // 选区范围 [start, end)（start < end）；无选区时为 null。
  // 约定：start/end 均为已规整（0 <= start < end <= value.length）。
  selection: { start: number; end: number } | null
}

/** 生成一个空编辑器状态。 */
export function emptyState(): EditorState {
  return { value: '', cursor: 0, selection: null }
}

/**
 * 把光标位置 clamp 到 [0, len]。
 * @param n 原始位置。
 * @param len 文本长度。
 * @returns 合法位置。
 */
function clampCursor(n: number, len: number): number {
  return Math.max(0, Math.min(len, n))
}

/**
 * 规整一个选区：保证 start<end 且落在 [0,len]；非法/空选区返回 null。
 * @param sel 原始选区。
 * @param len 文本长度。
 * @returns 规整后的选区或 null。
 */
function normalizeSelection(
  sel: { start: number; end: number } | null,
  len: number,
): { start: number; end: number } | null {
  if (!sel) return null
  const start = clampCursor(Math.min(sel.start, sel.end), len)
  const end = clampCursor(Math.max(sel.start, sel.end), len)
  if (end <= start) return null
  return { start, end }
}

/**
 * 取当前选中的文本（无选区时为空串）。
 * @param st 编辑器状态。
 * @returns 选中文本。
 */
export function selectedText(st: EditorState): string {
  const sel = normalizeSelection(st.selection, st.value.length)
  if (!sel) return ''
  return st.value.slice(sel.start, sel.end)
}

/**
 * 删除选区内容，返回删除后的状态（光标落在选区起点，清除选区）。
 * 无选区时原样返回。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
function deleteSelection(st: EditorState): EditorState {
  const sel = normalizeSelection(st.selection, st.value.length)
  if (!sel) return st
  return {
    value: st.value.slice(0, sel.start) + st.value.slice(sel.end),
    cursor: sel.start,
    selection: null,
  }
}

/**
 * 全选：选中整段文本，光标置于末尾（活动端）。空文本时无选区。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
export function selectAll(st: EditorState): EditorState {
  if (st.value.length === 0) return { ...st, selection: null, cursor: 0 }
  return { ...st, selection: { start: 0, end: st.value.length }, cursor: st.value.length }
}

/** 清除选区（保留文本与光标）。 */
export function clearSelection(st: EditorState): EditorState {
  return st.selection ? { ...st, selection: null } : st
}

/**
 * 在光标处插入文本；若存在选区则先替换选区。插入后清除选区。
 * @param st 编辑器状态。
 * @param text 要插入的文本（通常为 1 个可见字符，也支持多字符粘贴）。
 * @returns 新状态。
 */
export function insertText(st: EditorState, text: string): EditorState {
  if (!text) return st
  const base = deleteSelection(st)
  const pos = clampCursor(base.cursor, base.value.length)
  return {
    value: base.value.slice(0, pos) + text + base.value.slice(pos),
    cursor: pos + text.length,
    selection: null,
  }
}

/**
 * 退格：有选区则删选区；否则删除光标左侧一个字符。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
export function deleteBackward(st: EditorState): EditorState {
  if (normalizeSelection(st.selection, st.value.length)) return deleteSelection(st)
  if (st.cursor <= 0) return st
  return {
    value: st.value.slice(0, st.cursor - 1) + st.value.slice(st.cursor),
    cursor: st.cursor - 1,
    selection: null,
  }
}

/**
 * 向前删除（Delete 键）：有选区则删选区；否则删除光标右侧一个字符；
 * 光标在末尾且无右侧字符时，退化为删除左侧（与原实现语义一致）。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
export function deleteForward(st: EditorState): EditorState {
  if (normalizeSelection(st.selection, st.value.length)) return deleteSelection(st)
  if (st.cursor < st.value.length) {
    return {
      value: st.value.slice(0, st.cursor) + st.value.slice(st.cursor + 1),
      cursor: st.cursor,
      selection: null,
    }
  }
  if (st.cursor > 0) {
    return { value: st.value.slice(0, st.cursor - 1), cursor: st.cursor - 1, selection: null }
  }
  return st
}

// 剪切结果：新状态 + 被剪切到剪贴板的文本。
export interface CutResult {
  state: EditorState
  clip: string
}

/**
 * 剪切：有选区则剪切选区；无选区则剪切整行（清空文本）。
 * 返回新状态与应写入剪贴板的文本（调用方负责存剪贴板）。
 * @param st 编辑器状态。
 * @returns 剪切结果。
 */
export function cut(st: EditorState): CutResult {
  const sel = normalizeSelection(st.selection, st.value.length)
  if (sel) {
    return { state: deleteSelection(st), clip: st.value.slice(sel.start, sel.end) }
  }
  // 无选区：剪切整行。
  if (st.value.length === 0) return { state: st, clip: '' }
  return { state: emptyState(), clip: st.value }
}

/**
 * 复制：返回应写入剪贴板的文本（不修改状态）。
 * 有选区时复制选区，无选区时复制整行（与 cut 的取值范围一致，仅不删除）。
 * @param st 编辑器状态。
 * @returns 应复制的文本（空内容时为空串）。
 */
export function copy(st: EditorState): string {
  const sel = selectedText(st)
  return sel !== '' ? sel : st.value
}

/**
 * 粘贴：把剪贴板文本插入（替换选区）。等价于 insertText。
 * @param st 编辑器状态。
 * @param clip 剪贴板文本。
 * @returns 新状态。
 */
export function paste(st: EditorState, clip: string): EditorState {
  return insertText(st, clip)
}

/**
 * 左移光标：
 *   - 有选区：折叠到选区左端（不再缩小一格，符合编辑器习惯）；
 *   - 无选区：左移一格（clamp）。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
export function moveLeft(st: EditorState): EditorState {
  const sel = normalizeSelection(st.selection, st.value.length)
  if (sel) return { ...st, cursor: sel.start, selection: null }
  return { ...st, cursor: clampCursor(st.cursor - 1, st.value.length) }
}

/**
 * 右移光标：
 *   - 有选区：折叠到选区右端；
 *   - 无选区：右移一格（clamp）。
 * @param st 编辑器状态。
 * @returns 新状态。
 */
export function moveRight(st: EditorState): EditorState {
  const sel = normalizeSelection(st.selection, st.value.length)
  if (sel) return { ...st, cursor: sel.end, selection: null }
  return { ...st, cursor: clampCursor(st.cursor + 1, st.value.length) }
}

/** 光标移到行首（清除选区）。 */
export function moveHome(st: EditorState): EditorState {
  return { ...st, cursor: 0, selection: null }
}

/** 光标移到行尾（清除选区）。 */
export function moveEnd(st: EditorState): EditorState {
  return { ...st, cursor: st.value.length, selection: null }
}

/**
 * 整行清空（Ctrl+U）。
 * @returns 空状态。
 */
export function clearLine(): EditorState {
  return emptyState()
}

/**
 * 用给定文本整体替换内容（用于历史回溯/补全），光标置于末尾、清除选区。
 * @param value 新文本。
 * @returns 新状态。
 */
export function replaceAll(value: string): EditorState {
  return { value, cursor: value.length, selection: null }
}

/**
 * 判断两个状态在「文本」维度是否不同（撤销栈据此决定是否记录快照，避免纯光标移动入栈）。
 * @param a 状态 A。
 * @param b 状态 B。
 * @returns 文本是否不同。
 */
export function valueChanged(a: EditorState, b: EditorState): boolean {
  return a.value !== b.value
}
