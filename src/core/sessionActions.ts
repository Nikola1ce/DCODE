// 会话级回退协调：先校验消息边界与文件检查点，再执行可审计的状态变更。
// 不自动撤销 shell、Git 或外部服务的副作用；文件冲突时拒绝覆盖。
// 制作人：Moriarty_Dox

import { resolve } from 'node:path'
import { listCheckpointSummaries, undoSessionCheckpoints } from './checkpoint.js'
import { rewindSessionHistory, type SessionRecorder, type SessionSnapshot } from './session.js'

export type RewindMode = 'messages' | 'files' | 'both'

export interface SessionRewindResult {
  sessionId: string
  mode: RewindMode
  removedMessages: number
  restoredFiles: string[]
  warning: string
}

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'notebook_edit'])

/** 以 user 消息之前或 assistant 完整工具链之后为边界；分叉后的会话不继承父检查点。 */
export function rewindSession(
  recorder: SessionRecorder,
  cwd: string,
  messageId: string,
  mode: RewindMode,
): { result: SessionRewindResult; snapshot: SessionSnapshot } {
  if (!['messages', 'files', 'both'].includes(mode)) throw new Error('无效回退模式。')
  const before = recorder.snapshot()
  const retained = rewindSessionHistory(before.messages, messageId)
  const removed = before.messages.slice(retained.length)
  let restoredFiles: string[] = []

  if (mode !== 'messages' && removed.length > 0) {
    const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
    if (pathKey(before.meta.cwd) !== pathKey(cwd)) throw new Error('会话工作目录与当前项目不同，不能回退文件。')
    if (removed.some((message) => message.role !== 'system' && !message.turnId)) {
      throw new Error('这段旧历史没有轮次身份，无法安全关联文件检查点；可选择仅回退消息。')
    }
    const turnIds = new Set(removed.map((message) => message.turnId).filter(Boolean))
    const checkpoints = listCheckpointSummaries(cwd, recorder.id).filter((checkpoint) => turnIds.has(checkpoint.turnId))
    const toolCallIds = new Set(checkpoints.map((checkpoint) => checkpoint.toolCallId))
    // 已清理、手动回退或从父会话复制的工具调用不能伪装为“文件也回退成功”。
    const missing = removed.filter((message) => message.role === 'tool' && !message.isError && FILE_TOOLS.has(message.toolName ?? '') && !toolCallIds.has(message.toolCallId))
    if (missing.length > 0) throw new Error('部分文件检查点已回退、过期或不属于当前会话；可选择仅回退消息。')
    if (checkpoints.length > 0) {
      const undone = undoSessionCheckpoints(cwd, checkpoints.map((checkpoint) => checkpoint.id), recorder.id)
      if (!undone.ok) {
        const partial = undone.count > 0 ? `已有 ${undone.count} 个检查点回退；消息尚未改动。` : '消息和未回退文件保持不变。'
        throw new Error(`${partial}${undone.errors.join('；')}`)
      }
      restoredFiles = [...new Set([...undone.restored, ...undone.deleted])]
    }
  }

  let snapshot = before
  if (mode !== 'files') {
    try {
      snapshot = recorder.rewind(messageId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (restoredFiles.length) throw new Error(`文件已回退，但会话历史保存失败；请重新加载历史并选择仅回退消息。${detail}`)
      throw error
    }
  }
  return {
    snapshot,
    result: {
      sessionId: recorder.id,
      mode,
      removedMessages: mode === 'files' ? 0 : before.messages.length - snapshot.messages.length,
      restoredFiles,
      warning: '仅回退检查点跟踪的文件写入；命令、Git、依赖安装和外部服务的副作用不会自动撤销。',
    },
  }
}
