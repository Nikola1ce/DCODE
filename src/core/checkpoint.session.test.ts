// 会话检查点、安全回退与结构化 diff 的回归测试。
// 覆盖身份隔离、连续改动链、用户冲突、路径边界及备份/回退 I/O 失败。
// 制作人：Moriarty_Dox

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCheckpointFileDiff,
  clearCheckpoints,
  completeCheckpointAfterWrite,
  discardPendingCheckpoint,
  getCheckpointDiff,
  getCheckpointsDir,
  listCheckpoints,
  listCheckpointSummaries,
  renderCheckpointList,
  saveCheckpointBeforeWrite,
  undoCheckpointById,
  undoCheckpoints,
  undoSessionCheckpoints,
  type CheckpointIdentity,
  type CheckpointRecord,
} from './checkpoint.js'
import { buildDiffHunks } from '../tools/diff.js'

const faults = vi.hoisted(() => ({
  write: undefined as ((path: string) => boolean) | undefined,
  rename: undefined as ((from: string, to: string) => boolean) | undefined,
  unlink: undefined as ((path: string) => boolean) | undefined,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (faults.write?.(String(args[0]))) throw new Error('模拟写入失败')
      return actual.writeFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (faults.rename?.(String(args[0]), String(args[1]))) throw new Error('模拟重命名失败')
      return actual.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (faults.unlink?.(String(args[0]))) throw new Error('模拟删除失败')
      return actual.unlinkSync(...args)
    },
  }
})

let cwd: string
let outside: string
const identity: CheckpointIdentity = { sessionId: 'session-a', runId: 'run-a', turnId: 'turn-a', toolCallId: 'call-a' }

beforeEach(() => {
  cwd = fs.mkdtempSync(join(tmpdir(), 'dcode-cp-session-'))
  outside = fs.mkdtempSync(join(tmpdir(), 'dcode-cp-outside-'))
})

