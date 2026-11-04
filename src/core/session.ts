// 会话持久化模块。
// 将每个会话以 JSONL（每行一个 JSON）形式保存到 ~/.dcode/sessions/<id>.jsonl，
// 支持：新建会话、追加消息、加载历史、列出最近会话、定位“最新会话”。
// 用于实现 dcode -c（继续上次会话）与 dcode -r（恢复指定会话）。
// 制作人：Moriarty_Dox

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigDir } from '../config.js'
import type { AgentRunEvent, DeepMessage } from './types.js'
import {
  forkSessionHistory,
  legacySessionMessageId,
  retainSessionEvents,
  rewindSessionHistory,
  sameSessionMessage,
  sessionToolCalls,
  truncateSessionHistory,
  withSessionMessageIds,
  type SessionHistoryMessage,
} from './sessionHistory.js'

export {
  assertSafeSessionHistory,
  forkSessionHistory,
  getSessionHistoryBoundary,
  rewindSessionHistory,
  truncateSessionHistory,
  withSessionMessageIds,
} from './sessionHistory.js'
export type { SessionHistoryMessage } from './sessionHistory.js'

// 会话文件头部的元信息（写入 JSONL 第一行）。
export interface SessionMeta {
  // 标记该行为元信息。
  type: 'meta'
  // 会话 id。
  id: string
  // 创建时间（ISO 字符串）。
  createdAt: string
  // 创建会话时的工作目录（用于 -c 时校验是否同一项目）。
  cwd: string
  // 创建时使用的模型。
  model: string
  // fork 的直接来源与实际保留边界；不代表继承源会话的文件检查点所有权。
  parentSessionId?: string
  parentMessageId?: string
}

/** 可安全交给调用方修改的会话副本；读取会修复中断的工具结果，写操作则严格校验原始边界。 */
export interface SessionSnapshot {
  sessionId: string
  meta: SessionMeta
  messages: SessionHistoryMessage[]
  events: AgentRunEvent[]
}

interface SessionState {
  meta?: SessionMeta
  messages: SessionHistoryMessage[]
  events: AgentRunEvent[]
}

// 会话文件中的消息行。
interface MessageLine {
  // 标记该行为消息。
  type: 'message'
  // 消息内容。
  message: DeepMessage
}

// 会话文件中的 Agent 运行事件行。旧版读取逻辑会自然忽略该类型。
interface EventLine {
  type: 'event'
  version: 1
  event: AgentRunEvent
}

// 上下文替换通过快照追加，保留旧日志用于排查，同时让恢复遵循最新状态。
interface SnapshotLine {
  type: 'snapshot'
  messages: DeepMessage[]
}

/**
 * 计算会话目录路径（~/.dcode/sessions），不存在则创建。
 * @returns 会话目录绝对路径。
 */
function getSessionsDir(): string {
  const dir = join(getConfigDir(), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 计算指定会话的文件路径。
 * @param id 会话 id。
 * @returns 会话 JSONL 文件绝对路径。
 */
function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)
}

/** 会话文件路径；仅接受安全的单段 id，防止路径穿越与保留设备名。 */
export function getSessionPath(id: string): string {
  if (!isValidSessionId(id)) throw new Error('无效的会话 ID。')
  return join(getSessionsDir(), `${id}.jsonl`)
}

