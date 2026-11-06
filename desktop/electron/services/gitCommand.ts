// 固定 Git 子进程入口，输出有界，网络超时结束整棵进程树，错误不回传凭据和远程地址。
// 制作人：Moriarty_Dox
import { spawn } from 'node:child_process'
import { DesktopFault } from '../errors.js'
import { terminateProcessTree } from '../processTree.js'

function failure(stderr: string, network: boolean): DesktopFault {
  if (/would be overwritten|local changes|not fully merged|already checked out|already used by worktree|cannot switch branch while|unmerged|not possible to fast-forward|non-fast-forward|fetch first/i.test(stderr)) {
    return new DesktopFault('CONFLICT', 'Git 拒绝操作。请检查未提交修改、分支分叉、未合并提交或其他工作树占用；处理后刷新重试。')
  }
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled|credential|publickey/i.test(stderr)) {
    return new DesktopFault('GIT_FAILED', '远程认证失败，请先在系统 Git 中完成凭据或 SSH 配置，再重试。')
  }
  return new DesktopFault('GIT_FAILED', network
    ? '远程操作失败，请检查网络、远程配置和仓库访问权限，然后刷新核对状态。'
    : 'Git 操作失败，请检查分支名称、仓库状态、用户姓名/邮箱、提交钩子或文件占用。')
}

export function runGit(cwd: string, args: string[], allowMissingHead = false, input?: string, network = false): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')))
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-pager', ...args], {
      cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, LC_ALL: 'C', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let stopped: DesktopFault | null = null
    const stop = (message: string) => {
      if (stopped) return
      stopped = new DesktopFault('GIT_FAILED', message)
      void terminateProcessTree(child)
    }
    const timer = setTimeout(() => stop(network
      ? '远程操作超时。请刷新核对本地和远程状态后重试。'
      : 'Git 操作超时，请检查仓库状态和提交钩子。'), network ? 120_000 : 15_000)
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { stop('Git 输出超过限制，请在系统 Git 中检查仓库。'); return }
      chunks.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk))
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(new DesktopFault(error.code === 'ENOENT' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED', error.code === 'ENOENT' ? '请安装 Git 后重试。' : '无法启动 Git，请检查系统环境。'))
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(output).toString('utf8')
      if (stopped) reject(stopped)
      else if (code === 0 || (allowMissingHead && code === 1 && !stdout)) resolve(stdout)
      else reject(failure(`${stdout}\n${Buffer.concat(errors).toString('utf8')}`, network))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
