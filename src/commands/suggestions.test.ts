// 斜杠命令补全单元测试。
// 覆盖命令名过滤与 /provider、/model 参数子选项（含 Provider 感知模型列表）。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import type { DCodeConfig } from '../config.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../constants.js'
import { getSlashSuggestions } from './index.js'

/** 构造最小配置，便于测试 Provider 相关补全。 */
function baseConfig(overrides: Partial<DCodeConfig> = {}): DCodeConfig {
  return {
    baseURL: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    theme: 'dark',
    showThinking: true,
    reasoningEffort: 'high',
    alwaysAllow: [],
    totalCostUsd: 0,
    onboardingComplete: false,
    hooksEnabled: true,
    provider: 'deepseek',
    ...overrides,
  }
}
describe('getSlashSuggestions', () => {
  it('空前缀返回全部命令', () => {
    const items = getSlashSuggestions('/')
    expect(items.length).toBeGreaterThan(10)
    expect(items.some((i) => i.completion === '/provider')).toBe(true)
    expect(items.some((i) => i.completion === '/provider zhipu')).toBe(true)
    expect(items.some((i) => i.completion === '/provider openai')).toBe(true)
    // Provider 子选项排在全部命令之后（最底层）。
    const exitIdx = items.findIndex((i) => i.completion === '/exit')
    const zhipuIdx = items.findIndex((i) => i.completion === '/provider zhipu')
    expect(exitIdx).toBeGreaterThanOrEqual(0)
    expect(zhipuIdx).toBeGreaterThan(exitIdx)
  })

  it('/p 同时展示 plan/proxy/provider 命令与 Provider 子选项', () => {
    const items = getSlashSuggestions('/p')
    expect(items.some((i) => i.completion === '/plan')).toBe(true)
    expect(items.some((i) => i.completion === '/proxy')).toBe(true)
    expect(items.some((i) => i.completion === '/provider')).toBe(true)
    expect(items.some((i) => i.completion === '/provider openai')).toBe(true)
    expect(items.some((i) => i.completion === '/provider zhipu')).toBe(true)
    expect(items.some((i) => i.completion === '/provider deepseek')).toBe(true)
    expect(items.some((i) => i.completion === '/provider ollama')).toBe(false)
  })

  it('/pro 展示 proxy/provider 命令与 Provider 子选项', () => {
    const items = getSlashSuggestions('/pro')
    expect(items.some((i) => i.completion === '/proxy')).toBe(true)
    expect(items.some((i) => i.completion === '/provider')).toBe(true)
    expect(items.some((i) => i.completion === '/provider openai')).toBe(true)
  })

  it('/provider 完整匹配时展示命令本身与 Provider 子选项', () => {
    const items = getSlashSuggestions('/provider')
    expect(items.some((i) => i.completion === '/provider')).toBe(true)
    expect(items.map((i) => i.completion)).toContain('/provider openai')
    expect(items.map((i) => i.completion)).not.toContain('/provider ollama')
  })

  it('/provider o 前缀过滤子选项', () => {
    const items = getSlashSuggestions('/provider o')
    expect(items.some((i) => i.completion === '/provider openai')).toBe(true)
    expect(items.some((i) => i.completion === '/provider ollama')).toBe(false)
  })

  it('/model 完整匹配时展示 DeepSeek 模型子选项', () => {
    const items = getSlashSuggestions('/model', baseConfig({ provider: 'deepseek' }))
    expect(items.some((i) => i.completion.includes('deepseek-v4-flash'))).toBe(true)
    expect(items.some((i) => i.completion.includes('gpt-4o'))).toBe(false)
  })

  it('/model 在智谱 Provider 下展示 GLM 模型子选项', () => {
    const items = getSlashSuggestions(
      '/model',
      baseConfig({ provider: 'zhipu', model: 'glm-4-flash' }),
    )
    expect(items.some((i) => i.completion === '/model glm-4-flash')).toBe(true)
    expect(items.some((i) => i.completion === '/model glm-4.7-flash')).toBe(true)
    expect(items.some((i) => i.name.startsWith('★') && i.description.includes('永久免费'))).toBe(true)
    expect(items.some((i) => i.completion.includes('deepseek'))).toBe(false)
  })

  it('/model 在 OpenAI Provider 下展示 OpenAI 模型子选项', () => {
    const items = getSlashSuggestions('/model', baseConfig({ provider: 'openai', model: 'gpt-4o-mini' }))
    expect(items.some((i) => i.completion === '/model gpt-4o-mini')).toBe(true)
    expect(items.some((i) => i.completion.includes('deepseek'))).toBe(false)
  })

  it('/proxy 不匹配 provider 前缀，仍显示 proxy 命令', () => {
    const items = getSlashSuggestions('/proxy')
    expect(items.some((i) => i.completion === '/proxy')).toBe(true)
    expect(items.some((i) => i.completion === '/provider openai')).toBe(false)
  })

  it('/skill 前缀同时展示 /skill 与 /skills', () => {
    const items = getSlashSuggestions('/skill')
    expect(items.some((i) => i.completion === '/skill')).toBe(true)
    expect(items.some((i) => i.completion === '/skills')).toBe(true)
  })

  it('/skills 完整匹配展示 skills 命令', () => {
    const items = getSlashSuggestions('/skills')
    expect(items.some((i) => i.completion === '/skills')).toBe(true)
    expect(items.find((i) => i.completion === '/skills')?.description).toContain('技能')
  })

  it('/ 命令列表包含 /review', () => {
    const items = getSlashSuggestions('/')
    expect(items.some((i) => i.completion === '/review')).toBe(true)
  })

  it('/rev 前缀匹配 /review 命令', () => {
    const items = getSlashSuggestions('/rev')
    expect(items.some((i) => i.completion === '/review')).toBe(true)
  })

  it('/review 完整匹配展示范围与聚焦维度子选项', () => {
    const items = getSlashSuggestions('/review')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/review staged')
    expect(completions).toContain('/review status')
    expect(completions).toContain('/review security')
    expect(completions).toContain('/review performance')
    expect(completions).toContain('/review readability')
    expect(completions).toContain('/review best-practices')
  })

  it('/review s 前缀过滤子选项（staged/status/security）', () => {
    const items = getSlashSuggestions('/review s')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/review staged')
    expect(completions).toContain('/review status')
    expect(completions).toContain('/review security')
    expect(completions).not.toContain('/review readability')
  })
})
