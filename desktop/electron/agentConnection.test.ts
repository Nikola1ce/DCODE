// AgentConnection 纯 Node mock-child-process 回归测试；不启动 Electron、真实内核或真实工具。
// 制作人：Moriarty_Dox
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { resolve } from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentConnection } from './agentConnection.js'
import type { AgentConnectionOptions } from './agentConnection.js'
import type { DesktopEvent, PermissionChoice } from '../shared/api.js'
import { DesktopFault } from './errors.js'

class MockChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: Record<string, unknown>[] = []
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      const msg = JSON.parse(chunk.toString()) as Record<string, unknown>
      this.messages.push(msg)
      callback()
      if (this.exitOnShutdown && msg.type === 'shutdown') queueMicrotask(() => this.exit(0))
    },
  })
  readonly pid = 42_000
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  exitOnShutdown = true
  readonly kill = vi.fn(() => { this.exit(null, 'SIGKILL'); return true })

  send(message: unknown) { this.stdout.write(`${JSON.stringify(message)}\n`) }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }
  asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams }
}

const cwd = resolve('fixtures/project with spaces')
const coreEntry = resolve('fixtures/core/cli.js')
const executable = resolve('fixtures/Electron.exe')
const ready = (patch: Record<string, unknown> = {}) => ({
  type: 'ready', protocolVersion: 5, version: 'test', model: 'mock-model', provider: 'mock',
  permissionMode: 'plan', cwd, hasApiKey: true, sessionId: 'session-1', ...patch,
})
const status = (patch: Record<string, unknown> = {}) => ({
  type: 'status', model: 'mock-model', provider: 'mock', permissionMode: 'default', sessionId: 'session-1', ...patch,
})