// 临时文件与目标在同一目录，fsync 后一次 rename 发布；失败不能破坏旧会话。
function writeSessionAtomic(path: string, lines: (SessionMeta | MessageLine | EventLine | SnapshotLine)[], createOnly = false): void {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporaryPath, 'wx', 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    if (createOnly && existsSync(path)) throw new Error('会话 ID 已存在，不能覆盖已有会话。')
    renameSync(temporaryPath, path)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function sessionLines(meta: SessionMeta, messages: DeepMessage[], events: AgentRunEvent[]): (SessionMeta | SnapshotLine | EventLine)[] {
  return [meta, { type: 'snapshot', messages }, ...events.map((event): EventLine => ({ type: 'event', version: 1, event }))]
}

/**
 * 会话记录器：封装单个会话文件的写入操作。
 * 通过实例方法追加消息，避免上层关心文件细节。
 */
export class SessionRecorder {
  // 当前会话 id。
  readonly id: string
  // 当前会话文件路径。
  private path: string
  // 是否禁用持久化（无头一次性任务可关闭）。
  private disabled: boolean
  private appendBoundaryChecked = false

  /**
   * 构造函数。
   * @param id 会话 id。
   * @param disabled 是否禁用写盘。
   */
  constructor(id: string, disabled = false) {
    this.id = id
    this.path = getSessionPath(id)
    this.disabled = disabled
  }

  /**
   * 创建新会话并写入元信息头。
   * @param cwd 工作目录。
   * @param model 模型名。
   * @param disabled 是否禁用持久化。
   * @returns 新建的记录器实例。
   */
  static create(cwd: string, model: string, disabled = false): SessionRecorder {
    const id = randomUUID()
    const rec = new SessionRecorder(id, disabled)
    if (!disabled) {
      const meta: SessionMeta = {
        type: 'meta',
        id,
        createdAt: new Date().toISOString(),
        cwd,
        model,
      }
      writeSessionAtomic(rec.path, [meta], true)
    }
    return rec
  }

  /**
   * 向会话文件追加一条消息。
   * @param message 要追加的消息。
   */
  append(message: DeepMessage): void {
    // 新消息使用新身份，避免 rewind 后重用被删除消息的旧序号；不改写调用方对象。
    this.appendLine({ type: 'message', message: { ...message, id: message.id || randomUUID() } })
  }

  /**
   * 向会话文件追加一条结构化运行事件。
   * @param event AgentRunner 产出的事件。
   */
  appendEvent(event: AgentRunEvent): void {
    this.appendLine({ type: 'event', version: 1, event })
  }

  /** 追加当前有效上下文快照；恢复时替换之前的消息，随后追加的新消息仍保留。 */
  replaceMessages(messages: DeepMessage[]): void {
    if (this.disabled) return
    // 兼容旧调用方传入无 ID 的快照，保留能够匹配的旧消息身份。
    const previous = this.getHistory()
    const identified = identifySnapshotMessages(this.id, messages, previous)
    this.appendLine({ type: 'snapshot', messages: identified })
  }

  /** 获取当前历史的独立副本；与 CLI 加载一样会修复崩溃留下的缺失工具结果。 */
  getHistory(): SessionHistoryMessage[] {
    return loadSessionMessages(this.id)
  }

  /** 获取消息、事件与元信息；不存在或缺少合法元信息时抛错。 */
  snapshot(): SessionSnapshot {
    return loadSessionSnapshot(this.id)
  }

  /** 精确保留前 messageCount 条持久化消息（包含摘要/system）；边界不完整时不写盘。 */
  truncate(messageCount: number): SessionSnapshot {
    return this.rewriteHistory((messages) => truncateSessionHistory(messages, messageCount))
  }

  /** user 从目标前回退；assistant 保留至其连续工具链的最终回答，tool/system 不可作为目标。 */
  rewind(messageId: string): SessionSnapshot {
    return this.rewriteHistory((messages) => rewindSessionHistory(messages, messageId))
  }

  /**
   * fork 包含目标 user；assistant 延伸至完整工具链结尾；省略目标则复制全部安全历史。
   * 返回新记录器。parentMessageId 指向实际保留的最后消息，不复制任何检查点文件或所有权。
   */
  fork(messageId?: string): SessionRecorder {
    this.assertWritable()
    const state = requireSessionState(this.id, this.path)
    const messages = forkSessionHistory(state.messages, messageId)
    const events = retainSessionEvents(state.events, state.messages, messages)
    const rec = new SessionRecorder(randomUUID())
    const meta: SessionMeta = {
      type: 'meta',
      id: rec.id,
      createdAt: new Date().toISOString(),
      cwd: state.meta.cwd,
      model: state.meta.model,
      parentSessionId: this.id,
      ...(messages.length > 0 ? { parentMessageId: messages[messages.length - 1].id } : {}),
    }
    // 元信息只复制 cwd/model，不能把源会话的未来扩展字段（如检查点所有者）带入分支。
    writeSessionAtomic(rec.path, sessionLines(meta, messages, events), true)
    rec.appendBoundaryChecked = true
    return rec
  }

  private assertWritable(): void {
    if (this.disabled) throw new Error('会话持久化已禁用，不能改写或派生会话。')
  }

  private rewriteHistory(select: (messages: SessionHistoryMessage[]) => SessionHistoryMessage[]): SessionSnapshot {
    this.assertWritable()
    const state = requireSessionState(this.id, this.path)
    const messages = select(state.messages)
    const events = retainSessionEvents(state.events, state.messages, messages)
    writeSessionAtomic(this.path, sessionLines(state.meta, messages, events))
    this.appendBoundaryChecked = true
    return makeSessionSnapshot(this.id, { meta: state.meta, messages, events })
  }

  private appendLine(line: MessageLine | EventLine | SnapshotLine): void {
    if (this.disabled) return
    try {
      let separator = ''
      if (!this.appendBoundaryChecked && existsSync(this.path)) {
        const size = statSync(this.path).size
        if (size > 0) {
          const fd = openSync(this.path, 'r')
          try {
            const lastByte = Buffer.alloc(1)
            readSync(fd, lastByte, 0, 1, size - 1)
            if (lastByte[0] !== 10) separator = '\n'
          } finally {
            closeSync(fd)
          }
        }
      }
      // 崩溃可能留下半条 JSON；先补分隔符，避免下一条完整消息被粘进坏行。
      appendFileSync(this.path, separator + JSON.stringify(line) + '\n', 'utf8')
      this.appendBoundaryChecked = true
    } catch {
      // 写盘失败不应影响主流程。
    }
  }
}

/**
 * 加载指定会话的全部消息。
 * @param id 会话 id。
 * @returns 消息数组；文件不存在或损坏时返回空数组。
 */
export function loadSessionMessages(id: string): SessionHistoryMessage[] {
  const path = getSessionPath(id)
  if (!existsSync(path)) return []
  try {
    const state = readSessionState(readFileSync(path, 'utf8'), id)
    return withSessionMessageIds(id, repairInterruptedToolResults(state.messages))
  } catch {
    return []
  }
}

/** 加载严格的会话快照；与兼容 CLI 的 loadSessionMessages 不同，读盘/元信息错误会抛出。 */
export function loadSessionSnapshot(id: string): SessionSnapshot {
  return makeSessionSnapshot(id, requireSessionState(id, getSessionPath(id)))
}

/** 加载会话中保留的运行事件；文件不存在时返回空数组，损坏时抛出以免静默丢失审阅记录。 */
export function loadSessionEvents(id: string): AgentRunEvent[] {
  return requireSessionState(id, getSessionPath(id)).events
}

function requireSessionState(id: string, path: string): SessionState & { meta: SessionMeta } {
  if (!existsSync(path)) throw new Error(`会话不存在：${id}`)
  const state = readSessionState(readFileSync(path, 'utf8'), id)
  if (!state.meta) throw new Error('会话缺少合法元信息，不能安全改写或派生。')
  return { ...state, meta: state.meta }
}

function makeSessionSnapshot(id: string, state: SessionState & { meta: SessionMeta }): SessionSnapshot {
  return {
    sessionId: id,
    meta: structuredClone(state.meta),
    messages: withSessionMessageIds(id, repairInterruptedToolResults(state.messages)),
    events: structuredClone(state.events),
  }
}

export function repairInterruptedToolResults(messages: DeepMessage[]): DeepMessage[] {
  const out: DeepMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    // 工具结果必须紧随发起它的 assistant；孤立/重复结果不能发回 API。
    if (m.role === 'tool') continue
    out.push(m)
    const calls = sessionToolCalls(m)
    if (calls.length === 0) continue
    const pending = new Map(calls.map((call) => [call.id, call]))
    while (messages[i + 1]?.role === 'tool') {
      const result = messages[++i]
      if (!result.toolCallId || !pending.delete(result.toolCallId)) continue
      out.push(result)
    }
    for (const call of pending.values()) {
      out.push({
        role: 'tool',
        content: '上次工具执行中断，请检查当前工作区状态后再继续。',
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        ...(m.id ? { id: legacySessionMessageId(`${m.id}:tool:${call.id}`, 0) } : {}),
        ...(m.runId ? { runId: m.runId } : {}),
        ...(m.turnId ? { turnId: m.turnId } : {}),
        ...(m.timestamp !== undefined ? { timestamp: m.timestamp } : {}),
        metadata: { kind: 'synthetic_error', source: 'system' },
      })
    }
  }
  return out.length === messages.length && out.every((m, i) => m === messages[i]) ? messages : out
}

