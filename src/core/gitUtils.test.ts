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
  renderGitStatusReport,
  runGit,
} from './gitUtils.js'

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
