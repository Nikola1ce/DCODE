// OpenAI Provider 可选 live 集成测试。
// 仅当环境变量 OPENAI_API_KEY 已设置时运行，用于验证多 Provider 真实 API 连通性。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import type { DCodeConfig } from '../config.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_ZHIPU_MODEL } from '../constants.js'
import { createLLMClient } from './factory.js'
import { buildProviderSwitchPatch, resolveProviderBaseURL } from './registry.js'
import { readEnvProxy } from './proxy.js'

const hasOpenAiKey = !!process.env.OPENAI_API_KEY?.trim()
const hasZhipuKey = !!process.env.ZHIPU_API_KEY?.trim()
/** live 测试默认代理（可被 DCODE_PROXY / HTTPS_PROXY 覆盖）。 */
const LIVE_PROXY = readEnvProxy() || 'http://127.0.0.1:10793'

/** 构造测试用最小配置。 */
function testConfig(overrides: Partial<DCodeConfig> = {}): DCodeConfig {
  return {
    baseURL: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    theme: 'dark',
    showThinking: false,
    reasoningEffort: 'high',
    alwaysAllow: [],
    totalCostUsd: 0,
    onboardingComplete: true,
    hooksEnabled: false,
    provider: 'deepseek',
    ...overrides,
  }
}

describe.skipIf(!hasOpenAiKey)('OpenAI Provider live integration', () => {
  it('切换到 openai 后 client 可流式收到回复', async () => {
    const base = testConfig()
    const patch = buildProviderSwitchPatch(base, 'openai')
    const config: DCodeConfig = {
      ...base,
      ...patch,
      provider: 'openai',
      proxy: LIVE_PROXY,
    }

    expect(resolveProviderBaseURL(config)).toBe('https://api.openai.com/v1')

    const client = createLLMClient(config)
    expect(client.getProviderId()).toBe('openai')
    expect(client.hasApiKey()).toBe(true)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)

    let text = ''
    try {
      for await (const ev of client.streamChat({
        messages: [
          {
            role: 'user',
            content: 'Reply with exactly the word OK and nothing else.',
            timestamp: Date.now(),
          },
        ],
        tools: [],
        model: config.model,
        temperature: 0,
        thinking: 'disabled',
        abortSignal: ac.signal,
      })) {
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'done') {
          text = ev.message.content || text
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }

    expect(text.trim().toLowerCase()).toContain('ok')
  }, 25_000)
})

describe.skipIf(!hasZhipuKey)('Zhipu Provider live integration', () => {
  it('切换到 zhipu 后 client 可流式收到回复', async () => {
    const base = testConfig()
    const patch = buildProviderSwitchPatch(base, 'zhipu')
    const config: DCodeConfig = {
      ...base,
      ...patch,
      provider: 'zhipu',
    }

    const client = createLLMClient(config)
    expect(client.getProviderId()).toBe('zhipu')
    expect(client.hasApiKey()).toBe(true)

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)

    let text = ''
    try {
      for await (const ev of client.streamChat({
        messages: [
          {
            role: 'user',
            content: '请只回复 OK 两个字，不要其它内容。',
            timestamp: Date.now(),
          },
        ],
        tools: [],
        model: DEFAULT_ZHIPU_MODEL,
        temperature: 0.2,
        thinking: 'disabled',
        abortSignal: ac.signal,
      })) {
        if (ev.type === 'text') text += ev.delta
        if (ev.type === 'done') {
          text = ev.message.content || text
          break
        }
      }
    } finally {
      clearTimeout(timer)
    }

    expect(text.trim().toUpperCase()).toContain('OK')
  }, 25_000)
})

describe('Zhipu Provider live integration (skipped)', () => {
  it.skipIf(hasZhipuKey)('未设置 ZHIPU_API_KEY 时跳过 live 测试', () => {
    expect(true).toBe(true)
  })
})

describe('OpenAI Provider live integration (skipped)', () => {
  it.skipIf(hasOpenAiKey)('未设置 OPENAI_API_KEY 时跳过 live 测试', () => {
    expect(true).toBe(true)
  })
})