function isMessage(value: unknown): value is DeepMessage {
  if (!value || typeof value !== 'object') return false
  const m = value as DeepMessage
  return ['system', 'user', 'assistant', 'tool'].includes(m.role)
    && typeof m.content === 'string'
    && (m.toolCalls === undefined || (Array.isArray(m.toolCalls) && m.toolCalls.every((call) =>
      call && typeof call.id === 'string' && typeof call.name === 'string' && typeof call.argsJson === 'string')))
}

function identifySnapshotMessages(
  sessionId: string,
  messages: readonly DeepMessage[],
  previous: readonly SessionHistoryMessage[],
  startOrdinal?: number,
): SessionHistoryMessage[] {
  const candidates = [...previous]
  const identified = messages.map((message) => {
    const index = candidates.findIndex((candidate) => sameSessionMessage(message, candidate))
    const prior = index < 0 ? undefined : candidates.splice(index, 1)[0]
    return {
      ...message,
      ...(prior?.runId && !message.runId ? { runId: prior.runId } : {}),
      ...(prior?.turnId && !message.turnId ? { turnId: prior.turnId } : {}),
      id: message.id || prior?.id || (startOrdinal === undefined ? randomUUID() : undefined),
    }
  })
  return withSessionMessageIds(sessionId, identified, startOrdinal)
}

