// 原生目录选择授予的工作区能力；任何启动前重新验证 canonical 路径，renderer 无法自行构造授权。
// 制作人：Moriarty_Dox
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DesktopFault } from './errors.js'

export interface WorkspaceGrant {
  readonly id: string
  readonly cwd: string
}

interface DirectoryFs {
  realpath(path: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
}

export function samePath(a: string, b: string, platform = process.platform): boolean {
  const left = normalize(a)
  const right = normalize(b)
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export class WorkspaceAuthority {
  private readonly grants = new Map<string, WorkspaceGrant>()

  constructor(private readonly fs: DirectoryFs = {
    realpath,
    isDirectory: async (path) => (await stat(path)).isDirectory(),
  }) {}

  /** 只能由主进程原生对话框的结果调用；此方法不注册到 IPC。 */
  async authorizeDialogSelection(selected: string): Promise<WorkspaceGrant> {
    try {
      if (!isAbsolute(selected) || /[\x00-\x1f]/.test(selected)) throw new Error('path')
      const cwd = await this.fs.realpath(selected)
      if (!isAbsolute(cwd) || !await this.fs.isDirectory(cwd)) throw new Error('directory')
      const grant = Object.freeze({ id: randomUUID(), cwd })
      this.grants.set(grant.id, grant)
      return grant
    } catch {
      throw new DesktopFault('INVALID_WORKSPACE', '无法打开所选目录，请选择可访问的本地项目文件夹。')
    }
  }

  async validate(grant: WorkspaceGrant): Promise<void> {
    if (this.grants.get(grant.id) !== grant) {
      throw new DesktopFault('FORBIDDEN', '该工作区未通过原生目录选择授权。')
    }
    try {
      const actual = await this.fs.realpath(grant.cwd)
      if (!samePath(actual, grant.cwd) || !await this.fs.isDirectory(actual)) throw new Error('changed')
    } catch {
      throw new DesktopFault('WORKSPACE_CHANGED', '所选工作区已移除或路径发生变化，请重新选择目录。')
    }
  }

  revoke(grant: WorkspaceGrant): void {
    this.grants.delete(grant.id)
  }

  clear(): void {
    this.grants.clear()
  }
}
