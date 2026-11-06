// 异步 Git 服务，固定参数、字面路径、有界输出，丢弃前由原生对话框确认。
// 制作人：Moriarty_Dox
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { samePath } from '../workspaceAccess.js'
import { DesktopFault } from '../errors.js'
import { relativePath } from './validation.js'
import { workspacePath, WorkspaceService } from './workspace.js'
import { buildCheckpointFileDiff } from '../../../src/core/checkpoint.js'
import { runGit as run } from './gitCommand.js'
import { gitBranchInput, gitRemoteInput } from './gitInput.js'
import type { GitBranchInput, GitBranches, GitRemoteInput, GitCommit, GitEntry, GitStatus, TextDiff } from '../../shared/services.js'

export function parseGitStatus(output: string): GitStatus {
  const records = output.split('\0')
  const result: GitStatus = { branch: '', entries: [] }
  for (let i = 0; i < records.length; i++) {
    const line = records[i]
    if (line.startsWith('# branch.head ')) result.branch = line.slice(14)
    if (line.startsWith('# branch.upstream ')) result.upstream = line.slice(18)
    if (line.startsWith('# branch.ab ')) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(line)
      if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]) }
    }
    if (line.startsWith('? ')) result.entries.push({ path: line.slice(2), index: '?', worktree: '?' })
    if (!['1 ', '2 ', 'u '].some((prefix) => line.startsWith(prefix))) continue
    const fields = line.split(' ')
    const pathOffset = line[0] === '1' ? 8 : line[0] === '2' ? 9 : 10
    const entry: GitEntry = { path: fields.slice(pathOffset).join(' '), index: fields[1][0], worktree: fields[1][1] }
    if (line[0] === '2') entry.originalPath = records[++i]
    result.entries.push(entry)
  }
  return result
}

export class GitService {
  constructor(private readonly dialogs: {
    confirm(title: string, detail: string): Promise<boolean>
    trash(path: string): Promise<void>
  }) {}

  private async repository(cwd: string): Promise<void> {
    let root: string
    try { root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim() } catch (error) {
      if (error instanceof DesktopFault && error.code === 'GIT_UNAVAILABLE') throw error
      throw new DesktopFault('NOT_GIT_REPOSITORY', '请选择 Git 仓库根目录以使用 Git 面板。')
    }
    if (!samePath(root, cwd)) throw new DesktopFault('NOT_GIT_REPOSITORY', '请通过目录选择器授权 Git 仓库根目录。')
  }

