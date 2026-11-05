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
  private readonly serviceOperations = new Set<Promise<unknown>>()

  constructor(private readonly dependencies: {
    authority: WorkspaceAuthority
    chooseDirectory(defaultPath?: string): Promise<string | null>
    rememberWorkspace?(cwd: string): Promise<void>
    createConnection(grant: WorkspaceGrant, resumeId?: string): Promise<ConnectionPort>
  }) {}

  getSnapshot(): ConnectionSnapshot {
    return this.connection?.getSnapshot() ?? { ...EMPTY_SNAPSHOT, capabilities: [], permissions: [] }
  }

  subscribe(listener: (event: DesktopEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  chooseWorkspace(defaultPath?: string): Promise<ConnectionSnapshot | null> {
    return this.exclusive(async () => {
      const selected = await this.dependencies.chooseDirectory(defaultPath)
      if (selected === null || this.disposed) return null
      const grant = await this.dependencies.authority.authorizeDialogSelection(selected)
      try {
        await this.dependencies.rememberWorkspace?.(grant.cwd)
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

  configure<T>(save: () => Promise<T>): Promise<{ value: T; connectionError?: string }> {
    const operation = this.exclusive(async () => {
      await this.connection?.shutdown()
      if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
      let value: T
      try { value = await save() }
      catch (error) {
        if (!this.disposed) await this.connection?.start().catch(() => {})
        throw error
      }
      try {
        if (this.disposed) return { value, connectionError: '设置已保存，桌面正在关闭。' }
        if (this.grant) await this.dependencies.authority.validate(this.grant)
        await this.connection?.start()
        return { value }
      } catch { return { value, connectionError: '设置已保存，内核连接失败。请点击重新连接。' } }
    })
    this.serviceOperations.add(operation)
    return operation.finally(() => { this.serviceOperations.delete(operation) })
  }

  sendPrompt(text: string): { requestId: string } {
    if (this.changing || this.disposed) throw new DesktopFault('BUSY', '工作区操作正在进行，消息未发送。')
    return this.requiredConnection().sendPrompt(text)
  }

  /** 会话归属在独占区内重新核验，防止核验后切换到其他目录。 */
  openSession(id: string | null, validate: (cwd: string, id: string) => Promise<unknown>): Promise<void> {
    return this.exclusive(async () => {
      if (!this.grant) throw new DesktopFault('NO_WORKSPACE', '请先选择项目文件夹。')
      await this.dependencies.authority.validate(this.grant)
      if (id) await validate(this.grant.cwd, id)
      const connection = await this.dependencies.createConnection(this.grant, id ?? undefined)
      await this.connection?.shutdown()
      if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
      this.unsubscribe?.()
      this.connection = connection
      this.unsubscribe = connection.subscribe((event) => {
        for (const listener of this.listeners) listener(event)
      })
      await connection.start()
    })
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
      await Promise.allSettled([...this.serviceOperations])
      await this.connection?.shutdown()
    } finally {
      this.unsubscribe?.()
      this.listeners.clear()
      this.dependencies.authority.clear()
    }
  }

  /** 读服务可并行且允许回合运行，写服务与发消息、切换目录互斥。 */
  useWorkspace<T>(operation: (grant: WorkspaceGrant) => Promise<T>, mutate = false): Promise<T> {
    const execute = async () => {
      if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
      if (!this.grant) throw new DesktopFault('NO_WORKSPACE', '请先选择项目文件夹。')
      const grant = this.grant
      await this.dependencies.authority.validate(grant)
      return operation(grant)
    }
    if (this.changing || this.disposed) return Promise.reject(new DesktopFault('BUSY', '请等待当前工作区操作完成。'))
    const pending = mutate ? this.exclusive(execute) : execute()
    this.serviceOperations.add(pending)
    return pending.finally(() => { this.serviceOperations.delete(pending) })
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
      await Promise.allSettled([...this.serviceOperations])
      if (this.disposed) throw new DesktopFault('CONNECTION_CLOSED', '桌面正在关闭。')
      return await operation()
    } finally {
      this.changing = false
    }
  }
}