afterEach(() => {
  faults.write = undefined
  faults.rename = undefined
  faults.unlink = undefined
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function write(path: string, content: string): void {
  const abs = join(cwd, path)
  fs.mkdirSync(dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

function read(path: string): string {
  return fs.readFileSync(join(cwd, path), 'utf8')
}

function change(path: string, content: string | null, scope = identity): CheckpointRecord {
  const abs = join(cwd, path)
  const record = saveCheckpointBeforeWrite(cwd, abs, 'write_file', scope)
  expect(record).toBeDefined()
  if (content === null) fs.unlinkSync(abs)
  else write(path, content)
  const completed = completeCheckpointAfterWrite(cwd, record!.id, content)
  expect(completed).toBeDefined()
  return completed!
}

function snapshot(record: CheckpointRecord, after = false): string {
  return join(getCheckpointsDir(cwd), 'data', `${record.id}.${after ? 'after' : 'bak'}`)
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

describe('检查点身份与不可变 diff', () => {
  it('持久化完整身份、前后 hash/快照，并用已有算法返回结构化 diff', () => {
    write('a.txt', 'same\nbefore\nend')
    const record = change('a.txt', 'same\nafter\nend')
    expect(listCheckpoints(cwd)).toEqual([record])
    expect(record).toMatchObject({ ...identity, beforeHash: hash('same\nbefore\nend'), afterHash: hash('same\nafter\nend'), pending: false })
    expect(fs.readFileSync(snapshot(record), 'utf8')).toBe('same\nbefore\nend')
    expect(fs.readFileSync(snapshot(record, true), 'utf8')).toBe('same\nafter\nend')
    expect(listCheckpointSummaries(cwd, 'session-a')).toEqual([
      expect.objectContaining({ ...identity, id: record.id, path: 'a.txt', operation: 'edit', legacy: false, complete: true }),
    ])
    const diff = getCheckpointDiff(cwd, record.id, 'session-a')
    expect(diff).toMatchObject({ ok: true, added: 1, removed: 1, truncated: false })
    if (diff.ok) expect(diff.hunks).toEqual(buildDiffHunks('same\nbefore\nend', 'same\nafter\nend'))
  })

  it('diff 使用保存的 after，而不是后来修改的工作区内容', () => {
    write('a.txt', 'before')
    const record = change('a.txt', 'agent')
    write('a.txt', 'user')
    const diff = getCheckpointDiff(cwd, record.id, 'session-a')
    expect(diff.ok).toBe(true)
    if (diff.ok) {
      expect(diff.preview).toContain('agent')
      expect(diff.preview).not.toContain('user')
    }
    expect(completeCheckpointAfterWrite(cwd, record.id)).toBeUndefined()
    expect(listCheckpoints(cwd)[0].afterHash).toBe(hash('agent'))
  })

  it('创建空文件与不存在状态不同，回退新建文件会删除它', () => {
    const record = change('empty.txt', '')
    expect(record.afterHash).toBe(hash(''))
    expect(record.wasNewFile).toBe(true)
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: true, checkpoint: { operation: 'create' } })
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: true, count: 1, deleted: ['empty.txt'] })
    expect(fs.existsSync(join(cwd, 'empty.txt'))).toBe(false)
  })

  it('支持写后不存在的删除快照、diff 和恢复', () => {
    write('deleted.txt', 'old\ncontent')
    const record = change('deleted.txt', null)
    expect(record.afterHash).toBeNull()
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: true, added: 0, removed: 2, checkpoint: { operation: 'delete' } })
    expect(undoCheckpointById(cwd, record.id, 'session-a').ok).toBe(true)
    expect(read('deleted.txt')).toBe('old\ncontent')
  })

  it('只列出当前 session；跨会话 diff、单条和批量回退均拒绝', () => {
    const a = change('a.txt', 'a')
    const b = change('b.txt', 'b', { sessionId: 'session-b' })
    expect(listCheckpointSummaries(cwd, 'session-a').map((item) => item.id)).toEqual([a.id])
    expect(listCheckpointSummaries(cwd, 'session-b').map((item) => item.id)).toEqual([b.id])
    expect(listCheckpointSummaries(cwd, 'unknown')).toEqual([])
    expect(getCheckpointDiff(cwd, b.id, 'session-a')).toMatchObject({ ok: false, code: 'session_mismatch' })
    expect(undoCheckpointById(cwd, b.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'session_mismatch' }] })
    expect(undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')).toMatchObject({ ok: false, count: 0 })
    expect(read('a.txt')).toBe('a')
    expect(read('b.txt')).toBe('b')
  })

  it('空 session 不匹配 legacy，也不能执行空批次回退', () => {
    const record = change('a.txt', 'a')
    expect(listCheckpointSummaries(cwd, '')).toEqual([])
    expect(getCheckpointDiff(cwd, record.id, '')).toMatchObject({ ok: false, code: 'invalid_session' })
    expect(undoSessionCheckpoints(cwd, [], '')).toMatchObject({ ok: false, count: 0 })
    expect(undoSessionCheckpoints(cwd, [], 'session-a')).toMatchObject({ ok: true, count: 0 })
  })

  it('历史无身份记录仅保留 CLI list/undo 兼容，按 id 无法借用当前身份', () => {
    write('legacy.txt', 'before')
    const record = saveCheckpointBeforeWrite(cwd, join(cwd, 'legacy.txt'), 'edit_file')!
    write('legacy.txt', 'after')
    expect(listCheckpointSummaries(cwd, 'session-a')).toEqual([])
    expect(renderCheckpointList(cwd)).toContain('legacy')
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: false, code: 'legacy' })
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'legacy' }] })
    expect(undoCheckpoints(cwd, 1).count).toBe(1)
    expect(read('legacy.txt')).toBe('before')
  })

  it('真正的旧格式记录没有 hash 或 pending，仍仅允许 CLI 恢复', () => {
    write('legacy.txt', 'before')
    const saved = saveCheckpointBeforeWrite(cwd, join(cwd, 'legacy.txt'), 'edit_file')!
    const { beforeHash: _beforeHash, ...legacy } = saved
    fs.writeFileSync(join(getCheckpointsDir(cwd), 'manifest.json'), JSON.stringify([legacy]))
    write('legacy.txt', 'after')
    expect(listCheckpoints(cwd)).toEqual([legacy])
    expect(listCheckpointSummaries(cwd, 'session-a')).toEqual([])
    expect(getCheckpointDiff(cwd, legacy.id, 'session-a')).toMatchObject({ ok: false, code: 'legacy' })
    expect(undoCheckpointById(cwd, legacy.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'legacy' }] })
    expect(undoCheckpoints(cwd, 1).count).toBe(1)
    expect(read('legacy.txt')).toBe('before')
  })

  it('未完成写入的记录即使在旧 CLI 入口也不可回退', () => {
    write('a.txt', 'before')
    const record = saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)!
    write('a.txt', 'after')
    expect(listCheckpointSummaries(cwd, 'session-a')[0].complete).toBe(false)
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: false, code: 'incomplete' })
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'incomplete' }] })
    expect(undoCheckpoints(cwd, 1).count).toBe(0)
    expect(read('a.txt')).toBe('after')
  })
})

