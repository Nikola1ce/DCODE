// core/ignore 单元测试。
// 覆盖：默认噪声目录始终忽略、.gitignore 生效、.dcodeignore 叠加与 ! 反忽略（优先级最高）、
// 目录规则（dir/）匹配、工作根之外路径不应用规则、以及缓存随文件变更失效。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearIgnoreCache, createIgnoreFilter, isIgnored } from './ignore.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dcode-ignore-'))
  clearIgnoreCache()
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 清理失败忽略。
  }
})

describe('默认忽略目录', () => {
  it('node_modules / .git / dist 始终被忽略', () => {
    const f = createIgnoreFilter(root)
    expect(f.ignores('node_modules/x.js')).toBe(true)
    expect(f.ignores('.git/config')).toBe(true)
    expect(f.ignores('dist/bundle.js')).toBe(true)
  })

  it('普通源码文件默认不被忽略', () => {
    const f = createIgnoreFilter(root)
    expect(f.ignores('src/index.ts')).toBe(false)
  })

  it('globIgnorePatterns 返回默认目录的 glob 形式', () => {
    const f = createIgnoreFilter(root)
    expect(f.globIgnorePatterns()).toContain('**/node_modules/**')
    expect(f.globIgnorePatterns()).toContain('**/dist/**')
  })
})

describe('.gitignore 生效', () => {
  it('忽略 .gitignore 中声明的文件与目录', () => {
    writeFileSync(join(root, '.gitignore'), '*.log\nbuild/\n', 'utf8')
    const f = createIgnoreFilter(root)
    expect(f.ignores('debug.log')).toBe(true)
    expect(f.ignores('build/out.js')).toBe(true)
    expect(f.ignores('src/app.ts')).toBe(false)
  })
})

describe('.dcodeignore 叠加与优先级', () => {
  it('.dcodeignore 可新增忽略规则', () => {
    writeFileSync(join(root, '.dcodeignore'), 'secret/\n*.tmp\n', 'utf8')
    const f = createIgnoreFilter(root)
    expect(f.ignores('secret/key.txt')).toBe(true)
    expect(f.ignores('scratch.tmp')).toBe(true)
  })

  it('.dcodeignore 用 ! 可反忽略 .gitignore 的规则', () => {
    writeFileSync(join(root, '.gitignore'), '*.log\n', 'utf8')
    // .dcodeignore 在最后加入，! 规则覆盖前面的忽略。
    writeFileSync(join(root, '.dcodeignore'), '!important.log\n', 'utf8')
    const f = createIgnoreFilter(root)
    expect(f.ignores('important.log')).toBe(false)
    expect(f.ignores('other.log')).toBe(true)
  })
})

describe('目录规则与边界', () => {
  it('仅匹配目录的规则需带 isDir=true 命中', () => {
    writeFileSync(join(root, '.dcodeignore'), 'coverage/\n', 'utf8')
    const f = createIgnoreFilter(root)
    // 目录本身（带 isDir）应忽略。
    expect(f.ignores('coverage', true)).toBe(true)
    // 目录下的文件路径也应忽略。
    expect(f.ignores('coverage/report.html')).toBe(true)
  })

  it('工作根本身或根外路径不应用忽略规则', () => {
    writeFileSync(join(root, '.gitignore'), '*\n', 'utf8')
    const f = createIgnoreFilter(root)
    // 绝对路径落在根之外。
    const outside = join(tmpdir(), 'totally-outside-xyz', 'a.ts')
    expect(f.ignores(outside)).toBe(false)
  })

  it('接受 root 子树内的绝对路径', () => {
    writeFileSync(join(root, '.dcodeignore'), '*.bin\n', 'utf8')
    const f = createIgnoreFilter(root)
    expect(f.ignores(join(root, 'data', 'blob.bin'))).toBe(true)
  })
})

describe('缓存失效', () => {
  it('修改 .dcodeignore 后过滤结果随之更新', () => {
    const file = join(root, 'a.tmp')
    writeFileSync(file, 'x', 'utf8')
    // 初始无忽略文件：a.tmp 不被忽略。
    expect(isIgnored(root, 'a.tmp')).toBe(false)
    // 写入 .dcodeignore 后应被忽略（指纹变化触发重建）。
    writeFileSync(join(root, '.dcodeignore'), '*.tmp\n', 'utf8')
    expect(isIgnored(root, 'a.tmp')).toBe(true)
  })
})

describe('isIgnored 便捷函数', () => {
  it('与 createIgnoreFilter 行为一致', () => {
    writeFileSync(join(root, '.dcodeignore'), 'vendor/\n', 'utf8')
    mkdirSync(join(root, 'vendor'), { recursive: true })
    expect(isIgnored(root, 'vendor/lib.js')).toBe(true)
    expect(isIgnored(root, 'src/main.ts')).toBe(false)
  })
})
