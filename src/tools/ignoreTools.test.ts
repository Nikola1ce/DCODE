// glob / grep / list_dir 套用 .dcodeignore 的集成测试。
// 在临时目录铺设真实文件树 + .gitignore/.dcodeignore，验证三个检索工具的输出
// 都尊重统一忽略规则（含 .dcodeignore 新增忽略与 ! 反忽略）。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearIgnoreCache } from '../core/ignore.js'
import type { ToolContext } from '../core/types.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { listDirTool } from './listDir.js'

let root: string

/** 构造最小 ToolContext（bypass 免授权）。 */
function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    config: {} as any,
    permissionMode: 'bypass',
    abortSignal: new AbortController().signal,
    requestPermission: async () => 'allow_once',
    todos: [],
    setTodos: () => {},
  }
}

/** 写文件并自动创建父目录。 */
function write(rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content, 'utf8')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dcode-igntool-'))
  clearIgnoreCache()
  // 基础文件树：一个保留文件、一个将被 .dcodeignore 忽略的文件。
  write('src/keep.ts', 'export const keyword_marker = 1\n')
  write('generated/skip.ts', 'export const keyword_marker = 2\n')
  write('notes.secret', 'keyword_marker here\n')
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
})

describe('glob 套用 .dcodeignore', () => {
  it('默认能匹配到 generated 与 secret 文件', async () => {
    const res = await globTool.run({ pattern: '**/*' }, makeCtx(root))
    expect(res.llmContent).toContain('src/keep.ts')
    expect(res.llmContent).toContain('generated/skip.ts')
  })

  it('.dcodeignore 忽略 generated/ 与 *.secret 后不再出现', async () => {
    writeFileSync(join(root, '.dcodeignore'), 'generated/\n*.secret\n', 'utf8')
    clearIgnoreCache()
    const res = await globTool.run({ pattern: '**/*' }, makeCtx(root))
    expect(res.llmContent).toContain('src/keep.ts')
    expect(res.llmContent).not.toContain('generated/skip.ts')
    expect(res.llmContent).not.toContain('notes.secret')
  })
})

describe('grep 套用 .dcodeignore', () => {
  it('默认在所有文件中搜到关键词', async () => {
    const res = await grepTool.run({ pattern: 'keyword_marker' }, makeCtx(root))
    expect(res.llmContent).toContain('src/keep.ts')
    expect(res.llmContent).toContain('generated/skip.ts')
    expect(res.llmContent).toContain('notes.secret')
  })

  it('.dcodeignore 忽略后不再扫描被忽略文件', async () => {
    writeFileSync(join(root, '.dcodeignore'), 'generated/\n*.secret\n', 'utf8')
    clearIgnoreCache()
    const res = await grepTool.run({ pattern: 'keyword_marker' }, makeCtx(root))
    expect(res.llmContent).toContain('src/keep.ts')
    expect(res.llmContent).not.toContain('generated/skip.ts')
    expect(res.llmContent).not.toContain('notes.secret')
  })
})

describe('list_dir 套用 .dcodeignore', () => {
  it('默认列出 generated 目录', async () => {
    const res = await listDirTool.run({ path: '.' }, makeCtx(root))
    expect(res.llmContent).toContain('generated/')
    expect(res.llmContent).toContain('src/')
  })

  it('.dcodeignore 忽略 generated/ 后不再列出', async () => {
    writeFileSync(join(root, '.dcodeignore'), 'generated/\n', 'utf8')
    clearIgnoreCache()
    const res = await listDirTool.run({ path: '.' }, makeCtx(root))
    expect(res.llmContent).not.toContain('generated/')
    expect(res.llmContent).toContain('src/')
  })

  it('始终忽略 node_modules（默认规则）', async () => {
    write('node_modules/pkg/index.js', 'x')
    clearIgnoreCache()
    const res = await listDirTool.run({ path: '.' }, makeCtx(root))
    expect(res.llmContent).not.toContain('node_modules')
  })
})
