// 单工作区/会话的内核子进程连接：有界 NDJSON、握手、取消、回收与不重放 prompt 的会话恢复。
// 制作人：Moriarty_Dox
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ClientMessage } from '../../src/ide/protocol.js'
import type {
  ConnectionPhase, ConnectionSnapshot, DesktopEvent, PermissionCard, PermissionChoice,
} from '../shared/api.js'
import { EMPTY_SNAPSHOT, MAX_PROMPT_BYTES } from '../shared/api.js'
import { coreEnvironment } from './corePath.js'
import { DesktopFault } from './errors.js'
import { MAX_FRAME_BYTES, NdjsonDecoder, encodeFrame } from './framing.js'
import { compatibilityWarning, decodeServerMessage } from './protocol.js'
import type { DecodedMessage } from './protocol.js'
import { terminateProcessTree } from './processTree.js'
import type { TerminateTree } from './processTree.js'
import { samePath } from './workspaceAccess.js'

export interface CoreSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  windowsHide: true
  stdio: ['pipe', 'pipe', 'pipe']
  detached: boolean
}
export type SpawnCore = (file: string, args: string[], options: CoreSpawnOptions) => ChildProcessWithoutNullStreams

export interface AgentConnectionOptions {
  cwd: string
  coreEntry: string
  resumeId?: string
  // Electron 主进程传 process.execPath；不查找 PATH 中的 node。
  executable: string
  env?: NodeJS.ProcessEnv
  validateLaunch?: () => Promise<void>
  readyTimeoutMs?: number
  cancelTimeoutMs?: number
  shutdownTimeoutMs?: number
  killTimeoutMs?: number
  idleTimeoutMs?: number
  recoveryDelayMs?: number
  maxRecoveryAttempts?: number
  maxFrameBytes?: number
  maxStderrBytes?: number
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

type Timer = 'ready' | 'cancel' | 'shutdown' | 'kill' | 'idle' | 'recovery' | 'eof'
interface ProcessContext {
  child: ChildProcessWithoutNullStreams
  decoder: NdjsonDecoder
  detach(): void
  fault: DesktopFault | null
  stopping: 'disconnected' | 'idle' | null
  secured: boolean
  receivedReady: boolean
}

export class AgentConnection {
  private readonly listeners = new Set<(event: DesktopEvent) => void>()
  private state: ConnectionSnapshot
  private readonly permissions = new Map<string, PermissionCard>()
  private context: ProcessContext | null = null
  private readyWait: Deferred<ConnectionSnapshot> | null = null
  private cancelWait: Deferred<void> | null = null
  private stopWait: Deferred<void> | null = null
  private timers: Partial<Record<Timer, ReturnType<typeof setTimeout>>> = {}
  private generation = 0
  private recoveryAttempts = 0
  private stderrTail = Buffer.alloc(0)
  private stderrTruncated = false
  private readonly spawn: SpawnCore
  private readonly terminateTree: TerminateTree

  constructor(private readonly options: AgentConnectionOptions, dependencies: {
    spawn?: SpawnCore
    terminateTree?: TerminateTree
  } = {}) {
    if (![options.cwd, options.coreEntry, options.executable].every(isAbsolute)) {
      throw new DesktopFault('INVALID_ARGUMENT', '内核启动路径必须由主进程解析为绝对路径。')
    }
    this.state = { ...EMPTY_SNAPSHOT, cwd: options.cwd, sessionId: options.resumeId ?? null }
    this.spawn = dependencies.spawn ?? ((file, args, config) => nodeSpawn(file, args, config))
    this.terminateTree = dependencies.terminateTree ?? terminateProcessTree
  }

  getSnapshot(): ConnectionSnapshot {
    return {
      ...this.state, capabilities: [...this.state.capabilities],
      error: this.state.error && { ...this.state.error },
      compatibilityWarning: this.state.compatibilityWarning && { ...this.state.compatibilityWarning },
      permissions: [...this.permissions.values()].map((card) => ({ ...card, request: { ...card.request } })),
    }
  }

