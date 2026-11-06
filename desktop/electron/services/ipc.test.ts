// 从 preload 正常入口调用真实服务，使用模拟窗口/内核和隔离磁盘。
// 制作人：Moriarty_Dox
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => ({ directory: '' }))
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => disk.directory }))
import { SessionRecorder } from '../../../src/core/session.js'
import { DesktopController } from '../desktopController.js'
import { WorkspaceAuthority } from '../workspaceAccess.js'
import { createDesktopBridge } from '../bridge.js'
import { installIpcRoutes } from '../ipc.js'
import type { IpcHandler } from '../ipc.js'
import { EMPTY_SNAPSHOT } from '../../shared/api.js'
import type { ConnectionSnapshot, DesktopApi } from '../../shared/api.js'
import { CHANNELS } from '../../shared/channels.js'
import { DesktopServices } from './index.js'
import { SettingsService } from './settings.js'
import { completeCheckpointAfterWrite, saveCheckpointBeforeWrite } from '../../../src/core/checkpoint.js'

let root: string
let cwd: string
let controller: DesktopController
let services: DesktopServices
let api: Readonly<DesktopApi>
let routes: Map<string, IpcHandler>
let snapshot: ConnectionSnapshot
const event = { sender: {}, senderFrame: null }
const publish = vi.fn()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-service-ipc-'))
  cwd = join(root, 'project'); disk.directory = join(root, 'config')
  await mkdir(cwd); await mkdir(disk.directory)
  snapshot = { ...EMPTY_SNAPSHOT, cwd, phase: 'ready', sessionId: 'active' }
  controller = new DesktopController({
    authority: new WorkspaceAuthority(), chooseDirectory: async () => cwd,
    createConnection: async () => ({
      start: async () => snapshot, shutdown: async () => {}, subscribe: () => () => {},
      getSnapshot: () => snapshot, sendPrompt: () => ({ requestId: 'request' }),
      cancelTurn: async () => {}, respondPermission: () => {},
    }),
  })
  services = new DesktopServices(controller, new SettingsService(disk.directory), {
    confirm: async () => false, trash: async () => {},
  }, publish)
  routes = new Map()
  installIpcRoutes({ handle: (channel, handler) => { routes.set(channel, handler) }, removeHandler: (channel) => { routes.delete(channel) } },
    controller, (incoming) => incoming === event, services)
  api = createDesktopBridge({ invoke: (channel, ...args) => routes.get(channel)!(event, ...args), on: () => {}, removeListener: () => {} })
})
afterEach(async () => { await controller.dispose(); await services.dispose(); await rm(root, { recursive: true, force: true }) })

