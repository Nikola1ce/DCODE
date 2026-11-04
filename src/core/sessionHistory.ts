// 会话历史的纯函数：稳定消息身份、安全工具链边界和保留事件筛选。
// 不读写文件，也不操作检查点；供持久化层和无记录器的 Agent 复用。
// 制作人：Moriarty_Dox

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { AgentRunEvent, DeepMessage, ToolCall } from './types.js'

/** 已有持久化身份的会话消息。 */
export type SessionHistoryMessage = DeepMessage & { id: string }

/** 按会话和旧日志中的消息序号生成稳定 ID，不依赖时间或随机数。 */
export function legacySessionMessageId(sessionId: string, ordinal: number): string {
  return `msg_${createHash('sha256').update(JSON.stringify([sessionId, ordinal])).digest('hex').slice(0, 32)}`
}

/** 深复制历史并补齐旧消息 ID；已有 ID、Responses 输出与运行身份原样保留。 */
export function withSessionMessageIds(
  sessionId: string,
  messages: readonly DeepMessage[],
  startOrdinal = 0,
): SessionHistoryMessage[] {
  return messages.map((message, index) => ({
    ...structuredClone(message),
    id: typeof message.id === 'string' && message.id.length > 0
      ? message.id
      : legacySessionMessageId(sessionId, startOrdinal + index),
  }))
}

/** 比较消息正文，忽略旧日志可能缺少的身份字段。 */
export function sameSessionMessage(a: DeepMessage, b: DeepMessage): boolean {
  if (a.id && b.id) return a.id === b.id
  const payload = (message: DeepMessage) => Object.fromEntries(
    Object.entries(message).filter(([key, value]) => value !== undefined && !['id', 'runId', 'turnId'].includes(key)),
  )
  return isDeepStrictEqual(payload(a), payload(b))
}

/** Responses 的 function_call 也必须有结果，不能只检查 Chat Completions 的 toolCalls。 */
export function sessionToolCalls(message: DeepMessage): ToolCall[] {
  if (message.role !== 'assistant') return []
  const calls = new Map((message.toolCalls ?? []).map((call) => [call.id, call]))
  for (const item of message.responseOutput ?? []) {
    if (item.type === 'function_call' && !calls.has(item.call_id)) {
      calls.set(item.call_id, { id: item.call_id, name: item.name, argsJson: item.arguments })
    }
  }
  return [...calls.values()]
}

/** 校验完整前缀：tool 只能紧随所属调用批次，且每个调用必须恰好有一个结果。 */
export function assertSafeSessionHistory(messages: readonly DeepMessage[]): void {
  const pending = new Set<string>()
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.id) {
      if (ids.has(message.id)) throw new Error(`会话消息 ID 重复：${message.id}`)
      ids.add(message.id)
    }
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.delete(message.toolCallId)) {
        throw new Error('不安全的会话边界：存在孤立或重复的工具结果。')
      }
      continue
    }
    if (pending.size > 0) throw new Error('不安全的会话边界：工具调用尚未全部收到结果。')
    const declaredIds = message.toolCalls?.map((call) => call.id) ?? []
    const responseIds = (message.responseOutput ?? []).flatMap((item) => item.type === 'function_call' ? [item.call_id] : [])
    if (new Set(declaredIds).size !== declaredIds.length || new Set(responseIds).size !== responseIds.length) {
      throw new Error('不安全的会话边界：工具调用 ID 重复。')
    }
    for (const call of sessionToolCalls(message)) {
      if (!call.id) throw new Error('不安全的会话边界：工具调用缺少 ID。')
      pending.add(call.id)
    }
  }
  if (pending.size > 0) throw new Error('不安全的会话边界：工具调用尚未全部收到结果。')
}

/**
 * 计算保留的消息条数。
 * rewind user：删除该 user 及后文；fork user：保留该 user，以便重新生成回答。
 * assistant：保留该消息；若它发起工具调用，则延伸到连续工具链的最终 assistant 回答。
 * 缺少工具结果/最终回答、选择 tool/system、消息 ID 不唯一时均拒绝。
 */
