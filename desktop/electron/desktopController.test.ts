// 工作区切换的串行化和单进程所有权测试；原生对话框与连接均模拟。
// 制作人：Moriarty_Dox
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DesktopController } from './desktopController.js'
import type { ConnectionPort } from './desktopController.js'
import { WorkspaceAuthority } from './workspaceAccess.js'
import type { WorkspaceGrant } from './workspaceAccess.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'

function fixture() {
  const project = resolve('project')
  const trace: string[] = []
  const authority = new WorkspaceAuthority({ realpath: async (path) => path, isDirectory: async () => true })
  const connections: ConnectionPort[] = []
  const chooseDirectory = vi.fn(async (): Promise<string | null> => project)
  const createConnection = vi.fn(async (grant: WorkspaceGrant): Promise<ConnectionPort> => {
    const snapshot = { ...EMPTY_SNAPSHOT, cwd: grant.cwd, phase: 'ready' as const, sessionId: 'session' }
    const index = connections.length
    const connection: ConnectionPort = {
      getSnapshot: () => snapshot,
      start: vi.fn(async () => { trace.push(`start-${index}`); return snapshot }),
      shutdown: vi.fn(async () => { trace.push(`stop-${index}`) }),
      subscribe: vi.fn(() => vi.fn()),
      sendPrompt: vi.fn(() => ({ requestId: 'turn' })),
      cancelTurn: vi.fn(async () => {}), respondPermission: vi.fn(),
    }
    connections.push(connection)
    return connection
  })
  const controller = new DesktopController({ authority, chooseDirectory, createConnection })
  return { controller, authority, connections, chooseDirectory, createConnection, trace }
}

describe('DesktopController', () => {
  it('设置可在选项目之前保存，应用时重启同一会话，保存失败后恢复连接', async () => {
    const f = fixture()
    await expect(f.controller.configure(async () => 'first')).resolves.toEqual({ value: 'first' })
    await f.controller.chooseWorkspace()
    await expect(f.controller.configure(async () => 'saved')).resolves.toEqual({ value: 'saved' })
    expect(f.trace).toEqual(['start-0', 'stop-0', 'start-0'])
    await expect(f.controller.configure(async () => { throw new Error('save failed') })).rejects.toThrow('save failed')
    expect(f.connections).toHaveLength(1)
    expect(f.connections[0].start).toHaveBeenCalledTimes(3)
    await f.controller.dispose()
  })

  it('设置落盘后的重连失败单独返回，执行中拒绝修改且不调用保存', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    vi.mocked(f.connections[0].start).mockRejectedValueOnce(new Error('start failed'))
    await expect(f.controller.configure(async () => 'saved')).resolves.toMatchObject({ value: 'saved', connectionError: expect.stringContaining('设置已保存') })
    f.connections[0].getSnapshot().phase = 'running'
    const save = vi.fn(async () => {})
    await expect(f.controller.configure(save)).rejects.toMatchObject({ code: 'BUSY' })
    expect(save).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('设置保存期间拒绝消息和并发配置', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    let finish!: () => void
    const saving = f.controller.configure(() => new Promise<void>((resolve) => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(() => f.controller.sendPrompt('task')).toThrowError(expect.objectContaining({ code: 'BUSY' }))
    await expect(f.controller.configure(async () => {})).rejects.toMatchObject({ code: 'BUSY' })
    finish()
    await saving
    await f.controller.dispose()
  })

  it('退出等待在途设置保存，写入结束后释放连接', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    let finish!: () => void
    const saving = f.controller.configure(() => new Promise<void>((resolve) => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const disposed = vi.fn()
    const closing = f.controller.dispose().then(disposed)
    await Promise.resolve()
    expect(disposed).not.toHaveBeenCalled()
    finish()
    await expect(saving).resolves.toMatchObject({ connectionError: expect.stringContaining('桌面正在关闭') })
    await closing
    expect(f.connections[0].start).toHaveBeenCalledOnce()
  })

  it('恢复会话在当前授权内核验归属，新会话不传 resumeId', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    const validate = vi.fn(async () => {})
    await f.controller.openSession('saved-session', validate)
    expect(validate).toHaveBeenCalledWith(resolve('project'), 'saved-session')
    expect(f.createConnection).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: resolve('project') }), 'saved-session')
    await f.controller.openSession(null, validate)
    expect(f.createConnection).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: resolve('project') }), undefined)
    const calls = f.createConnection.mock.calls.length
    validate.mockRejectedValueOnce(new Error('foreign workspace'))
    await expect(f.controller.openSession('foreign', validate)).rejects.toThrow('foreign workspace')
    expect(f.createConnection).toHaveBeenCalledTimes(calls)
    await f.controller.dispose()
  })

  it('最近目录仍经过原生选择，取消时保持当前工作区', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    f.chooseDirectory.mockResolvedValue(null)
    await f.controller.chooseWorkspace(resolve('recent-project'))
    expect(f.chooseDirectory).toHaveBeenLastCalledWith(resolve('recent-project'))
    expect(f.createConnection).toHaveBeenCalledTimes(1)
    await f.controller.dispose()
  })
  it('未经过原生选择不能启动；切换项目先停止旧内核', async () => {
    const f = fixture()
    await expect(f.controller.reconnect()).rejects.toMatchObject({ code: 'NO_WORKSPACE' })
    expect(() => f.controller.sendPrompt('test')).toThrowError(expect.objectContaining({ code: 'NO_WORKSPACE' }))
    expect(f.createConnection).not.toHaveBeenCalled()
    await f.controller.chooseWorkspace()
    f.chooseDirectory.mockResolvedValue(resolve('project-2'))
    await f.controller.chooseWorkspace()
    expect(f.trace).toEqual(['start-0', 'stop-0', 'start-1'])
    expect(f.controller.getSnapshot().cwd).toBe(resolve('project-2'))
  })

  it('取消原生选择不改变现有连接', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    f.chooseDirectory.mockResolvedValue(null)
    expect(await f.controller.chooseWorkspace()).toBeNull()
    expect(f.createConnection).toHaveBeenCalledTimes(1)
    expect(f.connections[0].shutdown).not.toHaveBeenCalled()
  })

  it('并发选择和选择期间的 prompt 被拒绝', async () => {
    const f = fixture()
    let finish!: (value: string | null) => void
    f.chooseDirectory.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const choosing = f.controller.chooseWorkspace()
    await expect(f.controller.chooseWorkspace()).rejects.toMatchObject({ code: 'BUSY' })
    expect(() => f.controller.sendPrompt('task')).toThrowError(expect.objectContaining({ code: 'BUSY' }))
    finish(null)
    await choosing
    expect(f.chooseDirectory).toHaveBeenCalledTimes(1)
  })

  it('旧进程未能停止则不启动第二个内核', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    vi.mocked(f.connections[0].shutdown).mockRejectedValue(new Error('cannot stop'))
    await expect(f.controller.chooseWorkspace()).rejects.toThrow('cannot stop')
    expect(f.connections[1].start).not.toHaveBeenCalled()
    expect(f.controller.getSnapshot().cwd).toBe(resolve('project'))
  })

  it('手动重连只复用原授权与会话连接，不发送 prompt；退出清理授权', async () => {
    const f = fixture()
    await f.controller.chooseWorkspace()
    await f.controller.reconnect()
    expect(f.trace).toEqual(['start-0', 'stop-0', 'start-0'])
    expect(f.connections[0].sendPrompt).not.toHaveBeenCalled()
    await f.controller.dispose()
    await expect(f.controller.reconnect()).rejects.toMatchObject({ code: 'BUSY' })
  })
})
