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
    listRecentWorkspaces: () => transport.invoke(CHANNELS.listRecentWorkspaces) as ReturnType<DesktopApi['listRecentWorkspaces']>,
    openRecentWorkspace: (id) => transport.invoke(CHANNELS.openRecentWorkspace, id) as ReturnType<DesktopApi['openRecentWorkspace']>,
    listFiles: (path) => transport.invoke(CHANNELS.listFiles, path) as ReturnType<DesktopApi['listFiles']>,
    readFile: (path) => transport.invoke(CHANNELS.readFile, path) as ReturnType<DesktopApi['readFile']>,
    watchWorkspace: (enabled) => transport.invoke(CHANNELS.watchWorkspace, enabled) as ReturnType<DesktopApi['watchWorkspace']>,
    gitStatus: () => transport.invoke(CHANNELS.gitStatus) as ReturnType<DesktopApi['gitStatus']>,
    gitDiff: (path, staged) => transport.invoke(CHANNELS.gitDiff, path, staged) as ReturnType<DesktopApi['gitDiff']>,
    gitStage: (path, staged) => transport.invoke(CHANNELS.gitStage, path, staged) as ReturnType<DesktopApi['gitStage']>,
    gitDiscard: (path) => transport.invoke(CHANNELS.gitDiscard, path) as ReturnType<DesktopApi['gitDiscard']>,
    gitStageAll: (staged) => transport.invoke(CHANNELS.gitStageAll, staged) as ReturnType<DesktopApi['gitStageAll']>,
    gitCommit: (message, revision) => transport.invoke(CHANNELS.gitCommit, message, revision) as ReturnType<DesktopApi['gitCommit']>,
    gitHistory: () => transport.invoke(CHANNELS.gitHistory) as ReturnType<DesktopApi['gitHistory']>,
    gitCommitDiff: (hash) => transport.invoke(CHANNELS.gitCommitDiff, hash) as ReturnType<DesktopApi['gitCommitDiff']>,
    getSessionHistory: (id) => transport.invoke(CHANNELS.getSessionHistory, id) as ReturnType<DesktopApi['getSessionHistory']>,
    openSession: (id) => transport.invoke(CHANNELS.openSession, id) as ReturnType<DesktopApi['openSession']>,
    listSessions: (archived) => transport.invoke(CHANNELS.listSessions, archived) as ReturnType<DesktopApi['listSessions']>,
    updateSession: (id, patch) => transport.invoke(CHANNELS.updateSession, id, patch) as ReturnType<DesktopApi['updateSession']>,
    deleteSession: (id) => transport.invoke(CHANNELS.deleteSession, id) as ReturnType<DesktopApi['deleteSession']>,
    getUsage: (id) => transport.invoke(CHANNELS.getUsage, id) as ReturnType<DesktopApi['getUsage']>,
    listReviews: (sessionId) => transport.invoke(CHANNELS.listReviews, sessionId) as ReturnType<DesktopApi['listReviews']>,
    getReview: (sessionId, checkpointId) => transport.invoke(CHANNELS.getReview, sessionId, checkpointId) as ReturnType<DesktopApi['getReview']>,
    revertReview: (sessionId, checkpointId, revision, hunkIndex) => transport.invoke(CHANNELS.revertReview, sessionId, checkpointId, revision, hunkIndex) as ReturnType<DesktopApi['revertReview']>,
    undoReview: (sessionId, checkpointId) => transport.invoke(CHANNELS.undoReview, sessionId, checkpointId) as ReturnType<DesktopApi['undoReview']>,
    getSettings: () => transport.invoke(CHANNELS.getSettings) as ReturnType<DesktopApi['getSettings']>,
    updateSettings: (patch) => transport.invoke(CHANNELS.updateSettings, patch) as ReturnType<DesktopApi['updateSettings']>,
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