describe('整批预检与同文件连续修改', () => {
  it('同文件三次修改按记录逆序恢复，忽略 ids 的传入顺序', () => {
    write('a.txt', 'v0')
    const a = change('a.txt', 'v1')
    const b = change('a.txt', 'v2', { ...identity, turnId: 'turn-b' })
    const c = change('a.txt', 'v3')
    const result = undoSessionCheckpoints(cwd, [a.id, c.id, b.id], 'session-a')
    expect(result).toMatchObject({ ok: true, count: 3, undoneIds: [c.id, b.id, a.id], errors: [] })
    expect(read('a.txt')).toBe('v0')
    expect(listCheckpoints(cwd)).toEqual([])
  })

  it('后续检查点即使写入相同内容，单独回退较旧记录仍冲突', () => {
    write('a.txt', 'v0')
    const a = change('a.txt', 'v1')
    const b = change('a.txt', 'v1')
    expect(undoCheckpointById(cwd, a.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'conflict' }] })
    expect(read('a.txt')).toBe('v1')
    expect(undoCheckpointById(cwd, b.id, 'session-a').ok).toBe(true)
    expect(undoCheckpointById(cwd, a.id, 'session-a').ok).toBe(true)
    expect(read('a.txt')).toBe('v0')
  })

  it('未选择中间检查点时整批拒绝，不先撤销较新记录', () => {
    write('a.txt', 'v0')
    const a = change('a.txt', 'v1')
    change('a.txt', 'v2')
    const c = change('a.txt', 'v3')
    expect(undoSessionCheckpoints(cwd, [a.id, c.id], 'session-a')).toMatchObject({ ok: false, count: 0 })
    expect(read('a.txt')).toBe('v3')
    expect(listCheckpoints(cwd)).toHaveLength(3)
  })

  it('不同会话交错修改同一文件，不能整轮覆盖其他会话改动', () => {
    write('a.txt', 'v0')
    const a = change('a.txt', 'a1')
    change('a.txt', 'b1', { sessionId: 'session-b' })
    const a2 = change('a.txt', 'a2')
    expect(undoSessionCheckpoints(cwd, [a.id, a2.id], 'session-a')).toMatchObject({ ok: false, count: 0 })
    expect(read('a.txt')).toBe('a2')
    expect(undoCheckpointById(cwd, a2.id, 'session-a').ok).toBe(true)
    expect(read('a.txt')).toBe('b1')
    expect(undoCheckpointById(cwd, a.id, 'session-a').ok).toBe(false)
  })

  it('一个文件有用户修改时，其余文件也保持不动', () => {
    write('a.txt', 'a0')
    write('b.txt', 'b0')
    const a = change('a.txt', 'a1')
    const b = change('b.txt', 'b1')
    write('a.txt', 'user edit')
    expect(undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'conflict' }] })
    expect(read('a.txt')).toBe('user edit')
    expect(read('b.txt')).toBe('b1')
    expect(listCheckpoints(cwd)).toHaveLength(2)
    expect(undoCheckpoints(cwd, 2).count).toBe(0)
  })

  it('两次工具修改间夹有未登记的用户修改时，回退链校验拒绝覆盖', () => {
    write('a.txt', 'v0')
    const a = change('a.txt', 'v1')
    write('a.txt', 'user between turns')
    const b = change('a.txt', 'v2')
    expect(undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')).toMatchObject({ ok: false, count: 0 })
    expect(read('a.txt')).toBe('v2')
  })

  it('用户删除已创建文件也属于状态冲突', () => {
    const record = change('a.txt', 'agent')
    fs.unlinkSync(join(cwd, 'a.txt'))
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'conflict' }] })
    expect(listCheckpoints(cwd)).toHaveLength(1)
  })

  it('重复或不存在的 ids 不会导致重复回退或部分执行', () => {
    const record = change('a.txt', 'a')
    expect(undoSessionCheckpoints(cwd, [record.id, record.id], 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'invalid_id' }] })
    expect(undoSessionCheckpoints(cwd, [record.id, 'missing'], 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'not_found' }] })
    expect(read('a.txt')).toBe('a')
  })
})

