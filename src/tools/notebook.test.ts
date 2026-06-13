// Notebook 解析/序列化/编辑逻辑的单元测试。
// 覆盖：source 字符串↔数组规整、notebook 解析与非法输入、cell 渲染、
// 以及 notebook_edit 的 replace/insert/delete 三种模式与各类边界/错误。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  makeCell,
  normalizeSource,
  parseNotebook,
  renderCell,
  splitSourceToLines,
  stringifyNotebook,
  summarizeOutputs,
} from './notebook.js'
import { __test } from './notebookEdit.js'

const { applyNotebookEdit } = __test

// 构造一个最小可用的 notebook JSON 文本（含 code + markdown 两个 cell）。
function sampleNotebook(): string {
  return JSON.stringify({
    cells: [
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['print("hello")\n', 'x = 1'],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['hello\n'] }],
      },
      {
        cell_type: 'markdown',
        metadata: {},
        source: '# 标题',
      },
    ],
    metadata: { kernelspec: { name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  })
}

describe('source 规整', () => {
  it('normalizeSource 把字符串数组拼接为完整字符串', () => {
    expect(normalizeSource(['a\n', 'b'])).toBe('a\nb')
    expect(normalizeSource('a\nb')).toBe('a\nb')
    expect(normalizeSource(undefined)).toBe('')
  })

  it('splitSourceToLines 保留行末换行、最后一行不补', () => {
    expect(splitSourceToLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitSourceToLines('')).toEqual([])
    expect(splitSourceToLines('one')).toEqual(['one'])
  })

  it('normalizeSource 与 splitSourceToLines 互为逆（往返一致）', () => {
    const text = 'line1\nline2\nline3'
    expect(normalizeSource(splitSourceToLines(text))).toBe(text)
  })
})

describe('parseNotebook / stringifyNotebook', () => {
  it('能解析合法 notebook 并保留顶层字段', () => {
    const nb = parseNotebook(sampleNotebook())
    expect(nb.cells).toHaveLength(2)
    expect(nb.raw.nbformat).toBe(4)
    expect((nb.raw.metadata as any).kernelspec.name).toBe('python3')
  })

  it('非法 JSON 抛出可读错误', () => {
    expect(() => parseNotebook('{ not json')).toThrow(/JSON/)
  })

  it('缺少 cells 数组抛错', () => {
    expect(() => parseNotebook('{"nbformat":4}')).toThrow(/cells/)
  })

  it('顶层非对象抛错', () => {
    expect(() => parseNotebook('[]')).toThrow(/对象/)
  })

  it('序列化后可被再次解析（往返）', () => {
    const nb = parseNotebook(sampleNotebook())
    const text = stringifyNotebook(nb)
    expect(text.endsWith('\n')).toBe(true)
    const again = parseNotebook(text)
    expect(again.cells).toHaveLength(2)
  })
})

describe('renderCell / summarizeOutputs', () => {
  it('code cell 用围栏并附输出', () => {
    const nb = parseNotebook(sampleNotebook())
    const text = renderCell(nb.cells[0], { index: 0 })
    expect(text).toContain('[cell 0] code')
    expect(text).toContain('```')
    expect(text).toContain('print("hello")')
    expect(text).toContain('输出：')
    expect(text).toContain('hello')
  })

  it('markdown cell 直接展示原文、无围栏', () => {
    const nb = parseNotebook(sampleNotebook())
    const text = renderCell(nb.cells[1], { index: 1 })
    expect(text).toContain('[cell 1] markdown')
    expect(text).toContain('# 标题')
    expect(text).not.toContain('```')
  })

  it('includeOutputs=false 不渲染输出', () => {
    const nb = parseNotebook(sampleNotebook())
    const text = renderCell(nb.cells[0], { index: 0, includeOutputs: false })
    expect(text).not.toContain('输出：')
  })

  it('summarizeOutputs 汇总 stream/execute_result/error', () => {
    expect(
      summarizeOutputs([{ output_type: 'stream', text: 'hi' }]),
    ).toBe('hi')
    expect(
      summarizeOutputs([
        { output_type: 'execute_result', data: { 'text/plain': '42' } },
      ]),
    ).toBe('42')
    expect(
      summarizeOutputs([{ output_type: 'error', ename: 'ValueError', evalue: 'bad' }]),
    ).toBe('ValueError: bad')
    expect(summarizeOutputs([])).toBe('')
    expect(summarizeOutputs(undefined)).toBe('')
  })

  it('execute_result 的非文本数据给出类型提示', () => {
    expect(
      summarizeOutputs([
        { output_type: 'display_data', data: { 'image/png': 'base64...' } },
      ]),
    ).toContain('image/png')
  })
})

