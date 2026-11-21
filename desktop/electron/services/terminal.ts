// 每个窗口仅持有当前会话的 PTY，按终端实例标识接收输入和窗口变化。制作人：Moriarty_Dox
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { IPty } from 'node-pty'
import type { DesktopEvent } from '../../shared/api.js'
import type { TerminalAction } from '../../shared/services.js'
import { DesktopFault } from '../errors.js'

export class ProjectTerminal {
  private active?: { id: string; session: string; pty: IPty }
  constructor(private readonly publish: (event: DesktopEvent) => void) {}
  open(id: string, session: string, cwd: string) {
    this.close()
    const windows = process.platform === 'win32'
    const shell = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.env.SHELL || '/bin/sh'
    // 延迟加载原生扩展，普通对话不依赖 PTY 初始化。
    const native: typeof import('node-pty') = createRequire(__filename)('node-pty')
    const pty = native.spawn(shell, windows ? ['-NoLogo'] : [], { cwd, useConptyDll: windows, cols: 80, rows: 12, name: 'xterm-256color', env: { ...process.env, TERM: 'xterm-256color' } })
    this.active = { id, session, pty }
    pty.onData(text => { if (this.active?.pty === pty) this.publish({ type: 'terminal_data', id, text }) })
    pty.onExit(({ exitCode }) => {
      if (this.active?.pty !== pty) return
      this.active = undefined
      this.publish({ type: 'terminal_exit', id, code: exitCode })
    })
  }
  action(action: Exclude<TerminalAction, { type: 'open' }>) {
    const active = this.active
    if (active?.id !== action.id || !active) {
      if (action.type === 'close') return
      throw new DesktopFault('CONNECTION_CLOSED', '此终端已经关闭。')
    }
    if (action.type === 'input') active.pty.write(action.data)
    else if (action.type === 'resize') active.pty.resize(action.cols, action.rows)
    else this.close()
  }
  sessionChanged(session: string | null) {
    if (this.active && this.active.session !== session) this.close()
  }
  close() {
    const active = this.active
    this.active = undefined
    if (active) {
      try { active.pty.kill() } finally { this.publish({ type: 'terminal_exit', id: active.id, code: 0 }) }
    }
  }
}