describe('路径与快照完整性', () => {
  it.each(['../escape', '..\\escape', '/absolute', 'C:\\absolute', 'x/../../escape'])('拒绝遍历记录 id：%s', (id) => {
    const record = change('a.txt', 'a')
    expect(getCheckpointDiff(cwd, id, 'session-a')).toMatchObject({ ok: false, code: 'invalid_id' })
    expect(undoCheckpointById(cwd, id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'invalid_id' }] })
    expect(listCheckpoints(cwd)[0].id).toBe(record.id)
  })

  it('拒绝 cwd 之外的保存路径，不在目标目录生成备份', () => {
    const file = join(outside, 'victim.txt')
    fs.writeFileSync(file, 'keep')
    expect(saveCheckpointBeforeWrite(cwd, file, 'edit_file', identity)).toBeUndefined()
    expect(listCheckpoints(cwd)).toEqual([])
    expect(fs.readFileSync(file, 'utf8')).toBe('keep')
  })

  it.each(['../escape.txt', '..\\escape.txt', '/absolute.txt', 'C:/absolute.txt', '.dcode/checkpoints/data/victim.txt'])('恶意 manifest 路径不能被回退：%s', (targetPath) => {
    const record = change('a.txt', 'after')
    fs.writeFileSync(join(getCheckpointsDir(cwd), 'manifest.json'), JSON.stringify([{ ...record, targetPath }]))
    expect(getCheckpointDiff(cwd, record.id, 'session-a').ok).toBe(false)
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0 })
    expect(undoCheckpoints(cwd, 1).count).toBe(0)
    expect(read('a.txt')).toBe('after')
  })

  it('manifest 内的遍历 id 不被加载为合法记录', () => {
    const record = change('a.txt', 'after')
    fs.writeFileSync(join(getCheckpointsDir(cwd), 'manifest.json'), JSON.stringify([{ ...record, id: '../escape' }]))
    expect(listCheckpoints(cwd)).toEqual([])
    expect(undoSessionCheckpoints(cwd, ['valid-id'], 'session-a').count).toBe(0)
    expect(read('a.txt')).toBe('after')
  })

  it('父目录被替换为 junction/符号链接后，拒绝恢复外部同内容文件', () => {
    write('dir/a.txt', 'before')
    const record = change('dir/a.txt', 'after')
    fs.renameSync(join(cwd, 'dir'), join(cwd, 'original-dir'))
    fs.writeFileSync(join(outside, 'a.txt'), 'after')
    fs.symlinkSync(outside, join(cwd, 'dir'), 'junction')
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'invalid_path' }] })
    expect(fs.readFileSync(join(outside, 'a.txt'), 'utf8')).toBe('after')
  })

  it('检查点存储目录为外部链接时不读写备份', () => {
    fs.symlinkSync(outside, join(cwd, '.dcode'), 'junction')
    write('a.txt', 'before')
    expect(saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)).toBeUndefined()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it.each([false, true])('before/after 快照损坏会阻止 diff 与整批回退（after=%s）', (after) => {
    write('a.txt', 'before')
    const record = change('a.txt', 'after')
    fs.writeFileSync(snapshot(record, after), after ? 'AFTER' : 'BEFORE')
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: false, code: 'snapshot_corrupt' })
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'snapshot_corrupt' }] })
    expect(read('a.txt')).toBe('after')
  })

  it('完整记录缺少 beforeHash 时拒绝未校验 diff，且整批回退不写入任何文件', () => {
    write('a.txt', 'before')
    const a = change('a.txt', 'after')
    const b = change('b.txt', 'b1')
    fs.writeFileSync(snapshot(a), 'BEFORE')
    fs.writeFileSync(join(getCheckpointsDir(cwd), 'manifest.json'), JSON.stringify([{ ...a, beforeHash: undefined }, b]))
    expect(getCheckpointDiff(cwd, a.id, 'session-a')).toMatchObject({ ok: false, code: 'snapshot_corrupt' })
    expect(undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'snapshot_corrupt' }] })
    expect(read('a.txt')).toBe('after')
    expect(read('b.txt')).toBe('b1')
    expect(listCheckpoints(cwd)).toHaveLength(2)
  })

  it('备份 data 子目录被替换为 junction 后拒绝读取或回退', () => {
    write('a.txt', 'before')
    const record = change('a.txt', 'after')
    const data = join(getCheckpointsDir(cwd), 'data')
    const externalData = join(outside, 'data')
    fs.renameSync(data, externalData)
    fs.symlinkSync(externalData, data, 'junction')
    expect(getCheckpointDiff(cwd, record.id, 'session-a')).toMatchObject({ ok: false, code: 'invalid_path' })
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'invalid_path' }] })
    expect(read('a.txt')).toBe('after')
    expect(fs.readdirSync(externalData)).toHaveLength(2)
  })

  it('缺少备份时不恢复其他已通过预检的文件', () => {
    write('a.txt', 'a0')
    const a = change('a.txt', 'a1')
    const b = change('b.txt', 'b1')
    fs.unlinkSync(snapshot(a))
    expect(undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')).toMatchObject({ ok: false, count: 0, failures: [{ code: 'snapshot_missing' }] })
    expect(read('b.txt')).toBe('b1')
    expect(listCheckpoints(cwd)).toHaveLength(2)
  })
})