  /** 诊断只提供计数；stderr 内容永远不发布到 renderer。 */
  getDiagnostics(): { stderrBytes: number; stderrTruncated: boolean; pendingPermissions: number; processAlive: boolean } {
    return {
      stderrBytes: this.stderrTail.length, stderrTruncated: this.stderrTruncated,
      pendingPermissions: this.permissions.size, processAlive: this.context !== null,
    }
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 幂等连接；只有 ready + default 权限状态确认后才允许 prompt。 */
  start(): Promise<ConnectionSnapshot> {
    this.recoveryAttempts = 0
    return this.launch(false)
  }

  private launch(recovering: boolean): Promise<ConnectionSnapshot> {
    if (this.readyWait) return this.readyWait.promise
    if (this.context) {
      return this.context.secured && !this.context.fault && !this.context.stopping
        ? Promise.resolve(this.getSnapshot())
        : Promise.reject(new DesktopFault('BUSY', '旧内核尚未退出，不能创建第二个内核进程。'))
    }
    this.clearTimer('recovery')
    const generation = ++this.generation
    const wait = deferred<ConnectionSnapshot>()
    this.readyWait = wait
    this.stderrTail = Buffer.alloc(0)
    this.stderrTruncated = false
    this.state.error = recovering ? this.state.error : null
    this.phase(recovering ? 'recovering' : 'starting')
    this.setTimer('ready', this.options.readyTimeoutMs ?? 15_000, () => {
      this.fail(new DesktopFault('READY_TIMEOUT', '等待内核 ready/安全权限握手超时，连接已停止。'))
    })
    void (async () => {
      await this.options.validateLaunch?.()
      if (generation !== this.generation || this.readyWait !== wait) return
      const args = [this.options.coreEntry, '--ide-server', '--cwd', this.options.cwd, '--plan']
      if (this.state.sessionId) args.push('--resume', this.state.sessionId)
      const child = this.spawn(this.options.executable, args, {
        cwd: this.options.cwd, env: coreEnvironment(this.options.env ?? process.env),
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // 独立进程组用于 POSIX 超时终止整棵非脱离子进程树。
        detached: process.platform !== 'win32',
      })
      this.bindChild(child)
    })().catch((error: unknown) => {
      if (generation !== this.generation) return
      this.fail(error instanceof DesktopFault ? error
        : new DesktopFault('CORE_START_FAILED', '无法启动内核，请检查构建入口和 Electron 安装。'))
    })
    return wait.promise
  }

  sendPrompt(text: string): { requestId: string } {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
      throw new DesktopFault('INVALID_ARGUMENT', '请输入非空消息，UTF-8 长度不得超过 64 KiB。')
    }
    if (this.state.phase !== 'ready' || !this.context?.secured) {
      throw new DesktopFault('NOT_READY', '内核尚未就绪或已有回合正在运行。消息未发送。')
    }
    if (!this.state.hasApiKey) {
      throw new DesktopFault('API_KEY_REQUIRED', '内核尚未配置 API Key，请先通过命令行 /login 配置后重新连接。')
    }
    const requestId = randomUUID()
    this.clearTimer('idle')
    this.state.activeRequestId = requestId
    this.phase('running')
    this.emit({ type: 'turn_started', requestId, text })
    try {
      this.write({ type: 'prompt', requestId, text })
    } catch (error) {
      this.fail(error as DesktopFault)
      throw error
    }
    return { requestId }
  }

  cancelTurn(): Promise<void> {
    if (this.cancelWait) return this.cancelWait.promise
    if (!this.state.activeRequestId) return Promise.resolve()
    const wait = deferred<void>()
    this.cancelWait = wait
    this.permissions.clear()
    this.phase('cancelling')
    this.setTimer('cancel', this.options.cancelTimeoutMs ?? 5000, () => {
      this.fail(new DesktopFault('CANCEL_TIMEOUT', '内核未及时确认停止，已强制终止进程；不会重发本轮消息。'))
    })
    try {
      this.write({ type: 'cancel', requestId: this.state.activeRequestId })
    } catch (error) {
      this.fail(error as DesktopFault)
    }
    return wait.promise
  }

  respondPermission(permissionId: string, decision: PermissionChoice): void {
    if (decision !== 'allow_once' && decision !== 'deny') {
      throw new DesktopFault('INVALID_ARGUMENT', '桌面骨架仅支持允许一次或拒绝。')
    }
    const card = this.permissions.get(permissionId)
    if (!card || card.requestId !== this.state.activeRequestId || this.state.phase !== 'running') {
      throw new DesktopFault('PERMISSION_NOT_PENDING', '该权限请求已失效或不属于当前回合。')
    }
    this.permissions.delete(permissionId)
    this.publish()
    try {
      this.write({ type: 'permission_response', permissionId, decision })
    } catch (error) {
      this.fail(error as DesktopFault)
      throw error
    }
  }

