// 输入框编辑模型单测。
// 覆盖用户反馈的三类操作（全选 / 撤销依据 / 剪切）及其与选区的联动：
//   - Ctrl+A 全选 → selectAll
//   - Ctrl+X 剪切 → cut（含「无选区剪整行」）
//   - Ctrl+V 粘贴 → paste
//   - 选区下的插入/退格/删除/移动行为
//   - valueChanged：撤销栈是否记录的判定（纯光标移动不入栈）
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  type EditorState,
  clearSelection,
  copy,
  cut,
  deleteBackward,
  deleteForward,
  emptyState,
  insertText,
  moveLeft,
  moveRight,
  paste,
  replaceAll,
  selectAll,
  selectedText,
  valueChanged,
} from './inputEditor.js'

/** 便捷构造一个带文本/光标/选区的状态。 */
function st(value: string, cursor: number, selection?: { start: number; end: number }): EditorState {
  return { value, cursor, selection: selection ?? null }
}

describe('selectAll（Ctrl+A 全选）', () => {
  it('选中整段文本，光标置于末尾', () => {
    const s = selectAll(st('hello', 2))
    expect(s.selection).toEqual({ start: 0, end: 5 })
    expect(s.cursor).toBe(5)
    expect(selectedText(s)).toBe('hello')
  })

  it('空文本时不产生选区', () => {
    const s = selectAll(emptyState())
    expect(s.selection).toBeNull()
  })

  it('对中文同样按字符全选', () => {
    const s = selectAll(st('你好世界', 1))
    expect(s.selection).toEqual({ start: 0, end: 4 })
    expect(selectedText(s)).toBe('你好世界')
  })
})

describe('选区下的编辑联动', () => {
  it('全选后输入字符 → 替换整段', () => {
    const s = insertText(selectAll(st('old text', 0)), 'X')
    expect(s.value).toBe('X')
    expect(s.cursor).toBe(1)
    expect(s.selection).toBeNull()
  })

  it('全选后退格 → 清空', () => {
    const s = deleteBackward(selectAll(st('hello', 0)))
    expect(s.value).toBe('')
    expect(s.selection).toBeNull()
  })

  it('全选后 Delete → 清空', () => {
    const s = deleteForward(selectAll(st('hello', 0)))
    expect(s.value).toBe('')
  })

  it('部分选区替换：选中中间再插入', () => {
    // "abcdef" 选中 [1,4)=bcd，插入 X → aXef
    const s = insertText(st('abcdef', 4, { start: 1, end: 4 }), 'X')
    expect(s.value).toBe('aXef')
    expect(s.cursor).toBe(2)
  })

  it('左移在有选区时折叠到选区左端', () => {
    const s = moveLeft(st('abcdef', 4, { start: 1, end: 4 }))
    expect(s.cursor).toBe(1)
    expect(s.selection).toBeNull()
  })

  it('右移在有选区时折叠到选区右端', () => {
    const s = moveRight(st('abcdef', 1, { start: 1, end: 4 }))
    expect(s.cursor).toBe(4)
    expect(s.selection).toBeNull()
  })
})

describe('cut（Ctrl+X 剪切）/ paste（Ctrl+V 粘贴）', () => {
  it('有选区：剪切选区文本并从内容中删除', () => {
    const { state, clip } = cut(st('abcdef', 4, { start: 1, end: 4 }))
    expect(clip).toBe('bcd')
    expect(state.value).toBe('aef')
    expect(state.cursor).toBe(1)
    expect(state.selection).toBeNull()
  })

  it('无选区：剪切整行', () => {
    const { state, clip } = cut(st('whole line', 3))
    expect(clip).toBe('whole line')
    expect(state.value).toBe('')
  })

  it('空内容剪切：剪贴板为空、状态不变', () => {
    const { state, clip } = cut(emptyState())
    expect(clip).toBe('')
    expect(state.value).toBe('')
  })

  it('剪切再粘贴可还原文本（往返一致）', () => {
    const { state, clip } = cut(st('hello', 2)) // 无选区 → 剪整行
    const pasted = paste(state, clip)
    expect(pasted.value).toBe('hello')
  })

  it('粘贴到光标处插入', () => {
    const s = paste(st('ace', 1), 'b')
    expect(s.value).toBe('abce')
    expect(s.cursor).toBe(2)
  })

  it('有选区时粘贴替换选区', () => {
    const s = paste(st('abcdef', 4, { start: 1, end: 4 }), 'XY')
    expect(s.value).toBe('aXYef')
  })
})

describe('copy（Ctrl+C 复制，不修改内容）', () => {
  it('有选区：复制选区文本，状态不变', () => {
    const s = st('abcdef', 4, { start: 1, end: 4 })
    expect(copy(s)).toBe('bcd')
    // copy 不应改变内容（这里仅验证返回值；状态不可变由调用方保证）
    expect(s.value).toBe('abcdef')
  })

  it('无选区：复制整行', () => {
    expect(copy(st('whole line', 3))).toBe('whole line')
  })

  it('空内容复制返回空串', () => {
    expect(copy(emptyState())).toBe('')
  })

  it('复制不删除：与 cut 的区别', () => {
    const s = st('hello', 2, { start: 0, end: 5 })
    // copy 仅取文本
    expect(copy(s)).toBe('hello')
    // cut 取文本并删除
    const { state, clip } = cut(s)
    expect(clip).toBe('hello')
    expect(state.value).toBe('')
  })
})

describe('clearSelection / replaceAll', () => {
  it('清除选区保留文本与光标', () => {
    const s = clearSelection(st('hello', 3, { start: 0, end: 5 }))
    expect(s.selection).toBeNull()
    expect(s.value).toBe('hello')
    expect(s.cursor).toBe(3)
  })

  it('replaceAll 替换全部并把光标置于末尾', () => {
    const s = replaceAll('new value')
    expect(s.value).toBe('new value')
    expect(s.cursor).toBe('new value'.length)
    expect(s.selection).toBeNull()
  })
})

describe('valueChanged（撤销栈记录判定）', () => {
  it('文本不同 → true', () => {
    expect(valueChanged(st('a', 0), st('ab', 2))).toBe(true)
  })

  it('仅光标/选区不同、文本相同 → false（纯移动不入撤销栈）', () => {
    expect(valueChanged(st('abc', 0), st('abc', 2))).toBe(false)
    expect(valueChanged(st('abc', 0), st('abc', 3, { start: 0, end: 3 }))).toBe(false)
  })
})

describe('健壮性：越界选区被规整', () => {
  it('选区越界时按 [0,len] clamp', () => {
    // 选区 end 超出长度，selectedText/cut 应按实际长度截断
    const s = st('abc', 3, { start: 1, end: 99 })
    expect(selectedText(s)).toBe('bc')
    const { clip } = cut(s)
    expect(clip).toBe('bc')
  })

  it('start>end 的反向选区也能正确取出', () => {
    const s = st('abcdef', 1, { start: 4, end: 1 })
    expect(selectedText(s)).toBe('bcd')
  })
})
