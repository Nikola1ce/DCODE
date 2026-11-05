// 有界目录/文本预览与防抖监听，复用内核忽略规则和路径边界。
// 制作人：Moriarty_Dox
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { createIgnoreFilter } from '../../../src/core/ignore.js'
import { resolveWithinCwd } from '../../../src/tools/util.js'
import { DesktopFault } from '../errors.js'
import { samePath } from '../workspaceAccess.js'
import { relativePath } from './validation.js'
import type { FileListing, FilePreview } from '../../shared/services.js'

const MAX_PREVIEW_BYTES = 256 * 1024
const MAX_DIRECTORY_ENTRIES = 2000

/** 缺失末段供 Git 删除项使用，已有路径各段禁止符号链接与 junction。 */
export async function workspacePath(cwd: string, input: string, allowMissing = false): Promise<string> {
  const path = relativePath(input, true)
  if (!samePath(await realpath(cwd), cwd)) throw new DesktopFault('WORKSPACE_CHANGED', '工作区路径已变化，请重新选择目录。')
  let current = cwd
  for (const part of path.split('/').filter(Boolean)) {
    current = join(current, part)
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new DesktopFault('FORBIDDEN', '请直接访问工作区内的普通文件或目录。')
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  try {
    const resolved = resolveWithinCwd(cwd, path || '.')
    if (!samePath(resolved, join(cwd, path))) throw new Error('path changed')
    return resolved
  } catch {
    throw new DesktopFault('FORBIDDEN', '该路径超出已授权工作区。')
  }
}

export class WorkspaceService {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  async list(cwd: string, path: string): Promise<FileListing> {
    const directory = await workspacePath(cwd, path)
    const filter = createIgnoreFilter(cwd)
    const entries: FileListing['entries'] = []
    let truncated = false
    const handle = await opendir(directory)
    for await (const entry of handle) {
      const child = path ? `${path}/${entry.name}` : entry.name
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())
        || entry.name.toLowerCase() === '.git' || filter.ignores(child, entry.isDirectory())) continue
      if (entries.length === MAX_DIRECTORY_ENTRIES) { truncated = true; break }
      entries.push({ name: entry.name, path: child, kind: entry.isDirectory() ? 'directory' : 'file' })
    }
    entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
    return { entries, truncated }
  }

  async read(cwd: string, path: string): Promise<FilePreview> {
    const target = await workspacePath(cwd, relativePath(path))
    if (!(await lstat(target)).isFile()) throw new DesktopFault('INVALID_ARGUMENT', '请选择普通文件。')
    const file = await open(target, 'r')
    try {
      await workspacePath(cwd, path)
      const stat = await file.stat()
      if (!stat.isFile()) throw new DesktopFault('INVALID_ARGUMENT', '请选择普通文件。')
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES + 1))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const bytes = buffer.subarray(0, Math.min(bytesRead, MAX_PREVIEW_BYTES))
      if (bytes.includes(0)) return { kind: 'binary', path, size: stat.size }
      const truncated = stat.size > MAX_PREVIEW_BYTES || bytesRead > MAX_PREVIEW_BYTES
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
        return { kind: 'text', path, size: stat.size, text, truncated }
      } catch {
        return { kind: 'binary', path, size: stat.size }
      }
    } finally { await file.close() }
  }

  startWatch(cwd: string, changed: () => void, failed: () => void): void {
    this.dispose()
    const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
      const path = filename?.toString().replaceAll('\\', '/')
      if (path && createIgnoreFilter(cwd).ignores(path)) return
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => { this.timer = null; changed() }, 150)
    })
    this.watcher = watcher
    watcher.on('error', () => {
      if (this.watcher !== watcher) return
      this.dispose()
      failed()
    })
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
