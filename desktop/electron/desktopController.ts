// 单窗口工作区控制器：目录仅来自原生选择，切换串行化，先退出旧内核再连接新内核。
// 制作人：Moriarty_Dox
import type { AgentConnection } from './agentConnection.js'
import type { ConnectionSnapshot, DesktopEvent, PermissionChoice } from '../shared/api.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'
import { DesktopFault } from './errors.js'
import { WorkspaceAuthority } from './workspaceAccess.js'
import type { WorkspaceGrant } from './workspaceAccess.js'

export type ConnectionPort = Pick<AgentConnection,
  'start' | 'shutdown' | 'getSnapshot' | 'subscribe' | 'sendPrompt' | 'cancelTurn' | 'respondPermission'
>

export class DesktopController {
  private grant: WorkspaceGrant | null = null
  private connection: ConnectionPort | null = null
  private unsubscribe: (() => void) | null = null
  private readonly listeners = new Set<(event: DesktopEvent) => void>()
  private changing = false
  private disposed = false

  constructor(private readonly dependencies: {
    authority: WorkspaceAuthority
    chooseDirectory(): Promise<string | null>
    createConnection(grant: WorkspaceGrant): Promise<ConnectionPort>
  }) {}

  getSnapshot(): ConnectionSnapshot {
    return this.connection?.getSnapshot() ?? { ...EMPTY_SNAPSHOT, capabilities: [], permissions: [] }
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  chooseWorkspace(): Promise<ConnectionSnapshot | null> {
    return this.exclusive(async () => {
      const selected = await this.dependencies.chooseDirectory()
      if (selected === null || this.disposed) return null
      const grant = await this.dependencies.authority.authorizeDialogSelection(selected)
      try {
        const connection = await this.dependencies.createConnection(grant)
        await this.connection?.shutdown()
        await this.dependencies.authority.validate(grant)
        if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
        this.unsubscribe?.()
        if (this.grant) this.dependencies.authority.revoke(this.grant)
        this.grant = grant
        this.connection = connection
        this.unsubscribe = connection.subscribe((event) => {
          for (const listener of this.listeners) listener(event)
        })
        return await connection.start()
      } catch (error) {
        if (this.grant !== grant) this.dependencies.authority.revoke(grant)
        throw error
      }
    })
  }

  reconnect(): Promise<ConnectionSnapshot> {
    return this.exclusive(async () => {
      if (!this.grant || !this.connection) throw new DesktopFault('NO_WORKSPACE', '请先选择项目文件夹。')
      await this.dependencies.authority.validate(this.grant)
      await this.connection.shutdown()
      if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
      return this.connection.start()
    })
  }

  sendPrompt(text: string): { requestId: string } {
    if (this.changing || this.disposed) throw new DesktopFault('BUSY', '工作区正在切换，消息未发送。')
    return this.requiredConnection().sendPrompt(text)
  }

  cancelTurn(): Promise<void> {
    return this.requiredConnection().cancelTurn()
  }

  respondPermission(permissionId: string, decision: PermissionChoice): void {
    this.requiredConnection().respondPermission(permissionId, decision)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    try {
      await this.connection?.shutdown()
    } finally {
      this.unsubscribe?.()
      this.listeners.clear()
      this.dependencies.authority.clear()
    }
  }

  private requiredConnection(): ConnectionPort {
    if (!this.connection || this.disposed) throw new DesktopFault('NO_WORKSPACE', '请先连接项目。')
    return this.connection
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const phase = this.getSnapshot().phase
    if (this.changing || this.disposed || ['running', 'cancelling', 'starting', 'recovering', 'stopping'].includes(phase)) {
      throw new DesktopFault('BUSY', '请等待当前操作完成，或先停止当前回合。')
    }
    this.changing = true
    try {
      return await operation()
    } finally {
      this.changing = false
    }
  }
}
