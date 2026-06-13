// DCODE VS Code 扩展 —— 后台内核客户端。
// 负责启动并管理 `dcode --ide-server` 子进程，封装与之的 NDJSON 双向通信：
//   - 解析 CLI 路径（配置 → 环境变量 → 全局命令 → 随扩展打包的内核）；
//   - spawn 子进程，按行解码服务端消息并分发给监听者；
//   - 提供发送指令（prompt / cancel / 权限回执 / 切换模型与权限模式 / clear）的类型化方法；
//   - 管理生命周期：就绪等待、重启、退出与异常上报。
// 设计上完全复用内核能力，扩展自身不实现任何 Agent 逻辑。
// 制作人：Moriarty_Dox

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'
import {
  createServerMessageDecoder,
  encodeClientMessage,
  type ClientMessage,
  type IdePermissionMode,
  type PermissionDecision,
  type ServerMessage,
  type ServerReadyMessage,
} from './protocol'

// 客户端启动所需选项。
export interface DcodeClientOptions {
  // 后台内核的工作目录（一般是当前工作区根）。
  cwd: string
  // 扩展安装目录（用于定位随扩展打包的内核兜底路径）。
  extensionPath: string
  // 日志输出通道（VS Code Output 面板）。
  output: vscode.OutputChannel
}

// 服务端消息监听器。
type MessageListener = (msg: ServerMessage) => void
// 退出监听器（code 为退出码，可能为 null）。
type ExitListener = (info: { code: number | null; signal: string | null }) => void

/**
 * DCODE 后台内核客户端。
 * 一个实例对应一个 `dcode --ide-server` 子进程。
 */
export class DcodeClient {
  private readonly opts: DcodeClientOptions
  // 子进程句柄；未启动或已退出时为 null。
  private child: ChildProcessWithoutNullStreams | null = null
  // 按行解码服务端 stdout 的解码器。
  private decoder = createServerMessageDecoder()
  // 服务端消息监听者集合。
  private readonly listeners = new Set<MessageListener>()
  // 进程退出监听者集合。
  private readonly exitListeners = new Set<ExitListener>()
  // ready 消息（启动握手成功后缓存，便于面板随时读取当前状态）。
  private readyInfo: ServerReadyMessage | null = null
  // 等待 ready 的 resolve/reject（start() 期间）。
  private readyResolve: ((info: ServerReadyMessage) => void) | null = null
  private readyReject: ((err: Error) => void) | null = null
  // 是否正在主动停止（避免把主动 kill 误报为崩溃）。
  private stopping = false

  constructor(opts: DcodeClientOptions) {
    this.opts = opts
  }

  /** 当前是否有存活的子进程。 */
  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /** 获取最近一次握手得到的 ready 信息（未就绪返回 null）。 */
  getReadyInfo(): ServerReadyMessage | null {
    return this.readyInfo
  }

  /**
   * 注册服务端消息监听器。
   * @param listener 监听函数。
   * @returns 取消注册的 Disposable。
   */
  onMessage(listener: MessageListener): vscode.Disposable {
    this.listeners.add(listener)
    return new vscode.Disposable(() => this.listeners.delete(listener))
  }

  /**
   * 注册进程退出监听器。
   * @param listener 监听函数。
   * @returns 取消注册的 Disposable。
   */
  onExit(listener: ExitListener): vscode.Disposable {
    this.exitListeners.add(listener)
    return new vscode.Disposable(() => this.exitListeners.delete(listener))
  }

  /**
   * 启动后台内核子进程并等待 ready 握手。
   * @returns 服务端 ready 信息（含模型、权限模式、是否有 API Key 等）。
   */
  async start(): Promise<ServerReadyMessage> {
    if (this.isRunning()) {
      // 已在运行：若已握手直接返回，否则等待握手完成。
      if (this.readyInfo) return this.readyInfo
    }
    this.stopping = false
    this.decoder = createServerMessageDecoder()

    const resolved = this.resolveCliInvocation()
    this.log(`启动后台内核：${resolved.command} ${resolved.args.join(' ')}（cwd=${this.opts.cwd}）`)

    const config = vscode.workspace.getConfiguration('dcode')
    const permissionMode = config.get<IdePermissionMode>('permissionMode', 'acceptEdits')
    const model = config.get<string>('model', '').trim()

    // 拼装命令行参数：--ide-server + 工作目录 + 权限模式（用对应的 flag）+ 可选模型。
    const args = [...resolved.args, '--ide-server', '--cwd', this.opts.cwd]
    args.push(...permissionModeToFlags(permissionMode))
    if (model) args.push('--model', model)

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(resolved.command, args, {
        cwd: this.opts.cwd,
        // 继承环境变量（含 API Key 等），并标记由 IDE 启动，便于内核侧按需调整行为。
        env: { ...process.env, DCODE_IDE: '1' },
        // Windows 下需要 shell 才能正确解析 `dcode`/`npx` 之类命令名。
        shell: process.platform === 'win32',
      }) as ChildProcessWithoutNullStreams
    } catch (e: any) {
      throw new Error(`无法启动 dcode 内核：${e?.message ?? String(e)}`)
    }
    this.child = child

