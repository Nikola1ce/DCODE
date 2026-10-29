// 动态区真实 Ink 渲染回归：思考/正文与面板叠加时不得超过实际终端高度。
// 制作人：Moriarty_Dox
import React from 'react'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import type { Agent, TurnHandlers } from '../core/agent.js'
import type { DCodeConfig } from '../config.js'
import { shellManager } from '../core/shellManager.js'
import { App } from './App.js'
import { strCols } from './textLayout.js'

vi.mock('./sound.js', () => ({
  playInputSent: vi.fn(),
  playInterrupted: vi.fn(),
  playNotification: vi.fn(),
  playPermissionRequest: vi.fn(),
  playTurnComplete: vi.fn(),
  setSoundEnabled: vi.fn(),
  setSoundVolume: vi.fn(),
}))

const config: DCodeConfig = {
  provider: 'custom', model: 'test-model', baseURL: 'https://example.test/v1',
  theme: 'dark', showThinking: true, reasoningEffort: 'high', alwaysAllow: [],
  totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false,
  soundEnabled: false, soundVolume: 0,
}
const eventContext = { runId: 'run', turnId: 'turn', iteration: 1, timestamp: 1 }
const tick = () => new Promise((resolve) => setTimeout(resolve, 40))
const originalRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows')
const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
let finishRun: (() => void) | undefined

afterEach(async () => {
  finishRun?.()
  finishRun = undefined
  await tick()
  cleanup()
  vi.restoreAllMocks()
  for (const [name, descriptor] of [['rows', originalRows], ['columns', originalColumns]] as const) {
    if (descriptor) Object.defineProperty(process.stdout, name, descriptor)
    else Reflect.deleteProperty(process.stdout, name)
  }
})

function setTerminalSize(rows: number, cols: number) {
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: rows })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: cols })
}

async function startRun(rows: number, cols: number, background = false, todoCount = 1, shellCount = 1) {
  setTerminalSize(rows, cols)
  vi.spyOn(shellManager, 'getAllShells').mockReturnValue(background ? Array.from({ length: shellCount }, (_, i) => ({
    id: `test-job-${i}`, command: 'npm test -- 检查思考与正文重复\n验证小窗口显示',
    cwd: process.cwd(), status: 'running', output: '', exitCode: null, createdAt: Date.now(),
  })) : [])
  let handlers: TurnHandlers | undefined
  const agent = {
    cwd: process.cwd(), permissionMode: 'default', usage: { costUsd: 0 },
    getModel: () => config.model,
    getMessages: () => [],
    getContextTokens: () => 0,
    clear: vi.fn(),
    getTodos: () => Array.from({ length: todoCount }, () => ({ content: '检查思考与正文重复\n并验证小窗口中的显示效果', status: 'in_progress' })),
    hasApiKey: () => true,
    runTurn: vi.fn((_prompt: string, callbacks: TurnHandlers) => {
      handlers = callbacks
      return new Promise<void>((resolve) => { finishRun = resolve })
    }),
  } as unknown as Agent
  const view = render(React.createElement(App, {
    agent, config, initialItems: [], needLogin: false,
  }))
  Object.defineProperty(view.stdout, 'columns', { configurable: true, value: cols })
  view.stdout.emit('resize')
  await tick()
  view.stdin.write('probe')
  await tick()
  view.stdin.write('\r')
  await vi.waitFor(() => expect(handlers?.onEvent).toBeTypeOf('function'))
  await tick()

  // debug 帧含完整 Static 历史；用最后一个静态项的末尾定位实际可重绘的动态区。
  const liveFrame = (staticTail = 'probe\n\n') => {
    const frame = stripVTControlCharacters(view.lastFrame() ?? '')
    const boundary = frame.lastIndexOf(staticTail)
    expect(boundary, frame).toBeGreaterThanOrEqual(0)
    return frame.slice(boundary + staticTail.length)
  }
  const resize = async (nextRows: number, nextCols: number) => {
    setTerminalSize(nextRows, nextCols)
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: nextCols })
    process.stdout.emit('resize')
    view.stdout.emit('resize')
    await tick()
  }
  return { view, handlers: handlers!, liveFrame, resize }
}

