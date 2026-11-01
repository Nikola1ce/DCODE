// 编码能力相关回归测试：
//   - edit_file 匹配失败时的定位线索；
//   - read_file 按行截断提示 offset、识别二进制文件；
//   - 项目概况探测与系统提示中的 Shell 语法说明；
//   - Windows PowerShell 中文输出不乱码、退出码语义保持。
// 制作人：Moriarty_Dox

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FILE_READ_CHARS } from '../constants.js'
import { editFileTool } from '../tools/editFile.js'
import { describeMissingMatch } from '../tools/editHints.js'
import { readFileTool } from '../tools/readFile.js'
import { detectProjectProfile } from './projectProfile.js'
import { spawnShellProcess } from './shellManager.js'
import { buildShellNote, buildSystemPrompt } from './systemPrompt.js'
import type { ToolContext } from './types.js'

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dcode-ability-'))
})

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 忽略清理失败。
  }
})

describe('edit_file 匹配失败线索', () => {
  const file = 'function a() {\n    return 1\n}\n\nfunction b() {\n\treturn 2\n}\n'

  it('缩进不一致时给出实际内容与行号', () => {
    const hint = describeMissingMatch(file, 'function b() {\n  return 2\n}')
    expect(hint).toContain('第 5-7 行')
    expect(hint).toContain('6\t\treturn 2')
  })

  it('误带 read_file 行号前缀时直接指出', () => {
    const hint = describeMissingMatch(file, '1\tfunction a() {\n2\t    return 1')
    expect(hint).toContain('行号')
    expect(hint).toContain('前缀')
  })

  it('首行存在但后续不一致时定位到首行', () => {
    const hint = describeMissingMatch(file, 'function a() {\n    return 999\n}')
    expect(hint).toContain('第 1 行')
    expect(hint).toContain('后续行不一致')
  })

  it('完全找不到时给出兜底提示', () => {
    expect(describeMissingMatch(file, 'nothing like this')).toContain('read_file')
  })

  it('edit_file 不唯一时列出各处行号', async () => {
    writeFileSync(join(root, 'a.ts'), 'x = 1\ny = 2\nx = 1\n', 'utf8')
    const res = await editFileTool.run({ path: 'a.ts', old_string: 'x = 1', new_string: 'x = 3' }, makeCtx(root))
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('第 1 行、第 3 行')
  })
})

describe('read_file', () => {
  it('超长时按整行截断并提示下一次的 offset', async () => {
    const line = 'x'.repeat(99)
    const total = Math.ceil(MAX_FILE_READ_CHARS / 100) + 50
    writeFileSync(join(root, 'big.txt'), Array.from({ length: total }, () => line).join('\n'), 'utf8')
    const res = await readFileTool.run({ path: 'big.txt' }, makeCtx(root))
    const match = /offset=(\d+)/.exec(res.llmContent)
    expect(match).not.toBeNull()
    const next = Number(match![1])
    // 截断前的最后一行必须是完整的 next-1 行，不能在行中间切断。
    const body = res.llmContent.split('\n\n... [')[0]
    const lastLine = body.split('\n').pop()!
    expect(lastLine).toBe(`${String(next - 1).padStart(String(total).length, ' ')}\t${line}`)
  })

  it('二进制文件直接报错而不输出乱码', async () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]))
    const res = await readFileTool.run({ path: 'bin.dat' }, makeCtx(root))
    expect(res.isError).toBe(true)
    expect(res.llmContent).toContain('二进制')
  })
})

describe('项目概况与系统提示', () => {
  it('识别 Node/TypeScript 项目、包管理器与 scripts', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'x', test: 'y' } }), 'utf8')
    writeFileSync(join(root, 'tsconfig.json'), '{}', 'utf8')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '', 'utf8')
    writeFileSync(join(root, 'pyproject.toml'), '', 'utf8')
    expect(detectProjectProfile(root)).toBe('Node/TypeScript（pnpm）；scripts：build、test（用 pnpm run <名称> 执行）｜Python')
  })

  it('空目录不输出项目行', () => {
    expect(detectProjectProfile(root)).toBe('')
    expect(buildSystemPrompt({ cwd: root, model: 'm', permissionMode: 'default' })).not.toContain('- 项目：')
  })

  it('package.json 损坏时仍报告类型', () => {
    writeFileSync(join(root, 'package.json'), '{ broken', 'utf8')
    expect(detectProjectProfile(root)).toBe('Node（npm）')
  })

  it('仅在 Windows 提示 PowerShell 5.1 语法', () => {
    expect(buildShellNote('win32')).toContain('&&')
    expect(buildShellNote('linux')).toBe('')
  })

  it('系统提示包含编码工作流与项目概况', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf8')
    const prompt = buildSystemPrompt({ cwd: root, model: 'm', permissionMode: 'default' })
    expect(prompt).toContain('# 编码工作流')
    expect(prompt).toContain('- 项目：Node（npm）；scripts：test')
  })
})

/** 运行一条 Shell 命令，返回退出码与合并输出。 */
function runShell(command: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnShellProcess(command, process.cwd())
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => (out += d))
    child.stderr?.on('data', (d: string) => (out += d))
    child.on('close', (code) => resolve({ code, out }))
  })
}

describe.skipIf(process.platform !== 'win32')('Windows PowerShell 执行', () => {
  it('PowerShell 自身的中文输出与语法错误不乱码', async () => {
    expect(await runShell('Write-Output "中文测试"')).toEqual({ code: 0, out: expect.stringContaining('中文测试') })
    const syntax = await runShell('echo a && echo b')
    expect(syntax.code).toBe(1)
    expect(syntax.out).toContain('&&')
    expect(syntax.out).not.toContain('\uFFFD')
  }, 30_000)

  it('退出码语义：最后一条语句决定成败，原生命令透传退出码', async () => {
    expect((await runShell('node -e "process.exit(3)"')).code).toBe(3)
    expect((await runShell('node -e "process.exit(3)"; Write-Output after')).code).toBe(0)
    expect((await runShell('Get-Item C:\\dcode-not-exists-xyz')).code).toBe(1)
    expect((await runShell('exit 7')).code).toBe(7)
    expect((await runShell('$x = 2; Write-Output ($x * 3)')).out).toContain('6')
  }, 30_000)
})
