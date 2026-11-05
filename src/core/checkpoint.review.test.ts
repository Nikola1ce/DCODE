// 审阅按文件/按块回退、撤销、版本冲突和失败补偿回归。
// 制作人：Moriarty_Dox
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const faults = vi.hoisted(() => ({
  write: undefined as ((path: string) => boolean) | undefined,
  rename: undefined as ((from: string, to: string) => boolean) | undefined,
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.write?.(String(args[0]))) throw new Error('模拟写入失败')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.rename?.(String(args[0]), String(args[1]))) throw new Error('模拟替换失败')
      return actual.renameSync(...args)
    },
  }
})
import {
  completeCheckpointAfterWrite, getCheckpointReview, getCheckpointsDir, listCheckpoints,
  revertCheckpointReview, saveCheckpointBeforeWrite, undoCheckpointReview, undoSessionCheckpoints,
} from './checkpoint.js'
import type { CheckpointRecord, CheckpointReview } from './checkpoint.js'

let cwd: string
const sessionId = 'session-a'
beforeEach(() => { cwd = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'dcode-review-'))) })
afterEach(() => {
  faults.write = undefined; faults.rename = undefined
  fs.rmSync(cwd, { recursive: true, force: true })
})
function write(content: string | Buffer | null, path = 'a.txt') {
  const target = join(cwd, path)
  if (content === null) fs.unlinkSync(target)
  else fs.writeFileSync(target, content)
}
function change(content: string | Buffer | null, turnId = 'turn-a', session = sessionId, path = 'a.txt'): CheckpointRecord {
  const record = saveCheckpointBeforeWrite(cwd, join(cwd, path), 'edit_file', { sessionId: session, turnId })!
  expect(record).toBeDefined()
  write(content, path)
  const completed = completeCheckpointAfterWrite(cwd, record.id, content)
  expect(completed).toBeDefined()
  return completed!
}
function review(id: string): CheckpointReview {
  const result = getCheckpointReview(cwd, id, sessionId)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.review
}
function revert(id: string, hunk?: number): string {
  const result = revertCheckpointReview(cwd, id, sessionId, review(id).revision, hunk)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  return result.checkpointId
}
function text() { return fs.readFileSync(join(cwd, 'a.txt'), 'utf8') }