  async status(cwd: string): Promise<GitStatus> {
    await this.repository(cwd)
    const status = parseGitStatus(await run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']))
    status.revision = await this.indexRevision(cwd)
    return status
  }

  async branches(cwd: string): Promise<GitBranches> {
    await this.repository(cwd)
    const current = (await run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim() || null
    const head = (await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)).trim() || null
    const remotes = (await run(cwd, ['remote'])).split('\n').filter(Boolean)
    const refs = await run(cwd, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)', 'refs/heads/', 'refs/remotes/'])
    const config = await run(cwd, ['config', '--null', '--get-regexp', '^(remote|branch)[.]'], true)
    const revision = createHash('sha256').update(current ?? '').update(head ?? '').update(refs).update(config).update(await this.indexRevision(cwd)).digest('hex')
    const branches: GitBranches['branches'] = []
    for (const line of refs.split('\n').filter(Boolean)) {
      const [ref, , symbolic, worktree, upstream, remoteName, remoteBranch] = line.split('\0')
      if (symbolic) continue
      const remote = ref.startsWith('refs/remotes/')
      const name = ref.slice(remote ? 13 : 11)
      branches.push({ name, ref, remote, current: !remote && name === current, checkedOut: !!worktree,
        ...(upstream ? { upstream, remoteName, remoteBranch } : {}) })
    }
    return { current, head, remotes, branches, revision }
  }

  private async branchSnapshot(cwd: string, revision: string): Promise<GitBranches> {
    const snapshot = await this.branches(cwd)
    if (snapshot.revision !== revision) throw new DesktopFault('CONFLICT', '分支、暂存区或远程配置已变化，请刷新后重试。')
    return snapshot
  }

  private async newBranchName(cwd: string, name: string, snapshot: GitBranches): Promise<void> {
    if (name === 'HEAD' || name.startsWith('-') || snapshot.branches.some((branch) => !branch.remote && branch.name === name)) {
      throw new DesktopFault('CONFLICT', '分支名称已存在或不可用，请使用其他名称。')
    }
    await run(cwd, ['check-ref-format', `refs/heads/${name}`])
  }

  async branch(cwd: string, value: GitBranchInput): Promise<boolean> {
    const input = gitBranchInput(value)
    const snapshot = await this.branchSnapshot(cwd, input.revision)
    if (input.action === 'create') {
      await this.newBranchName(cwd, input.name, snapshot)
      if (input.startPoint && !snapshot.branches.some((branch) => branch.ref === input.startPoint)) {
        throw new DesktopFault('CONFLICT', '起始分支已变化，请重新选择。')
      }
      await run(cwd, ['switch', '--no-track', '-c', input.name, ...(input.startPoint ? ['--', input.startPoint] : [])])
      return true
    }
    const branch = snapshot.branches.find((item) => item.ref === input.name)
    if (!branch) throw new DesktopFault('CONFLICT', '分支已变化，请刷新列表。')
    if (input.action === 'switch') {
      if (branch.current) return true
      if (branch.remote) {
        const remote = snapshot.remotes.sort((a, b) => b.length - a.length).find((name) => branch.name.startsWith(`${name}/`))
        if (!remote) throw new DesktopFault('CONFLICT', '此远程分支缺少远程配置，请刷新后检查。')
        const name = branch.name.slice(remote.length + 1)
        await this.newBranchName(cwd, name, snapshot)
        await run(cwd, ['switch', '--track=direct', '-c', name, '--', branch.ref])
      } else await run(cwd, ['switch', '--no-guess', '--', branch.name])
      return true
    }
    if (branch.remote || (branch.checkedOut && !branch.current)) {
      throw new DesktopFault('CONFLICT', '请选择可操作的本地分支，其他工作树占用的分支需要先在对应工作树中处理。')
    }
    if (input.action === 'rename') {
      await this.newBranchName(cwd, input.newName!, snapshot)
      await run(cwd, ['branch', '-m', '--', branch.name, input.newName!])
      return true
    }
    if (branch.current) throw new DesktopFault('CONFLICT', '请先切换到其他分支，再删除此分支。')
    if (!await this.dialogs.confirm('删除本地分支', `删除本地分支“${branch.name}”？Git 将检查该分支的合并状态。`)) return false
    await this.branchSnapshot(cwd, input.revision)
    await run(cwd, ['branch', '-d', '--', branch.name])
    return true
  }

  async remote(cwd: string, value: GitRemoteInput): Promise<void> {
    const input = gitRemoteInput(value)
    const snapshot = await this.branchSnapshot(cwd, input.revision)
    if (!snapshot.remotes.includes(input.remote)) throw new DesktopFault('CONFLICT', '远程配置已变化，请刷新后重试。')
    if (input.action === 'fetch') {
      await run(cwd, ['fetch', '--no-recurse-submodules', '--', input.remote], false, undefined, true)
      return
    }
    if (!snapshot.current || !snapshot.head) throw new DesktopFault('CONFLICT', '请先创建提交并切换到本地分支。')
    const branch = snapshot.branches.find((item) => item.current)!
    if (branch.upstream && branch.remoteName !== input.remote) {
      throw new DesktopFault('CONFLICT', '所选远程与当前分支的跟踪远程不同，请选择对应远程。')
    }
    if (input.action === 'pull') {
      if (!branch.remoteBranch?.startsWith('refs/heads/')) throw new DesktopFault('CONFLICT', '当前分支尚未跟踪远程分支，请先发布分支或切换到远程跟踪分支。')
      const before = await this.indexRevision(cwd)
      await run(cwd, ['fetch', '--no-recurse-submodules', '--no-tags', '--', input.remote, branch.remoteBranch], false, undefined, true)
      const current = (await run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim()
      if (current !== snapshot.current || before !== await this.indexRevision(cwd)) {
        throw new DesktopFault('CONFLICT', '获取期间本地分支或暂存区已变化。远程信息已获取，请检查后重新拉取。')
      }
      await run(cwd, ['merge', '--ff-only', '--no-autostash', 'FETCH_HEAD'])
      return
    }
    const target = branch.remoteBranch ?? `refs/heads/${snapshot.current}`
    if (!target.startsWith('refs/heads/')) throw new DesktopFault('CONFLICT', '当前分支的远程目标不是分支，请检查跟踪配置。')
    await run(cwd, ['push', '--porcelain', '--no-force', '--no-mirror', '--no-follow-tags', '--recurse-submodules=no',
      ...(!branch.upstream ? ['--set-upstream'] : []), '--', input.remote, `refs/heads/${snapshot.current}:${target}`], false, undefined, true)
  }

  private async indexRevision(cwd: string): Promise<string> {
    const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)
    const index = await run(cwd, ['ls-files', '--stage', '-z'])
    return createHash('sha256').update(head).update(index).digest('hex')
  }

  private async paths(cwd: string, path: string, knownStatus?: GitStatus): Promise<string[]> {
    relativePath(path)
    const status = knownStatus ?? await this.status(cwd)
    const entry = status.entries.find((item) => item.path === path)
    if (!entry) throw new DesktopFault('CONFLICT', '该文件的 Git 状态已变化，请刷新列表。')
    if (entry.index === 'U' || entry.worktree === 'U' || ['AA', 'DD'].includes(entry.index + entry.worktree)) {
      throw new DesktopFault('CONFLICT', '请先解决该文件的合并冲突。')
    }
    const paths = entry.originalPath ? [entry.originalPath, path] : [path]
    for (const item of paths) {
      const absolute = await workspacePath(cwd, item, true)
      const info = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (info && !info.isFile()) throw new DesktopFault('FORBIDDEN', 'Git 文件操作仅支持普通文件。')
    }
    return paths
  }

  async diff(cwd: string, path: string, staged: boolean): Promise<TextDiff> {
    relativePath(path)
    const status = await this.status(cwd)
    // 提交、暂存或切换分支后，已打开的差异可能恢复干净；正常显示空差异。
    if (!status.entries.some((entry) => entry.path === path)) return { text: '', truncated: false }
    const paths = await this.paths(cwd, path, status)
    const entry = status.entries.find((item) => item.path === path)
    if (!staged && entry?.index === '?') {
      const preview = await new WorkspaceService().read(cwd, path)
      if (preview.kind === 'binary') return { text: '新增二进制文件', truncated: false }
      const diff = buildCheckpointFileDiff('', preview.text)
      return { text: diff.preview, truncated: preview.truncated || diff.truncated }
    }
    const text = await run(cwd, ['diff', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : []), '--', ...paths])
    const limit = 256 * 1024
    return { text: text.slice(0, limit), truncated: text.length > limit }
  }

