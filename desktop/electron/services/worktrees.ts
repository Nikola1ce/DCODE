import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ManagedWorktree, WorktreeInput } from '../../shared/services.js'
import { DesktopFault } from '../errors.js'
import { samePath } from '../workspaceAccess.js'
import { runGit } from './gitCommand.js'
import { relativePath } from './validation.js'

type Confirm = (title: string, detail: string) => Promise<boolean>
const conflict = (message: string) => new DesktopFault('CONFLICT', message)
const headOf = async (cwd: string) => (await runGit(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim()
const branchOf = async (cwd: string) => (await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true)).trim() || null

export class WorktreeService {
  constructor(private readonly parent: string, private readonly confirm: Confirm) {}

  // 仅管理该仓库登记在应用专用目录中的工作树，包括早期创建的分离 HEAD 工作树。
  private async registered(cwd: string) {
    const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()
    if (!samePath(root, cwd)) throw conflict('请从仓库根目录管理工作树。')
    if (samePath(dirname(cwd), this.parent)) throw conflict('请在原项目窗口打开工作树管理。')
    const listing = await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])
    return listing.split('\0\0').flatMap(entry => {
      const lines = entry.split('\0')
      const path = lines[0]?.startsWith('worktree ') ? lines[0].slice(9) : ''
      if (!samePath(dirname(path), this.parent) || !/^task-[a-zA-Z0-9]{6}$/.test(basename(path)) || lines.some(line => /^(locked|prunable)( |$)/.test(line))) return []
      return [path]
    })
  }

  private async inspect(cwd: string, path: string) {
    if (!samePath(await realpath(path), path) || !samePath(await realpath(this.parent), this.parent))
      throw conflict('工作树目录已被移动或替换。')
    const commonDir = async (directory: string) => (await runGit(directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
    const [sourceDir, childDir, admin, childRoot, base, branch, baseHead, taskHead, status, unmerged, mergeHead] = await Promise.all([
      commonDir(cwd), commonDir(path), runGit(path, ['rev-parse', '--absolute-git-dir']), runGit(path, ['rev-parse', '--show-toplevel']), branchOf(cwd), branchOf(path), headOf(cwd), headOf(path),
      runGit(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runGit(path, ['ls-files', '--unmerged', '-z']), runGit(path, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], true),
    ])
    if (!samePath(sourceDir, childDir) || !samePath(childRoot.trim(), path)
      || !samePath(dirname(admin.trim()), join(sourceDir, 'worktrees'))
      || !samePath(resolve(admin.trim(), (await readFile(join(admin.trim(), 'gitdir'), 'utf8')).trim()), join(path, '.git'))) throw conflict('工作树仓库身份已变化。')
    const [behind, ahead] = (await runGit(cwd, ['rev-list', '--left-right', '--count', baseHead + '...' + taskHead])).trim().split(/\s+/).map(Number)
    const conflicts = [...new Set(unmerged.split('\0').filter(Boolean).map(line => line.slice(line.indexOf('\t') + 1)))]
    const stamps = await Promise.all(conflicts.map(async file => {
      const info = await lstat(join(path, relativePath(file))).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
      return [file, info?.mtimeMs, info?.size]
    }))
    const revision = createHash('sha256').update(JSON.stringify([base, branch, baseHead, taskHead, status, unmerged, mergeHead, stamps])).digest('hex')
    const tree: ManagedWorktree = { id: basename(path), base, branch, revision, behind, ahead, dirty: !!status, merging: !!mergeHead, conflicts }
    return { tree, taskHead, baseHead }
  }

  async list(cwd: string): Promise<ManagedWorktree[]> {
    const trees: ManagedWorktree[] = []
    for (const path of await this.registered(cwd)) trees.push((await this.inspect(cwd, path)).tree)
    return trees
  }

  async locate(cwd: string, id: string) {
    const path = (await this.registered(cwd)).find(item => basename(item) === id)
    if (!path) throw conflict('找不到此工作树，请刷新列表。')
    return path
  }

  async verify(cwd: string, path: string, revision: string) {
    const state = await this.inspect(cwd, path)
    if (state.tree.revision !== revision) throw conflict('分支、工作树或冲突文件已变化，请刷新后重试。')
    return state
  }

  async apply(cwd: string, input: WorktreeInput, path: string): Promise<string> {
    const check = async () => {
      if (!samePath(await this.locate(cwd, input.id), path)) throw conflict('工作树已变化，请刷新。')
      return this.verify(cwd, path, input.revision)
    }
    const { tree, taskHead, baseHead } = await check()
    if (!tree.base) throw conflict('请先在原项目切换到接收改动的本地分支。')
    if (input.action === 'sync') {
      if (tree.dirty || tree.merging) throw conflict('请先提交工作树的修改或完成当前合并。')
      if (!tree.behind) return '工作树已包含基线的最新提交。'
      try { await runGit(path, ['merge', '--no-edit', '--no-autostash', '--no-overwrite-ignore', baseHead]) }
      catch (error) {
        if (await runGit(path, ['ls-files', '--unmerged', '-z'])) return '同步遇到冲突，请在下方逐个解决。'
        throw error
      }
      return '基线已同步到工作树。'
    }
    if (input.action === 'integrate') {
      if (tree.merging || tree.dirty || tree.behind) throw conflict('请先提交工作树修改并同步基线，再合并回来。')
      if (!tree.ahead) return '目标分支已包含工作树的全部提交。'
      if (!await this.confirm('合并工作树成果', '将 ' + (tree.branch ?? tree.id) + ' 的提交合并到当前分支 ' + tree.base + '。')) return '已取消合并。'
      await check()
      if (await runGit(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])) throw conflict('原项目有未提交修改，请先处理后再合并。')
      await runGit(cwd, ['merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', taskHead])
      return '成果已合并到 ' + tree.base + '。'
    }
    if (input.action === 'remove') {
      if (tree.dirty || tree.merging || tree.ahead) throw conflict('请先提交并合并所有成果，再清理工作树。')
      if (!await this.confirm('清理已合并的工作树', path + '\n将移除这个工作目录，保留 Git 分支。')) return '已取消清理。'
      await check()
      const gitDir = (await runGit(path, ['rev-parse', '--absolute-git-dir'])).trim()
      for (const name of ['rebase-apply', 'rebase-merge', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START']) {
        if (await stat(join(gitDir, name)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })) throw conflict('工作树有未结束的 Git 操作，请先处理。')
      }
      if (await runGit(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'])) throw conflict('工作树中还有被忽略的本地文件，请移走后再清理。')
      await runGit(cwd, ['worktree', 'remove', '--', path])
      return '已清理工作树。'
    }
    if (!tree.merging) throw conflict('工作树没有正在进行的合并。')
    if (input.action === 'abort') {
      if (!await this.confirm('中止工作树中的合并', '将撤回本次合并，包括已暂存的冲突处理结果。')) return '已取消中止操作。'
      await check()
      await runGit(path, ['merge', '--abort'])
      return '已中止工作树中的合并。'
    }
    if (input.action === 'finish') {
      if (tree.conflicts.length) throw conflict('请先解决全部冲突。')
      await runGit(path, ['commit', '--no-edit'])
      return '已完成工作树中的合并提交。'
    }
    const file = relativePath(input.path)
    if (!tree.conflicts.includes(file)) throw conflict('文件冲突状态已变化。')
    if (input.action === 'preview') {
      const diff = await runGit(path, ['diff', '--cc', '--no-ext-diff', '--no-textconv', '--', file])
      if (!diff) return '该冲突没有可显示的文本差异，请核对文件的新增或删除状态。'
      return diff.length <= 65536 ? diff : diff.slice(0, 65536) + '\n（差异较长，已截取预览）'
    }
    if (input.action === 'resolved') await runGit(path, ['add', '-A', '--', file])
    else if (input.action === 'ours' || input.action === 'theirs') {
      const ours = input.action === 'ours'
      if (!await this.confirm('采用' + (ours ? '工作树' : '基线') + '版本', '文件 ' + file + ' 将采用所选一侧的完整版本（包括删除），并标记为已解决。')) return '已取消选择。'
      await check()
      await runGit(path, ['restore', '--source=' + (ours ? 'HEAD' : 'MERGE_HEAD'), '--staged', '--worktree', '--', file])
    } else throw conflict('不支持的工作树操作。')
    return '已标记解决：' + file
  }
}