describe('失败处理不谎报成功', () => {
  it('before 备份保存失败返回 undefined，不登记可回退记录', () => {
    write('a.txt', 'before')
    faults.write = (path) => path.endsWith('.bak')
    expect(saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)).toBeUndefined()
    expect(listCheckpoints(cwd)).toEqual([])
    expect(read('a.txt')).toBe('before')
  })

  it('manifest 保存失败不留下记录，也清理已写入的 before 备份', () => {
    write('a.txt', 'before')
    faults.rename = (_, to) => to.endsWith('manifest.json')
    expect(saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)).toBeUndefined()
    expect(listCheckpoints(cwd)).toEqual([])
    expect(fs.readdirSync(join(getCheckpointsDir(cwd), 'data'))).toEqual([])
  })

  it('after 备份失败只保留 pending，不可按 id 或 CLI 回退', () => {
    write('a.txt', 'before')
    const record = saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)!
    write('a.txt', 'after')
    faults.write = (path) => path.endsWith('.after')
    expect(completeCheckpointAfterWrite(cwd, record.id)).toBeUndefined()
    expect(listCheckpoints(cwd)[0]).toMatchObject({ pending: true })
    expect(listCheckpoints(cwd)[0].afterHash).toBeUndefined()
    expect(undoCheckpointById(cwd, record.id, 'session-a').count).toBe(0)
    expect(undoCheckpoints(cwd, 1).count).toBe(0)
  })

  it('写后内容已被替换时，不把用户内容当作工具的 after 快照', () => {
    write('a.txt', 'before')
    const record = saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)!
    write('a.txt', 'user')
    expect(completeCheckpointAfterWrite(cwd, record.id, 'agent')).toBeUndefined()
    expect(listCheckpoints(cwd)[0].afterHash).toBeUndefined()
    expect(read('a.txt')).toBe('user')
  })

  it('工具失败清理只移除未改变文件的 pending，部分写入时保留原始备份', () => {
    write('a.txt', 'before')
    const untouched = saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)!
    expect(discardPendingCheckpoint(cwd, untouched.id)).toBe(true)
    const partial = saveCheckpointBeforeWrite(cwd, join(cwd, 'a.txt'), 'edit_file', identity)!
    write('a.txt', 'partial')
    expect(discardPendingCheckpoint(cwd, partial.id)).toBe(false)
    expect(fs.readFileSync(snapshot(partial), 'utf8')).toBe('before')
  })

  it('目标恢复失败时 count=0，文件和记录保留，修复后可再次回退', () => {
    write('a.txt', 'before')
    const record = change('a.txt', 'after')
    faults.rename = (_, to) => to === join(cwd, 'a.txt')
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, undoneIds: [] })
    expect(read('a.txt')).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
    faults.rename = undefined
    expect(undoCheckpointById(cwd, record.id, 'session-a').ok).toBe(true)
    expect(read('a.txt')).toBe('before')
  })

  it('恢复后 manifest 提交失败会补偿到 after，不虚报成功', () => {
    write('a.txt', 'before')
    const record = change('a.txt', 'after')
    faults.rename = (_, to) => to.endsWith('manifest.json')
    expect(undoCheckpointById(cwd, record.id, 'session-a')).toMatchObject({ ok: false, count: 0, undoneIds: [] })
    expect(read('a.txt')).toBe('after')
    expect(listCheckpoints(cwd)).toHaveLength(1)
    faults.rename = undefined
    expect(undoCheckpointById(cwd, record.id, 'session-a').ok).toBe(true)
  })

  it('执行中途 I/O 失败明确报告已完成部分，并保留失败记录', () => {
    write('a.txt', 'a0')
    write('b.txt', 'b0')
    const a = change('a.txt', 'a1')
    const b = change('b.txt', 'b1')
    faults.rename = (_, to) => to === join(cwd, 'a.txt')
    const result = undoSessionCheckpoints(cwd, [a.id, b.id], 'session-a')
    expect(result).toMatchObject({ ok: false, count: 1, undoneIds: [b.id], restored: ['b.txt'] })
    expect(result.errors).toHaveLength(1)
    expect(read('a.txt')).toBe('a1')
    expect(read('b.txt')).toBe('b0')
    expect(listCheckpoints(cwd).map((record) => record.id)).toEqual([a.id])
  })

  it('clear 同时清理前后快照', () => {
    write('a.txt', 'before')
    change('a.txt', 'after')
    expect(clearCheckpoints(cwd)).toBe(1)
    expect(listCheckpoints(cwd)).toEqual([])
    expect(fs.readdirSync(join(getCheckpointsDir(cwd), 'data'))).toEqual([])
  })
})

