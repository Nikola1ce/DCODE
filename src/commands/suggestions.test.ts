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
    soundEnabled: true,
    soundVolume: 100,
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

  it('/ 命令列表包含 /add-dir', () => {
    const items = getSlashSuggestions('/')
    expect(items.some((i) => i.completion === '/add-dir')).toBe(true)
  })

  it('/add 前缀匹配 /add-dir 命令', () => {
    const items = getSlashSuggestions('/add')
    expect(items.some((i) => i.completion === '/add-dir')).toBe(true)
  })

  it('/add-dir 完整匹配展示 list/remove/clear 子选项', () => {
    const items = getSlashSuggestions('/add-dir')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/add-dir list')
    expect(completions).toContain('/add-dir remove')
    expect(completions).toContain('/add-dir clear')
  })

  it('/add-dir r 前缀过滤出 remove', () => {
    const items = getSlashSuggestions('/add-dir r')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/add-dir remove')
    expect(completions).not.toContain('/add-dir list')
  })

  it('/effort 完整匹配展示四级强度子选项', () => {
    const items = getSlashSuggestions('/effort')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/effort low')
    expect(completions).toContain('/effort medium')
    expect(completions).toContain('/effort high')
    expect(completions).toContain('/effort max')
  })

  it('/effort m 前缀过滤出 medium / max', () => {
    const items = getSlashSuggestions('/effort m')
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/effort medium')
    expect(completions).toContain('/effort max')
    expect(completions).not.toContain('/effort low')
    expect(completions).not.toContain('/effort high')
  })

  it('/ 命令列表包含 /thinking-budget', () => {
    const items = getSlashSuggestions('/')
    expect(items.some((i) => i.completion === '/thinking-budget')).toBe(true)
  })

  it('/thinking-budget 完整匹配展示 clear 子选项', () => {
    const items = getSlashSuggestions('/thinking-budget')
    expect(items.map((i) => i.completion)).toContain('/thinking-budget clear')
  })

  it('/m 前缀即展示 /model context 子选项（无需输入完整 /model）', () => {
    const items = getSlashSuggestions('/m', baseConfig({ provider: 'deepseek' }))
    const completions = items.map((i) => i.completion)
    // 仍展示以 m 开头的命令本身。
    expect(completions).toContain('/model')
    // 关键：context 子选项随 /model 一并出现。
    expect(completions).toContain('/model context')
  })

  it('/mo、/mod、/model 前缀全程都含 /model context 子选项', () => {
    for (const input of ['/mo', '/mod', '/mode', '/model']) {
      const items = getSlashSuggestions(input, baseConfig({ provider: 'deepseek' }))
      const completions = items.map((i) => i.completion)
      expect(completions).toContain('/model context')
    }
  })

  it('context 子选项紧跟在 /model 命令项之后', () => {
    const items = getSlashSuggestions('/m', baseConfig({ provider: 'deepseek' }))
    const completions = items.map((i) => i.completion)
    const modelIdx = completions.indexOf('/model')
    const ctxIdx = completions.indexOf('/model context')
    expect(modelIdx).toBeGreaterThanOrEqual(0)
    expect(ctxIdx).toBe(modelIdx + 1)
  })

  it('仅输入 / 时命令列表也包含 /model context 子选项', () => {
    const items = getSlashSuggestions('/', baseConfig({ provider: 'deepseek' }))
    expect(items.map((i) => i.completion)).toContain('/model context')
  })

  it('多档模型在 /m 前缀下展示各档位快捷补全', () => {
    const items = getSlashSuggestions('/m', baseConfig({ provider: 'zhipu', model: 'glm-4-long' }))
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/model context')
    // glm-4-long 支持 128K/200K/1M 多档。
    expect(completions).toContain('/model context 128k')
    expect(completions).toContain('/model context 200k')
    expect(completions).toContain('/model context 1m')
  })

  it('单档模型在 /m 前缀下只展示 context 本身、不展示档位', () => {
    // 用真正的单档模型 gpt-4o（固定 128K）验证：DeepSeek V4 现为多档（128K~1M），不再适合作单档样例。
    const items = getSlashSuggestions('/m', baseConfig({ provider: 'openai', model: 'gpt-4o' }))
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/model context')
    // 单档模型无具体档位快捷项。
    expect(completions.some((c) => /\/model context \d/.test(c))).toBe(false)
  })

  it('/model context 参数阶段仍正常返回 context 与档位（回归）', () => {
    const items = getSlashSuggestions('/model context', baseConfig({ provider: 'zhipu', model: 'glm-4-long' }))
    const completions = items.map((i) => i.completion)
    expect(completions).toContain('/model context')
    expect(completions).toContain('/model context 1m')
  })
})
