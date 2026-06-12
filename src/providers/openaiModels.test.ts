// OpenAI 模型清单与 temperature 兼容单元测试。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  getOpenAIModelHint,
  OPENAI_CHAT_MODELS,
  openaiModelSupportsCustomTemperature,
} from './openaiModels.js'

describe('openaiModels', () => {
  it('OPENAI_CHAT_MODELS 仅含当前可用模型，不含历史快照', () => {
    expect(OPENAI_CHAT_MODELS).toContain('gpt-5.5')
    expect(OPENAI_CHAT_MODELS).toContain('gpt-4o-mini')
    expect(OPENAI_CHAT_MODELS).not.toContain('gpt-3.5-turbo')
    expect(OPENAI_CHAT_MODELS).not.toContain('gpt-4-0613')
    expect(OPENAI_CHAT_MODELS.length).toBeLessThan(30)
  })

  it('openaiModelSupportsCustomTemperature GPT-5.5 与 o3 不支持自定义', () => {
    expect(openaiModelSupportsCustomTemperature('gpt-5.5')).toBe(false)
    expect(openaiModelSupportsCustomTemperature('gpt-5.4-mini')).toBe(false)
    expect(openaiModelSupportsCustomTemperature('gpt-5.3-codex')).toBe(false)
    expect(openaiModelSupportsCustomTemperature('o3')).toBe(false)
    expect(openaiModelSupportsCustomTemperature('gpt-4o-mini')).toBe(true)
    expect(openaiModelSupportsCustomTemperature('gpt-4.1')).toBe(true)
  })

  it('getOpenAIModelHint 默认模型显示 DCODE 默认', () => {
    expect(getOpenAIModelHint('gpt-4o-mini', 'gpt-4o-mini')).toContain('默认')
  })
})