  async stage(cwd: string, path: string, staged: boolean): Promise<void> {
    const paths = await this.paths(cwd, path)
    if (staged) { await run(cwd, ['add', '-A', '--', ...paths]); return }
    const branch = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)
    if (!branch) await run(cwd, ['rm', '--cached', '-f', '--', ...paths])
    else await run(cwd, ['restore', '--staged', '--', ...paths])
  }

  async stageAll(cwd: string, staged: boolean): Promise<void> {
    const status = await this.status(cwd)
    const entries = status.entries.filter((entry) => staged ? entry.worktree !== '.' : !['.', '?'].includes(entry.index))
    const paths = new Set<string>()
    // 先预检所有路径，再用一次 Git 索引事务处理整组，避免中途失败留下部分暂存。
    for (const entry of entries) for (const path of await this.paths(cwd, entry.path, status)) paths.add(path)
    if (!paths.size) return
    const head = await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)
    const args = staged ? ['add', '-A'] : head ? ['restore', '--staged'] : ['rm', '--cached', '-f']
    await run(cwd, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], false, [...paths].join('\0') + '\0')
  }

  async commit(cwd: string, message: string, revision: string): Promise<string> {
    if (!message.trim() || Buffer.byteLength(message) > 16_384 || message.includes('\0')) {
      throw new DesktopFault('INVALID_ARGUMENT', '请填写提交消息，长度上限为 16 KiB。')
    }
    const status = await this.status(cwd)
    if (revision !== status.revision) throw new DesktopFault('CONFLICT', '暂存内容或 HEAD 已变化，请刷新并重新检查后提交。')
    const staged = status.entries.filter((entry) => !['.', '?'].includes(entry.index))
    if (!staged.length) throw new DesktopFault('CONFLICT', '请先暂存要提交的文件。')
    for (const entry of staged) await this.paths(cwd, entry.path, status)
    if (revision !== await this.indexRevision(cwd)) throw new DesktopFault('CONFLICT', '暂存区已变化，请刷新后重试。')
    await run(cwd, ['commit', '--file=-'], false, message)
    return (await run(cwd, ['rev-parse', 'HEAD'])).trim()
  }

  async history(cwd: string): Promise<GitCommit[]> {
    await this.repository(cwd)
    if (!await run(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], true)) return []
    const output = await run(cwd, ['log', '-100', '--topo-order', '-z', '--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D'])
    const fields = output.split('\0')
    const commits: GitCommit[] = []
    for (let i = 0; i + 5 < fields.length; i += 6) {
      commits.push({ hash: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2],
        timestamp: Number(fields[i + 3]) * 1000, subject: fields[i + 4], refs: fields[i + 5] })
    }
    return commits
  }

  async commitDiff(cwd: string, hash: string): Promise<TextDiff> {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new DesktopFault('INVALID_ARGUMENT', '提交标识格式不正确。')
    await this.repository(cwd)
    const text = await run(cwd, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--first-parent', hash, '--'])
    return { text: text.slice(0, 256 * 1024), truncated: text.length > 256 * 1024 }
  }

  async discard(cwd: string, path: string): Promise<boolean> {
    const paths = await this.paths(cwd, path)
    if (paths.length > 1) throw new DesktopFault('CONFLICT', '请先取消重命名的暂存，再分别处理文件。')
    const fingerprint = await this.fingerprint(cwd, path)
    if (!await this.dialogs.confirm('丢弃文件更改', `将恢复“${path}”的未暂存内容；未跟踪文件将移至回收站。`)) return false
    await this.paths(cwd, path)
    if (fingerprint !== await this.fingerprint(cwd, path)) throw new DesktopFault('CONFLICT', '确认期间文件或暂存区发生变化，请刷新后重试。')
    const entry = (await this.status(cwd)).entries.find((item) => item.path === path)!
    if (entry.index === '?') await this.dialogs.trash(await workspacePath(cwd, path))
    else await run(cwd, ['restore', '--worktree', '--', path])
    return true
  }

  private async fingerprint(cwd: string, path: string): Promise<string> {
    const target = await workspacePath(cwd, path, true)
    const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info && info.size > 16 * 1024 * 1024) throw new DesktopFault('FILE_TOO_LARGE', '请在外部 Git 客户端处理超过 16 MiB 的文件。')
    const hash = createHash('sha256')
    hash.update(await run(cwd, ['ls-files', '--stage', '-z', '--', path]))
    hash.update(JSON.stringify((await this.status(cwd)).entries.find((item) => item.path === path)))
    hash.update(info ? await readFile(target) : '<missing>')
    return hash.digest('hex')
  }
}
