// 主进程 IPC 白名单：校验顶层页面身份、参数类型/数量/大小，统一返回安全错误码。
// 制作人：Moriarty_Dox
import type { DesktopController } from './desktopController.js'
import type { Result } from '../shared/api.js'
import { MAX_PROMPT_BYTES } from '../shared/api.js'
import { CHANNELS } from '../shared/channels.js'
import { DesktopFault, publicError } from './errors.js'
import type { IpcRequest } from './windowSecurity.js'
import type { DesktopServices } from './services/index.js'
import { boolean, invalid, record, relativePath, sessionId } from './services/validation.js'
import { preferencePatch, presentationPatch } from './services/settings.js'
import { modelSettingsInput } from './services/configuration.js'
import { gitBranchInput, gitRemoteInput } from './services/gitInput.js'

export type IpcHandler = (event: IpcRequest, ...args: unknown[]) => Promise<Result<unknown>>
export interface IpcRouter {
  handle(channel: string, handler: IpcHandler): void
  removeHandler(channel: string): void
}
export type IpcController = Pick<DesktopController,
  'getSnapshot' | 'chooseWorkspace' | 'reconnect' | 'sendPrompt' | 'cancelTurn' | 'respondPermission'
>

function searchText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200) invalid()
  return value
}

function count(args: unknown[], size: number): void {
  if (args.length !== size) throw new DesktopFault('INVALID_ARGUMENT', 'IPC 参数数量不正确。')
}