describe('服务 IPC 与生命周期', () => {
  it('仅注册固定通道，原生授权前文件/会话访问被拒绝，偏好可独立访问', async () => {
    expect([...routes.keys()].sort()).toEqual(Object.values(CHANNELS).filter((channel) => channel !== CHANNELS.event).sort())
    expect(await api.readFile('file.txt')).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } })
    expect(await api.listSessions(false)).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } })
    expect(await api.getSettings()).toMatchObject({ ok: true, value: { theme: 'system' } })
    expect(await api.getModelSettings()).toMatchObject({ ok: true, value: { providers: expect.any(Array) } })
    expect(await api.searchFiles('')).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } })
    expect(await routes.get(CHANNELS.getSettings)!({ sender: {}, senderFrame: null })).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
  })

  it('正常 bridge 可读文件、保存偏好、列出/归档/恢复会话并查看用量', async () => {
    await api.chooseWorkspace()
    await writeFile(join(cwd, 'file.txt'), '内容')
    const recorder = SessionRecorder.create(cwd, 'test')
    recorder.append({ role: 'user', content: '任务' })
    expect(await api.readFile('file.txt')).toMatchObject({ ok: true, value: { kind: 'text', text: '内容' } })
    expect(await api.listFiles('')).toMatchObject({ ok: true, value: { entries: [{ path: 'file.txt' }] } })
    expect(await api.updateSettings({ theme: 'light' })).toMatchObject({ ok: true, value: { theme: 'light' } })
    expect(await api.updateSession(recorder.id, { archived: true })).toMatchObject({ ok: true })
    expect(await api.listSessions(true)).toMatchObject({ ok: true, value: { sessions: [{ id: recorder.id }] } })
    expect(await api.updateSession(recorder.id, { archived: false })).toMatchObject({ ok: true })
    expect(await api.listSessions(false)).toMatchObject({ ok: true, value: { sessions: [{ id: recorder.id }] } })
    expect(await api.getUsage(recorder.id)).toMatchObject({ ok: true, value: { total: { requests: 0 } } })
    expect(await api.deleteSession(recorder.id)).toEqual({ ok: true, value: false })
  })

  it('所有新通道校验参数数量、类型、额外属性与目录边界', async () => {
    for (const [channel, args] of [
      [CHANNELS.listFiles, ['../secret']], [CHANNELS.readFile, ['/secret']],
      [CHANNELS.gitStatus, ['git status']], [CHANNELS.gitDiff, ['a.txt', 1]],
      [CHANNELS.gitStage, ['a.txt', true, 'extra']], [CHANNELS.gitDiscard, ['']],
      [CHANNELS.listSessions, [{}]], [CHANNELS.updateSession, ['id', { apiKey: 'secret' }]],
      [CHANNELS.deleteSession, ['../id']], [CHANNELS.getUsage, ['__proto__']],
      [CHANNELS.getSettings, ['config.json']], [CHANNELS.updateSettings, [{ proxy: 'bad' }]],
      [CHANNELS.watchWorkspace, ['true']],
      [CHANNELS.getModelSettings, ['extra']], [CHANNELS.validateModelSettings, [{}]],
      [CHANNELS.saveModelSettings, [{ apiKey: 'secret' }]], [CHANNELS.searchFiles, ['x'.repeat(201)]],
      [CHANNELS.searchFiles, ['bad\u0000']], [CHANNELS.searchFiles, [false]],
      [CHANNELS.gitStageAll, ['true']], [CHANNELS.gitHistory, [1]],
      [CHANNELS.gitBranches, ['extra']], [CHANNELS.gitBranch, [{ action: 'switch', name: '--force', revision: 'a'.repeat(64) }]],
      [CHANNELS.gitBranch, [{ action: ['create'], name: 'feature', revision: 'a'.repeat(64) }]],
      [CHANNELS.gitRemote, [{ action: ['push'], remote: 'origin', revision: 'a'.repeat(64) }]],
      [CHANNELS.gitBranch, [{ action: 'rename', name: 'refs/heads/main', revision: 'a'.repeat(64) }]],
      [CHANNELS.gitBranch, [{ action: 'create', name: 'feature', revision: 'a'.repeat(64), force: true }]],
      [CHANNELS.gitRemote, [{ action: 'push', remote: 'origin', revision: 'HEAD' }]],
      [CHANNELS.gitRemote, [{ action: 'push', remote: 'origin', revision: 'a'.repeat(64), force: true }]],
      [CHANNELS.gitCommit, ['', 'a'.repeat(64)]], [CHANNELS.gitCommit, ['message', 'HEAD']],
      [CHANNELS.gitCommitDiff, ['--help']], [CHANNELS.openSession, ['../session']],
      [CHANNELS.getSessionHistory, ['../session']],
      [CHANNELS.listRecentWorkspaces, [1]], [CHANNELS.openRecentWorkspace, ['../workspace']],
      [CHANNELS.listReviews, ['../session']], [CHANNELS.getReview, ['id', '../checkpoint']],
      [CHANNELS.undoReview, ['id', 'checkpoint', 'extra']],
      [CHANNELS.revertReview, ['id', 'checkpoint', 'forged', 0]],
      [CHANNELS.revertReview, ['id', 'checkpoint', 'a'.repeat(64), -1]],
      [CHANNELS.revertReview, ['id', 'checkpoint', 'a'.repeat(64), 0.5]],
      [CHANNELS.revertReview, ['id', 'checkpoint', 'a'.repeat(64), {}]],
    ] as [string, unknown[]][]) {
      expect(await routes.get(channel)!(event, ...args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    }
  })

  it('文件搜索使用授权和忽略规则，匹配相对路径并限制结果数', async () => {
    await api.chooseWorkspace()
    await mkdir(join(cwd, 'nested'))
    await mkdir(join(cwd, 'node_modules'))
    await writeFile(join(cwd, 'nested', '说明.TXT'), '内容')
    await writeFile(join(cwd, 'node_modules', '说明.txt'), '忽略')
    expect(await api.searchFiles('nested/说明.txt')).toMatchObject({ ok: true, value: { entries: [{ path: 'nested/说明.TXT' }], truncated: false } })
    await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(join(cwd, `match-${index}.txt`), '内容')))
    const result = await api.searchFiles('match-')
    expect(result.ok && result.value.entries.length).toBe(200)
    expect(result.ok && result.value.truncated).toBe(true)
  })

  it('历史只投影对话字段，拒绝打开其他工作区的会话', async () => {
    await api.chooseWorkspace()
    const recorder = SessionRecorder.create(cwd, 'test')
    recorder.append({ role: 'system', content: '内部提示' })
    recorder.append({ role: 'user', content: '历史任务' })
    recorder.append({ role: 'assistant', content: '历史回复' })
    const history = await api.getSessionHistory(recorder.id)
    expect(history).toMatchObject({ ok: true, value: { messages: [{ role: 'user', text: '历史任务' }, { role: 'assistant', text: '历史回复' }] } })
    expect(JSON.stringify(history)).not.toContain('内部提示')
    const foreignPath = join(root, 'foreign'); await mkdir(foreignPath)
    const foreign = SessionRecorder.create(foreignPath, 'test')
    expect(await api.openSession(foreign.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    expect(await api.openSession(recorder.id)).toMatchObject({ ok: true })
    expect(await api.openSession(null)).toMatchObject({ ok: true })
  })

  it('回合运行期间允许并行读取，拒绝 Git 写入及删除', async () => {
    await api.chooseWorkspace()
    await writeFile(join(cwd, 'file.txt'), '内容')
    snapshot.phase = 'running'
    const results = await Promise.all([api.readFile('file.txt'), api.listFiles('')])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(await api.gitStage('file.txt', true)).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await api.gitBranch({ action: 'create', name: 'feature', revision: 'a'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await api.gitRemote({ action: 'fetch', remote: 'origin', revision: 'a'.repeat(64) })).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await api.deleteSession('id')).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await api.revertReview('id', 'checkpoint', 'a'.repeat(64), null)).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    expect(await api.undoReview('id', 'checkpoint')).toMatchObject({ ok: false, error: { code: 'BUSY' } })
  })

  it('正常 bridge 合并轮次文件、按块回退与撤销，拒绝跨会话访问及过期版本', async () => {
    await api.chooseWorkspace()
    const recorder = SessionRecorder.create(cwd, 'test')
    const other = SessionRecorder.create(cwd, 'test')
    await writeFile(join(cwd, 'file.txt'), '原始\n')
    const checkpoint = saveCheckpointBeforeWrite(cwd, join(cwd, 'file.txt'), 'edit_file', { sessionId: recorder.id, turnId: 'turn' })!
    await writeFile(join(cwd, 'file.txt'), '修改\n')
    completeCheckpointAfterWrite(cwd, checkpoint.id, '修改\n')
    expect(await api.listReviews(recorder.id)).toMatchObject({ ok: true, value: { turns: [{ turnId: 'turn', files: [{ checkpointId: checkpoint.id }] }] } })
    expect(await api.getReview(other.id, checkpoint.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    const preview = await api.getReview(recorder.id, checkpoint.id)
    expect(preview.ok).toBe(true)
    if (!preview.ok || !preview.value.ok) throw new Error('缺少审阅结果')
    const reverted = await api.revertReview(recorder.id, checkpoint.id, preview.value.review.revision, 0)
    expect(reverted).toMatchObject({ ok: true, value: { ok: true } })
    expect(await api.readFile('file.txt')).toMatchObject({ ok: true, value: { text: '原始\n' } })
    expect(await api.revertReview(recorder.id, checkpoint.id, preview.value.review.revision, 0)).toMatchObject({ ok: true, value: { ok: false, code: 'conflict' } })
    if (!reverted.ok || !reverted.value.ok) throw new Error('回退失败')
    expect(await api.undoReview(recorder.id, reverted.value.checkpointId)).toMatchObject({ ok: true, value: { ok: true, count: 1 } })
    expect(await api.readFile('file.txt')).toMatchObject({ ok: true, value: { text: '修改\n' } })
    expect(publish).toHaveBeenCalledWith({ type: 'workspace_changed', cwd })
  })

  it('轮次列表按文件合并，缺少轮次身份的旧记录单独展示，跨工作区拒绝访问', async () => {
    await api.chooseWorkspace()
    const recorder = SessionRecorder.create(cwd, 'test')
    for (const [path, turnId, content] of [
      ['a.txt', 'turn', 'first'], ['b.txt', 'turn', 'second'], ['a.txt', 'turn', 'third'],
      ['old-a.txt', undefined, 'old-a'], ['old-b.txt', undefined, 'old-b'],
    ] as [string, string | undefined, string][]) {
      const checkpoint = saveCheckpointBeforeWrite(cwd, join(cwd, path), 'write_file', { sessionId: recorder.id, turnId })!
      await writeFile(join(cwd, path), content)
      completeCheckpointAfterWrite(cwd, checkpoint.id, content)
    }
    const listing = await api.listReviews(recorder.id)
    expect(listing).toMatchObject({ ok: true, value: { turns: [
      { turnId: null, files: [{ path: 'old-b.txt', checkpointCount: 1 }] },
      { turnId: null, files: [{ path: 'old-a.txt', checkpointCount: 1 }] },
      { turnId: 'turn', files: [{ path: 'a.txt', checkpointCount: 2 }, { path: 'b.txt', checkpointCount: 1 }] },
    ] } })
    const otherPath = join(root, 'other-project')
    await mkdir(otherPath)
    const foreign = SessionRecorder.create(otherPath, 'test')
    expect(await api.listReviews(foreign.id)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } })
    await writeFile(join(cwd, '.dcode/checkpoints/manifest.json'), '{broken')
    expect(await api.listReviews(recorder.id)).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
  })

  it('读服务期间允许发消息，切换排队等待读取并阻止新操作，dispose 等待在途操作', async () => {
    await api.chooseWorkspace()
    let finish!: () => void
    const pending = controller.useWorkspace(() => new Promise<void>((resolve) => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await api.sendPrompt('任务')).toMatchObject({ ok: true })
    const choosing = api.chooseWorkspace()
    expect(await api.sendPrompt('任务')).toMatchObject({ ok: false, error: { code: 'BUSY' } })
    let disposed = false
    const closing = controller.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    finish(); await pending; await closing
    expect(await choosing).toMatchObject({ ok: false, error: { code: 'CONNECTION_CLOSED' } })
    expect(disposed).toBe(true)
    expect(await api.readFile('file.txt')).toMatchObject({ ok: false, error: { code: 'BUSY' } })
  })
})
