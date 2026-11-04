// 内核超时强制终止：Windows 使用 taskkill /T，POSIX 使用独立进程组；不经 Shell。
// 制作人：Moriarty_Dox
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

export type TerminateTree = (child: ChildProcessWithoutNullStreams) => Promise<void>

export const terminateProcessTree: TerminateTree = async (child) => {
  if (!child.pid) {
    child.kill('SIGKILL')
    return
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
    return
  }
  await new Promise<void>((resolve) => {
    const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      // taskkill 失败时仍尝试结束根进程；是否退出由 AgentConnection 的 exit/close 确认。
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      resolve()
    }
    const timer = setTimeout(() => { killer.kill(); finish() }, 1500)
    killer.once('error', finish)
    killer.once('exit', finish)
  })
}
