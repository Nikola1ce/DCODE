// 内核 JSONL 兼容、工作区隔离、展示元信息、回收站确认与实际用量回归。
// 制作人：Moriarty_Dox
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../../src/config.js', () => ({ getConfigDir: () => disk.directory }))
import { SessionRecorder } from '../../../src/core/session.js'
import { SettingsService } from './settings.js'
import { SessionService } from './sessions.js'
import { sessionUsage } from './usage.js'

let root: string
let cwd: string
let service: SessionService
const confirm = vi.fn(async () => true)
const trash = vi.fn(async (_path: string) => {})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dcode-sessions-'))
  cwd = join(root, 'project'); disk.directory = join(root, 'config')
  await mkdir(cwd); await mkdir(disk.directory)
  confirm.mockImplementation(async () => true)
  service = new SessionService(new SettingsService(disk.directory), { confirm, trash })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function create() {
  const recorder = SessionRecorder.create(cwd, 'test')
  recorder.append({ role: 'system', content: 'private system' })
  recorder.append({ role: 'user', content: '解释项目' })
  return recorder
}

describe('会话与用量服务', () => {
  it('展示兼容旧消息，重命名/置顶/归档/恢复使用独立元信息', async () => {
    const recorder = create()
    const path = join(disk.directory, 'sessions', `${recorder.id}.jsonl`)
    const before = await readFile(path, 'utf8')
    expect((await service.list(cwd, false)).sessions[0]).toMatchObject({ title: '解释项目', messageCount: 1 })
    await service.update(cwd, recorder.id, { title: '新的标题', pinned: true, archived: true })
    expect((await service.list(cwd, false)).sessions).toEqual([])
    expect((await service.list(cwd, true)).sessions[0]).toMatchObject({ title: '新的标题', pinned: true, archived: true })
    await service.update(cwd, recorder.id, { archived: false })
    expect((await service.list(cwd, false)).sessions).toHaveLength(1)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('跨项目会话访问/篡改被拒绝，坏日志计入 skipped，半条记录不吞后续消息', async () => {
    const recorder = create()
    const other = join(root, 'other'); await mkdir(other)
    await expect(service.snapshot(other, recorder.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(service.update(other, recorder.id, { title: 'bad' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await service.list(other, false)).sessions).toEqual([])
    await writeFile(join(disk.directory, 'sessions', 'bad.jsonl'), '{broken')
    await appendFile(join(disk.directory, 'sessions', `${recorder.id}.jsonl`), '{bad\n' + JSON.stringify({ type: 'message', message: { role: 'assistant', content: '回答' } }) + '\n')
    const listing = await service.list(cwd, false)
    expect(listing.skipped).toBe(1)
    expect(listing.sessions[0].messageCount).toBe(2)
    await expect(service.snapshot(cwd, '../secret')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('当前连接会话保护、取消删除与确认期间追加保护', async () => {
    const recorder = create()
    await expect(service.remove(cwd, recorder.id, recorder.id)).rejects.toMatchObject({ code: 'BUSY' })
    confirm.mockResolvedValueOnce(false)
    expect(await service.remove(cwd, recorder.id, null)).toBe(false)
    confirm.mockImplementationOnce(async () => { recorder.append({ role: 'assistant', content: '追加' }); return true })
    await expect(service.remove(cwd, recorder.id, null)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(trash).not.toHaveBeenCalled()
    expect(await service.remove(cwd, recorder.id, null)).toBe(true)
    expect(trash).toHaveBeenCalledWith(join(disk.directory, 'sessions', `${recorder.id}.jsonl`))
  })

  it('按请求去重，按轮汇总 token/缓存/费用，缺失费用保留未计价标记', async () => {
    const recorder = create()
    const event = {
      type: 'llm_done' as const, runId: 'run', turnId: 'turn', iteration: 1, timestamp: 100,
      message: { role: 'assistant' as const, content: '回答' }, finishReason: 'stop', durationMs: 2,
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } }, costUsd: 0.01,
    }
    recorder.appendEvent(event); recorder.appendEvent(event)
    recorder.appendEvent({ ...event, iteration: 2, costUsd: undefined })
    const usage = sessionUsage(await service.snapshot(cwd, recorder.id))
    expect(usage.total).toEqual({ requests: 2, promptTokens: 200, completionTokens: 40, cacheHitTokens: 120, costUsd: 0.01, unpricedRequests: 1 })
    expect(usage.turns).toEqual([{ turnId: 'turn', timestamp: 100, usage: usage.total }])
  })
})
