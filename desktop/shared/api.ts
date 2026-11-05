// 主进程、隔离 preload 与渲染进程之间的最小桌面契约；协议仅作类型引用。
// 制作人：Moriarty_Dox
import type {
  IdePermissionMode,
  ServerMessage,
  ServerPermissionRequestMessage,
  ServerReadyMessage,
} from '../../src/ide/protocol.js'
import type { ServicesApi } from './services.js'

export type ConnectionPhase =
  | 'disconnected' | 'starting' | 'ready' | 'running' | 'cancelling'
  | 'stopping' | 'idle' | 'recovering' | 'failed'

export type DesktopErrorCode =
  | 'INVALID_ARGUMENT' | 'FORBIDDEN' | 'BUSY' | 'NO_WORKSPACE'
  | 'INVALID_WORKSPACE' | 'WORKSPACE_CHANGED' | 'CORE_NOT_FOUND'
  | 'CORE_START_FAILED' | 'CORE_EXITED' | 'CORE_IO_ERROR' | 'CORE_STILL_RUNNING'
  | 'READY_TIMEOUT' | 'CANCEL_TIMEOUT' | 'SHUTDOWN_TIMEOUT' | 'CONNECTION_CLOSED'
  | 'FRAME_TOO_LARGE' | 'INVALID_FRAME' | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_PROTOCOL' | 'UNSUPPORTED_CAPABILITY' | 'PROTOCOL_V4_LIMITED'
  | 'IDENTITY_MISMATCH' | 'UNSAFE_PERMISSION_MODE' | 'NOT_READY'
  | 'API_KEY_REQUIRED' | 'PERMISSION_NOT_PENDING' | 'INTERNAL_ERROR'
  | 'GIT_UNAVAILABLE' | 'GIT_FAILED' | 'NOT_GIT_REPOSITORY' | 'CONFLICT'
  | 'FILE_TOO_LARGE' | 'SETTINGS_INVALID'

export interface DesktopError {
  code: DesktopErrorCode
  message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: DesktopError }
export type PermissionChoice = 'allow_once' | 'deny'
export type PermissionCard = Pick<ServerPermissionRequestMessage, 'requestId' | 'permissionId'> & {
  request: Pick<ServerPermissionRequestMessage['request'], 'toolName' | 'title' | 'preview'>
}

type MessageOf<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>
export type StreamMessage =
  | Pick<MessageOf<'text'>, 'type' | 'requestId' | 'delta'>
  | Pick<MessageOf<'reasoning'>, 'type' | 'requestId' | 'delta'>
  | Pick<MessageOf<'tool_start'>, 'type' | 'requestId' | 'toolCallId' | 'name' | 'summary'>
  | Pick<MessageOf<'tool_progress'>, 'type' | 'requestId' | 'toolCallId' | 'text'>
  | Pick<MessageOf<'tool_end'>, 'type' | 'requestId' | 'toolCallId' | 'name' | 'isError' | 'summary'>
  | Pick<MessageOf<'turn_done'>, 'type' | 'requestId' | 'reason' | 'costUsd'>
  | Pick<MessageOf<'turn_error'>, 'type' | 'requestId' | 'message'>

export interface ConnectionSnapshot {
  phase: ConnectionPhase
  cwd: string | null
  model: string | null
  provider: string | null
  sessionId: ServerReadyMessage['sessionId']
  protocolVersion: number | null
  permissionMode: IdePermissionMode | null
  hasApiKey: boolean
  capabilities: string[]
  compatibilityWarning: DesktopError | null
  activeRequestId: string | null
  permissions: PermissionCard[]
  error: DesktopError | null
}

export type DesktopEvent =
  | { type: 'workspace_changed' | 'workspace_watch_error'; cwd: string }
  | { type: 'connection'; snapshot: ConnectionSnapshot }
  | { type: 'turn_started'; requestId: string; text: string }
  | { type: 'stream'; message: StreamMessage }
  | { type: 'turn_interrupted'; requestId: string; error: DesktopError }

/** 服务路径绑定原生授权工作区，配置只投影白名单展示字段与密钥存在状态。 */
export interface DesktopApi extends ServicesApi {
  getSnapshot(): Promise<Result<ConnectionSnapshot>>
  chooseWorkspace(): Promise<Result<ConnectionSnapshot | null>>
  reconnect(): Promise<Result<ConnectionSnapshot>>
  sendPrompt(text: string): Promise<Result<{ requestId: string }>>
  cancelTurn(): Promise<Result<void>>
  respondPermission(permissionId: string, decision: PermissionChoice): Promise<Result<void>>
  subscribe(listener: (event: DesktopEvent) => void): () => void
}

export const EMPTY_SNAPSHOT: ConnectionSnapshot = {
  phase: 'disconnected', cwd: null, model: null, provider: null, sessionId: null,
  protocolVersion: null, permissionMode: null, hasApiKey: false, capabilities: [],
  compatibilityWarning: null, activeRequestId: null, permissions: [], error: null,
}

export const MAX_PROMPT_BYTES = 64 * 1024