function isEvent(value: unknown): value is AgentRunEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as AgentRunEvent
  return typeof event.type === 'string' && typeof event.runId === 'string' && typeof event.turnId === 'string'
    && typeof event.timestamp === 'number'
    && (!('message' in event) || isMessage(event.message))
}

function readSessionState(text: string, sessionId: string): SessionState {
  let meta: SessionMeta | undefined
  let messages: SessionHistoryMessage[] = []
  const events: AgentRunEvent[] = []
  let activeRun: { runId: string; turnId: string } | undefined
  let ordinal = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      if (obj?.type === 'meta' && obj.id === sessionId && typeof obj.cwd === 'string'
        && typeof obj.createdAt === 'string') {
        meta = { ...obj, model: typeof obj.model === 'string' ? obj.model : '' }
      } else if (obj?.type === 'message' && isMessage(obj.message)) {
        // 旧日志已记录 run/turn 事件，但消息自身没有关联字段；只在明确的运行区间内回填。
        const message = {
          ...obj.message,
          ...(activeRun && !obj.message.runId ? { runId: activeRun.runId } : {}),
          ...(activeRun && !obj.message.turnId ? { turnId: activeRun.turnId } : {}),
        }
        messages.push(...withSessionMessageIds(sessionId, [message], ordinal++))
      } else if (obj?.type === 'snapshot' && Array.isArray(obj.messages) && obj.messages.every(isMessage)) {
        messages = identifySnapshotMessages(sessionId, obj.messages, messages, ordinal)
        ordinal += obj.messages.length
      } else if (obj?.type === 'event' && isEvent(obj.event)) {
        events.push(obj.event)
        activeRun = obj.event.type === 'run_end' ? undefined : { runId: obj.event.runId, turnId: obj.event.turnId }
      }
    } catch {
      // 单条日志损坏不应吞掉后续有效消息，也不应让整个会话从恢复列表消失。
    }
  }
  return { meta, messages, events }
}

// 会话摘要信息（用于 /resume 列表展示）。
export interface SessionSummary {
  // 会话 id。
  id: string
  // 创建时间。
  createdAt: string
  // 工作目录。
  cwd: string
  // 文件最后修改时间（ms），用于排序。
  mtime: number
  // 首条用户消息（作为标题预览）。
  firstUserText: string
  // 消息条数。
  messageCount: number
}

/**
 * 列出所有会话的摘要，按最近修改时间倒序。
 * @param limit 最多返回条数，默认 20。
 * @returns 会话摘要数组。
 */
export function listSessions(limit = 20): SessionSummary[] {
  const dir = getSessionsDir()
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  const summaries: SessionSummary[] = []

  for (const file of files) {
    const path = join(dir, file)
    try {
      const mtime = statSync(path).mtimeMs
      const id = file.slice(0, -'.jsonl'.length)
      if (!isValidSessionId(id)) continue
      const { meta, messages } = readSessionState(readFileSync(path, 'utf8'), id)
      if (!meta) continue
      const firstUserText = messages.find((m) => m.role === 'user' && m.content)?.content.slice(0, 60) ?? '(无内容)'
      const messageCount = messages.length

      summaries.push({
        id: meta.id,
        createdAt: meta.createdAt,
        cwd: meta.cwd,
        mtime,
        firstUserText,
        messageCount,
      })
    } catch {
      // 跳过损坏的会话文件。
    }
  }

  summaries.sort((a, b) => b.mtime - a.mtime)
  return summaries.slice(0, limit)
}

/**
 * 获取在指定工作目录下“最近”的一个会话 id（供 dcode -c 使用）。
 * @param cwd 工作目录。
 * @returns 会话 id；没有则返回 null。
 */
export function getLatestSessionId(cwd: string): string | null {
  const sessions = listSessions(Number.POSITIVE_INFINITY)
  const normalizeCwd = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  const normalizedCwd = normalizeCwd(cwd)
  // 仅匹配同一工作目录的会话；无匹配时不应回退到其他项目的会话。
  const sameCwd = sessions.find((s) => normalizeCwd(s.cwd) === normalizedCwd)
  return sameCwd?.id ?? null
}
