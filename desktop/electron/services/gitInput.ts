// Git 操作参数白名单，分支和远程必须再与当前仓库的实际记录核对。
// 制作人：Moriarty_Dox
import type { GitBranchInput, GitRemoteInput } from '../../shared/services.js'
import { invalid, record } from './validation.js'

function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /^[\s-]/.test(value) || /[\x00-\x20\x7f]/.test(value)) invalid()
  return value
}
function revision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid()
  return value
}
export function gitBranchInput(value: unknown): GitBranchInput {
  const input = record(value, ['action', 'name', 'revision', 'newName', 'startPoint'])
  if (typeof input.action !== 'string' || !['switch', 'create', 'rename', 'delete'].includes(input.action)) invalid()
  if ((input.action === 'rename') !== (input.newName !== undefined)) invalid()
  if (input.startPoint !== undefined && input.action !== 'create') invalid()
  return {
    action: input.action as GitBranchInput['action'], name: name(input.name), revision: revision(input.revision),
    ...(input.newName !== undefined ? { newName: name(input.newName) } : {}),
    ...(input.startPoint !== undefined ? { startPoint: name(input.startPoint) } : {}),
  }
}
export function gitRemoteInput(value: unknown): GitRemoteInput {
  const input = record(value, ['action', 'remote', 'revision'])
  if (typeof input.action !== 'string' || !['fetch', 'pull', 'push'].includes(input.action)) invalid()
  return { action: input.action as GitRemoteInput['action'], remote: name(input.remote), revision: revision(input.revision) }
}