  /** 正常退出先走协议；超时才杀进程。不会在未确认旧进程退出时复用连接。 */
  shutdown(target: 'disconnected' | 'idle' = 'disconnected'): Promise<void> {
    this.clearTimer('recovery')
    this.clearTimer('idle')
    if (this.stopWait) return this.stopWait.promise
    const error = new DesktopFault('CONNECTION_CLOSED', '内核连接已关闭，本轮未自动重发。')
    if (!this.context) {
      ++this.generation
      this.clearTimer('ready')
      this.clearPending(error)
      this.phase(target)
      return Promise.resolve()
    }
    if (this.context.fault) {
      // 已进入强杀流程时不能再写入管道；等待现有 kill 确认，或立即报告已超时的残留进程。
      if (!this.timers.kill) {
        return Promise.reject(new DesktopFault('CORE_STILL_RUNNING', '旧内核退出尚未确认，不能启动第二个内核。'))
      }
      const wait = deferred<void>()
      this.stopWait = wait
      return wait.promise
    }
    const wait = deferred<void>()
    this.stopWait = wait
    this.context.stopping = target
    this.clearPending(error)
    this.phase('stopping')
    this.setTimer('shutdown', this.options.shutdownTimeoutMs ?? 3000, () => {
      this.fail(new DesktopFault('SHUTDOWN_TIMEOUT', '内核未及时退出，已请求终止进程树。'))
    })
    try {
      this.write({ type: 'shutdown' })
      this.context?.child.stdin.end()
    } catch {
      this.fail(new DesktopFault('CORE_IO_ERROR', '关闭内核时协议通道不可写，已请求终止进程树。'))
    }
    return wait.promise
  }