describe('轮次审阅', () => {
  it('合并同轮同文件的连续修改，保留来源与回退前检查点，可通过磁盘记录撤销', () => {
    write('base\n')
    const first = change('middle\n')
    const last = change('final\n')
    const initial = review(last.id)
    expect(initial.checkpointIds).toEqual([first.id, last.id])
    expect(initial.diff.preview).toContain('base')
    expect(initial.diff.preview).toContain('final')
    expect(initial.diff.preview).not.toContain('middle')
    const undoId = revert(first.id)
    expect(text()).toBe('base\n')
    expect(listCheckpoints(cwd)).toHaveLength(3)
    expect(listCheckpoints(cwd)[2].reviewOf).toEqual([first.id, last.id])
    expect(review(first.id)).toMatchObject({ reverted: true, canRevert: false, undoCheckpointId: undoId })
    expect(undoCheckpointReview(cwd, undoId, sessionId)).toMatchObject({ ok: true, count: 1 })
    expect(text()).toBe('final\n')
    expect(listCheckpoints(cwd)).toHaveLength(2)
  })

  it('逐块回退后重新计算剩余差异，拒绝重复版本，按逆序撤销恢复每一步', () => {
    const original = Array.from({ length: 25 }, (_, i) => `行 ${i}`).join('\r\n') + '\r\n'
    write(original)
    const modified = original.replace('行 1\r', '更改一\r').replace('行 21\r', '更改二\r')
    const source = change(modified)
    const initial = review(source.id)
    expect(initial.diff.hunks).toHaveLength(2)
    const undoFirst = revert(source.id, 0)
    expect(text()).toBe(original.replace('行 21\r', '更改二\r'))
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision, 0)).toMatchObject({ ok: false, code: 'conflict' })
    expect(review(source.id).diff.hunks).toHaveLength(1)
    const undoSecond = revert(source.id, 0)
    expect(text()).toBe(original)
    expect(undoCheckpointReview(cwd, undoFirst, sessionId)).toMatchObject({ ok: false, count: 0 })
    expect(undoCheckpointReview(cwd, undoSecond, sessionId).ok).toBe(true)
    expect(text()).toContain('更改二')
    expect(undoCheckpointReview(cwd, undoFirst, sessionId).ok).toBe(true)
    expect(text()).toBe(modified)
  })

  it.each([
    ['空新文件', null, Buffer.from('')],
    ['新文件', null, Buffer.from('新增\n')],
    ['删除文件', Buffer.from('删除前\r\n'), null],
    ['UTF-8 BOM', Buffer.from('\ufeff旧\r\n'), Buffer.from('\ufeff新\r\n')],
    ['二进制', Buffer.from([0, 1, 255]), Buffer.from([0, 2, 254])],
    ['非 UTF-8', Buffer.from([255, 254, 128]), Buffer.from([255, 254, 129])],
  ] as [string, Buffer | null, Buffer | null][])('整文件回退和撤销保持原始字节与存在状态 — %s', (_name, before, after) => {
    if (before !== null) write(before)
    const source = change(after)
    const undoId = revert(source.id)
    if (before === null) expect(fs.existsSync(join(cwd, 'a.txt'))).toBe(false)
    else expect(fs.readFileSync(join(cwd, 'a.txt'))).toEqual(before)
    expect(undoCheckpointReview(cwd, undoId, sessionId).ok).toBe(true)
    if (after === null) expect(fs.existsSync(join(cwd, 'a.txt'))).toBe(false)
    else expect(fs.readFileSync(join(cwd, 'a.txt'))).toEqual(after)
  })

  it.each([
    ['旧末行', '新末行'], ['', '新增\n'], ['旧\r\n', '新\r\n'], ['\ufeff旧', '\ufeff新'], ['删除\n', ''],
    ['a\nb\nc', 'first\na\nb\nc'], ['a\nb\nc', 'a\ninsert\nb\nc'], ['a\nb\nc', 'a\nb\nc\nlast'],
    ['a\nb\nc', 'b\nc'], ['a\nb\nc', 'a\nc'], ['a\nb\nc', 'a\nb'],
    ['a\nb', 'a\nb\n'], ['a\nb\n', 'a\nb'],
  ])('按块回退保留末尾换行和空文本 %j → %j', (before, after) => {
    write(before)
    const source = change(after)
    revert(source.id, 0)
    expect(text()).toBe(before)
  })

  it('新建和删除文件的完整差异块正确恢复不存在/存在状态', () => {
    const created = change('新内容')
    const undoId = revert(created.id, 0)
    expect(fs.existsSync(join(cwd, 'a.txt'))).toBe(false)
    expect(undoCheckpointReview(cwd, undoId, sessionId).ok).toBe(true)
    const deleted = change(null, 'turn-delete')
    revert(deleted.id, 0)
    expect(text()).toBe('新内容')
  })

  it('其他会话和 legacy 记录不能借用当前会话，原始改动不能误作为撤销回退', () => {
    const source = change('text')
    expect(getCheckpointReview(cwd, source.id, 'other')).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(undoCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, count: 0 })
    const legacy = saveCheckpointBeforeWrite(cwd, join(cwd, 'legacy.txt'), 'write_file')!
    expect(getCheckpointReview(cwd, legacy.id, sessionId)).toMatchObject({ ok: false, code: 'legacy' })
  })

  it('后续其他轮次即使内容相同也阻止旧轮次回退，原历史仍可审阅', () => {
    write('before')
    const source = change('after')
    change('after', 'later', 'other')
    const state = review(source.id)
    expect(state.canRevert).toBe(false)
    expect(state.diff.preview).toContain('before')
    expect(revertCheckpointReview(cwd, source.id, sessionId, state.revision)).toMatchObject({ ok: false, code: 'conflict' })
    expect(text()).toBe('after')
  })

  it('检测穿插轮次、未记录修改、用户编辑及过期版本', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    write('user')
    expect(review(source.id).canRevert).toBe(false)
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'conflict' })
    change('next')
    expect(getCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, code: 'conflict' })
    change('other', 'other-turn')
    change('again')
    expect(getCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, code: 'conflict' })
    expect(text()).toBe('again')
  })

  it('截断 diff 与非 UTF-8 仅可整文件回退，无效块序号拒绝写入', () => {
    write('before')
    const source = change('新增\n'.repeat(500))
    const initial = review(source.id)
    expect(initial.diff.truncated).toBe(true)
    for (const index of [0, -1, 0.5, Number.NaN]) {
      expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision, index)).toMatchObject({ ok: false, code: 'unsupported' })
    }
    expect(listCheckpoints(cwd)).toHaveLength(1)
    revert(source.id)
    expect(text()).toBe('before')
    write(Buffer.from([255]))
    const invalid = change(Buffer.from([254]), 'invalid-utf8')
    expect(revertCheckpointReview(cwd, invalid.id, sessionId, review(invalid.id).revision, 0)).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('损坏快照与 pending 检查点均拒绝回退', () => {
    write('before')
    const source = change('after')
    const backup = join(getCheckpointsDir(cwd), 'data', `${source.id}.bak`)
    fs.writeFileSync(backup, 'corrupt')
    expect(getCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, code: 'snapshot_corrupt' })
    const pending = saveCheckpointBeforeWrite(cwd, join(cwd, 'b.txt'), 'write_file', { sessionId, turnId: 'pending' })!
    expect(getCheckpointReview(cwd, pending.id, sessionId)).toMatchObject({ ok: false, code: 'incomplete' })
    expect(text()).toBe('after')
  })

  it('路径目录被 junction 替换时拒绝访问外部文件', () => {
    fs.mkdirSync(join(cwd, 'folder'))
    fs.mkdirSync(join(cwd, 'outside'))
    write('before', 'folder/a.txt')
    const source = change('after', 'turn-a', sessionId, 'folder/a.txt')
    write('secret', 'outside/a.txt')
    fs.renameSync(join(cwd, 'folder'), join(cwd, 'original'))
    fs.symlinkSync(join(cwd, 'outside'), join(cwd, 'folder'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(getCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, code: 'invalid_path' })
    expect(fs.readFileSync(join(cwd, 'outside/a.txt'), 'utf8')).toBe('secret')
  })

  it('检查点达到上限时拒绝回退以保留原始快照', () => {
    write('before')
    const source = change('after')
    const records = [source, ...Array.from({ length: 199 }, (_, i) => ({ ...source, id: `other-${i}`, targetPath: `other-${i}.txt`, turnId: `other-${i}` }))]
    fs.writeFileSync(join(getCheckpointsDir(cwd), 'manifest.json'), JSON.stringify(records))
    const initial = review(source.id)
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'limit_exceeded' })
    expect(listCheckpoints(cwd)).toEqual(records)
    expect(text()).toBe('after')
  })

  it('消息级整批回退可依次撤销审阅记录和原始改动', () => {
    write('before')
    const source = change('after')
    const undoId = revert(source.id)
    expect(undoSessionCheckpoints(cwd, [source.id, undoId], sessionId)).toMatchObject({ ok: true, count: 2 })
    expect(text()).toBe('before')
    expect(listCheckpoints(cwd)).toEqual([])
  })
})

