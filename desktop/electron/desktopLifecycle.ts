// 系统通知、防休眠与托盘状态协调；只在执行回合期间持有电源阻止器。
// 制作人：Moriarty_Dox
import type { ConnectionPhase, DesktopEvent } from '../shared/api.js'
import type { DesktopPreferences } from '../shared/services.js'

export interface LifecycleHost {
  focused(): boolean
  notify(title: string, body: string): void
  startPowerBlocker(): number
  stopPowerBlocker(id: number): void
  status(phase: ConnectionPhase): void
}

export class DesktopLifecycle {
  private phase: ConnectionPhase = 'disconnected'
  private blocker: number | null = null
  private permissions = new Set<string>()
  private completed = new Set<string>()
  private disposed = false
  constructor(private preferences: DesktopPreferences, private readonly host: LifecycleHost) {}

  update(preferences: DesktopPreferences) { if (this.disposed) return; this.preferences = preferences; this.syncPower() }

  handle(event: DesktopEvent): void {
    if (this.disposed) return
    if (event.type === 'connection') {
      this.phase = event.snapshot.phase
      this.syncPower()
      this.host.status(this.phase)
      const next = new Set(event.snapshot.permissions.map((card) => card.permissionId))
      if ([...next].some((id) => !this.permissions.has(id)) && this.preferences.notifyPermission) {
        this.notify('DCODE 需要授权', '打开工作台查看并处理待审批操作。')
      }
      this.permissions = next
    }
    const done = event.type === 'stream' && (event.message.type === 'turn_done' || event.message.type === 'turn_error')
    if (!done && event.type !== 'turn_interrupted') return
    const id = event.type === 'stream' ? event.message.requestId : event.type === 'turn_interrupted' ? event.requestId : ''
    if (this.completed.has(id)) return
    this.completed.add(id)
    if (this.completed.size > 50) this.completed.delete(this.completed.values().next().value!)
    const failed = event.type === 'turn_interrupted' || (event.type === 'stream' && event.message.type === 'turn_error')
    if (failed ? this.preferences.notifyError : this.preferences.notifyComplete) {
      this.notify(failed ? 'DCODE 回合中断' : 'DCODE 回合结束', '打开工作台查看执行结果。')
    }
  }

  private notify(title: string, body: string) {
    if (this.preferences.notifications && !this.host.focused()) this.host.notify(title, body)
  }
  private syncPower() {
    const needed = this.preferences.preventSleep && ['running', 'cancelling'].includes(this.phase)
    if (needed && this.blocker === null) this.blocker = this.host.startPowerBlocker()
    if (!needed && this.blocker !== null) { this.host.stopPowerBlocker(this.blocker); this.blocker = null }
  }
  dispose() {
    this.disposed = true
    if (this.blocker !== null) this.host.stopPowerBlocker(this.blocker)
    this.blocker = null
    this.permissions.clear()
    this.completed.clear()
  }
}
