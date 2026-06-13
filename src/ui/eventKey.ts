// Agent 事件幂等去重键生成器。
// 同一轮 run 中每个 event 只应被处理一次。若 AgentRunner 内部发生重试/重连，
// 同一 event 会被重复 yield；本函数生成稳定 key 用于检测并跳过重复。
//
// 关键约束：
// - text_delta / reasoning_delta：每条 delta 是唯一的，不能去重！
//   因为同一个 iteration 内多个 delta 逐个追加，它们的 key 相同，去重会丢失数据。
//   chunk 级去重已在 streamDelta.ts 处理，delta 级去重会破坏正常流式输出。
// - tool_message / tool_start / tool_end：有唯一标识字段（toolCallId/id），
//   可以安全去重。
// - assistant_message：有 message.timestamp，可去重。
// - 其他事件类型（llm_start、compact_start 等）：每个 iteration 只出现一次，
//   但在同一 run 中不同 iteration 可能重复，可以用 iteration 辅助区分。
//
// 制作人：Moriarty_Dox

import type { AgentRunEvent } from '../core/types.js'

/**
 * 生成事件的幂等去重键。
 * 返回 null 表示该事件类型不需要或不应该去重（正常流式 delta 不去重）。
 * 返回字符串表示该事件有稳定唯一标识，可以去重。
 */
export function makeEventKey(ev: AgentRunEvent): string | null {
  const base = `${ev.runId}|${ev.turnId}`
  switch (ev.type) {
    case 'text_delta':
    case 'reasoning_delta':
      // 重要：delta 事件不能去重！
      // 每个 delta 都是流式序列中独一无二的内容，同一 iteration 内多个 delta
      // 逐个追加产生完整文本。如果按 iteration 去重，同 iteration 内只有第一个
      // delta 被处理，其余全部被跳过，导致输出不完整或缺失。
      // chunk 粒度的重复已在 streamDelta.ts 处理。
      return null

    case 'tool_message':
      return `${base}|tool_message|${ev.message?.toolCallId ?? ''}`

    case 'tool_start':
    case 'tool_end':
      return `${base}|${ev.type}|${ev.id}`

    case 'assistant_message':
      return `${base}|assistant_message|${ev.message?.timestamp ?? 0}`

    case 'llm_start':
    case 'llm_done':
    case 'compact_start':
    case 'compact_end':
    case 'tool_batch_start':
    case 'tool_progress':
    case 'iteration_end':
      return `${base}|${ev.type}|${ev.iteration}`

    default: {
      // run_start、turn_start、run_end、run_error 等没有 iteration 字段。
      // 它们每个 run/turn 通常只出现一次，用 type + timestamp 区分即可。
      const ev2 = ev as { type: string; timestamp?: number }
      return `${base}|${ev2.type}|${ev2.timestamp ?? 0}`
    }
  }
}

/**
 * 判断一个事件是否已被处理（幂等检查）。
 * @param key 之前处理过的事件 key（null 表示不需要去重）。
 * @param processedKeys 已处理过的事件 key 集合。
 * @returns true 表示该事件应被跳过（重复），false 表示应正常处理。
 */
export function isEventDuplicate(key: string | null, processedKeys: Set<string>): boolean {
  if (key === null) return false // 不需要去重的事件，永远不跳过
  return processedKeys.has(key)
}
