// tools/util 单元测试。
// 重点覆盖 resolveWithinCwd 的安全边界：默认仅允许 cwd 内，
// 传入 extraDirs 后允许额外授权目录，但仍拒绝未授权目录。
// 制作人：Moriarty_Dox

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { resolveWithinCwd, toDisplayPath } from './util.js'

/** 创建临时目录并返回其路径。 */
function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('resolveWithinCwd', () => {
  it('允许工作目录内的相对路径', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const abs = resolveWithinCwd(cwd, 'sub/file.ts')
    expect(abs.startsWith(cwd) || abs.includes('file.ts')).toBe(true)
  })

  it('拒绝越出工作目录的绝对路径（无额外目录）', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const outside = tempDir('dcode-util-out-')
    expect(() => resolveWithinCwd(cwd, join(outside, 'x.ts'))).toThrow(/越界/)
  })

  it('拒绝 ../ 逃逸', () => {
    const cwd = tempDir('dcode-util-cwd-')
    expect(() => resolveWithinCwd(cwd, '../../etc/passwd')).toThrow(/越界/)
  })

  it('extraDirs 授权后允许访问额外目录内文件', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const extra = tempDir('dcode-util-extra-')
    // 在额外目录里建一个文件。
    const target = join(extra, 'note.md')
    writeFileSync(target, 'hello', 'utf8')
    const abs = resolveWithinCwd(cwd, target, [extra])
    // 解析应成功且指向该文件。
    expect(abs.endsWith('note.md')).toBe(true)
  })

  it('extraDirs 中的目录允许新建文件（不存在路径）', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const extra = tempDir('dcode-util-extra-')
    const abs = resolveWithinCwd(cwd, join(extra, 'new', 'created.ts'), [extra])
    expect(abs.endsWith('created.ts')).toBe(true)
  })

  it('未列入 extraDirs 的其它目录仍被拒绝', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const extra = tempDir('dcode-util-extra-')
    const other = tempDir('dcode-util-other-')
    // 只授权 extra，访问 other 仍应越界。
    expect(() => resolveWithinCwd(cwd, join(other, 'x.ts'), [extra])).toThrow(/越界/)
  })

  it('支持多个额外目录', () => {
    const cwd = tempDir('dcode-util-cwd-')
    const extraA = tempDir('dcode-util-extraA-')
    const extraB = tempDir('dcode-util-extraB-')
    const fileB = join(extraB, 'b.txt')
    writeFileSync(fileB, 'b', 'utf8')
    const abs = resolveWithinCwd(cwd, fileB, [extraA, extraB])
    expect(abs.endsWith('b.txt')).toBe(true)
  })
})

describe('toDisplayPath', () => {
  it('cwd 内返回相对路径', () => {
    const cwd = tempDir('dcode-disp-')
    const sub = join(cwd, 'src', 'a.ts')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    expect(toDisplayPath(cwd, sub)).toBe('src/a.ts')
  })

  it('cwd 外返回绝对路径', () => {
    const cwd = tempDir('dcode-disp-')
    const outside = tempDir('dcode-disp-out-')
    const f = join(outside, 'a.ts')
    expect(toDisplayPath(cwd, f)).toBe(f)
  })
})
