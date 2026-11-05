// 桌面独有设置与会话展示元信息，串行合并、写前备份、原子替换。
// 制作人：Moriarty_Dox
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DesktopFault } from '../errors.js'
import { boolean, invalid, record, sessionId } from './validation.js'
import type { DesktopPreferences, RecentWorkspace, SessionPresentation } from '../../shared/services.js'
import { samePath } from '../workspaceAccess.js'

const DEFAULTS: DesktopPreferences = { theme: 'system', sendKey: 'enter', notifications: true, preventSleep: true }
interface SettingsData {
  version: number
  preferences?: Record<string, unknown>
  sessions?: Record<string, SessionPresentation>
  [key: string]: unknown
}

export function preferencePatch(value: unknown): Partial<DesktopPreferences> {
  const patch = record(value, Object.keys(DEFAULTS))
  if ('theme' in patch && !['system', 'light', 'dark'].includes(patch.theme as string)) invalid()
  if ('sendKey' in patch && !['enter', 'mod-enter'].includes(patch.sendKey as string)) invalid()
  for (const key of ['notifications', 'preventSleep']) if (key in patch) boolean(patch[key])
  return patch
}

export function presentationPatch(value: unknown): SessionPresentation {
  const patch = record(value, ['title', 'pinned', 'archived'])
  if ('title' in patch && (typeof patch.title !== 'string' || !patch.title.trim() || patch.title.length > 200)) invalid()
  for (const key of ['pinned', 'archived']) if (key in patch) boolean(patch[key])
  return patch
}

export class SettingsService {
  private pending: Promise<unknown> = Promise.resolve()
  readonly path: string

  constructor(private readonly directory: string) { this.path = join(directory, 'desktop.json') }

  async flush(): Promise<void> { await this.pending }

  private async load(): Promise<SettingsData> {
    try {
      const info = await lstat(this.path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('settings file')
      const value = JSON.parse(await readFile(this.path, 'utf8')) as SettingsData
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) throw new Error('version')
      if (value.preferences !== undefined) {
        if (!value.preferences || typeof value.preferences !== 'object' || Array.isArray(value.preferences)) throw new Error('preferences')
        const known = Object.fromEntries(Object.keys(DEFAULTS).filter((key) => key in value.preferences!).map((key) => [key, value.preferences![key]]))
        preferencePatch(known)
      }
      if (value.sessions !== undefined && (!value.sessions || typeof value.sessions !== 'object' || Array.isArray(value.sessions))) throw new Error('sessions')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }
      throw new DesktopFault('SETTINGS_INVALID', '桌面设置无法读取，请检查 desktop.json 或其备份。')
    }
  }

  async get(): Promise<DesktopPreferences> {
    await this.pending
    const data = await this.load()
    return Object.fromEntries(Object.entries(DEFAULTS).map(([key, fallback]) => [key, data.preferences?.[key] ?? fallback])) as unknown as DesktopPreferences
  }

  async presentations(): Promise<Record<string, SessionPresentation>> {
    await this.pending
    return (await this.load()).sessions ?? {}
  }

  private recentEntries(data: SettingsData): RecentWorkspace[] {
    if (!Array.isArray(data.recentWorkspaces)) return []
    return data.recentWorkspaces.filter((entry): entry is RecentWorkspace => !!entry && typeof entry === 'object'
      && typeof entry.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)
      && typeof entry.path === 'string' && isAbsolute(entry.path) && entry.path.length <= 4096
      && typeof entry.openedAt === 'number' && Number.isFinite(entry.openedAt)).slice(0, 12)
      .map(({ id, path, openedAt }) => ({ id, path, openedAt }))
  }

  async recentWorkspaces(): Promise<RecentWorkspace[]> {
    await this.pending
    return this.recentEntries(await this.load())
  }

  async rememberWorkspace(path: string): Promise<void> {
    if (!isAbsolute(path)) invalid()
    await this.change((data) => {
      const recent = this.recentEntries(data)
      const previous = recent.find((entry) => samePath(entry.path, path))
      data.recentWorkspaces = [{ id: previous?.id ?? randomUUID(), path, openedAt: Date.now() }, ...recent.filter((entry) => !samePath(entry.path, path))].slice(0, 12)
    })
  }

  async update(value: unknown): Promise<DesktopPreferences> {
    const patch = preferencePatch(value)
    await this.change((data) => { data.preferences = { ...data.preferences, ...patch } })
    return this.get()
  }

  async updateSession(id: string, value: unknown): Promise<void> {
    sessionId(id)
    const patch = presentationPatch(value)
    await this.change((data) => {
      data.sessions = { ...data.sessions, [id]: { ...data.sessions?.[id], ...patch } }
    })
  }

  private change(mutate: (data: SettingsData) => void): Promise<void> {
    const operation = this.pending.then(async () => {
      const data = await this.load()
      mutate(data)
      const text = JSON.stringify(data, null, 2) + '\n'
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new DesktopFault('FILE_TOO_LARGE', '桌面设置已达到 4 MiB 上限。')
      await mkdir(this.directory, { recursive: true })
      const previous = await readFile(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (previous) await this.replace(`${this.path}.bak`, previous)
      await this.replace(this.path, text)
    })
    this.pending = operation.catch(() => {})
    return operation
  }

  private async replace(path: string, content: string | Buffer): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(content); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => {}) }
  }
}
