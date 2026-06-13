// Provider 注册表单元测试。
// 覆盖 Provider 解析、API Key/baseURL 合并、切换补丁与模型校验。
// 制作人：Moriarty_Dox

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { DCodeConfig } from '../config.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_ZHIPU_BASE_URL, DEFAULT_ZHIPU_MODEL, ENV_API_KEY, ENV_BASE_URL, ENV_OPENAI_API_KEY, ENV_ZHIPU_API_KEY } from '../constants.js'
import {
  buildProviderSwitchPatch,
  getActiveProviderId,
  getModelSelectOptions,
  getSuggestedModelsForProvider,
  isModelAllowedForProvider,
  isValidProviderId,
  resolveProviderApiKey,
  resolveProviderBaseURL,
} from './registry.js'
import { OPENAI_CHAT_MODELS } from './openaiModels.js'
import { ZHIPU_CHAT_MODELS } from './zhipuModels.js'

/** 构造最小可用配置。 */
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

describe('providers/registry', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv[ENV_API_KEY] = process.env[ENV_API_KEY]
    savedEnv[ENV_OPENAI_API_KEY] = process.env[ENV_OPENAI_API_KEY]
    savedEnv[ENV_ZHIPU_API_KEY] = process.env[ENV_ZHIPU_API_KEY]
    delete process.env[ENV_API_KEY]
    delete process.env[ENV_OPENAI_API_KEY]
    delete process.env[ENV_ZHIPU_API_KEY]
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('isValidProviderId 识别内置 Provider', () => {
    expect(isValidProviderId('zhipu')).toBe(true)
    expect(isValidProviderId('deepseek')).toBe(true)
    expect(isValidProviderId('openai')).toBe(true)
    expect(isValidProviderId('ollama')).toBe(true)
    expect(isValidProviderId('unknown')).toBe(false)
  })

  it('getActiveProviderId 默认 zhipu，非法值回退', () => {
    expect(getActiveProviderId(baseConfig())).toBe('deepseek')
    expect(getActiveProviderId({ ...baseConfig(), provider: undefined as any })).toBe('zhipu')
    expect(getActiveProviderId(baseConfig({ provider: 'openai' }))).toBe('openai')
    expect(getActiveProviderId(baseConfig({ provider: 'bad' as any }))).toBe('zhipu')
  })

  it('resolveProviderApiKey deepseek 使用顶层 apiKey', () => {
    const key = resolveProviderApiKey(baseConfig({ apiKey: 'sk-test' }))
    expect(key).toBe('sk-test')
  })

  it('resolveProviderApiKey openai 优先环境变量', () => {
    process.env[ENV_OPENAI_API_KEY] = 'sk-openai'
    const key = resolveProviderApiKey(baseConfig({ provider: 'openai' }))
    expect(key).toBe('sk-openai')
  })

  it('resolveProviderApiKey ollama 无 Key 时返回占位符', () => {
    const key = resolveProviderApiKey(baseConfig({ provider: 'ollama' }))
    expect(key).toBe('ollama')
  })

  it('resolveProviderApiKey zhipu 优先环境变量', () => {
    process.env[ENV_ZHIPU_API_KEY] = 'sk-zhipu'
    const key = resolveProviderApiKey(baseConfig({ provider: 'zhipu' }))
    expect(key).toBe('sk-zhipu')
  })

  it('resolveProviderBaseURL zhipu 使用智谱默认端点', () => {
    expect(resolveProviderBaseURL(baseConfig({ provider: 'zhipu' }))).toBe(
      DEFAULT_ZHIPU_BASE_URL,
    )
  })

  it('buildProviderSwitchPatch 从 deepseek 切到 zhipu 时切换模型', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ model: DEFAULT_MODEL }),
      'zhipu',
    )
    expect(patch.provider).toBe('zhipu')
    expect(patch.baseURL).toBe(DEFAULT_ZHIPU_BASE_URL)
    expect(patch.model).toBe(DEFAULT_ZHIPU_MODEL)
  })

  it('resolveProviderBaseURL 使用 Provider 默认端点', () => {
    expect(resolveProviderBaseURL(baseConfig({ provider: 'openai' }))).toBe(
      'https://api.openai.com/v1',
    )
    expect(resolveProviderBaseURL(baseConfig({ provider: 'ollama' }))).toBe(
      'http://127.0.0.1:11434/v1',
    )
  })

  it('resolveProviderBaseURL 忽略其它 Provider 的残留默认端点', () => {
    const url = resolveProviderBaseURL(
      baseConfig({ provider: 'openai', baseURL: DEFAULT_BASE_URL }),
    )
    expect(url).toBe('https://api.openai.com/v1')
  })

  it('buildProviderSwitchPatch 从 deepseek 切到 openai 时切换模型', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ model: DEFAULT_MODEL }),
      'openai',
    )
    expect(patch.provider).toBe('openai')
    expect(patch.baseURL).toBe('https://api.openai.com/v1')
    expect(patch.model).toBe('gpt-4o-mini')
  })

  it('buildProviderSwitchPatch 从 zhipu 切到 openai 时切换模型', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ provider: 'zhipu', model: DEFAULT_ZHIPU_MODEL }),
      'openai',
    )
    expect(patch.provider).toBe('openai')
    expect(patch.model).toBe('gpt-4o-mini')
  })

  it('buildProviderSwitchPatch 从 zhipu 切到 deepseek 时切换模型', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ provider: 'zhipu', model: DEFAULT_ZHIPU_MODEL }),
      'deepseek',
    )
    expect(patch.provider).toBe('deepseek')
    expect(patch.model).toBe(DEFAULT_MODEL)
  })

  it('buildProviderSwitchPatch 从 openai 切到 zhipu 时切换模型', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ provider: 'openai', model: 'gpt-4o-mini' }),
      'zhipu',
    )
    expect(patch.provider).toBe('zhipu')
    expect(patch.model).toBe(DEFAULT_ZHIPU_MODEL)
  })

  it('buildProviderSwitchPatch 目标 Provider 内已匹配模型时保留', () => {
    const patch = buildProviderSwitchPatch(
      baseConfig({ provider: 'openai', model: 'gpt-5.5' }),
      'openai',
    )
    expect(patch.model).toBeUndefined()
  })

  it('isModelAllowedForProvider deepseek 仅允许内置模型', () => {
    expect(isModelAllowedForProvider(DEFAULT_MODEL, baseConfig())).toBe(true)
    expect(isModelAllowedForProvider('gpt-4o', baseConfig())).toBe(false)
  })

  it('isModelAllowedForProvider openai 允许非空模型名', () => {
    expect(isModelAllowedForProvider('gpt-4o', baseConfig({ provider: 'openai' }))).toBe(true)
    expect(isModelAllowedForProvider('', baseConfig({ provider: 'openai' }))).toBe(false)
  })

  it('getSuggestedModelsForProvider 随 Provider 返回对应模型列表', () => {
    expect(getSuggestedModelsForProvider(baseConfig())).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
    expect(getSuggestedModelsForProvider(baseConfig({ provider: 'openai' }))).toEqual([
      ...OPENAI_CHAT_MODELS,
    ])
    expect(getSuggestedModelsForProvider(baseConfig({ provider: 'zhipu' }))).toEqual([
      ...ZHIPU_CHAT_MODELS,
    ])
  })

  it('getModelSelectOptions 智谱含默认免费 hint', () => {
    const opts = getModelSelectOptions(
      baseConfig({ provider: 'zhipu', model: DEFAULT_ZHIPU_MODEL }),
    )
    expect(opts.map((o) => o.value)).toContain(DEFAULT_ZHIPU_MODEL)
    expect(opts.find((o) => o.value === DEFAULT_ZHIPU_MODEL)?.hint).toContain('★')
    expect(opts.find((o) => o.value === DEFAULT_ZHIPU_MODEL)?.label).toContain('★')
    expect(opts.find((o) => o.value === 'glm-4.7-flash')?.hint).toContain('永久免费')
  })

  it('getModelSelectOptions OpenAI 含默认与前沿模型 hint', () => {
    const opts = getModelSelectOptions(baseConfig({ provider: 'openai', model: 'gpt-4o-mini' }))
    expect(opts.map((o) => o.value)).toContain('gpt-4o-mini')
    expect(opts.map((o) => o.value)).toContain('gpt-5.5')
    expect(opts.find((o) => o.value === 'gpt-4o-mini')?.hint).toContain('默认')
    expect(opts.find((o) => o.value === 'gpt-5.5')?.hint).toContain('前沿')
  })

  it('getModelSelectOptions 多档模型 hint 追加「多档上下文」标记，单档模型不追加', () => {
    const opts = getModelSelectOptions(baseConfig({ provider: 'zhipu', model: DEFAULT_ZHIPU_MODEL }))
    // glm-4-long 支持多档上下文，hint 末尾应有标记。
    expect(opts.find((o) => o.value === 'glm-4-long')?.hint).toContain('多档上下文')
    // 单档的 glm-4-flash 不应被追加该标记。
    expect(opts.find((o) => o.value === 'glm-4-flash')?.hint ?? '').not.toContain('多档上下文')
  })

  it('DEEPSEEK_BASE_URL 环境变量仅影响 deepseek Provider', () => {
    process.env[ENV_BASE_URL] = 'https://custom-deepseek.example/v1'
    expect(resolveProviderBaseURL(baseConfig({ provider: 'deepseek' }))).toBe(
      'https://custom-deepseek.example/v1',
    )
    expect(resolveProviderBaseURL(baseConfig({ provider: 'zhipu' }))).toBe(DEFAULT_ZHIPU_BASE_URL)
  })
})