function emitDelta(handlers: TurnHandlers, type: 'reasoning_delta' | 'text_delta', delta: string) {
  handlers.onEvent!({ ...eventContext, type, delta })
}

function expectFits(frame: string, rows: number, cols: number) {
  const lines = frame.split('\n')
  // log-update 还会追加换行，动态内容必须为其留一行。
  expect(lines.length, frame).toBeLessThanOrEqual(rows - 1)
  for (const line of lines) expect(strCols(line), line).toBeLessThanOrEqual(cols)
}

describe('App 流式动态区高度', () => {
  it('清空已提交历史后，新提示和下一轮正文仍会进入 Static', async () => {
    const { handlers, view } = await startRun(24, 80)
    for (let i = 0; i < 6; i++) {
      emitDelta(handlers, 'text_delta', `old-${i}\n`)
      await tick()
    }
    finishRun?.()
    finishRun = undefined
    await tick()
    view.stdin.write('/clear')
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(view.lastFrame()).toContain('已清空对话历史。')
    view.stdin.write('NEXT-TURN')
    await tick()
    view.stdin.write('\r')
    await tick()
    expect(view.lastFrame()).toContain('NEXT-TURN')
  })

  it('运行结束时撤销遗留授权弹窗，下一轮可正常输入', async () => {
    const { handlers, view } = await startRun(24, 80)
    const decision = handlers.requestPermission({ toolName: 'run_command', title: '测试取消', ruleKey: 'Bash(test)' })
    await tick()
    expect(view.lastFrame()).toContain('请选择授权')
    finishRun?.()
    finishRun = undefined
    await expect(decision).resolves.toBe('deny')
    await tick()
    expect(view.lastFrame()).not.toContain('请选择授权')
  })

  it.each([[16, 24], [24, 80], [16, 16]])('结束后展开任务和后台面板仍共用预算：%i × %i', async (rows, cols) => {
    const { liveFrame, view } = await startRun(rows, cols, true, 20, 8)
    finishRun?.()
    finishRun = undefined
    await tick()
    expect(liveFrame()).toContain('任务进度')
    expect(liveFrame()).toContain('后台 Shell')
    expectFits(liveFrame(), rows, cols)
    // 菜单也属于动态区，不能在已占满高度的面板后直接追加。
    view.stdin.write('/')
    await tick()
    expectFits(liveFrame(), rows, cols)
  })

  it('达到迭代上限后的继续提示进入历史，不被 finally 清空', async () => {
    const { handlers, view } = await startRun(8, 24)
    emitDelta(handlers, 'text_delta', '\n\n[已达到迭代上限，如需继续请再次输入。]')
    handlers.onEvent!({ ...eventContext, type: 'run_end', reason: 'max_iterations', iterations: 1 })
    finishRun?.()
    finishRun = undefined
    await tick()
    expect(stripVTControlCharacters(view.lastFrame() ?? '').replace(/\s+/g, '')).toContain('[已达到迭代上限，如需继续请再次输入。]')
  })

  it('思考预览、中文任务摘要和状态栏叠加时仍留在小窗口内', async () => {
    const { handlers, liveFrame } = await startRun(8, 24)
    emitDelta(handlers, 'reasoning_delta', '正在核对流式思考增量与最终回答的分流逻辑。'.repeat(30))
    await tick()
    const frame = liveFrame()
    expect(frame).toContain('分流逻辑')
    expect(frame).toContain('任务进度')
    expectFits(frame, 8, 24)
  })

  it.each([[8, 24], [6, 20], [10, 16]])(
    '后台 Shell 与多行任务摘要叠加：%i 行 × %i 列',
    async (rows, cols) => {
      const { handlers, liveFrame } = await startRun(rows, cols, true)
      emitDelta(handlers, 'reasoning_delta', '核对流式事件与重复输出。'.repeat(30))
      await tick()
      const frame = liveFrame()
      expect(frame).toContain('思考中')
      expect(frame).toContain('输出')
      expect(frame).toContain('任务进度')
      expect(frame).toContain('后台 Shell')
      expectFits(frame, rows, cols)
    },
  )

  it('正文未换行的尾巴不会与任务和后台 Shell 面板一起撑出窗口', async () => {
    const { handlers, liveFrame } = await startRun(8, 24, true)
    emitDelta(handlers, 'text_delta', '未换行的正文'.repeat(4) + 'TAIL')
    await tick()
    const frame = liveFrame()
    expect(frame.replace(/\s+/g, '')).toContain('正文TAIL')
    expect(frame).toContain('正在回答')
    expectFits(frame, 8, 24)
  })

  it('按词折行比按列估算更高时也不会溢出预算', async () => {
    const { handlers, liveFrame } = await startRun(8, 24, true)
    emitDelta(handlers, 'reasoning_delta', 'concurrency hypothesis verification '.repeat(30))
    await tick()
    const frame = liveFrame()
    expect(frame).toContain('hypothesis')
    expectFits(frame, 8, 24)
  })

  it('工具摘要和进度与两个面板叠加时共用预算', async () => {
    const { handlers, liveFrame } = await startRun(8, 24, true)
    handlers.onEvent!({
      ...eventContext, type: 'tool_start', id: 'tool', name: 'run_command',
      summary: 'TOOL 检查重复输出\n并运行很长的中文测试命令',
    })
    handlers.onEvent!({
      ...eventContext, type: 'tool_progress', id: 'tool', text: '正在验证思考与正文分流。'.repeat(30),
    })
    await vi.waitFor(() => expect(liveFrame()).toContain('分流'))
    const frame = liveFrame()
    expect(frame).toContain('TOOL')
    expectFits(frame, 8, 24)
  })

  it('窗口反复缩小和恢复后按真实尺寸重新分配预算', async () => {
    const { handlers, liveFrame, resize } = await startRun(24, 80, true)
    emitDelta(handlers, 'reasoning_delta', '核对流式事件与重复输出。'.repeat(30))
    await tick()
    for (const [rows, cols] of [[8, 24], [6, 20], [10, 16], [24, 80]]) {
      await resize(rows, cols)
      const frame = liveFrame()
      expect(frame).toContain('输出')
      expectFits(frame, rows, cols)
    }
  })

  it('授权选项优先保留，工具和辅助面板让出高度', async () => {
    const { handlers, liveFrame, view } = await startRun(8, 24, true)
    handlers.onEvent!({
      ...eventContext, type: 'tool_start', id: 'tool', name: 'run_command', summary: 'TOOL 等待授权',
    })
    const decision = handlers.requestPermission({
      toolName: 'run_command', title: 'PERMISSION', preview: 'PREVIEW', ruleKey: 'Bash(test)',
    })
    await tick()
    const frame = liveFrame(`╰${'─'.repeat(22)}╯\n\n`)
    expect(frame).toContain('1. 允许一次')
    expect(frame).toContain('2. 总是允许')
    expect(frame).toContain('3. 拒绝')
    expectFits(frame, 8, 24)
    view.stdin.write('n')
    await expect(decision).resolves.toBe('deny')
  })

  it('完成后正文仅提交一次，保留合法重复行，思考预览不进入历史', async () => {
    const { handlers, view, liveFrame } = await startRun(8, 24, true)
    emitDelta(handlers, 'reasoning_delta', '不应写入历史的思考段落'.repeat(20))
    await tick()
    const parts = ['alpha\n', 'echo\n', 'echo\n', 'tail-END']
    for (const part of parts) {
      emitDelta(handlers, 'text_delta', part)
      await tick()
    }
    const done = {
      ...eventContext, type: 'assistant_message' as const,
      message: { role: 'assistant' as const, content: parts.join('') },
    }
    handlers.onEvent!(done)
    await tick()
    handlers.onEvent!(done)
    finishRun?.()
    finishRun = undefined
    await tick()
    const frame = stripVTControlCharacters(view.lastFrame() ?? '')
    expect(frame.match(/已思考/g)).toHaveLength(1)
    expect(frame.match(/alpha/g)).toHaveLength(1)
    expect(frame.match(/echo/g)).toHaveLength(2)
    expect(frame.match(/tail-END/g)).toHaveLength(1)
    expect(frame).not.toContain('不应写入历史')
    expectFits(liveFrame('tail-END\n\n'), 8, 24)
  })
})
