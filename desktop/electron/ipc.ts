// 主进程 IPC 白名单：校验顶层页面身份、参数类型/数量/大小，统一返回安全错误码。
// 制作人：Moriarty_Dox
import type { DesktopController } from './desktopController.js'
import type { Result } from '../shared/api.js'
import { MAX_PROMPT_BYTES } from '../shared/api.js'
import { CHANNELS } from '../shared/channels.js'
import { DesktopFault, publicError } from './errors.js'
import type { IpcRequest } from './windowSecurity.js'
import type { DesktopServices } from './services/index.js'
import { boolean, invalid, relativePath, sessionId } from './services/validation.js'
import { preferencePatch, presentationPatch } from './services/settings.js'
import { modelSettingsInput } from './services/configuration.js'

export type IpcHandler = (event: IpcRequest, ...args: unknown[]) => Promise<Result<unknown>>
export interface IpcRouter {
  handle(channel: string, handler: IpcHandler): void
  removeHandler(channel: string): void
}
export type IpcController = Pick<DesktopController,
  'getSnapshot' | 'chooseWorkspace' | 'reconnect' | 'sendPrompt' | 'cancelTurn' | 'respondPermission'
>

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
      count(args, 1)
      const [text] = args
      if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > MAX_PROMPT_BYTES) {
        throw new DesktopFault('INVALID_ARGUMENT', '消息必须为非空字符串，UTF-8 长度上限 64 KiB。')
      }
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
    [CHANNELS.gitStatus]: (...args: unknown[]) => { count(args, 0); return services.gitStatus() },
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
    [CHANNELS.getSessionHistory]: (...args: unknown[]) => { count(args, 1); return services.getSessionHistory(sessionId(args[0])) },
    [CHANNELS.openSession]: (...args: unknown[]) => { count(args, 1); return services.openSession(args[0] === null ? null : sessionId(args[0])) },
    [CHANNELS.listSessions]: (...args: unknown[]) => { count(args, 1); return services.listSessions(boolean(args[0])) },
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