describe('makeCell', () => {
  it('code cell 带空 outputs 与 execution_count=null', () => {
    const cell = makeCell('code', 'print(1)')
    expect(cell.cell_type).toBe('code')
    expect(cell.outputs).toEqual([])
    expect(cell.execution_count).toBeNull()
    expect(normalizeSource(cell.source)).toBe('print(1)')
  })

  it('markdown cell 不带 outputs', () => {
    const cell = makeCell('markdown', '# hi')
    expect(cell.cell_type).toBe('markdown')
    expect(cell.outputs).toBeUndefined()
  })
})

describe('applyNotebookEdit — replace', () => {
  it('替换 cell 源码并清空 code cell 旧输出', () => {
    const { newText, summary } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'replace',
      cell: 0,
      source: 'y = 2',
    })
    const nb = parseNotebook(newText)
    expect(normalizeSource(nb.cells[0].source)).toBe('y = 2')
    expect(nb.cells[0].outputs).toEqual([])
    expect(nb.cells[0].execution_count).toBeNull()
    expect(summary).toContain('替换 cell 0')
  })

  it('替换 markdown cell 保留为 markdown 类型', () => {
    const { newText } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'replace',
      cell: 1,
      source: '## 新标题',
    })
    const nb = parseNotebook(newText)
    expect(nb.cells[1].cell_type).toBe('markdown')
    expect(normalizeSource(nb.cells[1].source)).toBe('## 新标题')
  })

  it('缺 source 抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), { path: 'x', mode: 'replace', cell: 0 }),
    ).toThrow(/source/)
  })

  it('索引越界抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), {
        path: 'x',
        mode: 'replace',
        cell: 9,
        source: 'a',
      }),
    ).toThrow(/超出范围/)
  })

  it('缺 cell 索引抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), { path: 'x', mode: 'replace', source: 'a' }),
    ).toThrow(/索引/)
  })
})

describe('applyNotebookEdit — insert', () => {
  it('在指定索引前插入新 code cell', () => {
    const { newText, summary } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'insert',
      cell: 1,
      source: 'z = 3',
      cell_type: 'code',
    })
    const nb = parseNotebook(newText)
    expect(nb.cells).toHaveLength(3)
    expect(normalizeSource(nb.cells[1].source)).toBe('z = 3')
    expect(nb.cells[1].cell_type).toBe('code')
    expect(summary).toContain('插入')
  })

  it('省略 cell 时追加到末尾', () => {
    const { newText } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'insert',
      source: '尾部',
      cell_type: 'markdown',
    })
    const nb = parseNotebook(newText)
    expect(nb.cells).toHaveLength(3)
    expect(nb.cells[2].cell_type).toBe('markdown')
    expect(normalizeSource(nb.cells[2].source)).toBe('尾部')
  })

  it('插入位置超过总数时夹紧到末尾', () => {
    const { newText } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'insert',
      cell: 999,
      source: 'end',
    })
    const nb = parseNotebook(newText)
    expect(nb.cells).toHaveLength(3)
    expect(normalizeSource(nb.cells[2].source)).toBe('end')
  })

  it('insert 默认 cell_type 为 code', () => {
    const { newText } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'insert',
      cell: 0,
      source: 'a',
    })
    const nb = parseNotebook(newText)
    expect(nb.cells[0].cell_type).toBe('code')
  })

  it('非法 cell_type 抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), {
        path: 'x',
        mode: 'insert',
        source: 'a',
        cell_type: 'sql' as any,
      }),
    ).toThrow(/cell_type/)
  })

  it('负数插入位置抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), {
        path: 'x',
        mode: 'insert',
        cell: -1,
        source: 'a',
      }),
    ).toThrow(/插入位置/)
  })
})

describe('applyNotebookEdit — delete', () => {
  it('删除指定 cell', () => {
    const { newText, summary } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      mode: 'delete',
      cell: 0,
    })
    const nb = parseNotebook(newText)
    expect(nb.cells).toHaveLength(1)
    expect(nb.cells[0].cell_type).toBe('markdown')
    expect(summary).toContain('删除 cell 0')
  })

  it('缺索引抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), { path: 'x', mode: 'delete' }),
    ).toThrow(/索引/)
  })

  it('越界抛错', () => {
    expect(() =>
      applyNotebookEdit(sampleNotebook(), { path: 'x', mode: 'delete', cell: 5 }),
    ).toThrow(/超出范围/)
  })
})

describe('applyNotebookEdit — 默认模式', () => {
  it('未指定 mode 时默认 replace', () => {
    const { summary } = applyNotebookEdit(sampleNotebook(), {
      path: 'x.ipynb',
      cell: 0,
      source: 'a = 1',
    })
    expect(summary).toContain('替换 cell 0')
  })
})
