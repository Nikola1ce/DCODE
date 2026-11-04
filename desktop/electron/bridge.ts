// 最小 preload API 工厂：闭包绑定白名单通道，订阅去掉 Electron event 并可幂等退订。
// 制作人：Moriarty_Dox
import type { DesktopApi, DesktopEvent } from '../shared/api.js'
import { CHANNELS } from '../shared/channels.js'

type Listener = (event: unknown, payload: DesktopEvent) => void
export interface BridgeTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: Listener): unknown
  removeListener(channel: string, listener: Listener): unknown
}

export function createDesktopBridge(transport: BridgeTransport): Readonly<DesktopApi> {
  const api: DesktopApi = {
    getSnapshot: () => transport.invoke(CHANNELS.snapshot) as ReturnType<DesktopApi['getSnapshot']>,
    chooseWorkspace: () => transport.invoke(CHANNELS.chooseWorkspace) as ReturnType<DesktopApi['chooseWorkspace']>,
    reconnect: () => transport.invoke(CHANNELS.reconnect) as ReturnType<DesktopApi['reconnect']>,
    sendPrompt: (text) => transport.invoke(CHANNELS.prompt, text) as ReturnType<DesktopApi['sendPrompt']>,
    cancelTurn: () => transport.invoke(CHANNELS.cancel) as ReturnType<DesktopApi['cancelTurn']>,
    respondPermission: (permissionId, decision) => transport.invoke(CHANNELS.permission, permissionId, decision) as ReturnType<DesktopApi['respondPermission']>,
    subscribe: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function')
      let active = true
      const handler: Listener = (_event, payload) => { if (active) listener(payload) }
      transport.on(CHANNELS.event, handler)
      return () => {
        if (!active) return
        active = false
        transport.removeListener(CHANNELS.event, handler)
      }
    },
  }
  return Object.freeze(api)
}
