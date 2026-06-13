// gitUtils 单元测试。
// 在 DCODE 仓库内验证 git 检测、分支、status；非仓库目录返回错误。
// 制作人：Moriarty_Dox

import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  isGitRepository,
  getCurrentBranch,
  detectDefaultBranch,
  summarizeRepo,
  buildCommitAgentPrompt,
  buildReviewAgentPrompt,
  parseReviewFocuses,
  renderGitStatusReport,
  runGit,
} from './gitUtils.js'
import { writeFileSync } from 'node:fs'

describe('gitUtils', () => {
  const repoCwd = process.cwd()

  it('isGitRepository 在 DCODE 仓库为 true', () => {
    expect(isGitRepository(repoCwd)).toBe(true)
  })

  it('isGitRepository 在非 git 临时目录为 false', () => {
    const temp = mkdtempSync(join(tmpdir(), 'dcode-nogit-'))
    expect(isGitRepository(temp)).toBe(false)
  })

  it('getCurrentBranch 返回非空分支名', () => {
    const branch = getCurrentBranch(repoCwd)
    expect(branch.length).toBeGreaterThan(0)
  })

  it('detectDefaultBranch 返回 main 或 master', () => {
    const base = detectDefaultBranch(repoCwd)
    expect(['main', 'master']).toContain(base)
  })

  it('summarizeRepo 返回完整结构', () => {
    const info = summarizeRepo(repoCwd)
    expect(info.isRepo).toBe(true)
    expect(info.branch).toBeTruthy()
    expect(info.defaultBranch).toBeTruthy()
  })

  it('runGit status 成功', () => {
    const res = runGit(repoCwd, ['status', '--short'])
    expect(res.ok).toBe(true)
  })

  it('renderGitStatusReport 含分支信息', () => {
    const text = renderGitStatusReport(repoCwd)
    expect(text).toContain('Git 状态')
    expect(text).toContain('分支')
  })

  it('buildCommitAgentPrompt 无 staged 时返回 error', () => {
    // 先确保工作区无 staged（多数情况下成立）。
    const staged = runGit(repoCwd, ['diff', '--staged', '--name-only'])
    if (staged.stdout.trim()) {
      // 有 staged 时跳过此断言。
      return
    }
    const built = buildCommitAgentPrompt(repoCwd)
    expect(built.ok).toBe(false)
    if (!built.ok) {
      expect(built.error).toContain('暂存')
    }
  })
})

describe('parseReviewFocuses', () => {
  it('识别标准维度标识', () => {
    expect(parseReviewFocuses(['security', 'performance'])).toEqual([
      'security',
      'performance',
    ])
  })

  it('识别简写与中文别名', () => {
    expect(parseReviewFocuses(['perf'])).toEqual(['performance'])
    expect(parseReviewFocuses(['sec'])).toEqual(['security'])
    expect(parseReviewFocuses(['安全'])).toEqual(['security'])
    expect(parseReviewFocuses(['可读性'])).toEqual(['readability'])
    expect(parseReviewFocuses(['best'])).toEqual(['best-practices'])
  })

  it('大小写不敏感且去重保序', () => {
    expect(parseReviewFocuses(['Security', 'SEC', 'perf'])).toEqual([
      'security',
      'performance',
    ])
  })

  it('忽略未知词条', () => {
    expect(parseReviewFocuses(['nope', 'whatever'])).toEqual([])
  })
})

describe('buildReviewAgentPrompt', () => {
  const repoCwd = process.cwd()

  it('单文件审查：文件不存在返回 error', () => {
    const built = buildReviewAgentPrompt(repoCwd, {
      kind: 'file',
      path: 'no/such/file/____xyz.ts',
    })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('不存在')
  })

  it('单文件审查：对已存在文件返回审查 prompt（全文或 diff）', () => {
    const built = buildReviewAgentPrompt(
      repoCwd,
      { kind: 'file', path: 'package.json' },
      ['security'],
    )
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.prompt).toContain('结构化代码审查')
      expect(built.prompt).toContain('package.json')
      // 指定了聚焦维度时，prompt 中应体现该维度。
      expect(built.prompt).toContain('安全性')
      expect(built.summary).toContain('代码审查范围')
      // 分级标记应在 prompt 中声明。
      expect(built.prompt).toContain('[Critical]')
    }
  })

  it('单文件审查：目录路径返回 error', () => {
    const built = buildReviewAgentPrompt(repoCwd, { kind: 'file', path: 'src' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('目录')
  })

  it('staged 范围：无暂存时返回 error', () => {
    const staged = runGit(repoCwd, ['diff', '--staged', '--name-only'])
    if (staged.stdout.trim()) return // 有 staged 时跳过。
    const built = buildReviewAgentPrompt(repoCwd, { kind: 'staged' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('暂存')
  })

  it('base 范围：与自身对比无差异返回 error', () => {
    const branch = getCurrentBranch(repoCwd)
    if (!branch) return
    // 同一分支 diff 必为空，应报告无差异。
    const built = buildReviewAgentPrompt(repoCwd, { kind: 'base', base: branch })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('没有可审查')
  })

  it('非 git 目录的非文件范围返回 error', () => {
    const temp = mkdtempSync(join(tmpdir(), 'dcode-review-'))
    const built = buildReviewAgentPrompt(temp, { kind: 'working' })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.error).toContain('Git 仓库')
  })

  it('非 git 目录仍可审查单文件全文', () => {
    const temp = mkdtempSync(join(tmpdir(), 'dcode-review-file-'))
    const f = join(temp, 'demo.ts')
    writeFileSync(f, 'export const x = 1\n', 'utf8')
    const built = buildReviewAgentPrompt(temp, { kind: 'file', path: 'demo.ts' })
    expect(built.ok).toBe(true)
    if (built.ok) {
      expect(built.prompt).toContain('demo.ts')
      expect(built.prompt).toContain('export const x = 1')
    }
  })
})
