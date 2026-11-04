// 文件写工具的检查点、结构化权限与 changedFiles 集成测试。
// 覆盖 write_file / edit_file / notebook_edit 的身份透传、失败降级及有界 diff。
// 制作人：Moriarty_Dox

import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../core/types.js'
import { getCheckpointDiff, listCheckpoints, undoCheckpointById, undoCheckpoints } from '../core/checkpoint.js'
import { writeFileTool } from './writeFile.js'
import { editFileTool } from './editFile.js'
import { notebookEditTool } from './notebookEdit.js'

const faults = vi.hoisted(() => ({ write: undefined as ((path: string) => boolean) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.write?.(String(args[0]))) throw new Error('模拟写入失败')
      return actual.writeFileSync(...args)
    },
  }
})

let cwd: string
const identity = { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', toolCallId: 'call-a' }

beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), 'dcode-file-checkpoint-'))
})

afterEach(() => {
  faults.write = undefined
  fs.rmSync(cwd, { recursive: true, force: true })
})

function context(permissionMode: ToolContext['permissionMode'] = 'bypass'): ToolContext {
  return {
    cwd,
    ...identity,
    config: {} as ToolContext['config'],
    permissionMode,
    abortSignal: new AbortController().signal,
    requestPermission: async () => 'allow_once',
    todos: [],
    setTodos: () => {},
  }
}

function notebook(): string {
  return `${JSON.stringify({
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Demo'] },
      { cell_type: 'code', execution_count: 1, metadata: {}, source: ['print(1)'], outputs: [] },
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2)}\n`
}

