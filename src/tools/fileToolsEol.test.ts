// 文件类工具的换行风格与路径展示回归测试。
// 覆盖：CRLF 文件的 read_file/edit_file/write_file、grep/glob 指定 path 时的结果路径、
// grep include 递归匹配，以及 run_command 超时参数规整。
// 制作人：Moriarty_Dox

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_COMMAND_TIMEOUT_MS } from '../constants.js'
import { clearIgnoreCache } from '../core/ignore.js'
import type { ToolContext } from '../core/types.js'
import { editFileTool } from './editFile.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { readFileTool } from './readFile.js'
import { normalizeTimeout } from './runCommand.js'
import { writeFileTool } from './writeFile.js'

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
  root = mkdtempSync(join(tmpdir(), 'dcode-eol-'))
  clearIgnoreCache()
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
})

describe('CRLF 文件', () => {
  it('read_file 输出不残留 \\r', async () => {
    write('a.txt', 'one\r\ntwo\r\nthree\r\n')
    const res = await readFileTool.run({ path: 'a.txt' }, makeCtx(root))
    expect(res.llmContent).not.toContain('\r')
    const ranged = await readFileTool.run({ path: 'a.txt', offset: 2, limit: 1 }, makeCtx(root))
    expect(ranged.llmContent).toBe('2\ttwo')
  })

  it('edit_file 可用 LF 的多行 old_string 编辑 CRLF 文件，并保持 CRLF', async () => {
    write('a.txt', 'one\r\ntwo\r\nthree\r\n')
    const res = await editFileTool.run(
      { path: 'a.txt', old_string: 'one\ntwo', new_string: 'ONE\nTWO\nextra' },
      makeCtx(root),
    )
    expect(res.isError).toBeFalsy()
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('ONE\r\nTWO\r\nextra\r\nthree\r\n')
  })

  it('edit_file 单行 old_string 插入多行时沿用 CRLF', async () => {
    write('a.txt', 'one\r\ntwo\r\n')
    await editFileTool.run(
      { path: 'a.txt', old_string: 'two', new_string: 'two\nthree' },
      makeCtx(root),
    )
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('edit_file 不改变 LF 文件', async () => {
    write('a.txt', 'one\ntwo\n')
    await editFileTool.run(
      { path: 'a.txt', old_string: 'one\ntwo', new_string: 'x\ny' },
      makeCtx(root),
    )
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('x\ny\n')
  })

  it('write_file 覆盖 CRLF 文件时保持 CRLF，新文件保持原样', async () => {
    write('a.txt', 'old\r\nfile\r\n')
    await writeFileTool.run({ path: 'a.txt', content: 'new\ncontent\n' }, makeCtx(root))
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\r\ncontent\r\n')
    await writeFileTool.run({ path: 'b.txt', content: 'new\ncontent\n' }, makeCtx(root))
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('new\ncontent\n')
  })

  it('grep 的行尾锚点可匹配 CRLF 文件', async () => {
    write('a.txt', 'foo\r\nbar\r\n')
    const res = await grepTool.run({ pattern: 'foo$' }, makeCtx(root))
    expect(res.llmContent).toContain('a.txt:1: foo')
  })
})

describe('检索结果路径', () => {
  beforeEach(() => {
    write('src/core/agent.ts', 'export const marker = 1\n')
    write('top.ts', 'export const marker = 2\n')
  })

  it('grep 指定 path 时返回相对工作目录的路径', async () => {
    const res = await grepTool.run({ pattern: 'marker', path: 'src' }, makeCtx(root))
    expect(res.llmContent).toContain('src/core/agent.ts:1:')
  })

  it('glob 指定 path 时返回相对工作目录的路径', async () => {
    const res = await globTool.run({ pattern: '**/*.ts', path: 'src' }, makeCtx(root))
    expect(res.llmContent).toBe('src/core/agent.ts')
  })

  it('grep include 不含目录时递归匹配', async () => {
    const res = await grepTool.run({ pattern: 'marker', include: '*.ts' }, makeCtx(root))
    expect(res.llmContent).toContain('src/core/agent.ts')
    expect(res.llmContent).toContain('top.ts')
  })

  it('grep 截断超长匹配行', async () => {
    write('min.js', `marker${'x'.repeat(5000)}\n`)
    const res = await grepTool.run({ pattern: 'marker', include: 'min.js' }, makeCtx(root))
    expect(res.llmContent.length).toBeLessThan(500)
  })
})

describe('normalizeTimeout', () => {
  it('非法值回退默认，越界值被限制', () => {
    expect(normalizeTimeout(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(normalizeTimeout(0)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(normalizeTimeout(-5)).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(normalizeTimeout('abc')).toBe(DEFAULT_COMMAND_TIMEOUT_MS)
    expect(normalizeTimeout('5000')).toBe(5000)
    expect(normalizeTimeout(10)).toBe(1000)
    expect(normalizeTimeout(1e12)).toBe(60 * 60 * 1000)
  })
})
