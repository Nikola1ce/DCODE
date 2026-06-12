// 上下文压缩模块。
// 当对话历史增长到接近模型上下文上限时，把较早的消息交给模型做结构化摘要，
// 用一条“摘要消息”替换大量历史，从而在保留关键信息的同时释放上下文空间。
// 借鉴 Claude Code 的 /compact 思路：保留最近若干轮原文，其余压缩为要点。
// 制作人：Moriarty_Dox

import { COMPACT_TOKEN_THRESHOLD } from '../constants.js'
import type { LLMClient } from '../providers/types.js'
import type { DeepMessage } from './types.js'

// 压缩时保留的最近消息条数（不参与摘要，原样保留）。
const KEEP_RECENT = 6

/**
 * 将对话历史拆分为不可再分的消息组（assistant+tool_calls 与其 tool 结果同组）。
 * @param convo 不含 system 的消息列表。
 * @returns 消息组数组。
 */
export function splitConversationGroups(convo: DeepMessage[]): DeepMessage[][] {
  const groups: DeepMessage[][] = []
  let i = 0
  while (i < convo.length) {
    const m = convo[i]
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const group: DeepMessage[] = [m]
      i++
      while (i < convo.length && convo[i].role === 'tool') {
        group.push(convo[i])
        i++
      }
      groups.push(group)
    } else {
      groups.push([m])
      i++
    }
  }
  return groups
}

/**
 * 按消息条数从尾部选取保留组，保证不在 assistant/tool 组中间切分。
 * @param groups 消息组。
 * @param keepRecent 保留的最近消息条数上限。
 * @returns [待摘要组, 保留组]。
 */
export function partitionGroupsForCompact(
  groups: DeepMessage[][],
  keepRecent: number,
): [DeepMessage[][], DeepMessage[][]] {
  const keptGroups: DeepMessage[][] = []
  let keptCount = 0
  for (let g = groups.length - 1; g >= 0 && keptCount < keepRecent; g--) {
    keptGroups.unshift(groups[g])
    keptCount += groups[g].length
  }
  const summarizeCount = groups.length - keptGroups.length
  return [groups.slice(0, summarizeCount), keptGroups]
}

/**
 * 粗略估算一段文本的 token 数。
 * 中文按约 1.5 字符/token、英文按约 4 字符/token，混合场景取折中系数 3。
 * 仅用于触发阈值判断，不要求精确。
 * @param text 文本。
 * @returns 估算 token 数。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3)
}

/**
 * 估算整个消息历史的 token 数（含工具调用入参）。
 * @param messages 消息历史。
 * @returns 估算 token 总数。
 */
export function estimateMessagesTokens(messages: DeepMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTextTokens(m.content)
    if (m.toolCalls) {
      for (const tc of m.toolCalls) total += estimateTextTokens(tc.argsJson)
    }
  }
  return total
}

/**
 * 判断是否应触发自动压缩。
 * @param messages 消息历史。
 * @returns 超过阈值返回 true。
 */
export function shouldCompact(messages: DeepMessage[]): boolean {
  return estimateMessagesTokens(messages) > COMPACT_TOKEN_THRESHOLD
}

/**
 * 对消息历史执行压缩。
 * 流程：分离出 system 消息与最近 KEEP_RECENT 条消息，把中间的历史请模型总结为要点，
 * 然后重组为 [system, 摘要(user), ...最近消息]。
 * 若历史过短或压缩失败，原样返回。
 * @param client LLM 客户端。
 * @param messages 原始消息历史。
 * @param model 用于摘要的模型名。
 * @returns 压缩后的新消息历史。
 */
export async function compactMessages(
  client: LLMClient,
  messages: DeepMessage[],
  model: string,
): Promise<DeepMessage[]> {
  // 拆出 system 消息（始终保留在最前）。
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const convo = messages.filter((m) => m.role !== 'system')

  // 历史太短没必要压缩。
  if (convo.length <= KEEP_RECENT + 2) return messages

  // 按完整消息组划分，避免 assistant+tool_calls 与 tool 结果被拆到不同段。
  const groups = splitConversationGroups(convo)
  const [summarizeGroups, keptGroups] = partitionGroupsForCompact(groups, KEEP_RECENT)
  if (summarizeGroups.length === 0) return messages

  const toSummarize = summarizeGroups.flat()
  const recent = keptGroups.flat()

  // 将待摘要消息拼成纯文本喂给模型。
  const transcript = toSummarize
    .map((m) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const calls = m.toolCalls.map((t) => `调用工具 ${t.name}(${t.argsJson})`).join('；')
        return `助手：${m.content}\n${calls}`
      }
      if (m.role === 'tool') return `工具结果(${m.toolName})：${m.content}`
      if (m.role === 'user') return `用户：${m.content}`
      return `助手：${m.content}`
    })
    .join('\n\n')

  // 构造摘要请求。
  const summaryPrompt: DeepMessage[] = [
    {
      role: 'system',
      content:
        '你是对话压缩器。请把下面的编程会话历史压缩成结构化要点，保留：用户的目标与需求、' +
        '已做出的关键决策、已修改的文件与改动要点、尚未完成的事项、重要的命令输出结论。' +
        '丢弃寒暄与冗余细节。用简体中文，分条输出，尽量精炼。',
    },
    { role: 'user', content: `以下是需要压缩的历史：\n\n${transcript}` },
  ]

  try {
    // 收集模型流式输出，组装为摘要文本。
    let summary = ''
    for await (const ev of client.streamChat({
      messages: summaryPrompt,
      tools: [],
      model,
      temperature: 0.2,
      thinking: 'disabled',
    })) {
      if (ev.type === 'text') summary += ev.delta
      if (ev.type === 'done') summary = ev.message.content || summary
    }

    // 组装压缩后的历史。
    const summaryMsg: DeepMessage = {
      role: 'user',
      content: `【以下是先前对话的压缩摘要，请据此延续工作】\n${summary}`,
      timestamp: Date.now(),
    }
    return [...systemMsgs, summaryMsg, ...recent]
  } catch {
    // 压缩失败则保持原状，保证可用性优先。
    return messages
  }
}
