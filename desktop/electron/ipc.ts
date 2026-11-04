// 主进程 IPC 白名单：校验顶层页面身份、参数类型/数量/大小，统一返回安全错误码。
// 制作人：Moriarty_Dox
import type { DesktopController } from './desktopController.js'
import type { Result } from '../shared/api.js'
import { MAX_PROMPT_BYTES } from '../shared/api.js'
import { CHANNELS } from '../shared/channels.js'
import { DesktopFault, publicError } from './errors.js'
import type { IpcRequest } from './windowSecurity.js'

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
  trusted: (event: IpcRequest) => boolean): () => void {
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
