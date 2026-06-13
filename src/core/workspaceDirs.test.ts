// workspaceDirs 单元测试。
// 覆盖额外工作目录的添加、移除、加载、清空与项目级持久化（.dcode/workspace.json）。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  addExtraDir,
  removeExtraDir,
  loadExtraDirs,
  clearExtraDirs,
  getWorkspaceDirsPath,
  renderExtraDirsList,
} from './workspaceDirs.js'

/** 创建一个临时项目目录（充当 cwd）。 */
function makeProject(): string {
  return mkdtempSync(join(tmpdir(), 'dcode-ws-proj-'))
}

/** 创建一个临时外部目录（充当待添加目录）。 */
function makeExternalDir(): string {
  return mkdtempSync(join(tmpdir(), 'dcode-ws-ext-'))
}

describe('workspaceDirs', () => {
  let cwd: string

  beforeEach(() => {
    cwd = makeProject()
  })

  it('初始无额外目录', () => {
    expect(loadExtraDirs(cwd)).toEqual([])
  })

  it('添加存在的目录并持久化到 .dcode/workspace.json', () => {
    const ext = makeExternalDir()
    const result = addExtraDir(cwd, ext)
    expect(result.ok).toBe(true)
    expect(result.alreadyPresent).toBe(false)
    expect(result.resolved).toBeTruthy()

    // 持久化文件应存在且包含该目录。
    const p = getWorkspaceDirsPath(cwd)
    expect(existsSync(p)).toBe(true)
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    expect(Array.isArray(parsed.dirs)).toBe(true)
    expect(parsed.dirs.length).toBe(1)

    // 重新加载应返回该目录。
    const loaded = loadExtraDirs(cwd)
    expect(loaded.length).toBe(1)
  })

  it('重复添加同一目录返回 alreadyPresent', () => {
    const ext = makeExternalDir()
    addExtraDir(cwd, ext)
    const again = addExtraDir(cwd, ext)
    expect(again.ok).toBe(true)
    expect(again.alreadyPresent).toBe(true)
    // 不应产生重复项。
    expect(loadExtraDirs(cwd).length).toBe(1)
  })

  it('添加不存在的目录返回 error', () => {
    const result = addExtraDir(cwd, join(cwd, 'no-such-dir-xyz'))
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('添加文件（非目录）返回 error', () => {
    const f = join(cwd, 'a-file.txt')
    writeFileSync(f, 'x', 'utf8')
    const result = addExtraDir(cwd, f)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不是目录')
  })

  it('添加当前工作目录自身返回 error', () => {
    const result = addExtraDir(cwd, cwd)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('当前工作目录')
  })

  it('移除已添加目录', () => {
    const ext = makeExternalDir()
    addExtraDir(cwd, ext)
    const removed = removeExtraDir(cwd, ext)
    expect(removed.removed).toBe(true)
    expect(loadExtraDirs(cwd)).toEqual([])
  })

  it('移除不存在的目录返回 removed=false', () => {
    const removed = removeExtraDir(cwd, join(tmpdir(), 'never-added-zzz'))
    expect(removed.removed).toBe(false)
  })

  it('clearExtraDirs 清空全部并返回数量', () => {
    addExtraDir(cwd, makeExternalDir())
    addExtraDir(cwd, makeExternalDir())
    expect(loadExtraDirs(cwd).length).toBe(2)
    const n = clearExtraDirs(cwd)
    expect(n).toBe(2)
    expect(loadExtraDirs(cwd)).toEqual([])
  })

  it('loadExtraDirs 过滤掉已不存在的目录', () => {
    const ext = makeExternalDir()
    addExtraDir(cwd, ext)
    // 手动写入一个不存在的目录到持久化文件。
    const p = getWorkspaceDirsPath(cwd)
    const ghost = join(tmpdir(), 'dcode-ghost-dir-zzz')
    writeFileSync(p, JSON.stringify({ dirs: [ext, ghost] }, null, 2), 'utf8')
    const loaded = loadExtraDirs(cwd)
    // 只应保留真实存在的 ext。
    expect(loaded.length).toBe(1)
  })

  it('renderExtraDirsList 空列表给出用法提示', () => {
    const text = renderExtraDirsList(cwd, [])
    expect(text).toContain('没有额外工作目录')
    expect(text).toContain('/add-dir')
  })

  it('renderExtraDirsList 非空列表含目录与持久化路径', () => {
    const ext = makeExternalDir()
    const text = renderExtraDirsList(cwd, [ext])
    expect(text).toContain(ext)
    expect(text).toContain('持久化于')
  })

  it('损坏的 workspace.json 视为无额外目录', () => {
    const dir = join(cwd, '.dcode')
    mkdirSync(dir, { recursive: true })
    writeFileSync(getWorkspaceDirsPath(cwd), '{ not valid json', 'utf8')
    expect(loadExtraDirs(cwd)).toEqual([])
  })
})