describe('大文件 diff 限制', () => {
  it('限制 LCS 矩阵规模，省略时不谎报零改动', () => {
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n')
    const diff = buildCheckpointFileDiff(text, `${text}\nnew`)
    expect(diff).toMatchObject({ hunks: [], truncated: true })
    expect(diff.added).toBeUndefined()
    expect(diff.removed).toBeUndefined()
    expect(diff.preview).toContain('省略')
  })

  it('限制输入字节数，支持巨大的单行文件', () => {
    const diff = buildCheckpointFileDiff('before', 'a'.repeat(600 * 1024))
    expect(diff).toMatchObject({ hunks: [], truncated: true })
    expect(diff.preview.length).toBeLessThan(200)
  })

  it('保留准确统计，但限制输出行数及 JSON 大小', () => {
    const before = Array.from({ length: 300 }, (_, i) => `before ${i}`).join('\n')
    const after = Array.from({ length: 300 }, (_, i) => `after ${i}`).join('\n')
    const diff = buildCheckpointFileDiff(before, after)
    expect(diff).toMatchObject({ added: 300, removed: 300, truncated: true })
    expect(diff.hunks.flatMap((hunk) => hunk.lines).length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(JSON.stringify(diff))).toBeLessThan(128 * 1024)
    const longLine = buildCheckpointFileDiff('old', 'x'.repeat(100 * 1024))
    expect(longLine).toMatchObject({ added: 1, removed: 1, truncated: true })
    expect(Buffer.byteLength(JSON.stringify(longLine))).toBeLessThan(128 * 1024)
  })
})