  private bindChild(child: ChildProcessWithoutNullStreams): void {
    const context: ProcessContext = {
      child, decoder: new NdjsonDecoder(this.options.maxFrameBytes), detach: () => {},
      fault: null, stopping: null, secured: false, receivedReady: false,
    }
    this.context = context
    const onData = (chunk: Buffer | string) => {
      if (this.context !== context || context.fault) return
      try {
        for (const raw of context.decoder.push(chunk)) {
          if (this.context !== context || context.fault) break
          const message = decodeServerMessage(raw)
          if (message) this.onMessage(context, message)
        }
      } catch (error) {
        this.fail(error instanceof DesktopFault ? error : new DesktopFault('INVALID_MESSAGE', '内核消息无法处理。'))
      }
    }
    const onStderr = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const max = this.options.maxStderrBytes ?? 16 * 1024
      const overflow = this.stderrTail.length + bytes.length - max
      this.stderrTruncated ||= overflow > 0
      if (bytes.length >= max) this.stderrTail = Buffer.from(bytes.subarray(bytes.length - max))
      else this.stderrTail = Buffer.concat([this.stderrTail.subarray(Math.max(0, overflow)), bytes])
    }
    const onError = () => {
      if (this.context !== context) return
      this.fail(new DesktopFault('CORE_IO_ERROR', '内核进程或协议管道发生错误，连接已停止。'))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => this.onExit(context, code, signal)
    const onEnd = () => {
      if (this.context !== context || context.fault || context.stopping) return
      try {
        context.decoder.end()
        // 留出正常 exit 事件的到达机会；单独关闭 stdout 而不退出不能让 pending 永久悬挂。
        this.setTimer('eof', 50, () => {
          if (this.context === context && !context.stopping) {
            this.fail(new DesktopFault('CORE_IO_ERROR', '内核协议输出已关闭，但进程未退出；连接已停止。'))
          }
        })
      } catch (error) {
        this.fail(error as DesktopFault)
      }
    }
    child.stdout.on('data', onData)
    child.stdout.on('end', onEnd)
    child.stderr.on('data', onStderr)
    child.on('error', onError)
    child.stdin.on('error', onError)
    child.stdout.on('error', onError)
    child.stderr.on('error', onError)
    child.once('exit', onExit)
    child.once('close', onExit)
    context.detach = () => {
      child.stdout.off('data', onData)
      child.stdout.off('end', onEnd)
      child.stderr.off('data', onStderr)
      child.off('exit', onExit)
      child.off('close', onExit)
      // 迟到的管道 error 仍被消费，但不再持有连接实例。
      for (const emitter of [child, child.stdin, child.stdout, child.stderr]) {
        emitter.off('error', onError)
        emitter.on('error', ignoreLateError)
      }
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }

  private onMessage(context: ProcessContext, msg: DecodedMessage): void {
    if (context.stopping) return
    if (msg.type === 'ready') {
      if (context.receivedReady) throw new DesktopFault('INVALID_MESSAGE', '内核重复发送 ready。')
      if (msg.protocolVersion !== 4 && msg.protocolVersion !== 5) {
        throw new DesktopFault('UNSUPPORTED_PROTOCOL', '当前桌面仅兼容 IDE 协议 v4/v5，请使用匹配的内核。')
      }
      if (!samePath(msg.cwd, this.options.cwd) || (this.state.sessionId && msg.sessionId !== this.state.sessionId)) {
        throw new DesktopFault('IDENTITY_MISMATCH', '内核返回的工作区或会话与授权连接不一致。')
      }
      context.receivedReady = true
      this.state = {
        ...this.state, model: msg.model, provider: msg.provider, sessionId: msg.sessionId,
        protocolVersion: msg.protocolVersion, permissionMode: msg.permissionMode, hasApiKey: msg.hasApiKey,
        capabilities: msg.protocolVersion === 5 ? msg.capabilities : [],
        compatibilityWarning: compatibilityWarning(msg.protocolVersion),
      }
      // --ide-server 默认 acceptEdits；先 --plan，再等待 default 的 status 确认，避免审批旁路。
      this.write({ type: 'set_permission_mode', mode: 'default' })
      this.publish()
      return
    }
    if (msg.type === 'status') {
      if (!context.receivedReady) throw new DesktopFault('INVALID_MESSAGE', '内核在 ready 前发送 status。')
      if (msg.sessionId !== this.state.sessionId) {
        throw new DesktopFault('IDENTITY_MISMATCH', '内核会话身份意外变化，连接已停止。')
      }
      if (msg.permissionMode !== 'default') {
        throw new DesktopFault('UNSAFE_PERMISSION_MODE', '内核未确认逐次审批模式，拒绝继续执行。')
      }
      this.state.model = msg.model
      this.state.provider = msg.provider
      this.state.permissionMode = msg.permissionMode
      if (!context.secured) {
        context.secured = true
        this.clearTimer('ready')
        this.phase('ready')
        const wait = this.readyWait
        this.readyWait = null
        wait?.resolve(this.getSnapshot())
        this.scheduleIdle()
      } else this.publish()
      return
    }
    if (!context.secured) throw new DesktopFault('INVALID_MESSAGE', '内核在握手完成前发送回合消息。')
    // 忽略旧回合的迟到消息；权限永远绑定当前回合和原始 permissionId。
    if (msg.requestId !== this.state.activeRequestId) return
    if (msg.type === 'permission_request') {
      if (this.state.phase === 'cancelling') {
        this.write({ type: 'permission_response', permissionId: msg.permissionId, decision: 'deny' })
        return
      }
      if (this.permissions.has(msg.permissionId) || this.permissions.size >= 64) {
        throw new DesktopFault('INVALID_MESSAGE', '内核权限请求重复或超过待审批上限。')
      }
      this.permissions.set(msg.permissionId, {
        requestId: msg.requestId, permissionId: msg.permissionId, request: msg.request,
      })
      this.publish()
      return
    }
    this.emit({ type: 'stream', message: msg })
    if (msg.type === 'turn_done' || msg.type === 'turn_error') {
      this.state.activeRequestId = null
      this.permissions.clear()
      this.clearTimer('cancel')
      this.cancelWait?.resolve()
      this.cancelWait = null
      this.phase('ready')
      this.scheduleIdle()
    }
  }

  private write(message: ClientMessage): void {
    const context = this.context
    if (!context || context.child.stdin.destroyed || !context.child.stdin.writable) {
      throw new DesktopFault('CORE_IO_ERROR', '内核协议通道不可写。')
    }
    const max = this.options.maxFrameBytes ?? MAX_FRAME_BYTES
    const frame = encodeFrame(message, max)
    if (context.child.stdin.writableLength + Buffer.byteLength(frame) > max * 2) {
      throw new DesktopFault('CORE_IO_ERROR', '内核未及时读取协议消息，发送队列已达上限。')
    }
    try {
      context.child.stdin.write(frame, (error) => {
        if (error && this.context === context && !context.fault) {
          this.fail(new DesktopFault('CORE_IO_ERROR', '向内核写入消息失败，当前消息不会自动重发。'))
        }
      })
    } catch {
      throw new DesktopFault('CORE_IO_ERROR', '向内核写入消息失败，当前消息不会自动重发。')
    }
  }

  private fail(error: DesktopFault): void {
    const context = this.context
    if (context?.fault) return
    ++this.generation
    this.clearTimers()
    if (context) context.fault = error
    this.clearPending(error)
    this.state.error = error.toPublic()
    this.phase('failed')
    if (!context) return
    this.setTimer('kill', this.options.killTimeoutMs ?? 2500, () => {
      if (this.context !== context) return
      this.state.error = { code: 'CORE_STILL_RUNNING', message: '无法确认旧内核退出，禁止启动第二个内核；请关闭桌面后检查残留进程。' }
      this.publish()
      this.stopWait?.reject(new DesktopFault('CORE_STILL_RUNNING', this.state.error.message))
      this.stopWait = null
    })
    void this.terminateTree(context.child).catch(() => {
      try { context.child.kill('SIGKILL') } catch { /* 由 kill 超时呈现无法确认退出。 */ }
    })
  }

  private onExit(context: ProcessContext, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.context !== context) return
    context.detach()
    this.context = null
    ++this.generation
    this.clearTimers()
    if (context.fault) {
      this.stopWait?.reject(context.fault)
      this.stopWait = null
      this.phase('failed')
      return
    }
    if (context.stopping) {
      this.phase(context.stopping)
      this.stopWait?.resolve()
      this.stopWait = null
      return
    }
    const error = new DesktopFault('CORE_EXITED', `内核异常退出（${signal ?? `退出码 ${code ?? '未知'}`}）。未完成回合已中断，不会自动重发。`)
    this.clearPending(error)
    this.state.error = error.toPublic()
    this.phase('failed')
    if (context.secured && this.state.sessionId && this.recoveryAttempts < (this.options.maxRecoveryAttempts ?? 1)) {
      ++this.recoveryAttempts
      this.phase('recovering')
      this.setTimer('recovery', this.options.recoveryDelayMs ?? 300, () => {
        // 只恢复原会话；没有保存或重新发送 prompt 的逻辑。
        void this.launch(true).catch(() => {})
      })
    }
  }