describe('文件改动与权限结构', () => {
  it('write_file 创建文件的权限和结果带完整 diff/identity/checkpointId', async () => {
    const input = { path: 'new.txt', content: 'hello\nworld' }
    const request = writeFileTool.checkPermission!(input, context('default'))!
    expect(request.details).toMatchObject({ kind: 'file', path: 'new.txt', operation: 'create', added: 2, removed: 0 })
    expect(request.preview).toContain('@@')
    expect(listCheckpoints(cwd)).toEqual([])
    const result = await writeFileTool.run(input, context())
    const [record] = listCheckpoints(cwd)
    expect(record).toMatchObject({ ...identity, pending: false })
    expect(record.afterHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.changedFiles).toEqual([{ path: 'new.txt', operation: 'create', checkpointId: record.id, added: 2, removed: 0 }])
    const diff = getCheckpointDiff(cwd, record.id, identity.sessionId)
    expect(diff.ok).toBe(true)
    if (diff.ok && request.details?.kind === 'file') expect(diff.hunks).toEqual(request.details.hunks)
    expect(undoCheckpointById(cwd, record.id, identity.sessionId).ok).toBe(true)
    expect(fs.existsSync(join(cwd, 'new.txt'))).toBe(false)
  })

  it('write_file 覆盖时保留 CRLF，权限和最终快照使用同一份内容', async () => {
    fs.writeFileSync(join(cwd, 'a.txt'), 'one\r\ntwo\r\n')
    const input = { path: 'a.txt', content: 'one\nTWO\n' }
    const request = writeFileTool.checkPermission!(input, context('default'))!
    const result = await writeFileTool.run(input, context())
    const [record] = listCheckpoints(cwd)
    expect(result.changedFiles?.[0]).toMatchObject({ path: 'a.txt', operation: 'edit', checkpointId: record.id, added: 1, removed: 1 })
    expect(request.details).toMatchObject({ kind: 'file', operation: 'edit', added: 1, removed: 1 })
    expect(fs.readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\r\nTWO\r\n')
    const diff = getCheckpointDiff(cwd, record.id, identity.sessionId)
    if (diff.ok && request.details?.kind === 'file') expect(diff.hunks).toEqual(request.details.hunks)
    expect(undoCheckpointById(cwd, record.id, identity.sessionId).ok).toBe(true)
    expect(fs.readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\n')
  })

  it('edit_file 传递身份并返回准确改动统计', async () => {
    fs.writeFileSync(join(cwd, 'a.txt'), 'one\r\ntwo\r\n')
    const input = { path: 'a.txt', old_string: 'one\ntwo', new_string: 'ONE\nTWO\nextra' }
    const request = editFileTool.checkPermission!(input, context('default'))!
    expect(request.details).toMatchObject({ kind: 'file', path: 'a.txt', operation: 'edit', added: 3, removed: 2 })
    const result = await editFileTool.run(input, context())
    const [record] = listCheckpoints(cwd)
    expect(record).toMatchObject({ ...identity, tool: 'edit_file', pending: false })
    expect(result.changedFiles?.[0]).toMatchObject({ path: 'a.txt', operation: 'edit', checkpointId: record.id, added: 3, removed: 2 })
    const diff = getCheckpointDiff(cwd, record.id, identity.sessionId)
    expect(diff).toMatchObject({ ok: true, added: 3, removed: 2 })
    if (diff.ok && request.details?.kind === 'file') expect(diff.hunks).toEqual(request.details.hunks)
  })

  it.each(['replace', 'insert', 'delete'] as const)('notebook_edit 的 %s cell 是文件 edit 而非文件 create/delete', async (mode) => {
    const original = notebook()
    fs.writeFileSync(join(cwd, 'demo.ipynb'), original)
    const input = { path: 'demo.ipynb', mode, cell: 1, source: 'print(2)' }
    const request = notebookEditTool.checkPermission!(input, context('default'))!
    expect(request.details).toMatchObject({ kind: 'file', path: 'demo.ipynb', operation: 'edit' })
    expect(request.preview).toContain('@@')
    const result = await notebookEditTool.run(input, context())
    const [record] = listCheckpoints(cwd)
    expect(record).toMatchObject({ ...identity, tool: 'notebook_edit', pending: false })
    expect(result.changedFiles?.[0]).toMatchObject({ path: 'demo.ipynb', operation: 'edit', checkpointId: record.id })
    const diff = getCheckpointDiff(cwd, record.id, identity.sessionId)
    expect(diff.ok).toBe(true)
    if (diff.ok && request.details?.kind === 'file') {
      expect(diff.hunks).toEqual(request.details.hunks)
      expect(result.changedFiles?.[0].added).toBe(diff.added)
      expect(result.changedFiles?.[0].removed).toBe(diff.removed)
    }
    expect(undoCheckpointById(cwd, record.id, identity.sessionId).ok).toBe(true)
    expect(fs.readFileSync(join(cwd, 'demo.ipynb'), 'utf8')).toBe(original)
  })

  it('较大文件省略昂贵 diff，但仍返回路径、operation 和检查点', async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    fs.writeFileSync(join(cwd, 'large.txt'), text)
    const input = { path: 'large.txt', old_string: 'line 1500', new_string: 'changed 1500' }
    const request = editFileTool.checkPermission!(input, context('default'))!
    expect(request.details).toMatchObject({ kind: 'file', path: 'large.txt', operation: 'edit' })
    if (request.details?.kind === 'file') {
      expect(request.details.hunks).toBeUndefined()
      expect(request.details.added).toBeUndefined()
    }
    expect(request.preview).toContain('省略')
    const result = await editFileTool.run(input, context())
    expect(result.isError).toBeFalsy()
    expect(result.changedFiles?.[0].checkpointId).toBeDefined()
    expect(result.changedFiles?.[0].added).toBeUndefined()
    expect(result.llmContent).toContain('未逐行统计')
  })

  it('无 session 的旧工具上下文仍可 CLI 回退，但不能按当前 session 借用 id', async () => {
    const ctx = context()
    delete ctx.sessionId
    const result = await writeFileTool.run({ path: 'a.txt', content: 'a' }, ctx)
    const id = result.changedFiles![0].checkpointId!
    expect(undoCheckpointById(cwd, id, identity.sessionId)).toMatchObject({ ok: false, count: 0, failures: [{ code: 'legacy' }] })
    expect(undoCheckpoints(cwd, 1).count).toBe(1)
  })
})

const writeCases = [
  { name: 'write_file', tool: writeFileTool, path: 'a.txt', before: 'before', input: { path: 'a.txt', content: 'after' } },
  { name: 'edit_file', tool: editFileTool, path: 'a.txt', before: 'before', input: { path: 'a.txt', old_string: 'before', new_string: 'after' } },
  { name: 'notebook_edit', tool: notebookEditTool, path: 'demo.ipynb', before: notebook(), input: { path: 'demo.ipynb', cell: 1, source: 'print(2)' } },
]

describe('文件工具错误与检查点失败', () => {
  it('无效编辑不返回 changedFiles，也不生成检查点', async () => {
    fs.writeFileSync(join(cwd, 'a.txt'), 'before')
    const result = await editFileTool.run({ path: 'a.txt', old_string: 'missing', new_string: 'after' }, context())
    expect(result.isError).toBe(true)
    expect(result.changedFiles).toBeUndefined()
    expect(listCheckpoints(cwd)).toEqual([])
  })

  it.each(writeCases)('$name 备份失败不阻断已授权写入，但警告且不返回可回退 id', async ({ tool, path, before, input }) => {
    fs.writeFileSync(join(cwd, path), before)
    faults.write = (file) => file.endsWith('.bak')
    const result = await tool.run(input, context())
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('无法自动回退')
    expect(result.changedFiles?.[0]).toMatchObject({ path, operation: 'edit' })
    expect(result.changedFiles?.[0].checkpointId).toBeUndefined()
    expect(fs.readFileSync(join(cwd, path), 'utf8')).not.toBe(before)
    expect(listCheckpoints(cwd)).toEqual([])
  })

  it.each(writeCases)('$name after 备份失败不把 pending id 暴露为可回退改动', async ({ tool, path, before, input }) => {
    fs.writeFileSync(join(cwd, path), before)
    faults.write = (file) => file.endsWith('.after')
    const result = await tool.run(input, context())
    expect(result.isError).toBeFalsy()
    expect(result.llmContent).toContain('无法自动回退')
    expect(result.changedFiles?.[0]).toMatchObject({ path, operation: 'edit' })
    expect(result.changedFiles?.[0].checkpointId).toBeUndefined()
    expect(fs.readFileSync(join(cwd, path), 'utf8')).not.toBe(before)
    const [record] = listCheckpoints(cwd)
    expect(record).toMatchObject({ ...identity, pending: true })
    expect(undoCheckpointById(cwd, record.id, identity.sessionId).count).toBe(0)
    expect(undoCheckpoints(cwd, 1).count).toBe(0)
  })

  it.each(writeCases)('$name 实际写入失败清理未改变文件的 pending，不谎报 changedFiles', async ({ tool, path, before, input }) => {
    fs.writeFileSync(join(cwd, path), before)
    faults.write = (file) => file === join(cwd, path)
    const result = await tool.run(input, context())
    expect(result.isError).toBe(true)
    expect(result.changedFiles).toBeUndefined()
    expect(listCheckpoints(cwd)).toEqual([])
    expect(fs.readFileSync(join(cwd, path), 'utf8')).toBe(before)
  })

  it('预览无法应用的 notebook 操作仍提供结构化文件定位，不伪造 diff', () => {
    fs.writeFileSync(join(cwd, 'demo.ipynb'), notebook())
    const request = notebookEditTool.checkPermission!({ path: 'demo.ipynb', cell: 99, source: 'bad' }, context('default'))!
    expect(request.details).toMatchObject({ kind: 'file', path: 'demo.ipynb', operation: 'edit' })
    expect(request.preview).toBeUndefined()
    if (request.details?.kind === 'file') expect(request.details.hunks).toBeUndefined()
  })
})
