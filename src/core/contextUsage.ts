// 统一运行器与界面的请求上下文估算：使用发送视图，并计入工具定义。
// 制作人：Moriarty_Dox
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { estimateMessagesTokens, estimateTextTokens } from './compact.js'
import { trimHistoryForRequest } from './historyTrim.js'
import type { DeepMessage } from './types.js'

/** 近似 token 数，非供应商计费值；旧工具全文不计入实际发送的上下文。 */
export function estimateRequestTokens(messages: DeepMessage[], tools: ChatCompletionTool[] = []): number {
  return estimateMessagesTokens(trimHistoryForRequest(messages))
    + (tools.length ? estimateTextTokens(JSON.stringify(tools)) : 0)
}
