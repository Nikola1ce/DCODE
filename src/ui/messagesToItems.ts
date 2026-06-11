// 历史消息 -> 展示项 转换。
// 把持久化的 DeepMessage[] 还原为界面可渲染的 DisplayItem[]，用于 dcode -c / -r 恢复会话时
// 在界面上回放此前的对话内容。
// 制作人：Moriarty_Dox

import type { DeepMessage } from '../core/types.js'
import type { DisplayItem } from './types.js'

// 用于生成稳定 key 的自增序号。
let _seq = 0
function nextId(): string {
  _seq += 1
  return `r${_seq}`
}

/**
 * 将历史消息转换为展示项数组。
 * - system 消息不展示；
 * - assistant 仅在有正文时展示（纯工具调用消息跳过）；
 * - tool 结果以工具项展示（成功/错误）。
 * @param messages 历史消息。
 * @returns 展示项数组。
 */
export function messagesToItems(messages: DeepMessage[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      // 跳过内部注入的压缩摘要标记，保持回放干净。
      items.push({ id: nextId(), kind: 'user', text: m.content })
    } else if (m.role === 'assistant') {
      if (m.content.trim()) {
        items.push({
          id: nextId(),
          kind: 'assistant',
          text: m.content,
          reasoning: m.reasoning,
        })
      }
    } else if (m.role === 'tool') {
      items.push({
        id: nextId(),
        kind: 'tool',
        name: m.toolName ?? 'tool',
        summary: m.toolName ?? '工具调用',
        status: m.isError ? 'error' : 'done',
        resultText: m.content,
      })
    }
  }
  return items
}
