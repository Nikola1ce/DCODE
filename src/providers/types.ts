// LLM Provider 类型定义。
// 抽象 OpenAI 兼容 API 客户端接口，供 Agent、子代理与上下文压缩共用。
// 制作人：Moriarty_Dox

import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { ReasoningEffort } from '../constants.js'
import type { DeepMessage } from '../core/types.js'
import type { DeepSeekUsage } from '../deepseek/pricing.js'

/** 内置 Provider 标识。 */
export type ProviderId = 'deepseek' | 'openai' | 'zhipu' | 'ollama' | 'custom'

/** 用户可覆盖的单 Provider 连接配置（写入 config.providers）。 */
export interface ProviderOverrides {
  /** API 基础地址。 */
  baseURL?: string
  /** API Key（敏感）。 */
  apiKey?: string
  /** 该 Provider 的默认模型名。 */
  defaultModel?: string
  /** 该 Provider 专用 HTTP(S) 代理（覆盖全局 config.proxy）。 */
  proxy?: string
}

/** 内置 Provider 元数据。 */
export interface ProviderDefinition {
  /** 标识符。 */
  id: ProviderId
  /** 展示名称。 */
  name: string
  /** 默认 API 端点。 */
  defaultBaseURL: string
  /** 默认模型。 */
  defaultModel: string
  /** 对应的环境变量名（API Key）。 */
  apiKeyEnv: string
  /** 是否支持 DeepSeek 风格 thinking / reasoning_effort。 */
  supportsThinking: boolean
  /** 是否必须配置 API Key（Ollama 本地可为 false）。 */
  requiresApiKey: boolean
  /** 可选：该 Provider 常见模型列表（用于 /model 提示）。 */
  suggestedModels?: string[]
}

/**
 * 流式过程中产出的事件类型（供 Agent 主循环消费并转发到 UI）。
 */
export type StreamEvent =
  | { type: 'reasoning'; delta: string }
  | { type: 'text'; delta: string }
  | {
      type: 'done'
      message: DeepMessage
      usage?: DeepSeekUsage
      finishReason: string
    }

/** 发起一次流式对话所需的参数。 */
export interface StreamChatParams {
  messages: DeepMessage[]
  tools: ChatCompletionTool[]
  model: string
  temperature?: number
  abortSignal?: AbortSignal
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: ReasoningEffort
}

/**
 * LLM 客户端抽象：OpenAI 兼容 API 的统一入口。
 */
export interface LLMClient {
  /** 校验是否已配置可用的 API Key（或 Provider 不要求 Key）。 */
  hasApiKey(): boolean
  /** 当前 Provider 标识。 */
  getProviderId(): ProviderId
  /** 流式对话补全。 */
  streamChat(params: StreamChatParams): AsyncGenerator<StreamEvent>
}
