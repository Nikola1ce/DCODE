// LLM 客户端工厂。
// 根据当前 config.provider 创建 OpenAI 兼容客户端实例。
// 制作人：Moriarty_Dox

import type { DCodeConfig } from '../config.js'
import { OpenAICompatibleClient } from '../deepseek/client.js'
import type { LLMClient } from './types.js'

/**
 * 创建与当前配置匹配的 LLM 客户端。
 * @param config 完整配置。
 * @returns LLMClient 实例。
 */
export function createLLMClient(config: DCodeConfig): LLMClient {
  return new OpenAICompatibleClient(config)
}
