// 系统生命周期使用端口替身，覆盖通知去重和电源阻止器释放。
// 制作人：Moriarty_Dox
import { describe, expect, it, vi } from 'vitest'
import { DesktopLifecycle } from './desktopLifecycle.js'
import { DEFAULT_PREFERENCES } from './services/settings.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'
import type { ConnectionPhase, DesktopEvent } from '../shared/api.js'

function fixture() {
  const host = { focused: vi.fn(() => false), notify: vi.fn(), startPowerBlocker: vi.fn(() => 0), stopPowerBlocker: vi.fn(), status: vi.fn() }
  const lifecycle = new DesktopLifecycle({ ...DEFAULT_PREFERENCES }, host)
  const phase = (value: ConnectionPhase) => lifecycle.handle({ type: 'connection', snapshot: { ...EMPTY_SNAPSHOT, phase: value } })
  return { host, lifecycle, phase }
}

describe('桌面系统生命周期', () => {
  it('执行与取消期间只申请一次防休眠，结束、关闭偏好及退出都释放', () => {
    const f = fixture()
    f.phase('running'); f.phase('running'); f.phase('cancelling')
    expect(f.host.startPowerBlocker).toHaveBeenCalledOnce()
    f.phase('ready')
    expect(f.host.stopPowerBlocker).toHaveBeenCalledWith(0)
    f.phase('running')
    f.lifecycle.update({ ...DEFAULT_PREFERENCES, preventSleep: false })
    expect(f.host.stopPowerBlocker).toHaveBeenCalledTimes(2)
    f.lifecycle.update({ ...DEFAULT_PREFERENCES })
    f.lifecycle.dispose(); f.phase('running'); f.lifecycle.update({ ...DEFAULT_PREFERENCES })
    expect(f.host.stopPowerBlocker).toHaveBeenCalledTimes(3)
    expect(f.host.startPowerBlocker).toHaveBeenCalledTimes(3)
  })

  it('后台审批只通知一次，完成与失败按请求去重且遵守分类开关', () => {
    const f = fixture()
    const permission: DesktopEvent = { type: 'connection', snapshot: { ...EMPTY_SNAPSHOT, permissions: [
      { permissionId: 'permission', requestId: 'request', request: { toolName: 'run_command', title: '执行命令', preview: 'secret-argument' } },
    ] } }
    f.lifecycle.handle(permission); f.lifecycle.handle(permission)
    expect(f.host.notify).toHaveBeenCalledTimes(1)
    const done: DesktopEvent = { type: 'stream', message: { type: 'turn_done', requestId: 'request', reason: 'final', costUsd: 0 } }
    f.lifecycle.handle(done); f.lifecycle.handle(done)
    expect(f.host.notify).toHaveBeenCalledTimes(2)
    f.lifecycle.update({ ...DEFAULT_PREFERENCES, notifyError: false })
    f.lifecycle.handle({ type: 'stream', message: { type: 'turn_error', requestId: 'request-2', message: 'secret-error' } })
    expect(f.host.notify).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(f.host.notify.mock.calls)).not.toContain('secret')
  })

  it('聚焦或关闭通知时静默，后台异常终止使用通用提示', () => {
    const f = fixture()
    const event = (id: string): DesktopEvent => ({ type: 'turn_interrupted', requestId: id, error: { code: 'CORE_EXITED', message: 'private-error' } })
    f.host.focused.mockReturnValue(true)
    f.lifecycle.handle(event('first'))
    f.host.focused.mockReturnValue(false)
    f.lifecycle.update({ ...DEFAULT_PREFERENCES, notifications: false })
    f.lifecycle.handle(event('second'))
    expect(f.host.notify).not.toHaveBeenCalled()
    f.lifecycle.update({ ...DEFAULT_PREFERENCES })
    f.lifecycle.handle(event('third'))
    expect(f.host.notify).toHaveBeenCalledWith('DCODE 回合中断', '打开工作台查看执行结果。')
  })
})
