// 无头模式退出码回归：正常完成、运行失败与用户中断必须可由脚本区分。
// 制作人：Moriarty_Dox
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, TurnHandlers } from './core/agent.js'
import { runHeadless } from './headless.js'

vi.mock('./core/checkpoint.js', () => ({ getCheckpointExitHint: () => '' }))

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => vi.restoreAllMocks())

function fakeAgent(run: (handlers: TurnHandlers) => Promise<void>): Agent {
  return {
    cwd: process.cwd(),
    getSessionId: () => 'test-session',
    runTurn: (_prompt: string, handlers: TurnHandlers) => run(handlers),
  } as unknown as Agent
}

function emitEnd(handlers: TurnHandlers, reason: 'final' | 'aborted') {
  handlers.onEvent?.({
    type: 'run_end', runId: 'run', turnId: 'turn', timestamp: 1, iterations: 1, reason,
  })
}

describe('无头退出码', () => {
  it('正常完成返回 0，普通错误返回 1，并清理 SIGINT 监听器', async () => {
    const listeners = process.listenerCount('SIGINT')
    const success = fakeAgent(async (handlers) => {
      handlers.onText?.('完成')
      emitEnd(handlers, 'final')
    })
    expect(await runHeadless(success, '任务', { autoApprove: false })).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(listeners)

    const failed = fakeAgent(async () => { throw new Error('连接失败') })
    expect(await runHeadless(failed, '任务', { autoApprove: false })).toBe(1)
    expect(process.stderr.write).toHaveBeenCalledWith('\n错误：连接失败\n')
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it.each(['正常返回', '抛出中断异常'] as const)('SIGINT 后 Agent %s 仍返回 130', async (mode) => {
    const listeners = process.listenerCount('SIGINT')
    const agent = fakeAgent(async (handlers) => {
      process.emit('SIGINT')
      expect(handlers.abortSignal.aborted).toBe(true)
      if (mode === '抛出中断异常') throw new Error('request aborted')
      emitEnd(handlers, 'aborted')
    })

    expect(await runHeadless(agent, '任务', { autoApprove: false })).toBe(130)
    expect(process.stderr.write).not.toHaveBeenCalledWith('\n错误：request aborted\n')
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it('只有 aborted 终态而没有 SIGINT 时也不误报成功', async () => {
    const agent = fakeAgent(async (handlers) => emitEnd(handlers, 'aborted'))

    expect(await runHeadless(agent, '任务', { autoApprove: false })).toBe(130)
    expect(process.stderr.write).toHaveBeenCalledWith('[已中断]\n')
  })

  it('SIGINT 后没有终态事件也按中断退出', async () => {
    const agent = fakeAgent(async () => { process.emit('SIGINT') })

    expect(await runHeadless(agent, '任务', { autoApprove: false })).toBe(130)
  })
})
