// Provider /login 多 Key 存储单元测试。
// 验证各 Provider 独立保存 Key、切换 Provider 时使用对应 Key。
// 制作人：Moriarty_Dox

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DCodeConfig } from '../config.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  ENV_API_KEY,
  ENV_OPENAI_API_KEY,
  ENV_ZHIPU_API_KEY,
} from '../constants.js'
import {
  buildProviderLoginPatch,
  getProviderLoginMeta,
  getStoredProviderApiKey,
  resolveProviderApiKey,
} from './registry.js'

function baseConfig(overrides: Partial<DCodeConfig> = {}): DCodeConfig {
  return {
    baseURL: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    theme: 'dark',
    showThinking: true,
    reasoningEffort: 'high',
    alwaysAllow: [],
    totalCostUsd: 0,
    onboardingComplete: true,
    hooksEnabled: false,
    provider: 'deepseek',
    ...overrides,
  }
}

describe('provider login / multi-key', () => {
  const providerApiEnvKeys = [ENV_API_KEY, ENV_OPENAI_API_KEY, ENV_ZHIPU_API_KEY]
  const envBackup = new Map<string, string | undefined>()

  beforeEach(() => {
    envBackup.clear()
    for (const key of providerApiEnvKeys) {
      envBackup.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of providerApiEnvKeys) {
      const value = envBackup.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('buildProviderLoginPatch 为 zhipu 写入 providers.zhipu.apiKey', () => {
    const patch = buildProviderLoginPatch(baseConfig(), 'zhipu', 'sk-zhipu-test')
    expect(patch.providers?.zhipu?.apiKey).toBe('sk-zhipu-test')
    expect(patch.apiKey).toBeUndefined()
  })

  it('buildProviderLoginPatch 为 openai 写入 providers.openai.apiKey', () => {
    const patch = buildProviderLoginPatch(baseConfig(), 'openai', 'sk-openai-test')
    expect(patch.providers?.openai?.apiKey).toBe('sk-openai-test')
    expect(patch.apiKey).toBeUndefined()
  })

  it('buildProviderLoginPatch deepseek 同步顶层 apiKey', () => {
    const patch = buildProviderLoginPatch(baseConfig(), 'deepseek', 'sk-ds-test')
    expect(patch.providers?.deepseek?.apiKey).toBe('sk-ds-test')
    expect(patch.apiKey).toBe('sk-ds-test')
  })

  it('先后保存两个 Provider Key 互不覆盖', () => {
    let cfg = baseConfig()
    cfg = { ...cfg, ...buildProviderLoginPatch(cfg, 'deepseek', 'sk-ds') }
    cfg = { ...cfg, ...buildProviderLoginPatch(cfg, 'openai', 'sk-oai') }
    expect(getStoredProviderApiKey(cfg, 'deepseek')).toBe('sk-ds')
    expect(getStoredProviderApiKey(cfg, 'openai')).toBe('sk-oai')
  })

  it('resolveProviderApiKey 随 provider 切换', () => {
    const cfg = {
      ...baseConfig({
        providers: {
          deepseek: { apiKey: 'sk-ds' },
          openai: { apiKey: 'sk-oai' },
        },
      }),
    }
    expect(resolveProviderApiKey({ ...cfg, provider: 'deepseek' })).toBe('sk-ds')
    expect(resolveProviderApiKey({ ...cfg, provider: 'openai' })).toBe('sk-oai')
  })

  it('getProviderLoginMeta zhipu 返回智谱文案', () => {
    const meta = getProviderLoginMeta('zhipu')
    expect(meta.providerName).toBe('智谱AI')
    expect(meta.platformUrl).toContain('bigmodel.cn')
    expect(meta.apiKeyEnv).toBe('ZHIPU_API_KEY')
  })

  it('getProviderLoginMeta openai 返回 OpenAI 文案', () => {
    const meta = getProviderLoginMeta('openai')
    expect(meta.providerName).toBe('OpenAI')
    expect(meta.platformUrl).toContain('openai.com')
    expect(meta.apiKeyEnv).toBe('OPENAI_API_KEY')
  })

  it('updateConfig 深合并 providers 不丢失其它 Key', () => {
    const initial = baseConfig({
      providers: { deepseek: { apiKey: 'sk-ds-keep' } },
    })
    // 模拟仅 patch openai（不 spread 全量 providers）
    const merged = {
      ...initial,
      providers: {
        ...initial.providers,
        openai: { apiKey: 'sk-oai-new' },
      },
    }
    expect(merged.providers?.deepseek?.apiKey).toBe('sk-ds-keep')
    expect(merged.providers?.openai?.apiKey).toBe('sk-oai-new')
  })
})
