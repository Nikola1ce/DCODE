// checkpoint 单元测试。
// 覆盖备份、undo 恢复、undo 删除新建文件、清空与列表。
// 制作人：Moriarty_Dox

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  saveCheckpointBeforeWrite,
  undoCheckpoints,
  listCheckpoints,
  clearCheckpoints,
  getCheckpointCount,
  getCheckpointsDir,
} from './checkpoint.js'

describe('checkpoint', () => {
  let tempCwd: string

  /** 创建临时工作目录。 */
  function setup(): void {
    tempCwd = mkdtempSync(join(tmpdir(), 'dcode-cp-test-'))
  }

  it('saveCheckpointBeforeWrite 备份已有文件', () => {
    setup()
    const file = join(tempCwd, 'a.txt')
    writeFileSync(file, 'original', 'utf8')

    saveCheckpointBeforeWrite(tempCwd, file, 'write_file')
    writeFileSync(file, 'modified', 'utf8')

    expect(getCheckpointCount(tempCwd)).toBe(1)
    const result = undoCheckpoints(tempCwd, 1)
    expect(result.count).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe('original')
  })

  it('saveCheckpointBeforeWrite 新建文件 undo 时删除', () => {
    setup()
    const file = join(tempCwd, 'new.txt')

    saveCheckpointBeforeWrite(tempCwd, file, 'write_file')
    writeFileSync(file, 'brand new', 'utf8')
    expect(existsSync(file)).toBe(true)

    const result = undoCheckpoints(tempCwd, 1)
    expect(result.deleted).toContain('new.txt')
    expect(existsSync(file)).toBe(false)
  })

  it('undoCheckpoints 可一次回退多条', () => {
    setup()
    const file = join(tempCwd, 'b.txt')
    writeFileSync(file, 'v0', 'utf8')

    saveCheckpointBeforeWrite(tempCwd, file, 'edit_file')
    writeFileSync(file, 'v1', 'utf8')
    saveCheckpointBeforeWrite(tempCwd, file, 'edit_file')
    writeFileSync(file, 'v2', 'utf8')

    expect(listCheckpoints(tempCwd).length).toBe(2)
    undoCheckpoints(tempCwd, 2)
    expect(readFileSync(file, 'utf8')).toBe('v0')
  })

  it('clearCheckpoints 清空 manifest 与计数', () => {
    setup()
    const file = join(tempCwd, 'c.txt')
    writeFileSync(file, 'x', 'utf8')
    saveCheckpointBeforeWrite(tempCwd, file, 'write_file')
    expect(getCheckpointCount(tempCwd)).toBe(1)

    const n = clearCheckpoints(tempCwd)
    expect(n).toBe(1)
    expect(getCheckpointCount(tempCwd)).toBe(0)
  })

  it('getCheckpointsDir 位于 .dcode/checkpoints', () => {
    setup()
    expect(getCheckpointsDir(tempCwd)).toContain('.dcode')
    expect(getCheckpointsDir(tempCwd)).toContain('checkpoints')
  })
})
