// Provider 代理解析单元测试。
// 覆盖环境变量优先级、外国 Provider 判定与 fetch 选项生成。
// 制作人：Moriarty_Dox

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { DCodeConfig } from '../config.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, ENV_DCODE_PROXY, ENV_HTTPS_PROXY } from '../constants.js'
import {
  buildOpenAIClientAgentOptions,
  formatProxyDisplay,
  isForeignProvider,
  isLocalBaseURL,
  readEnvProxy,
  resolveProviderProxy,
} from './proxy.js'

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
    soundEnabled: true,
    soundVolume: 100,
    provider: 'deepseek',
    ...overrides,
  }
}

describe('providers/proxy', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved[ENV_DCODE_PROXY] = process.env[ENV_DCODE_PROXY]
    saved[ENV_HTTPS_PROXY] = process.env[ENV_HTTPS_PROXY]
    delete process.env[ENV_DCODE_PROXY]
    delete process.env[ENV_HTTPS_PROXY]
    delete process.env.https_proxy
    delete process.env.http_proxy
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('isLocalBaseURL 识别 localhost 与 127.0.0.1', () => {
    expect(isLocalBaseURL('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalBaseURL('https://api.openai.com/v1')).toBe(false)
  })

  it('isForeignProvider openai 为 true，zhipu/deepseek 为 false', () => {
    expect(isForeignProvider(baseConfig({ provider: 'openai' }))).toBe(true)
    expect(isForeignProvider(baseConfig({ provider: 'zhipu' }))).toBe(false)
    expect(isForeignProvider(baseConfig({ provider: 'deepseek' }))).toBe(false)
    expect(isForeignProvider(baseConfig({ provider: 'ollama' }))).toBe(false)
  })

  it('resolveProviderProxy 优先级：providers > config > 环境变量', () => {
    process.env[ENV_HTTPS_PROXY] = 'http://127.0.0.1:9999'
    expect(resolveProviderProxy(baseConfig({ proxy: 'http://127.0.0.1:10793' }))).toBe(
      'http://127.0.0.1:10793',
    )
    expect(
      resolveProviderProxy(
        baseConfig({
          provider: 'openai',
          providers: { openai: { proxy: 'http://127.0.0.1:8888' } },
          proxy: 'http://127.0.0.1:10793',
        }),
        'openai',
      ),
    ).toBe('http://127.0.0.1:8888')
  })

  it('readEnvProxy 读取 DCODE_PROXY 与 HTTPS_PROXY', () => {
    process.env[ENV_DCODE_PROXY] = 'http://127.0.0.1:10793'
    expect(readEnvProxy()).toBe('http://127.0.0.1:10793')
    delete process.env[ENV_DCODE_PROXY]
    process.env[ENV_HTTPS_PROXY] = 'http://127.0.0.1:10793'
    expect(readEnvProxy()).toBe('http://127.0.0.1:10793')
  })

  it('buildOpenAIClientAgentOptions 仅外国 Provider 且配置代理时返回 httpAgent', () => {
    expect(buildOpenAIClientAgentOptions(baseConfig({ provider: 'deepseek' }))).toEqual({})
    expect(
      buildOpenAIClientAgentOptions(
        baseConfig({ provider: 'openai', proxy: 'http://127.0.0.1:10793' }),
      ).httpAgent,
    ).toBeDefined()
    expect(buildOpenAIClientAgentOptions(baseConfig({ provider: 'openai' }))).toEqual({})
  })

  it('formatProxyDisplay 格式化展示', () => {
    expect(formatProxyDisplay('http://127.0.0.1:10793')).toBe('http://127.0.0.1:10793')
    expect(formatProxyDisplay(undefined)).toBe('(未配置)')
  })
})
