import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_BACKGROUND_SHELL_RECORDS, MAX_SHELL_OUTPUT_CHARS } from '../constants.js'

const mock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
import { ShellManager } from './shellManager.js'

function setup() {
  const mgr = new ShellManager()
  const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough }> = []
  mock.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    children.push(child)
    return child
  })
  return { mgr, children, start: () => mgr.spawnBackground({ command: 'test', cwd: process.cwd() }) }
}
afterEach(() => { vi.useRealTimers(); mock.spawn.mockReset() })

describe('后台 Shell 日志与生命周期', () => {
  it('日志超限后仍保留最新输出，tail 游标随滚动窗口移动', async () => {
    const { mgr, children, start } = setup()
    const id = start()
    const child = children[0]
    child.stdout.write('a'.repeat(MAX_SHELL_OUTPUT_CHARS * 4))
    for (let i = 0; i < 4; i++) await mgr.getOutput(id, 0, { tail: true })
    child.stdout.write('FINAL-RESULT')
    child.emit('close', 0)
    expect(mgr.getShell(id)?.output.length).toBe(MAX_SHELL_OUTPUT_CHARS * 4)
    expect((await mgr.getOutput(id, 0, { tail: true })).formatted).toContain('FINAL-RESULT')
    expect((await mgr.getOutput(id)).formatted).toContain('FINAL-RESULT')
    expect((await mgr.getOutput(id, 0, { tail: true })).formatted).toContain('无新增输出')
  })

  it('大量未读日志分批返回，不能把截断未展示的部分标为已读', async () => {
    const { mgr, children, start } = setup()
    const id = start()
    children[0].stdout.write('a'.repeat(MAX_SHELL_OUTPUT_CHARS) + 'SECOND-PAGE')
    children[0].emit('close', 0)
    const first = await mgr.getOutput(id, 0, { tail: true })
    expect(first.formatted).not.toContain('SECOND-PAGE')
    expect((await mgr.getOutput(id, 0, { tail: true })).formatted).toContain('SECOND-PAGE')
  })

  it('UTF-8 汉字跨 Buffer 边界不会变成乱码', async () => {
    const { mgr, children, start } = setup()
    const id = start()
    const bytes = Buffer.from('中文测试')
    children[0].stdout.write(bytes.subarray(0, 2))
    children[0].stdout.write(bytes.subarray(2))
    children[0].emit('close', 0)
    expect(mgr.getShell(id)?.output).toBe('中文测试')
  })

  it('取消查询立即退出等待，不停止后台 Shell', async () => {
    const { mgr, children, start } = setup()
    const id = start()
    const ac = new AbortController()
    const pending = mgr.getOutput(id, 60_000, { tail: true, abortSignal: ac.signal })
    children[0].stdout.write('UNREAD')
    ac.abort()
    await expect(pending).resolves.toMatchObject({ found: true, done: false })
    expect(mgr.getShell(id)?.status).toBe('running')
    expect((await mgr.getOutput(id, 0, { tail: true })).formatted).toContain('UNREAD')
    children[0].emit('close', 0)
  })

  it('历史数量限制包括运行中记录，旧的已完成记录及游标被清理', async () => {
    const { mgr, children, start } = setup()
    const first = start()
    children[0].stdout.write('read')
    await mgr.getOutput(first, 0, { tail: true })
    children[0].emit('close', 0)
    for (let i = 0; i < MAX_BACKGROUND_SHELL_RECORDS; i++) start()
    expect(mgr.getAllShells()).toHaveLength(MAX_BACKGROUND_SHELL_RECORDS)
    expect(mgr.getShell(first)).toBeUndefined()
    for (const child of children) child.emit('close', 0)
  })
})