export function installIpcRoutes(router: IpcRouter, controller: IpcController,
  trusted: (event: IpcRequest) => boolean, services?: DesktopServices): () => void {
  const routes: Record<string, (...args: unknown[]) => unknown> = {
    [CHANNELS.snapshot]: (...args) => { count(args, 0); return controller.getSnapshot() },
    [CHANNELS.chooseWorkspace]: (...args) => { count(args, 0); return controller.chooseWorkspace() },
    [CHANNELS.reconnect]: (...args) => { count(args, 0); return controller.reconnect() },
    [CHANNELS.cancel]: (...args) => { count(args, 0); return controller.cancelTurn() },
    [CHANNELS.prompt]: (...args) => {
      if (args.length < 1 || args.length > 3) invalid()
      const [text, follow, image] = args
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
        throw new DesktopFault('INVALID_ARGUMENT', '消息必须为非空字符串，UTF-8 长度上限 64 KiB。')
      }
      if (follow != null) {
        if (typeof follow !== 'object' || !('mode' in follow) || !('requestId' in follow)
          || (follow.mode !== 'queue' && follow.mode !== 'steer' && follow.mode !== 'withdraw') || typeof follow.requestId !== 'string'
          || !/^[a-zA-Z0-9_-]{1,128}$/.test(follow.requestId) || image !== undefined) invalid()
        return controller.sendPrompt(text, { mode: follow.mode, requestId: follow.requestId })
      }
      if (args.length === 3 && follow === null && typeof image === 'string' && image.length <= 720000 && /^data:image\/jpeg;base64,\/9j\/[a-zA-Z0-9+/]+=*$/.test(image)) {
        return controller.sendPrompt(text, undefined, image)
      }
      if (args.length !== 1) invalid()
      return controller.sendPrompt(text)
    },
    [CHANNELS.permission]: (...args) => {
      count(args, 2)
      const [permissionId, decision] = args
      if (typeof permissionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(permissionId)
        || (decision !== 'allow_once' && decision !== 'deny')) {
        throw new DesktopFault('INVALID_ARGUMENT', '权限响应仅接受 permissionId 与 allow_once/deny。')
      }
      return controller.respondPermission(permissionId, decision)
    },
  }
  if (services) Object.assign(routes, {
    [CHANNELS.getModelSettings]: (...args: unknown[]) => { count(args, 0); return services.getModelSettings() },
    [CHANNELS.validateModelSettings]: (...args: unknown[]) => { count(args, 1); return services.validateModelSettings(modelSettingsInput(args[0])) },
    [CHANNELS.saveModelSettings]: (...args: unknown[]) => { count(args, 1); return services.saveModelSettings(modelSettingsInput(args[0])) },
    [CHANNELS.searchFiles]: (...args: unknown[]) => {
      count(args, 1)
      if (typeof args[0] !== 'string' || args[0].length > 200 || /[\x00-\x1f]/.test(args[0])) invalid()
      return services.searchFiles(args[0])
    },
    [CHANNELS.listRecentWorkspaces]: (...args: unknown[]) => { count(args, 0); return services.listRecentWorkspaces() },
    [CHANNELS.openRecentWorkspace]: (...args: unknown[]) => { count(args, 1); return services.openRecentWorkspace(sessionId(args[0])) },
    [CHANNELS.listFiles]: (...args: unknown[]) => { count(args, 1); return services.listFiles(relativePath(args[0], true)) },
    [CHANNELS.readFile]: (...args: unknown[]) => { count(args, 1); return services.readFile(relativePath(args[0])) },
    [CHANNELS.watchWorkspace]: (...args: unknown[]) => { count(args, 1); return services.watchWorkspace(boolean(args[0])) },
    [CHANNELS.terminal]: (...args: unknown[]) => {
      count(args, 1)
      const input = record(args[0], ['type', 'id', 'data', 'session', 'cols', 'rows'])
      const id = sessionId(input.id)
      if (input.type === 'open') return services.terminal({ type: 'open', id, session: sessionId(input.session) })
      if (input.type === 'close') return services.terminal({ type: 'close', id })
      if (input.type === 'input' && typeof input.data === 'string' && input.data.length <= 65536) return services.terminal({ type: 'input', id, data: input.data })
      if (input.type === 'resize' && [input.cols, input.rows].every(v => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000)) {
        return services.terminal({ type: 'resize', id, cols: Number(input.cols), rows: Number(input.rows) })
      }
      invalid()
    },
    [CHANNELS.listWorktrees]: (...args: unknown[]) => { count(args, 0); return services.listWorktrees() },
    [CHANNELS.manageWorktree]: (...args: unknown[]) => {
      count(args, 1)
      const { id, revision, action, path } = record(args[0], ['id', 'revision', 'action', 'path'])
      if (typeof id !== 'string' || !/^task-[a-zA-Z0-9]{6}$/.test(id) || typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) invalid()
      if (action === 'ours' || action === 'theirs' || action === 'resolved' || action === 'preview') return services.manageWorktree({ id, revision, action, path: relativePath(path) })
      if (path !== undefined || (action !== 'open' && action !== 'sync' && action !== 'integrate' && action !== 'remove' && action !== 'abort' && action !== 'finish')) invalid()
      return services.manageWorktree({ id, revision, action })
    },
    [CHANNELS.openWorktree]: (...args: unknown[]) => { count(args, 0); return services.openWorktree() },
    [CHANNELS.gitStatus]: (...args: unknown[]) => { count(args, 0); return services.gitStatus() },
    [CHANNELS.gitBranches]: (...args: unknown[]) => { count(args, 0); return services.gitBranches() },
    [CHANNELS.gitBranch]: (...args: unknown[]) => { count(args, 1); return services.gitBranch(gitBranchInput(args[0])) },
    [CHANNELS.gitRemote]: (...args: unknown[]) => { count(args, 1); return services.gitRemote(gitRemoteInput(args[0])) },
    [CHANNELS.gitDiff]: (...args: unknown[]) => { count(args, 2); return services.gitDiff(relativePath(args[0]), boolean(args[1])) },
    [CHANNELS.gitStage]: (...args: unknown[]) => { count(args, 2); return services.gitStage(relativePath(args[0]), boolean(args[1])) },
    [CHANNELS.gitDiscard]: (...args: unknown[]) => { count(args, 1); return services.gitDiscard(relativePath(args[0])) },
    [CHANNELS.gitStageAll]: (...args: unknown[]) => { count(args, 1); return services.gitStageAll(boolean(args[0])) },
    [CHANNELS.gitHistory]: (...args: unknown[]) => { count(args, 0); return services.gitHistory() },
    [CHANNELS.gitCommitDiff]: (...args: unknown[]) => {
      count(args, 1)
      if (typeof args[0] !== 'string' || !/^[a-f0-9]{40,64}$/.test(args[0])) invalid()
      return services.gitCommitDiff(args[0])
    },
    [CHANNELS.gitCommit]: (...args: unknown[]) => {
      count(args, 2)
      const [message, revision] = args
      if (typeof message !== 'string' || !message.trim() || message.includes('\0') || Buffer.byteLength(message) > 16_384) invalid()
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) invalid()
      return services.gitCommit(message, revision)
    },
    [CHANNELS.forkSession]: (...args: unknown[]) => { count(args, 2); return services.forkSession(sessionId(args[0]), sessionId(args[1])) },
    [CHANNELS.getSessionHistory]: (...args: unknown[]) => { if (args.length === 2) {
      const cursor = record(args[1], ['direction', 'id', 'offset'])
      if ((cursor.direction !== 'before' && cursor.direction !== 'after') || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > 32 * 1024 * 1024) invalid()
      return services.getSessionHistory(sessionId(args[0]), { direction: cursor.direction, id: sessionId(cursor.id), offset: Number(cursor.offset) })
    }
    if (args.length === 3) return services.getSessionHistory(sessionId(args[0]), sessionId(args[1]), searchText(args[2])); count(args, 1); return services.getSessionHistory(sessionId(args[0])) },
    [CHANNELS.openSession]: (...args: unknown[]) => { count(args, 1); return services.openSession(args[0] === null ? null : sessionId(args[0])) },
    [CHANNELS.listSessions]: (...args: unknown[]) => { if (args.length === 2) return services.listSessions(boolean(args[0]), searchText(args[1])); count(args, 1); return services.listSessions(boolean(args[0])) },
    [CHANNELS.updateSession]: (...args: unknown[]) => { count(args, 2); return services.updateSession(sessionId(args[0]), presentationPatch(args[1])) },
    [CHANNELS.deleteSession]: (...args: unknown[]) => { count(args, 1); return services.deleteSession(sessionId(args[0])) },
    [CHANNELS.getUsage]: (...args: unknown[]) => { count(args, 1); return services.getUsage(sessionId(args[0])) },
    [CHANNELS.listReviews]: (...args: unknown[]) => { count(args, 1); return services.listReviews(sessionId(args[0])) },
    [CHANNELS.getReview]: (...args: unknown[]) => { count(args, 2); return services.getReview(sessionId(args[0]), sessionId(args[1])) },
    [CHANNELS.undoReview]: (...args: unknown[]) => { count(args, 2); return services.undoReview(sessionId(args[0]), sessionId(args[1])) },
    [CHANNELS.revertReview]: (...args: unknown[]) => {
      count(args, 4)
      const [session, checkpoint, revision, hunk] = args
      if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) invalid()
      if (hunk !== null && (typeof hunk !== 'number' || !Number.isSafeInteger(hunk) || hunk < 0 || hunk > 199)) invalid()
      return services.revertReview(sessionId(session), sessionId(checkpoint), revision, hunk)
    },
    [CHANNELS.getSettings]: (...args: unknown[]) => { count(args, 0); return services.getSettings() },
    [CHANNELS.updateSettings]: (...args: unknown[]) => { count(args, 1); return services.updateSettings(preferencePatch(args[0])) },
  })
  for (const [channel, operation] of Object.entries(routes)) {
    router.handle(channel, async (event, ...args) => {
      try {
        if (!trusted(event)) throw new DesktopFault('FORBIDDEN', '拒绝非授权窗口或子框架的 IPC 请求。')
        return { ok: true, value: await operation(...args) }
      } catch (error) {
        return { ok: false, error: publicError(error) }
      }
    })
  }
  return () => { for (const channel of Object.keys(routes)) router.removeHandler(channel) }
}
