// 复用内核会话快照，展示字段单独保存，删除使用原生确认与回收站。
// 制作人：Moriarty_Dox
import { lstat, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from '../../../src/config.js'
import { loadSessionSnapshot } from '../../../src/core/session.js'
import type { SessionSnapshot } from '../../../src/core/session.js'
import { samePath } from '../workspaceAccess.js'
import { DesktopFault } from '../errors.js'
import { sessionId } from './validation.js'
import { presentationPatch, SettingsService } from './settings.js'
import type { SessionHistory, SessionListing, SessionPresentation } from '../../shared/services.js'

export class SessionService {
  constructor(private readonly settings: SettingsService, private readonly dialogs: {
    confirm(title: string, detail: string): Promise<boolean>
    trash(path: string): Promise<void>
  }) {}

  private async file(id: string): Promise<{ path: string; mtime: number; size: number }> {
    sessionId(id)
    const directory = join(getConfigDir(), 'sessions')
    const path = join(directory, `${id}.jsonl`)
    const parent = await lstat(directory)
    const info = await lstat(path)
    if (parent.isSymbolicLink() || info.isSymbolicLink() || !info.isFile()) {
      throw new DesktopFault('FORBIDDEN', '会话必须存储在标准目录的普通文件中。')
    }
    if (info.size > 32 * 1024 * 1024) throw new DesktopFault('FILE_TOO_LARGE', '会话超过当前 32 MiB 读取上限。')
    return { path, mtime: info.mtimeMs, size: info.size }
  }

  async snapshot(cwd: string, id: string): Promise<SessionSnapshot> {
    await this.file(id)
    const snapshot = loadSessionSnapshot(id)
    const actual = await realpath(snapshot.meta.cwd)
    if (!samePath(actual, cwd)) throw new DesktopFault('FORBIDDEN', '会话属于其他工作区，请先授权对应目录。')
    return snapshot
  }

  async list(cwd: string, archived: boolean): Promise<SessionListing> {
    const presentations = await this.settings.presentations()
    const result: SessionListing = { sessions: [], skipped: 0, truncated: false }
    const directory = join(getConfigDir(), 'sessions')
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return result
    if (info.isSymbolicLink()) throw new DesktopFault('FORBIDDEN', '会话目录已被替换。')
    const handle = await opendir(directory)
    let scanned = 0
    for await (const entry of handle) {
      if (!entry.name.endsWith('.jsonl')) continue
      if (++scanned > 2000) { result.truncated = true; break }
      const id = entry.name.slice(0, -6)
      try {
        const snapshot = await this.snapshot(cwd, id)
        const { mtime } = await this.file(id)
        const presentation = presentationPatch(presentations[id] ?? {})
        if (Boolean(presentation.archived) !== archived) continue
        result.sessions.push({
          ...presentation, id, createdAt: snapshot.meta.createdAt, updatedAt: mtime,
          title: presentation.title ?? snapshot.messages.find((message) => message.role === 'user' && message.content)?.content.slice(0, 80) ?? '新会话',
          messageCount: snapshot.messages.filter((message) => message.role !== 'system').length,
        })
      } catch (error) {
        if (!(error instanceof DesktopFault && error.code === 'FORBIDDEN')) result.skipped++
      }
    }
    result.sessions.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
    return result
  }

  async update(cwd: string, id: string, patch: SessionPresentation): Promise<void> {
    await this.snapshot(cwd, id)
    await this.settings.updateSession(id, patch)
  }

  async history(cwd: string, id: string): Promise<SessionHistory> {
    const snapshot = await this.snapshot(cwd, id)
    const messages = snapshot.messages.filter((message) => message.role === 'user' || message.role === 'assistant')
    let remaining = 512 * 1024
    const result: SessionHistory = { messages: [], truncated: messages.length > 100 }
    // 从末尾保留最近内容，避免大型历史阻塞 IPC 与渲染。
    for (const message of messages.slice(-100).reverse()) {
      const content = message.content ?? ''
      const text = content.slice(0, Math.min(remaining, 64 * 1024))
      if (text.length < content.length) result.truncated = true
      result.messages.unshift({ id: message.id, role: message.role as 'user' | 'assistant', text })
      remaining -= text.length
      if (remaining <= 0) { result.truncated = true; break }
    }
    return result
  }

  async remove(cwd: string, id: string, activeId: string | null): Promise<boolean> {
    if (id === activeId) throw new DesktopFault('BUSY', '请先切换会话，再删除当前连接的会话。')
    await this.snapshot(cwd, id)
    const before = await this.file(id)
    if (!await this.dialogs.confirm('删除会话', '会话记录将移至系统回收站，可从回收站恢复。')) return false
    await this.snapshot(cwd, id)
    const after = await this.file(id)
    if (before.mtime !== after.mtime || before.size !== after.size) {
      throw new DesktopFault('CONFLICT', '确认期间会话有新内容，请刷新后重试。')
    }
    await this.dialogs.trash(after.path)
    return true
  }
}
