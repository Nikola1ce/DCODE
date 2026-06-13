// notebook_read / notebook_edit 工具层单元测试。
// notebook.test.ts 已覆盖解析/渲染/applyNotebookEdit 的纯逻辑；本文件聚焦「工具外壳」：
// 真实临时 .ipynb 文件的读取渲染、写回、错误路径（文件不存在/越界/缺参）、
// 权限请求生成（default 附 diff、bypass 放行）以及编辑后磁盘内容保真。
// 制作人：Moriarty_Dox

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../core/types.js'
import { normalizeSource, parseNotebook } from './notebook.js'
import { notebookEditTool } from './notebookEdit.js'
import { notebookReadTool } from './notebookRead.js'

/** 构造一个最小可用的 ToolContext（默认 bypass，免授权直接跑 run）。 */
function makeCtx(
  cwd: string,
  permissionMode: ToolContext['permissionMode'] = 'bypass',
): ToolContext {
  return {
    cwd,
    config: {} as any,
    permissionMode,
    abortSignal: new AbortController().signal,
    requestPermission: async () => 'allow_once',
    todos: [],
    setTodos: () => {},
  }
}

/** 在临时目录写入示例 notebook，返回 { cwd, file }。 */
function writeSampleNotebook(): { cwd: string; file: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'dcode-nbtool-'))
  const file = join(cwd, 'demo.ipynb')
  const nb = {
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Demo'] },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['print(1)'],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
      },
    ],
    metadata: { kernelspec: { name: 'python3' }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }
  writeFileSync(file, `${JSON.stringify(nb, null, 2)}\n`, 'utf8')
  return { cwd, file }
}

/** 读取并解析磁盘 notebook，便于断言写回结果。 */
function readNb(file: string) {
  return parseNotebook(readFileSync(file, 'utf8'))
}

describe('notebookReadTool', () => {
  it('文件不存在返回错误', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dcode-nbtool-'))
    const res = await notebookReadTool.run({ path: 'none.ipynb' }, makeCtx(cwd))
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('不存在')
  })

  it('渲染整本 notebook 含两类 cell', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookReadTool.run({ path: file }, makeCtx(cwd))
    expect(res.isError).toBeFalsy()
    expect(res.llmContent).toContain('共 2 个 cell')
    expect(res.llmContent).toContain('[cell 0] markdown')
    expect(res.llmContent).toContain('[cell 1] code')
    expect(res.llmContent).toContain('print(1)')
    expect(res.llmContent).toContain('输出：')
  })

  it('cell 参数仅渲染单个 cell', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookReadTool.run({ path: file, cell: 1 }, makeCtx(cwd))
    expect(res.llmContent).toContain('[cell 1] code')
    expect(res.llmContent).not.toContain('[cell 0] markdown')
  })

  it('cell 越界返回错误', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookReadTool.run({ path: file, cell: 9 }, makeCtx(cwd))
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('超出范围')
  })

  it('include_outputs=false 不展示输出', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookReadTool.run(
      { path: file, include_outputs: false },
      makeCtx(cwd),
    )
    expect(res.llmContent).not.toContain('输出：')
  })

  it('损坏的 .ipynb 返回解析错误', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dcode-nbtool-'))
    const file = join(cwd, 'bad.ipynb')
    writeFileSync(file, '{ broken', 'utf8')
    const res = await notebookReadTool.run({ path: file }, makeCtx(cwd))
    expect(res.isError).toBe(true)
  })
})

describe('notebookEditTool - run', () => {
  it('replace 写回新源码并清空 code cell 旧输出', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookEditTool.run(
      { path: file, cell: 1, source: 'print(2)' },
      makeCtx(cwd),
    )
    expect(res.isError).toBeFalsy()
    const nb = readNb(file)
    expect(normalizeSource(nb.cells[1].source)).toBe('print(2)')
    expect(nb.cells[1].outputs).toEqual([])
    expect(nb.cells[1].execution_count).toBeNull()
  })

  it('insert 在指定位置插入 code cell', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookEditTool.run(
      { path: file, mode: 'insert', cell: 1, source: 'x = 42', cell_type: 'code' },
      makeCtx(cwd),
    )
    expect(res.isError).toBeFalsy()
    const nb = readNb(file)
    expect(nb.cells).toHaveLength(3)
    expect(normalizeSource(nb.cells[1].source)).toBe('x = 42')
  })

  it('delete 删除指定 cell', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookEditTool.run(
      { path: file, mode: 'delete', cell: 0 },
      makeCtx(cwd),
    )
    expect(res.isError).toBeFalsy()
    const nb = readNb(file)
    expect(nb.cells).toHaveLength(1)
    expect(nb.cells[0].cell_type).toBe('code')
  })

  it('文件不存在返回错误', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dcode-nbtool-'))
    const res = await notebookEditTool.run(
      { path: 'none.ipynb', cell: 0, source: 'x' },
      makeCtx(cwd),
    )
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('不存在')
  })

  it('越界 cell 返回错误（不抛异常）', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookEditTool.run(
      { path: file, cell: 9, source: 'x' },
      makeCtx(cwd),
    )
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('超出范围')
  })

  it('replace 缺 source 返回错误', async () => {
    const { cwd, file } = writeSampleNotebook()
    const res = await notebookEditTool.run({ path: file, cell: 0 }, makeCtx(cwd))
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('source')
  })

  it('编辑后顶层 nbformat 与 metadata 被保留', async () => {
    const { cwd, file } = writeSampleNotebook()
    await notebookEditTool.run({ path: file, cell: 0, source: '# 改了' }, makeCtx(cwd))
    const nb = readNb(file)
    expect(nb.raw.nbformat).toBe(4)
    expect((nb.raw.metadata as any).kernelspec.name).toBe('python3')
  })
})

describe('notebookEditTool - 权限', () => {
  it('default 模式生成权限请求并附 diff 预览', () => {
    const { cwd, file } = writeSampleNotebook()
    const req = notebookEditTool.checkPermission?.(
      { path: file, cell: 1, source: 'print(3)' },
      makeCtx(cwd, 'default'),
    )
    expect(req?.toolName).toBe('notebook_edit')
    expect(typeof req?.preview).toBe('string')
    expect(req?.preview).toContain('print(3)')
  })

  it('bypass 模式不请求授权', () => {
    const { cwd, file } = writeSampleNotebook()
    const req = notebookEditTool.checkPermission?.(
      { path: file, cell: 1, source: 'print(3)' },
      makeCtx(cwd, 'bypass'),
    )
    expect(req).toBeNull()
  })
})
