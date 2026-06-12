// hooks 单元测试。
// 覆盖配置加载、PreToolUse 阻止/改参、PostToolUse 改结果、matcher 过滤与全局开关。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HookManager,
  getGlobalHooksConfigPath,
  getProjectHooksConfigPath,
} from './hooks.js'

describe('HookManager', () => {
  let tempCwd: string
  let scriptsDir: string

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * 在临时目录创建 hook 脚本与 hooks.json。
   * @param defs 脚本名 -> 脚本内容。
   * @param hookSpecs 钩子规格（command 填脚本文件名，如 continue.mjs）。
   */
  function setupProjectHooks(
    defs: Record<string, string>,
    hookSpecs: Array<Record<string, unknown> & { script?: string }>,
  ): HookManager {
    tempCwd = mkdtempSync(join(tmpdir(), 'dcode-hooks-test-'))
    scriptsDir = join(tempCwd, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    for (const [name, body] of Object.entries(defs)) {
      writeFileSync(join(scriptsDir, name), body, 'utf8')
    }
    const resolvedHooks = hookSpecs.map(({ script, ...rest }) => {
      const command = script ? `node scripts/${script}` : (rest as Record<string, unknown>).command
      return { ...rest, command }
    })
    const dcodeDir = join(tempCwd, '.dcode')
    mkdirSync(dcodeDir, { recursive: true })
    // 项目级 Hooks 需显式信任标记才会加载。
    writeFileSync(join(dcodeDir, 'trust'), '', 'utf8')
    writeFileSync(
      join(dcodeDir, 'hooks.json'),
      JSON.stringify({ hooks: resolvedHooks }),
      'utf8',
    )
    const mgr = new HookManager()
    mgr.load(tempCwd)
    return mgr
  }

  it('load 从项目 .dcode/hooks.json 读取钩子', () => {
    const mgr = setupProjectHooks(
      { 'continue.mjs': `process.stdout.write(JSON.stringify({ action: 'continue' }))` },
      [
        {
          id: 'test-pre',
          event: 'PreToolUse',
          type: 'command',
          script: 'continue.mjs',
        },
      ],
    )
    const list = mgr.listHooks()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-pre')
  })

  it('PreToolUse block 阻止工具执行', async () => {
    const mgr = setupProjectHooks(
      {
        'block.mjs': `process.stdout.write(JSON.stringify({ action: 'block', reason: 'lint failed' }))`,
      },
      [
        {
          id: 'block-write',
          event: 'PreToolUse',
          matcher: 'write_file',
          type: 'command',
          script: 'block.mjs',
        },
      ],
    )
    const result = await mgr.runPreToolUse(
      'write_file',
      { path: 'a.ts', contents: 'x' },
      { cwd: tempCwd },
    )
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('lint failed')
  })

  it('PreToolUse updatedInput 修改入参', async () => {
    const mgr = setupProjectHooks(
      {
        'patch.mjs': `process.stdout.write(JSON.stringify({ action: 'continue', updatedInput: { extra: true } }))`,
      },
      [
        {
          id: 'patch-input',
          event: 'PreToolUse',
          type: 'command',
          script: 'patch.mjs',
        },
      ],
    )
    const result = await mgr.runPreToolUse('grep', { pattern: 'foo' }, { cwd: tempCwd })
    expect(result.blocked).toBe(false)
    expect(result.input.extra).toBe(true)
    expect(result.input.pattern).toBe('foo')
  })

  it('PreToolUse 非零退出码且无 JSON 时阻止', async () => {
    const mgr = setupProjectHooks(
      { 'exit2.mjs': 'process.exit(2)' },
      [
        {
          id: 'fail-exit',
          event: 'PreToolUse',
          type: 'command',
          script: 'exit2.mjs',
        },
      ],
    )
    const result = await mgr.runPreToolUse('read_file', { path: 'x' }, { cwd: tempCwd })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('退出码 2')
  })

  it('matcher 仅匹配指定工具', async () => {
    const mgr = setupProjectHooks(
      {
        'block.mjs': `process.stdout.write(JSON.stringify({ action: 'block', reason: 'blocked edit' }))`,
      },
      [
        {
          id: 'only-edit',
          event: 'PreToolUse',
          matcher: '^edit_file$',
          type: 'command',
          script: 'block.mjs',
        },
      ],
    )
    const grepResult = await mgr.runPreToolUse('grep', {}, { cwd: tempCwd })
    expect(grepResult.blocked).toBe(false)

    const editResult = await mgr.runPreToolUse('edit_file', {}, { cwd: tempCwd })
    expect(editResult.blocked).toBe(true)
  })

  it('PostToolUse updatedResult 修改工具结果', async () => {
    const mgr = setupProjectHooks(
      {
        'post.mjs': `process.stdout.write(JSON.stringify({ updatedResult: { llmContent: 'hooked output', uiSummary: 'done' } }))`,
      },
      [
        {
          id: 'post-patch',
          event: 'PostToolUse',
          type: 'command',
          script: 'post.mjs',
        },
      ],
    )
    const post = await mgr.runPostToolUse(
      'read_file',
      { path: 'a.ts' },
      { llmContent: 'original', isError: false },
      { cwd: tempCwd },
    )
    expect(post.result.llmContent).toBe('hooked output')
    expect(post.result.uiSummary).toBe('done')
  })

  it('setGlobalEnabled(false) 跳过所有钩子', async () => {
    const mgr = setupProjectHooks(
      {
        'block.mjs': `process.stdout.write(JSON.stringify({ action: 'block', reason: 'should not run' }))`,
      },
      [
        {
          event: 'PreToolUse',
          type: 'command',
          script: 'block.mjs',
        },
      ],
    )
    mgr.setGlobalEnabled(false)
    const result = await mgr.runPreToolUse('write_file', {}, { cwd: tempCwd })
    expect(result.blocked).toBe(false)
  })

  it('getGlobalHooksConfigPath 与 getProjectHooksConfigPath 返回预期路径', () => {
    expect(getGlobalHooksConfigPath()).toContain('hooks.json')
    expect(getProjectHooksConfigPath('/tmp/proj')).toContain('.dcode')
    expect(getProjectHooksConfigPath('/tmp/proj')).toContain('hooks.json')
  })
})