    // 绑定 stdout：按行解码 NDJSON 并分发。
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      for (const msg of this.decoder.push(chunk)) {
        this.dispatch(msg)
      }
    })
    // stderr 仅写日志（内核的诊断信息），不影响协议。
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.log(`[内核] ${chunk.toString().trimEnd()}`)
    })
    // 进程错误（如可执行文件不存在）。
    child.on('error', (err) => {
      this.log(`内核进程错误：${err.message}`)
      this.failReady(new Error(`内核进程错误：${err.message}`))
    })
    // 进程退出：清理状态并通知监听者。
    child.on('exit', (code, signal) => {
      this.log(`内核进程退出（code=${code}, signal=${signal}）`)
      this.child = null
      this.readyInfo = null
      this.failReady(new Error('内核进程在就绪前退出。'))
      const wasStopping = this.stopping
      for (const l of this.exitListeners) {
        try {
          l({ code, signal })
        } catch {
          // 监听器异常不影响其它监听器。
        }
      }
      // 非主动停止视为崩溃，由上层（扩展）决定是否提示重启。
      void wasStopping
    })

    // 等待 ready 握手（带超时，避免无限挂起）。
    const ready = await new Promise<ServerReadyMessage>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      const timer = setTimeout(() => {
        this.failReady(new Error('等待内核就绪超时（15s）。请检查 dcode 是否可用。'))
      }, 15000)
      // 包装 resolve/reject 以清理定时器。
      const origResolve = this.readyResolve
      const origReject = this.readyReject
      this.readyResolve = (info) => {
        clearTimeout(timer)
        origResolve?.(info)
      }
      this.readyReject = (err) => {
        clearTimeout(timer)
        origReject?.(err)
      }
    })

    // 校正权限模式：CLI 无独立的 "--default" flag，若用户选了 default 而内核报告的不一致，
    // 启动后立即用 set_permission_mode 切回，确保与用户设置一致。
    if (permissionMode !== ready.permissionMode) {
      this.setPermissionMode(permissionMode)
    }
    return ready
  }

  /**
   * 分发一条服务端消息：缓存 ready，然后广播给监听者。
   * @param msg 服务端消息。
   */
  private dispatch(msg: ServerMessage): void {
    if (msg.type === 'ready') {
      this.readyInfo = msg
      const resolve = this.readyResolve
      this.readyResolve = null
      this.readyReject = null
      resolve?.(msg)
    }
    for (const l of this.listeners) {
      try {
        l(msg)
      } catch (e: any) {
        this.log(`消息监听器异常：${e?.message ?? String(e)}`)
      }
    }
  }

  /**
   * 使等待 ready 的 Promise 失败（并清空回调）。
   * @param err 失败原因。
   */
  private failReady(err: Error): void {
    const reject = this.readyReject
    this.readyResolve = null
    this.readyReject = null
    reject?.(err)
  }

  /**
   * 向后台内核发送一条客户端消息。
   * @param msg 客户端消息。
   * @returns 是否成功写入。
   */
  send(msg: ClientMessage): boolean {
    if (!this.child || this.child.exitCode !== null) {
      this.log('发送失败：后台内核未运行。')
      return false
    }
    try {
      this.child.stdin.write(encodeClientMessage(msg))
      return true
    } catch (e: any) {
      this.log(`发送失败：${e?.message ?? String(e)}`)
      return false
    }
  }

  /**
   * 发起一轮对话。
   * @param requestId 轮次 id。
   * @param text 用户输入。
   * @returns 是否成功发送。
   */
  prompt(requestId: string, text: string): boolean {
    return this.send({ type: 'prompt', requestId, text })
  }

  /**
   * 中断当前（或指定）轮次。
   * @param requestId 可选轮次 id。
   */
  cancel(requestId?: string): void {
    this.send({ type: 'cancel', requestId })
  }

  /**
   * 回执一次权限请求。
   * @param permissionId 权限请求 id。
   * @param decision 用户决策。
   */
  respondPermission(permissionId: string, decision: PermissionDecision): void {
    this.send({ type: 'permission_response', permissionId, decision })
  }

  /**
   * 切换权限模式。
   * @param mode 权限模式。
   */
  setPermissionMode(mode: IdePermissionMode): void {
    this.send({ type: 'set_permission_mode', mode })
  }

  /**
   * 切换模型。
   * @param model 模型名。
   */
  setModel(model: string): void {
    this.send({ type: 'set_model', model })
  }

  /** 清空当前会话上下文。 */
  clear(): void {
    this.send({ type: 'clear' })
  }

  /**
   * 停止后台内核：先发 shutdown 优雅退出，超时则强制 kill。
   */
  async stop(): Promise<void> {
    if (!this.child) return
    this.stopping = true
    const child = this.child
    this.send({ type: 'shutdown' })
    // 给内核一点时间优雅退出。
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('exit', finish)
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill()
          } catch {
            // 忽略 kill 异常。
          }
          finish()
        }
      }, 2000)
    })
    this.child = null
    this.readyInfo = null
  }

  /**
   * 重启后台内核（先停后启）。
   * @returns 新的 ready 信息。
   */
  async restart(): Promise<ServerReadyMessage> {
    await this.stop()
    return await this.start()
  }

  /** 释放资源：停止子进程并清空监听者。 */
  dispose(): void {
    void this.stop()
    this.listeners.clear()
    this.exitListeners.clear()
  }

  /**
   * 解析 dcode CLI 的调用方式（命令 + 前置参数）。
   * 优先级：配置 dcode.cliPath → 环境变量 DCODE_CLI_PATH → 随扩展打包的内核（node dist/cli.js）→ 全局命令 dcode。
   * @returns { command, args } 形式的调用描述。
   */
  private resolveCliInvocation(): { command: string; args: string[] } {
    const config = vscode.workspace.getConfiguration('dcode')
    const configured = config.get<string>('cliPath', '').trim()
    const fromEnv = (process.env.DCODE_CLI_PATH ?? '').trim()

    // 1) 用户显式配置的路径/命令。
    const explicit = configured || fromEnv
    if (explicit) {
      // 若指向一个 .js 文件，用 node 执行；否则当作可执行命令直接调用。
      if (explicit.endsWith('.js')) {
        return { command: process.execPath, args: [explicit] }
      }
      return { command: explicit, args: [] }
    }

    // 2) 随扩展打包的内核兜底：扩展目录下 dist/cli.js（发布时一并拷入）。
    const bundled = path.join(this.opts.extensionPath, 'dist', 'cli.js')
    if (existsSync(bundled)) {
      return { command: process.execPath, args: [bundled] }
    }

    // 3) 开发态兜底：扩展子项目相对主项目的 ../dist/cli.js。
    const devKernel = path.join(this.opts.extensionPath, '..', 'dist', 'cli.js')
    if (existsSync(devKernel)) {
      return { command: process.execPath, args: [devKernel] }
    }

    // 4) 最后回退到全局命令 dcode（要求用户已 npm link / 全局安装）。
    return { command: process.platform === 'win32' ? 'dcode.cmd' : 'dcode', args: [] }
  }

  /**
   * 写一行日志到 Output 通道（带时间戳）。
   * @param line 日志文本。
   */
  private log(line: string): void {
    const ts = new Date().toLocaleTimeString()
    this.opts.output.appendLine(`[${ts}] ${line}`)
  }
}

/**
 * 把 IDE 权限模式翻译为 dcode CLI 的对应参数。
 * @param mode 权限模式。
 * @returns CLI 参数数组。
 */
function permissionModeToFlags(mode: IdePermissionMode): string[] {
  switch (mode) {
    case 'plan':
      return ['--plan']
    case 'acceptEdits':
      return ['--auto']
    case 'bypass':
      return ['--bypass']
    case 'default':
    default:
      // default 模式：内核 --ide-server 默认即 acceptEdits，需显式传 default 才覆盖；
      // 但 CLI 当前无 "--default" flag，故通过不传任何模式 flag 由扩展在启动后用 set_permission_mode 校正。
      return []
  }
}

/**
 * 获取一个适合作为后台内核 cwd 的工作区目录。
 * @returns 第一个工作区文件夹路径；无工作区时回退到用户主目录。
 */
export function resolveWorkspaceCwd(): string {
  const folders = vscode.workspace.workspaceFolders
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath
  }
  return os.homedir()
}