export function getSessionHistoryBoundary(
  messages: readonly DeepMessage[],
  messageId: string,
  mode: 'rewind' | 'fork',
): number {
  if (typeof messageId !== 'string' || !messageId) throw new Error('必须指定消息 ID。')
  const matches = messages.flatMap((message, index) => message.id === messageId ? [index] : [])
  if (matches.length !== 1) throw new Error(matches.length ? '会话消息 ID 不唯一。' : '找不到指定的会话消息。')
  let index = matches[0]
  const target = messages[index]
  if (target.role === 'user') {
    const count = mode === 'rewind' ? index : index + 1
    assertSafeSessionHistory(messages.slice(0, count))
    return count
  }
  if (target.role !== 'assistant') throw new Error('请选择 user 或 assistant 消息，不能单独选择工具结果或系统消息。')

  while (sessionToolCalls(messages[index]).length > 0) {
    index++
    while (messages[index]?.role === 'tool') index++
    if (messages[index]?.role !== 'assistant') {
      throw new Error('不完整的工具链：必须保留到最终 assistant 回答，不能在工具链中间回退或派生。')
    }
  }
  assertSafeSessionHistory(messages.slice(0, index + 1))
  return index + 1
}

/** 精确保留前 messageCount 条消息；不自动修补或跨越不完整工具批次。 */
export function truncateSessionHistory<T extends DeepMessage>(messages: readonly T[], messageCount: number): T[] {
  if (!Number.isSafeInteger(messageCount) || messageCount < 0 || messageCount > messages.length) {
    throw new Error('无效的会话消息数量。')
  }
  const retained = messages.slice(0, messageCount)
  assertSafeSessionHistory(retained)
  return structuredClone(retained)
}

/** 按 rewind 的消息级语义返回独立副本，不修改传入历史。 */
export function rewindSessionHistory<T extends DeepMessage>(messages: readonly T[], messageId: string): T[] {
  return truncateSessionHistory(messages, getSessionHistoryBoundary(messages, messageId, 'rewind'))
}

/** 按 fork 的消息级语义返回独立副本；不指定消息则选择全部安全历史。 */
export function forkSessionHistory<T extends DeepMessage>(messages: readonly T[], messageId?: string): T[] {
  return truncateSessionHistory(messages, messageId === undefined
    ? messages.length
    : getSessionHistoryBoundary(messages, messageId, 'fork'))
}

/**
 * 保留完整留存 turn 的全部事件（包括 llm_done 用量和 run_end）。
 * 只留存 turn 的前半段时，以最后保留消息对应的事件为截止点，不能携带被删除回答的事件。
 */
export function retainSessionEvents(
  events: readonly AgentRunEvent[],
  previous: readonly DeepMessage[],
  retained: readonly DeepMessage[],
): AgentRunEvent[] {
  if (retained.length === 0) return []
  if (retained.length === previous.length) return structuredClone([...events])
  const belongsTo = (message: DeepMessage, event: AgentRunEvent) => message.turnId
    ? message.turnId === event.turnId && (!message.runId || message.runId === event.runId)
    : Boolean(message.runId && message.runId === event.runId)
  const groups = new Map<string, AgentRunEvent[]>()
  for (const event of events) {
    const key = JSON.stringify([event.runId, event.turnId])
    const group = groups.get(key) ?? []
    group.push(event)
    groups.set(key, group)
  }
  const keep = new Set<AgentRunEvent>()
  for (const group of groups.values()) {
    const originalTurn = previous.filter((message) => belongsTo(message, group[0]))
    const retainedTurn = retained.filter((message) => belongsTo(message, group[0]))
    // 压缩摘要仍代表已经压缩掉的旧 turns；不能因消息正文不再存在就丢弃其用量。
    if (originalTurn.length === 0 && retained.some((message) => message.metadata?.kind === 'summary')) {
      for (const event of group) keep.add(event)
      continue
    }
    if (retainedTurn.length === 0) continue
    if (retainedTurn.length === originalTurn.length) {
      for (const event of group) keep.add(event)
      continue
    }
    let cutoff = -1
    for (let index = 0; index < group.length; index++) {
      const event = group[index]
      if ('message' in event && retainedTurn.some((message) => sameSessionMessage(message, event.message))) {
        cutoff = index
      } else if (event.type === 'turn_start' && retainedTurn.some((message) => message.role === 'user'
        && (event.messageId ? event.messageId === message.id : event.userInput === message.content))) {
        cutoff = Math.max(cutoff, index)
      }
    }
    for (let index = 0; index <= cutoff; index++) keep.add(group[index])
  }
  return structuredClone(events.filter((event) => keep.has(event)))
}
