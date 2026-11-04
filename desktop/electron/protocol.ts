// 桌面端安全协议投影：只复用内核类型，运行时不加载内核模块或配置。
// 制作人：Moriarty_Dox
import type {
  ServerReadyMessage,
  ServerStatusMessage,
} from '../../src/ide/protocol.js'
import type { DesktopError, PermissionCard, StreamMessage } from '../shared/api.js'
import { DesktopFault } from './errors.js'

export type ReadyInfo = Pick<ServerReadyMessage,
  'type' | 'protocolVersion' | 'version' | 'model' | 'provider' | 'permissionMode' | 'cwd' | 'hasApiKey' | 'sessionId'
> & { capabilities: string[] }
export type StatusInfo = Pick<ServerStatusMessage,
  'type' | 'model' | 'provider' | 'permissionMode' | 'sessionId'
>
export type DecodedMessage = ReadyInfo | StatusInfo | StreamMessage | (PermissionCard & { type: 'permission_request' })

function invalid(): never {
  throw new DesktopFault('INVALID_MESSAGE', '内核消息结构无效，连接已停止。')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}

function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) return invalid()
  return value
}

function id(value: unknown): string {
  const result = text(value, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) return invalid()
  return result
}

function session(value: unknown): string | null {
  return value === null ? null : id(value)
}

function toolId(value: unknown): string {
  const result = text(value, 256)
  if (!result || /[\x00-\x1f]/.test(result)) return invalid()
  return result
}

function mode(value: unknown): ReadyInfo['permissionMode'] {
  if (value !== 'default' && value !== 'acceptEdits' && value !== 'plan' && value !== 'bypass') return invalid()
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return invalid()
  return value
}

/** 能力声明可缺省；仅识别显式为 true 的标记或字符串列表，不推测未声明能力。 */
export function normalizeCapabilities(value: unknown): string[] {
  const candidates = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? Object.entries(value).filter(([, enabled]) => enabled === true).map(([name]) => name)
      : []
  return [...new Set(candidates.filter((name): name is string =>
    typeof name === 'string' && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(name),
  ))].slice(0, 64)
}

export function compatibilityWarning(version: number): DesktopError | null {
  return version === 4
    ? { code: 'PROTOCOL_V4_LIMITED', message: '当前内核为协议 v4，仅启用基础对话与审批；v5 高级能力尚不可用。' }
    : null
}

/** 后续功能调用前必须显式检查；v4 和未声明能力均产生稳定错误码。 */
export function requireCapability(version: number | null, capabilities: readonly string[], name: string): void {
  if (version !== 5 || !capabilities.includes(name)) {
    throw new DesktopFault('UNSUPPORTED_CAPABILITY', '当前内核未声明此能力，请升级内核后重试。')
  }
}

/** 未知扩展事件安全忽略；已使用的消息严格校验并重新构造，绝不直接透传对象。 */
export function decodeServerMessage(value: unknown): DecodedMessage | null {
  const msg = record(value)
  const type = text(msg.type, 80)
  switch (type) {
    case 'ready': {
      if (!Number.isSafeInteger(msg.protocolVersion)) return invalid()
      return {
        type, protocolVersion: msg.protocolVersion as number, version: text(msg.version, 100),
        model: text(msg.model, 200), provider: text(msg.provider, 100), permissionMode: mode(msg.permissionMode),
        cwd: text(msg.cwd, 32_768), hasApiKey: boolean(msg.hasApiKey), sessionId: session(msg.sessionId),
        capabilities: normalizeCapabilities(msg.capabilities),
      }
    }
    case 'status':
      return {
        type, model: text(msg.model, 200), provider: text(msg.provider, 100),
        permissionMode: mode(msg.permissionMode), sessionId: session(msg.sessionId),
      }
    case 'text':
    case 'reasoning':
      return { type, requestId: id(msg.requestId), delta: text(msg.delta, 1024 * 1024) }
    case 'tool_start':
      return {
        type, requestId: id(msg.requestId), toolCallId: toolId(msg.toolCallId),
        name: text(msg.name, 200), summary: text(msg.summary, 16_384),
      }
    case 'tool_progress':
      return { type, requestId: id(msg.requestId), toolCallId: toolId(msg.toolCallId), text: text(msg.text, 1024 * 1024) }
    case 'tool_end':
      return {
        type, requestId: id(msg.requestId), toolCallId: toolId(msg.toolCallId), name: text(msg.name, 200),
        isError: boolean(msg.isError), summary: msg.summary === undefined ? undefined : text(msg.summary, 16_384),
      }
    case 'permission_request': {
      const request = record(msg.request)
      return {
        type, requestId: id(msg.requestId), permissionId: id(msg.permissionId),
        request: {
          toolName: text(request.toolName, 200), title: text(request.title, 4096),
          preview: request.preview === undefined ? undefined : text(request.preview, 1024 * 1024).slice(0, 64 * 1024),
        },
      }
    }
    case 'turn_done': {
      if (msg.reason !== 'final' && msg.reason !== 'max_iterations' && msg.reason !== 'aborted') return invalid()
      if (typeof msg.costUsd !== 'number' || !Number.isFinite(msg.costUsd) || msg.costUsd < 0) return invalid()
      return { type, requestId: id(msg.requestId), reason: msg.reason, costUsd: msg.costUsd }
    }
    case 'turn_error':
      return { type, requestId: id(msg.requestId), message: text(msg.message, 64 * 1024) }
    default:
      // log / command_result / login_prompt / 任意未知扩展不会进入页面（可能含配置或端点）。
      return null
  }
}