describe('审阅失败补偿', () => {
  it('备份失败时保留原文件与原始记录', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    faults.write = (path) => path.endsWith('.bak')
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'io_error' })
    expect(text()).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
  })

  it('目标文件替换失败时清理未生效的检查点', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    faults.rename = (_from, to) => to === join(cwd, 'a.txt')
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'io_error' })
    expect(text()).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
  })

  it('写后快照登记失败时补偿文件，原始审阅版本可重试', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    faults.write = (path) => path.endsWith('.after')
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'io_error' })
    expect(text()).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
    faults.write = undefined
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision).ok).toBe(true)
  })

  it('manifest 登记失败也补偿文件；补偿失败则保留 pending 备份并报告', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    let manifestWrites = 0
    faults.rename = (_from, to) => to.endsWith('manifest.json') && ++manifestWrites === 2
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({ ok: false, code: 'io_error' })
    expect(text()).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
    faults.rename = undefined
    faults.write = (path) => path.endsWith('.after')
    let targetWrites = 0
    faults.rename = (_from, to) => to === join(cwd, 'a.txt') && ++targetWrites === 2
    const result = revertCheckpointReview(cwd, source.id, sessionId, initial.revision)
    expect(result).toMatchObject({ ok: false, code: 'io_error', checkpointId: expect.any(String) })
    expect(text()).toBe('before')
    expect(listCheckpoints(cwd).at(-1)).toMatchObject({ pending: true, reviewOf: [source.id] })
    expect(getCheckpointReview(cwd, source.id, sessionId)).toMatchObject({ ok: false, code: 'incomplete' })
  })

  it('补偿期间出现用户修改时保留新内容及恢复检查点', () => {
    write('before')
    const source = change('after')
    const initial = review(source.id)
    faults.write = (path) => {
      if (!path.endsWith('.after')) return false
      write('用户刚刚保存的内容')
      return true
    }
    expect(revertCheckpointReview(cwd, source.id, sessionId, initial.revision)).toMatchObject({
      ok: false, code: 'io_error', checkpointId: expect.any(String),
    })
    expect(text()).toBe('用户刚刚保存的内容')
    expect(listCheckpoints(cwd).at(-1)).toMatchObject({ pending: true })
  })
})
