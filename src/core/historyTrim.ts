// 历史「发送前瘦身」模块（成本优化，无损可用性）。
// 背景：Agent 主循环每一轮都会把【完整对话历史】作为输入 token 重新发送给模型。
// 其中体积最大的往往是工具结果——尤其是 read_file（单条可达 10 万字符）、grep/list_dir 等。
// 当这些结果滚动到历史深处后，模型当前推理几乎不再需要其全文，却仍在每轮被反复计费。
//
// 本模块在【发送前】对历史做一次「视图变换」：把滚出最近窗口、且体积超过阈值的旧工具结果
// 截断为「头部片段 + 占位说明」，最近窗口内的结果与所有非工具消息保持原样。
// 关键约束：
//   1) 纯函数：返回新数组与新消息对象，绝不原地修改入参（避免污染会话持久化的完整历史）；
//   2) 不改变消息条数与顺序，不破坏 assistant+tool_calls 与其 tool 结果的配对关系；
//   3) 仅作用于发送给模型的副本——磁盘会话记录、/resume 恢复仍是完整原文；
//   4) 幂等：已瘦身的消息带 metadata.trimmed 标记，重复调用不会二次截断。
// 制作人：Moriarty_Dox

import {
  HISTORY_TRIM_KEEP_RECENT,
  HISTORY_TRIM_MAX_TOOL_RESULT_CHARS,
  HISTORY_TRIM_HEAD_CHARS,
} from '../constants.js'
import type { DeepMessage } from './types.js'

/**
 * 估算字符串「约等于多少 token」，仅用于占位说明的人类可读提示（与 compact 的估算口径一致）。
 * @param chars 字符数。
 * @returns 估算 token 数。
 */
function approxTokens(chars: number): number {
  return Math.ceil(chars / 3)
}

/**
 * 判断一条消息是否为「可瘦身的大工具结果」。
 * 仅针对 role=tool、内容超阈值、且尚未被本模块瘦身过的消息。
 * @param m 消息。
 * @returns 可瘦身返回 true。
 */
function isTrimmableToolResult(m: DeepMessage): boolean {
  return (
    m.role === 'tool' &&
    typeof m.content === 'string' &&
    m.content.length > HISTORY_TRIM_MAX_TOOL_RESULT_CHARS &&
    m.metadata?.trimmed !== true
  )
}

/**
 * 生成被瘦身后的工具结果内容：保留头部片段，附中文占位说明与「可重新获取」提示。
 * @param toolName 工具名（用于提示重新调用哪个工具）。
 * @param original 原始完整内容。
 * @returns 瘦身后的内容文本。
 */
function buildTrimmedContent(toolName: string | undefined, original: string): string {
  const head = original.slice(0, HISTORY_TRIM_HEAD_CHARS)
  const omitted = original.length - head.length
  const name = toolName ? `（${toolName}）` : ''
  return (
    `${head}\n\n` +
    `[历史瘦身：该工具结果${name}较早且体积较大，已省略后续约 ${omitted} 字符` +
    `（≈ ${approxTokens(omitted)} tokens）以节省上下文开销。` +
    `如仍需完整内容，请重新调用相应工具（如 read_file 指定 offset/limit）获取最新结果。]`
  )
}

/**
 * 对「发送给模型的历史副本」执行瘦身。
 * 流程：从尾部保留最近 HISTORY_TRIM_KEEP_RECENT 条消息原样不动；对更早的消息中
 * 命中 isTrimmableToolResult 的大工具结果，替换为「头部片段 + 占位说明」。
 * 不命中的消息按引用原样放回（不复制），命中的消息生成浅拷贝并改写 content。
 * @param messages 完整消息历史（含 system）。
 * @returns 瘦身后的新消息数组（与入参等长、同序）。
 */
export function trimHistoryForRequest(messages: DeepMessage[]): DeepMessage[] {
  const n = messages.length
  // 历史很短时无需处理：保护性早退，避免无谓遍历。
  if (n <= HISTORY_TRIM_KEEP_RECENT + 1) return messages

  // 最近窗口的起始下标（含）——该下标及之后的消息一律保持原样。
  const recentStart = n - HISTORY_TRIM_KEEP_RECENT
  let changed = false

  const out = messages.map((m, idx) => {
    if (idx >= recentStart) return m
    if (!isTrimmableToolResult(m)) return m
    changed = true
    return {
      ...m,
      content: buildTrimmedContent(m.toolName, m.content),
      metadata: { ...m.metadata, trimmed: true },
    }
  })

  // 没有任何改动时返回原数组引用，避免制造无意义的新数组。
  return changed ? out : messages
}
