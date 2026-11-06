// 真实临时仓库及本地裸远程覆盖分支、发布、快进、拒绝覆盖与确认期间的变化。
// 制作人：Moriarty_Dox
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService } from './git.js'

let root: string
let cwd: string
const confirm = vi.fn(async () => true)
const service = new GitService({ confirm, trash: async () => {} })
function git(directory: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: directory, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
async function commit(directory: string, text: string) {
  await writeFile(join(directory, 'file.txt'), text)
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', text)
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-branches-'))
  cwd = join(root, 'project'); await mkdir(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'config', 'user.name', 'Test'); git(cwd, 'config', 'user.email', 'test@example.invalid')
  git(cwd, 'config', 'commit.gpgsign', 'false'); git(cwd, 'config', 'core.autocrlf', 'false')
  confirm.mockImplementation(async () => true)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('Git 分支与远程', () => {
  it('首次提交前创建分支，提交后创建、重命名、切换和删除，支持中文名称', async () => {
    const empty = await service.branches(cwd)
    expect(empty).toMatchObject({ current: 'main', head: null, branches: [], remotes: [] })
    await service.branch(cwd, { action: 'create', name: '准备', revision: empty.revision })
    await commit(cwd, 'base')
    await service.branch(cwd, { action: 'create', name: '功能/测试', revision: (await service.branches(cwd)).revision })
    await service.branch(cwd, { action: 'rename', name: 'refs/heads/功能/测试', newName: 'feature/renamed', revision: (await service.branches(cwd)).revision })
    await service.branch(cwd, { action: 'switch', name: 'refs/heads/准备', revision: (await service.branches(cwd)).revision })
    expect(await service.branch(cwd, { action: 'delete', name: 'refs/heads/feature/renamed', revision: (await service.branches(cwd)).revision })).toBe(true)
    expect((await service.branches(cwd)).branches.map(item => item.name)).toEqual(['准备'])
  }, 30_000)

  it('过期版本、未合并分支、未提交覆盖与确认竞态均保留文件和分支', async () => {
    await commit(cwd, 'base')
    const old = await service.branches(cwd)
    git(cwd, 'switch', '-qc', 'feature'); await commit(cwd, 'feature'); git(cwd, 'switch', 'main')
    await expect(service.branch(cwd, { action: 'create', name: 'stale', revision: old.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    const current = await service.branches(cwd)
    await expect(service.branch(cwd, { action: 'delete', name: 'refs/heads/feature', revision: current.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    await writeFile(join(cwd, 'file.txt'), '用户修改')
    await expect(service.branch(cwd, { action: 'switch', name: 'refs/heads/feature', revision: current.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('用户修改')
    confirm.mockImplementationOnce(async () => { git(cwd, 'branch', 'another'); return true })
    await expect(service.branch(cwd, { action: 'delete', name: 'refs/heads/feature', revision: current.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(git(cwd, 'branch', '--list', 'feature')).toContain('feature')
    confirm.mockResolvedValueOnce(false)
    expect(await service.branch(cwd, { action: 'delete', name: 'refs/heads/feature', revision: (await service.branches(cwd)).revision })).toBe(false)
  }, 30_000)

  it('本地裸远程完成首次发布、获取、跟踪远程分支与快进拉取，分叉时拒绝拉取和推送', async () => {
    await commit(cwd, 'base')
    const remote = join(root, 'remote.git'); git(root, 'init', '--bare', '-q', remote)
    git(cwd, 'remote', 'add', 'origin', remote)
    const operate = async (action: 'fetch' | 'pull' | 'push') => service.remote(cwd, { action, remote: 'origin', revision: (await service.branches(cwd)).revision })
    await operate('push')
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
    const peer = join(root, 'peer'); git(root, 'clone', '-q', '-b', 'main', remote, peer)
    git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@example.invalid'); git(peer, 'config', 'commit.gpgsign', 'false')
    await commit(peer, 'remote update'); git(peer, 'push', '-q', 'origin', 'main')
    await operate('fetch')
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('base')
    await operate('pull')
    expect(await readFile(join(cwd, 'file.txt'), 'utf8')).toBe('remote update')
    git(peer, 'switch', '-qc', 'topic'); git(peer, 'push', '-qu', 'origin', 'topic')
    await operate('fetch')
    await service.branch(cwd, { action: 'switch', name: 'refs/remotes/origin/topic', revision: (await service.branches(cwd)).revision })
    expect(git(cwd, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/topic')
    await service.branch(cwd, { action: 'switch', name: 'refs/heads/main', revision: (await service.branches(cwd)).revision })
    git(peer, 'switch', 'main'); await commit(peer, 'remote ahead'); git(peer, 'push', '-q', 'origin', 'main')
    await commit(cwd, 'local ahead')
    const before = git(cwd, 'rev-parse', 'HEAD')
    await expect(operate('pull')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(operate('push')).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(remote, 'rev-parse', 'main')).toBe(git(peer, 'rev-parse', 'HEAD'))
  }, 60_000)

  it('分离 HEAD 可创建分支，拒绝伪造远程/选项与其他工作树占用', async () => {
    await commit(cwd, 'base')
    git(cwd, 'checkout', '--detach', '-q')
    const detached = await service.branches(cwd)
    expect(detached.current).toBeNull()
    await service.branch(cwd, { action: 'create', name: 'detached-work', revision: detached.revision })
    git(cwd, 'worktree', 'add', '-q', join(root, 'worktree'), 'main')
    const snapshot = await service.branches(cwd)
    expect(snapshot.branches.find(item => item.name === 'main')?.checkedOut).toBe(true)
    await expect(service.branch(cwd, { action: 'delete', name: 'refs/heads/main', revision: snapshot.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.branch(cwd, { action: 'create', name: '--force', revision: snapshot.revision })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.remote(cwd, { action: 'push', remote: 'https://example.invalid/forged', revision: snapshot.revision })).rejects.toMatchObject({ code: 'CONFLICT' })
  }, 30_000)
})
