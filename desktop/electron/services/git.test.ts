// 真实临时 Git 仓库回归，覆盖字面路径、未提交仓库、重命名和确认竞态。
// 制作人：Moriarty_Dox
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeService } from './worktrees.js'
import { GitService, parseGitStatus } from './git.js'

let root: string
const confirm = vi.fn(async () => true)
const trash = vi.fn(async (_path: string) => {})
let service: GitService
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-git-'))
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  git('config', 'core.autocrlf', 'false')
  confirm.mockImplementation(async () => true)
  service = new GitService({ confirm, trash })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Git 服务', () => {
  it('并行工作树从 HEAD 创建，原目录未提交的修改留在原处', async () => {
    await writeFile(join(root, 'tracked.txt'), '已提交')
    git('add', '.'); git('commit', '-qm', '基线')
    await writeFile(join(root, 'tracked.txt'), '本地修改')
    const parent = await mkdtemp(join(tmpdir(), 'dcode-parallel-'))
    try {
      const checkout = await service.createWorktree(root, parent)
      expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('已提交')
      expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('本地修改')
    } finally { await rm(parent, { recursive: true, force: true }) }
  })

  it('工作树处理分叉冲突，合回后仅清理干净且未被替换的工作树', async () => {
    await writeFile(join(root, 'shared.txt'), 'base\n')
    git('add', '.'); git('commit', '-qm', 'base')
    const parent = await mkdtemp(join(tmpdir(), 'dcode-managed-'))
    try {
      const path = await service.createWorktree(root, parent)
      const manager = new WorktreeService(parent, confirm)
      const list = async () => (await manager.list(root))[0]!
      const act = async (action: import('../../shared/services.js').WorktreeInput['action'], file?: string) => {
        const tree = await list()
        return manager.apply(root, { id: tree.id, revision: tree.revision, action, path: file }, path)
      }
      await writeFile(join(path, 'shared.txt'), 'child\n')
      git('-C', path, 'commit', '-qam', 'task')
      await writeFile(join(root, 'shared.txt'), 'parent\n')
      git('commit', '-qam', 'source')
      expect(await list()).toMatchObject({ ahead: 1, behind: 1, dirty: false })
      await expect(act('integrate')).rejects.toMatchObject({ code: 'CONFLICT' })
      await act('sync')
      expect((await list()).conflicts).toEqual(['shared.txt'])
      expect(await act('preview', 'shared.txt')).toContain('shared.txt')
      await act('ours', 'shared.txt')
      expect((await list()).conflicts).toEqual([])
      await act('finish')
      confirm.mockResolvedValueOnce(false)
      expect(await act('integrate')).toContain('取消')
      expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('parent\n')
      await act('integrate')
      expect(await readFile(join(root, 'shared.txt'), 'utf8')).toBe('child\n')
      await writeFile(join(path, 'untracked.txt'), 'local')
      await expect(act('remove')).rejects.toMatchObject({ code: 'CONFLICT' })
      await rm(join(path, 'untracked.txt'))
      await writeFile(join(root, '.git/info/exclude'), 'ignored.txt\n')
      await writeFile(join(path, 'ignored.txt'), 'local')
      await expect(act('remove')).rejects.toMatchObject({ code: 'CONFLICT' })
      await rm(join(path, 'ignored.txt'))
      const old = await list()
      await writeFile(join(path, 'changed'), 'new')
      await expect(manager.apply(root, { id: old.id, revision: old.revision, action: 'remove' }, path)).rejects.toMatchObject({ code: 'CONFLICT' })
      await rm(join(path, 'changed'))
      await act('remove')
      expect(await manager.list(root)).toEqual([])
      expect(git('branch', '--list', old.branch!)).toContain(old.branch)
    } finally { await rm(parent, { recursive: true, force: true }) }
  }, 60000)

  it('批量暂存/取消暂存支持中文和字面路径，提交后可读取父提交及差异', async () => {
    await writeFile(join(root, '[文件].txt'), '第一行\n')
    await writeFile(join(root, 'second.txt'), '内容\n')
    await service.stageAll(root, true)
    expect((await service.status(root)).entries.every((entry) => entry.index === 'A')).toBe(true)
    await service.stageAll(root, false)
    expect((await service.status(root)).entries.every((entry) => entry.index === '?')).toBe(true)
    await service.stageAll(root, true)
    const status = await service.status(root)
    const first = await service.commit(root, '首次提交\n\n多行说明 $(literal)', status.revision!)
    expect(first).toMatch(/^[a-f0-9]{40}$/)
    expect((await service.status(root)).entries).toHaveLength(0)
    expect(await service.diff(root, '[文件].txt', false)).toEqual({ text: '', truncated: false })
    expect(await service.diff(root, '[文件].txt', true)).toEqual({ text: '', truncated: false })
    await expect(service.diff(root, '../outside', false)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await writeFile(join(root, 'second.txt'), '更新内容\n')
    await service.stageAll(root, true)
    await service.commit(root, '更新文件', (await service.status(root)).revision!)
    const history = await service.history(root)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ subject: '更新文件', parents: [first], author: 'Test' })
    expect(history[1].parents).toEqual([])
    expect((await service.commitDiff(root, history[0].hash)).text).toContain('+更新内容')
  }, 20_000)

  it('暂存区变化拒绝过期提交，提交只包含暂存版本且保留未暂存内容', async () => {
    expect(await service.history(root)).toEqual([])
    await writeFile(join(root, 'a.txt'), '初始\n')
    await service.stage(root, 'a.txt', true)
    const before = await service.status(root)
    await writeFile(join(root, 'a.txt'), '新的暂存\n')
    await service.stage(root, 'a.txt', true)
    await expect(service.commit(root, '过期', before.revision!)).rejects.toMatchObject({ code: 'CONFLICT' })
    const current = await service.status(root)
    await writeFile(join(root, 'a.txt'), '保留在工作区\n')
    await service.commit(root, '提交暂存版本', current.revision!)
    expect(git('show', 'HEAD:a.txt')).toBe('新的暂存\n')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('保留在工作区\n')
    await expect(service.commit(root, ' ', current.revision!)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  }, 20_000)

  it('批量操作预检冲突失败时保留索引状态', async () => {
    await writeFile(join(root, 'a.txt'), '原始\n'); git('add', '.'); git('commit', '-qm', 'base')
    const branch = git('branch', '--show-current').trim()
    git('checkout', '-qb', 'other')
    await writeFile(join(root, 'a.txt'), '另一分支\n'); git('commit', '-am', 'other')
    git('checkout', branch)
    await writeFile(join(root, 'a.txt'), '当前分支\n'); git('commit', '-am', 'current')
    try { git('merge', 'other') } catch { /* 预期产生冲突。 */ }
    await writeFile(join(root, 'new.txt'), '未暂存\n')
    const before = git('ls-files', '--stage')
    await expect(service.stageAll(root, true)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(git('ls-files', '--stage')).toBe(before)
  }, 20_000)

  it('解析 NUL 分隔的中文、空格、重命名、冲突路径与分支', () => {
    const status = parseGitStatus(['# branch.head main', '? 新 文件.txt', '2 R. N... 100644 100644 100644 a b R100 new name', 'old name', 'u UU N... 1 2 3 4 a b c conflict.txt', ''].join('\0'))
    expect(status.branch).toBe('main')
    expect(status.entries).toEqual([
      { path: '新 文件.txt', index: '?', worktree: '?' },
      { path: 'new name', originalPath: 'old name', index: 'R', worktree: '.' },
      { path: 'conflict.txt', index: 'U', worktree: 'U' },
    ])
  })

  it('首次提交前可暂存/取消暂存，通配符文件名按字面匹配', async () => {
    await writeFile(join(root, '[one].txt'), 'first\n')
    await writeFile(join(root, 'o.txt'), 'second\n')
    expect((await service.diff(root, '[one].txt', false)).text).toContain('first')
    await service.stage(root, '[one].txt', true)
    let status = await service.status(root)
    expect(status.entries.find((entry) => entry.path === '[one].txt')?.index).toBe('A')
    expect(status.entries.find((entry) => entry.path === 'o.txt')?.index).toBe('?')
    await service.stage(root, '[one].txt', false)
    status = await service.status(root)
    expect(status.entries.every((entry) => entry.index === '?')).toBe(true)
    expect(await readFile(join(root, '[one].txt'), 'utf8')).toBe('first\n')
  })

  it('diff 区分暂存/未暂存，丢弃恢复至暂存区；用户取消时保留文件', async () => {
    await writeFile(join(root, 'a.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    await writeFile(join(root, 'a.txt'), 'staged\n')
    await service.stage(root, 'a.txt', true)
    await writeFile(join(root, 'a.txt'), 'working\n')
    expect((await service.diff(root, 'a.txt', true)).text).toContain('+staged')
    expect((await service.diff(root, 'a.txt', false)).text).toContain('+working')
    confirm.mockResolvedValueOnce(false)
    expect(await service.discard(root, 'a.txt')).toBe(false)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('working\n')
    expect(await service.discard(root, 'a.txt')).toBe(true)
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('staged\n')
    await service.stage(root, 'a.txt', false)
    expect((await service.status(root)).entries[0]).toMatchObject({ index: '.', worktree: 'M' })
  })

  it('重命名取消暂存同时处理原路径与新路径', async () => {
    await writeFile(join(root, 'old name.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base')
    git('mv', 'old name.txt', '新 name.txt')
    expect((await service.status(root)).entries[0].originalPath).toBe('old name.txt')
    await service.stage(root, '新 name.txt', false)
    expect((await service.status(root)).entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'old name.txt', worktree: 'D' }),
      expect.objectContaining({ path: '新 name.txt', index: '?' }),
    ]))
  })

  it('确认期间的新增修改阻止丢弃，未跟踪文件通过回收站处理', async () => {
    await writeFile(join(root, 'a.txt'), 'one\n')
    confirm.mockImplementationOnce(async () => { await writeFile(join(root, 'a.txt'), 'two\n'); return true })
    await expect(service.discard(root, 'a.txt')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(trash).not.toHaveBeenCalled()
    expect(await service.discard(root, 'a.txt')).toBe(true)
    expect(trash).toHaveBeenCalledWith(join(root, 'a.txt'))
  })

  it('拒绝子目录授权扩大到父仓库与目录级暂存', async () => {
    await writeFile(join(root, 'a.txt'), 'one')
    await mkdir(join(root, 'child'))
    await expect(service.status(join(root, 'child'))).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' })
    await expect(service.stage(root, '../a.txt', true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.stage(root, '', true)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.status(tmpdir())).rejects.toMatchObject({ code: 'NOT_GIT_REPOSITORY' })
  })
})
