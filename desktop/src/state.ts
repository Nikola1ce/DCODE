// 最小流式对话状态；有界保留窗口当前消息，不实现历史/分叉/审阅功能。
// 制作人：Moriarty_Dox
import type { ConnectionSnapshot, DesktopEvent, StreamMessage } from '../shared/api.js'
import { EMPTY_SNAPSHOT } from '../shared/api.js'

export interface TurnView {
  requestId: string
  prompt: string
  text: string
  reasoning: string
  tools: { id: string; summary: string; failed: boolean }[]
  status: 'running' | 'done' | 'aborted' | 'error'
  error?: string
  costUsd?: number
}
export interface ChatState {
  snapshot: ConnectionSnapshot
  turns: TurnView[]
}
export const INITIAL_CHAT_STATE: ChatState = { snapshot: EMPTY_SNAPSHOT, turns: [] }

function updateTurn(turn: TurnView, message: StreamMessage): TurnView {
  switch (message.type) {
    case 'text': return { ...turn, text: (turn.text + message.delta).slice(0, 256 * 1024) }
    case 'reasoning': return { ...turn, reasoning: (turn.reasoning + message.delta).slice(0, 64 * 1024) }
    case 'tool_start': return {
      ...turn, tools: [...turn.tools, { id: message.toolCallId, summary: message.summary, failed: false }].slice(-20),
    }
    case 'tool_end': return {
      ...turn, tools: turn.tools.map((tool) => tool.id === message.toolCallId
        ? { ...tool, summary: message.summary ?? tool.summary, failed: message.isError } : tool),
    }
    case 'tool_progress': return turn
    case 'turn_done': return { ...turn, status: message.reason === 'aborted' ? 'aborted' : 'done', costUsd: message.costUsd }
    case 'turn_error': return { ...turn, status: 'error', error: message.message }
  }
}

export function reduceEvents(state: ChatState, events: readonly DesktopEvent[]): ChatState {
  let result = state
  for (const event of events) {
    if (event.type === 'connection') {
      const old = result.snapshot
      const next = event.snapshot
      const changed = old.cwd !== next.cwd || (old.sessionId && next.sessionId && old.sessionId !== next.sessionId)
      result = { snapshot: next, turns: changed ? [] : result.turns }
    } else if (event.type === 'turn_started') {
      result = { ...result, turns: [...result.turns, {
        requestId: event.requestId, prompt: event.text, text: '', reasoning: '', tools: [], status: 'running' as const,
      }].slice(-40) }
    } else if (event.type === 'turn_interrupted') {
      result = { ...result, turns: result.turns.map((turn) => turn.requestId === event.requestId
        ? { ...turn, status: 'error' as const, error: event.error.message } : turn) }
    } else {
      const message = event.message
      result = { ...result, turns: result.turns.map((turn) => turn.requestId === message.requestId
        ? updateTurn(turn, message) : turn) }
    }
  }
  return result
}
