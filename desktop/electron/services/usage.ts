// 从持久化 llm_done 事件聚合实际用量，缺失费用保留为未计价请求。
// 制作人：Moriarty_Dox
import type { SessionSnapshot } from '../../../src/core/session.js'
import type { SessionUsage, UsageTotals } from '../../shared/services.js'

function emptyTotals(): UsageTotals {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0, unpricedRequests: 0 }
}
function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function sessionUsage(snapshot: SessionSnapshot): SessionUsage {
  const result: SessionUsage = { sessionId: snapshot.sessionId, total: emptyTotals(), turns: [] }
  const turns = new Map<string, SessionUsage['turns'][number]>()
  const seen = new Set<string>()
  for (const event of snapshot.events) {
    if (event.type !== 'llm_done') continue
    const key = JSON.stringify([event.runId, event.iteration])
    if (seen.has(key)) continue
    seen.add(key)
    let turn = turns.get(event.turnId)
    if (!turn) {
      turn = { turnId: event.turnId, timestamp: event.timestamp, usage: emptyTotals() }
      turns.set(event.turnId, turn)
      result.turns.push(turn)
    }
    const promptTokens = nonNegative(event.usage?.prompt_tokens)
    const values: UsageTotals = {
      requests: 1, promptTokens, completionTokens: nonNegative(event.usage?.completion_tokens),
      cacheHitTokens: Math.min(promptTokens, nonNegative(event.usage?.prompt_cache_hit_tokens ?? event.usage?.prompt_tokens_details?.cached_tokens)),
      costUsd: nonNegative(event.costUsd),
      unpricedRequests: typeof event.costUsd === 'number' && Number.isFinite(event.costUsd) && event.costUsd >= 0 ? 0 : 1,
    }
    for (const key of Object.keys(values) as (keyof UsageTotals)[]) {
      result.total[key] += values[key]
      turn.usage[key] += values[key]
    }
  }
  return result
}