  private clearPending(error: DesktopFault): void {
    this.clearTimer('ready')
    this.clearTimer('cancel')
    this.readyWait?.reject(error)
    this.readyWait = null
    this.cancelWait?.reject(error)
    this.cancelWait = null
    if (this.state.activeRequestId) {
      this.emit({ type: 'turn_interrupted', requestId: this.state.activeRequestId, error: error.toPublic() })
    }
    this.state.activeRequestId = null
    this.permissions.clear()
  }

  private scheduleIdle(): void {
    if (!this.state.sessionId) return
    this.setTimer('idle', this.options.idleTimeoutMs ?? 10 * 60_000, () => {
      if (this.state.phase === 'ready') void this.shutdown('idle').catch(() => {})
    })
  }

  private phase(phase: ConnectionPhase): void {
    this.state.phase = phase
    this.publish()
  }

  private publish(): void {
    this.emit({ type: 'connection', snapshot: this.getSnapshot() })
  }

  private emit(event: DesktopEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* UI 订阅者不能破坏子进程生命周期。 */ }
    }
  }

  private setTimer(key: Timer, ms: number, callback: () => void): void {
    this.clearTimer(key)
    const timer = setTimeout(() => { delete this.timers[key]; callback() }, ms)
    timer.unref?.()
    this.timers[key] = timer
  }

  private clearTimer(key: Timer): void {
    clearTimeout(this.timers[key])
    delete this.timers[key]
  }

  private clearTimers(): void {
    for (const key of Object.keys(this.timers) as Timer[]) this.clearTimer(key)
  }
}

function ignoreLateError(): void {}