function fixture(options: Partial<AgentConnectionOptions> = {}, terminate = true) {
  const children: MockChild[] = []
  const spawn = vi.fn(() => { const child = new MockChild(); children.push(child); return child.asChild() })
  const terminateTree = vi.fn(async (child: ChildProcessWithoutNullStreams) => {
    if (terminate) child.kill('SIGKILL')
  })
  const connection = new AgentConnection({
    cwd, coreEntry, executable, readyTimeoutMs: 100, cancelTimeoutMs: 80, shutdownTimeoutMs: 60,
    killTimeoutMs: 40, recoveryDelayMs: 20, idleTimeoutMs: 1000,
    env: { NODE_OPTIONS: '--require unsafe', NODE_PATH: 'unsafe', ELECTRON_RUN_AS_NODE: '0', OPENAI_API_KEY: 'private-key' },
    ...options,
  }, { spawn, terminateTree })
  const events: DesktopEvent[] = []
  connection.subscribe((event) => events.push(event))
  const launch = async (patch: Record<string, unknown> = {}) => {
    const promise = connection.start()
    await Promise.resolve()
    const child = children.at(-1)!
    child.send(ready(patch))
    child.send(status())
    await promise
    return child
  }
  return { connection, children, spawn, terminateTree, events, launch }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('AgentConnection', () => {
  it('指定历史会话首次启动携带 resume 参数并校验握手身份', async () => {
    const f = fixture({ resumeId: 'session-1' })
    await f.launch()
    expect(f.spawn).toHaveBeenCalledWith(executable, [coreEntry, '--ide-server', '--cwd', cwd, '--plan', '--resume', 'session-1'], expect.any(Object))
    expect(f.connection.getSnapshot().sessionId).toBe('session-1')
    await f.connection.shutdown()
  })
  it('免 Shell 使用 Electron Node；ready 后还必须等待 default 权限状态，且连接幂等', async () => {
    const f = fixture()
    const first = f.connection.start()
    const second = f.connection.start()
    expect(first).toBe(second)
    await Promise.resolve()
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.spawn).toHaveBeenCalledWith(executable, [coreEntry, '--ide-server', '--cwd', cwd, '--plan'], expect.objectContaining({
      cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ELECTRON_RUN_AS_NODE: '1', OPENAI_API_KEY: 'private-key' },
    }))
    expect(() => f.connection.sendPrompt('not yet')).toThrowError(expect.objectContaining({ code: 'NOT_READY' }))
    const child = f.children[0]
    child.send(ready())
    expect(f.connection.getSnapshot().phase).toBe('starting')
    expect(child.messages).toEqual([{ type: 'set_permission_mode', mode: 'default' }])
    child.send(status())
    await expect(first).resolves.toMatchObject({ phase: 'ready', permissionMode: 'default', cwd, model: 'mock-model' })
    await f.connection.start()
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it('支持跨 UTF-8 边界分片与一包多帧，并拒绝第二个并发 prompt', async () => {
    const f = fixture()
    const child = await f.launch()
    const { requestId } = f.connection.sendPrompt('你好')
    expect(() => f.connection.sendPrompt('second')).toThrowError(expect.objectContaining({ code: 'NOT_READY' }))
    const bytes = Buffer.from(`${JSON.stringify({ type: 'text', requestId, delta: '你好𠮷' })}\n${JSON.stringify({
      type: 'turn_done', requestId, reason: 'final', costUsd: 0,
    })}\n`)
    const split = bytes.indexOf(Buffer.from('好')) + 1
    child.stdout.write(bytes.subarray(0, split))
    child.stdout.write(bytes.subarray(split))
    expect(f.events).toContainEqual({ type: 'stream', message: { type: 'text', requestId, delta: '你好𠮷' } })
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'ready', activeRequestId: null })
    expect(child.messages.filter((m) => m.type === 'prompt')).toHaveLength(1)
  })

  it.each([4, 5])('兼容协议 v%i，没有 capabilities 也可基础对话', async (version) => {
    const f = fixture()
    await f.launch({ protocolVersion: version })
    expect(f.connection.getSnapshot().capabilities).toEqual([])
    expect(f.connection.getSnapshot().compatibilityWarning?.code).toBe(version === 4 ? 'PROTOCOL_V4_LIMITED' : undefined)
    expect(f.connection.sendPrompt('hello').requestId).toBeTruthy()
  })

  it.each([3, 6])('不兼容协议 v%i 返回稳定错误，不重试', async (version) => {
    const f = fixture()
    const failure = expect(f.connection.start()).rejects.toMatchObject({ code: 'UNSUPPORTED_PROTOCOL' })
    await Promise.resolve()
    f.children[0].send(ready({ protocolVersion: version }))
    await failure
    expect(f.terminateTree).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(200)
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('ready 或安全状态缺失时均有握手超时（ready=%s）', async (sendReady) => {
    const f = fixture()
    const failure = expect(f.connection.start()).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
    await Promise.resolve()
    if (sendReady) f.children[0].send(ready())
    await vi.advanceTimersByTimeAsync(101)
    await failure
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'failed', activeRequestId: null, permissions: [] })
    expect(f.terminateTree).toHaveBeenCalledOnce()
  })

  it('拒绝不同工作区与不安全的权限确认', async () => {
    const mismatch = fixture()
    const failed = expect(mismatch.connection.start()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await Promise.resolve()
    mismatch.children[0].send(ready({ cwd: resolve('other') }))
    await failed
    const unsafe = fixture()
    const denied = expect(unsafe.connection.start()).rejects.toMatchObject({ code: 'UNSAFE_PERMISSION_MODE' })
    await Promise.resolve()
    unsafe.children[0].send(ready())
    unsafe.children[0].send(status({ permissionMode: 'bypass' }))
    await denied
  })

  it('只向 renderer 发布选定字段，不透传 config、日志、密钥或完整工具结果', async () => {
    const f = fixture()
    const child = await f.launch({ apiKey: 'hidden-key', config: { apiKey: 'hidden-config' }, capabilities: { historySnapshot: true } })
    child.send({ type: 'log', level: 'info', message: 'hidden-log' })
    child.send({ type: 'command_result', requestId: 'any', message: 'hidden-command' })
    const { requestId } = f.connection.sendPrompt('test')
    child.send({ type: 'tool_end', requestId, toolCallId: 'call-1', name: 'read_file', isError: false, summary: 'ok', detail: 'hidden-detail' })
    const serialized = JSON.stringify(f.events)
    expect(serialized).not.toContain('hidden-')
    expect(serialized).not.toContain('private-key')
    expect(f.connection.getSnapshot().capabilities).toEqual(['historySnapshot'])
  })

  it('缺 API key 时仅提供引导，不发出 prompt', async () => {
    const f = fixture()
    const child = await f.launch({ hasApiKey: false })
    expect(() => f.connection.sendPrompt('test')).toThrowError(expect.objectContaining({ code: 'API_KEY_REQUIRED' }))
    expect(child.messages.some((m) => m.type === 'prompt')).toBe(false)
  })

  it('权限响应只关联当前 permissionId；拒绝错轮次、未知/重复回执和 allow_always', async () => {
    const f = fixture()
    const child = await f.launch()
    const { requestId } = f.connection.sendPrompt('task')
    const permission = { type: 'permission_request', requestId, permissionId: 'perm-1', request: {
      toolName: 'run_command', title: '执行测试', preview: 'npm test', ruleKey: 'internal-rule', config: 'hidden',
    } }
    child.send({ ...permission, requestId: 'old-turn' })
    expect(f.connection.getDiagnostics().pendingPermissions).toBe(0)
    child.send(permission)
    expect(f.connection.getSnapshot().permissions).toEqual([{
      requestId, permissionId: 'perm-1', request: { toolName: 'run_command', title: '执行测试', preview: 'npm test' },
    }])
    expect(() => f.connection.respondPermission('unknown', 'allow_once')).toThrowError(expect.objectContaining({ code: 'PERMISSION_NOT_PENDING' }))
    expect(() => f.connection.respondPermission('perm-1', 'allow_always' as PermissionChoice)).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    f.connection.respondPermission('perm-1', 'deny')
    expect(child.messages.at(-1)).toEqual({ type: 'permission_response', permissionId: 'perm-1', decision: 'deny' })
    expect(() => f.connection.respondPermission('perm-1', 'allow_once')).toThrowError(expect.objectContaining({ code: 'PERMISSION_NOT_PENDING' }))
  })

  it('取消等待终态，清理权限并拒绝取消期间迟到的授权', async () => {
    const f = fixture()
    const child = await f.launch()
    const { requestId } = f.connection.sendPrompt('task')
    const cancellation = f.connection.cancelTurn()
    expect(child.messages.at(-1)).toEqual({ type: 'cancel', requestId })
    child.send({ type: 'permission_request', requestId, permissionId: 'late', request: { toolName: 'edit_file', title: 'edit', ruleKey: 'Edit' } })
    expect(child.messages.at(-1)).toEqual({ type: 'permission_response', permissionId: 'late', decision: 'deny' })
    child.send({ type: 'turn_done', requestId, reason: 'aborted', costUsd: 0 })
    await cancellation
    expect(f.connection.getSnapshot().phase).toBe('ready')
    expect(f.terminateTree).not.toHaveBeenCalled()
  })

  it('cancel 超时强杀并清理 pending，不盲重试 prompt', async () => {
    const f = fixture()
    await f.launch()
    const { requestId } = f.connection.sendPrompt('task')
    const cancelled = expect(f.connection.cancelTurn()).rejects.toMatchObject({ code: 'CANCEL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(81)
    await cancelled
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'failed', activeRequestId: null, permissions: [] })
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'turn_interrupted', requestId }))
    expect(f.terminateTree).toHaveBeenCalledOnce()
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it('正常 shutdown 等待进程退出，且解绑 stdout 订阅', async () => {
    const f = fixture()
    const child = await f.launch()
    await f.connection.shutdown()
    expect(child.messages.at(-1)).toEqual({ type: 'shutdown' })
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(f.connection.getSnapshot().phase).toBe('disconnected')
    expect(f.terminateTree).not.toHaveBeenCalled()
  })

  it('shutdown 超时终止进程树并返回明确错误', async () => {
    const f = fixture()
    const child = await f.launch()
    child.exitOnShutdown = false
    const stopped = expect(f.connection.shutdown()).rejects.toMatchObject({ code: 'SHUTDOWN_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(61)
    await stopped
    expect(f.terminateTree).toHaveBeenCalledOnce()
    expect(f.connection.getSnapshot().phase).toBe('failed')
  })

  it('异常退出清理回合，最多自动恢复原会话一次，不重放 prompt', async () => {
    const f = fixture()
    const child = await f.launch()
    const { requestId } = f.connection.sendPrompt('never replay me')
    child.send({ type: 'permission_request', requestId, permissionId: 'pending', request: { toolName: 'write_file', title: 'write', ruleKey: 'Write' } })
    child.exit(7)
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'recovering', activeRequestId: null, permissions: [], error: { code: 'CORE_EXITED' } })
    await vi.advanceTimersByTimeAsync(21)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.spawn.mock.calls[1]).toEqual([executable, expect.arrayContaining(['--resume', 'session-1']), expect.any(Object)])
    const recovered = f.children[1]
    recovered.send(ready())
    recovered.send(status())
    expect(recovered.messages).toEqual([{ type: 'set_permission_mode', mode: 'default' }])
    recovered.exit(8)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.connection.getSnapshot().phase).toBe('failed')
  })

  it('恢复时拒绝内核返回不同会话', async () => {
    const f = fixture()
    await f.launch()
    await f.connection.shutdown()
    const failed = expect(f.connection.start()).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' })
    await Promise.resolve()
    f.children[1].send(ready({ sessionId: 'different-session' }))
    await failed
  })

  it.each(['not-json\n', `${'x'.repeat(1100)}`])('拒绝污染/超限 stdout 并清理 pending', async (content) => {
    const f = fixture({ maxFrameBytes: 1024 })
    const child = await f.launch()
    f.connection.sendPrompt('test')
    child.stdout.write(content)
    expect(f.connection.getSnapshot().error?.code).toBe(content.endsWith('\n') ? 'INVALID_FRAME' : 'FRAME_TOO_LARGE')
    expect(f.connection.getSnapshot().activeRequestId).toBeNull()
    expect(f.terminateTree).toHaveBeenCalledOnce()
  })

  it('stderr 持续排空且只保留有界尾部，不泄漏到 renderer', async () => {
    const f = fixture({ maxStderrBytes: 64 })
    const child = await f.launch()
    for (let i = 0; i < 30; i++) child.stderr.write('stderr-secret'.repeat(100))
    expect(f.connection.getDiagnostics()).toMatchObject({ stderrBytes: 64, stderrTruncated: true })
    expect(JSON.stringify(f.events)).not.toContain('stderr-secret')
    expect(f.connection.getSnapshot().phase).toBe('ready')
  })

  it('空闲回收与手动唤醒保留会话，不自动发送消息', async () => {
    const f = fixture({ idleTimeoutMs: 100 })
    await f.launch()
    await vi.advanceTimersByTimeAsync(101)
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'idle', sessionId: 'session-1' })
    await f.launch()
    expect(f.spawn.mock.calls[1]).toEqual([executable, expect.arrayContaining(['--resume', 'session-1']), expect.any(Object)])
    expect(f.children[1].messages.some((msg) => msg.type === 'prompt')).toBe(false)
  })

  it('启动校验失败时不创建子进程', async () => {
    const f = fixture({ validateLaunch: async () => { throw new DesktopFault('WORKSPACE_CHANGED', 'changed') } })
    await expect(f.connection.start()).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' })
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('目录验证尚在等待时关闭，不会在验证完成后迟到启动', async () => {
    let allow!: () => void
    const f = fixture({ validateLaunch: () => new Promise<void>((resolve) => { allow = resolve }) })
    const started = expect(f.connection.start()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
    await f.connection.shutdown()
    allow()
    await Promise.resolve()
    await started
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it('未确认旧进程退出时拒绝新进程，并使关闭操作保持有界', async () => {
    const f = fixture({}, false)
    const failed = expect(f.connection.start()).rejects.toMatchObject({ code: 'READY_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(150)
    await failed
    expect(f.connection.getSnapshot().error?.code).toBe('CORE_STILL_RUNNING')
    await expect(f.connection.start()).rejects.toMatchObject({ code: 'BUSY' })
    const stopped = expect(f.connection.shutdown()).rejects.toMatchObject({ code: 'CORE_STILL_RUNNING' })
    await vi.advanceTimersByTimeAsync(200)
    await stopped
    expect(f.spawn).toHaveBeenCalledTimes(1)
  })

  it('同步 spawn 失败与异步子进程错误均结束 pending，错误内容不泄漏', async () => {
    const sync = fixture()
    sync.spawn.mockImplementation(() => { throw new Error('secret launch detail') })
    await expect(sync.connection.start()).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
    expect(JSON.stringify(sync.events)).not.toContain('secret launch detail')
    const asyncError = fixture()
    const pending = expect(asyncError.connection.start()).rejects.toMatchObject({ code: 'CORE_IO_ERROR' })
    await Promise.resolve()
    asyncError.children[0].emit('error', new Error('secret process detail'))
    await pending
    expect(JSON.stringify(asyncError.events)).not.toContain('secret process detail')
  })

  it('stdout 单独关闭时不会让回合永久悬挂', async () => {
    const f = fixture()
    const child = await f.launch()
    f.connection.sendPrompt('task')
    child.stdout.end()
    await vi.advanceTimersByTimeAsync(60)
    expect(f.connection.getSnapshot()).toMatchObject({ phase: 'failed', activeRequestId: null, error: { code: 'CORE_IO_ERROR' } })
    expect(f.terminateTree).toHaveBeenCalledOnce()
  })

  it('执行中的回合不会触发空闲回收；运行期意外切换 bypass 会停止连接', async () => {
    const f = fixture({ idleTimeoutMs: 50 })
    const child = await f.launch()
    f.connection.sendPrompt('task')
    await vi.advanceTimersByTimeAsync(100)
    expect(f.connection.getSnapshot().phase).toBe('running')
    expect(child.messages.some((msg) => msg.type === 'shutdown')).toBe(false)
    child.send(status({ permissionMode: 'bypass' }))
    expect(f.connection.getSnapshot().error?.code).toBe('UNSAFE_PERMISSION_MODE')
    expect(f.terminateTree).toHaveBeenCalledOnce()
  })

  it('订阅可以退订，断开的观察者不再收到事件', async () => {
    const f = fixture()
    const listener = vi.fn()
    const unsubscribe = f.connection.subscribe(listener)
    unsubscribe()
    await f.launch()
    expect(listener).not.toHaveBeenCalled()
  })
})
