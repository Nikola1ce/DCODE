// 后台记录在管理器内原地更新，面板轮询仍须正确刷新。
// 制作人：Moriarty_Dox
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'ink-testing-library'
import { shellManager, type ShellRecord } from '../core/shellManager.js'
import { BackgroundShellPanel } from './BackgroundShellPanel.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('后台面板轮询', () => {
  it('同一记录原地完成后从运行中切换为完成', async () => {
    vi.useFakeTimers()
    const record: ShellRecord = { id: 'job', command: '测试', cwd: process.cwd(), status: 'running', output: '', exitCode: null, createdAt: Date.now() }
    vi.spyOn(shellManager, 'getAllShells').mockImplementation(() => [record])
    const view = render(React.createElement(BackgroundShellPanel, { compact: true }))
    await vi.advanceTimersByTimeAsync(50)
    expect(view.lastFrame()).toContain('1 运行中')
    record.status = 'completed'
    record.exitCode = 0
    record.endedAt = Date.now()
    record.output = '已完成'
    await vi.advanceTimersByTimeAsync(1600)
    expect(view.lastFrame()).toContain('0 运行中')
  })
})
