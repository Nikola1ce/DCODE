// 复用内核会话快照，展示字段单独保存，删除使用原生确认与回收站。
// 制作人：Moriarty_Dox
import { lstat, opendir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigDir } from '../../../src/config.js'
import { loadSessionSnapshot, SessionRecorder } from '../../../src/core/session.js'
import type { SessionSnapshot } from '../../../src/core/session.js'
import { samePath } from '../workspaceAccess.js'
import { DesktopFault } from '../errors.js'
import { sessionId } from './validation.js'
import { presentationPatch, SettingsService } from './settings.js'
import { sessionToolCalls } from '../../../src/core/sessionHistory.js'
import type { HistoryCursor, HistoryMessage, SessionHistory, SessionListing, SessionPresentation } from '../../shared/services.js'

export class SessionService {
  private cachedHistory?: { path: string; mtime: number; size: number; cwd: string; rows: HistoryMessage[] }

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

  async list(cwd: string, archived: boolean, query = ''): Promise<SessionListing> {
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
        const title = presentation.title ?? snapshot.messages.find(message => message.role === 'user' && message.content)?.content.slice(0, 80) ?? '新会话'
        const needle = query.trim().toLocaleLowerCase()
        const match = needle && snapshot.messages.findLast(message =>
          (message.role === 'user' || message.role === 'assistant') && message.content?.toLocaleLowerCase().includes(needle))
        if (needle && !title.toLocaleLowerCase().includes(needle) && !match) continue
        const offset = match ? match.content.toLocaleLowerCase().indexOf(needle) : 0
        result.sessions.push({
          ...(match && { match: { id: match.id, snippet: match.content.slice(Math.max(0, offset - 24), offset + 100) } }),
          ...presentation, id, createdAt: snapshot.meta.createdAt, updatedAt: mtime,
          title,
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

  async fork(cwd: string, id: string, messageId: string): Promise<string> {
    await this.snapshot(cwd, id)
    return new SessionRecorder(id).fork(messageId).id
  }

  private async historyRows(cwd: string, id: string): Promise<HistoryMessage[]> {
    const file = await this.file(id)
    const cached = this.cachedHistory
    if (cached && samePath(cached.cwd, cwd) && cached.path === file.path && cached.mtime === file.mtime && cached.size === file.size) return cached.rows
    const snapshot = await this.snapshot(cwd, id)
    const rows: HistoryMessage[] = []
    const progress = new Map<string, string[]>()
    for (const event of snapshot.events) {
      if (event.type !== 'tool_progress') continue
      const key = JSON.stringify([event.turnId, event.id])
      const chunks = progress.get(key) ?? []
      chunks.push(event.text)
      progress.set(key, chunks)
    }
    const toolNames = new Map<string, string>()
    for (const message of snapshot.messages) {
      if (message.role === 'system') continue
      const calls = sessionToolCalls(message)
      for (const call of calls) toolNames.set(call.id, call.name)
      const output = message.role === 'tool' ? progress.get(JSON.stringify([message.turnId, message.toolCallId]))?.join('') : undefined
      const text = [...(output ? ['运行输出\n' + output, '工具结果'] : []), message.content, ...calls.map(call => call.name + '\n' + call.argsJson)].filter(Boolean).join('\n\n')
      const tool = message.role === 'tool' ? message.toolName || toolNames.get(message.toolCallId ?? '') || '工具' : calls.length ? '工具调用' : undefined
      // 单个持久化消息也能跨页，每片保留原始偏移，避免切开代理对。
      let offset = 0
      do {
        let end = Math.min(text.length, offset + 16_384)
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
        rows.push({ id: message.id, role: message.role, offset, text: text.slice(offset, end),
          continued: offset > 0 || end < text.length, tool, failed: message.isError })
        offset = end
      } while (offset < text.length)
    }
    this.cachedHistory = { ...file, cwd, rows }
    return rows
  }

  async history(cwd: string, id: string, target?: string | HistoryCursor, query = ''): Promise<SessionHistory> {
    const rows = await this.historyRows(cwd, id)
    let start = rows.length
    let end = rows.length
    let forward = false
    let hitOffset = -1
    if (typeof target === 'string') {
      const first = rows.findIndex(row => row.id === target && row.role !== 'tool')
      if (first < 0) throw new DesktopFault('CONFLICT', '目标消息已变化，请重新搜索。')
      let last = first + 1
      while (last < rows.length && rows[last].id === target) last++
      hitOffset = rows.slice(first, last).map(row => row.text).join('').toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
      start = first
      while (start + 1 < last && rows[start + 1].offset <= hitOffset) start++
      end = start
      forward = true
    } else if (target) {
      const index = rows.findIndex(row => row.id === target.id && row.offset === target.offset)
      if (index < 0) throw new DesktopFault('CONFLICT', '会话历史已变化，请返回最新对话。')
      forward = target.direction === 'after'
      start = end = forward ? index : index + 1
    }
    let chars = 0
    while (end - start < 40 && (forward ? end < rows.length : start > 0)) {
      const row = rows[forward ? end : start - 1]
      if (chars + row.text.length > 96 * 1024) break
      chars += row.text.length
      if (forward) end++
      else start--
    }
    const cursor = (row: HistoryMessage, direction: HistoryCursor['direction']): HistoryCursor => ({ id: row.id, offset: row.offset, direction })
    const messages = rows.slice(start, end).map(row => {
      if (row.id !== target || hitOffset < 0 || !query) return row
      const left = Math.max(0, hitOffset - row.offset)
      const right = Math.min(row.text.length, hitOffset + query.length - row.offset)
      return right > left ? { ...row, highlight: [left, right] as [number, number] } : row
    })
    return { messages, truncated: start > 0 || end < rows.length,
      ...(start > 0 && { before: cursor(rows[start - 1], 'before') }),
      ...(end < rows.length && { after: cursor(rows[end], 'after') }) }
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
