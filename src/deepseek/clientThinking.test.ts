// OpenAICompatibleClient 的 thinking / reasoning_effort 请求体单元测试。
// 验证：四级强度归一化（low/medium→high、max→max）、thinking budget 透传、
// 以及非 thinking Provider 不发送扩展字段。
// 制作人：Moriarty_Dox

import { describe, expect, it, vi } from 'vitest'
import type { DCodeConfig } from '../config.js'

// 捕获最近一次传给底层 SDK 的请求体，便于断言。
const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
  lastBody: undefined as Record<string, any> | undefined,
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: openAiMock.create,
      },
    }
  },
}))

const { OpenAICompatibleClient } = await import('./client.js')

/** 构造一个支持 thinking 的 DeepSeek 配置。 */
function deepseekConfig(overrides: Partial<DCodeConfig> = {}): DCodeConfig {
  return {
    baseURL: 'https://api.deepseek.com',
    apiKey: 'test-key',
    model: 'deepseek-v4-pro',
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

/** 一个最小的成功流，供 create 返回。 */
async function* successStream(): AsyncGenerator<any> {
  yield { choices: [{ delta: { content: 'ok' } }] }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
}

/** 跑一次 streamChat 并返回捕获到的请求体。 */
async function runAndCaptureBody(
  config: DCodeConfig,
  params: Partial<Parameters<InstanceType<typeof OpenAICompatibleClient>['streamChat']>[0]> = {},
): Promise<Record<string, any>> {
  openAiMock.create.mockReset()
  openAiMock.create.mockImplementation(async (body: Record<string, any>) => {
    openAiMock.lastBody = body
    return successStream()
  })
  const client = new OpenAICompatibleClient(config)
  for await (const _ev of client.streamChat({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    model: config.model,
    ...params,
  })) {
    // 仅触发请求，无需消费事件。
  }
  return openAiMock.lastBody as Record<string, any>
}

describe('OpenAICompatibleClient thinking / reasoning_effort 请求体', () => {
  it('high 强度按原值 high 发送', async () => {
    const body = await runAndCaptureBody(deepseekConfig({ reasoningEffort: 'high' }))
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })

  it('max 强度按原值 max 发送', async () => {
    const body = await runAndCaptureBody(deepseekConfig({ reasoningEffort: 'max' }))
    expect(body.reasoning_effort).toBe('max')
  })

  it('low / medium 被归一化为 high 发送给 DeepSeek', async () => {
    const low = await runAndCaptureBody(deepseekConfig({ reasoningEffort: 'low' }))
    expect(low.reasoning_effort).toBe('high')
    const medium = await runAndCaptureBody(deepseekConfig({ reasoningEffort: 'medium' }))
    expect(medium.reasoning_effort).toBe('high')
  })

  it('参数级 reasoningEffort 覆盖配置值', async () => {
    const body = await runAndCaptureBody(deepseekConfig({ reasoningEffort: 'high' }), {
      reasoningEffort: 'max',
    })
    expect(body.reasoning_effort).toBe('max')
  })

  it('设置合法 thinkingBudget 时随 thinking.budget_tokens 一并发送', async () => {
    const body = await runAndCaptureBody(deepseekConfig({ thinkingBudget: 16000 }))
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
  })

  it('未设置 thinkingBudget 时不发送 budget_tokens', async () => {
    const body = await runAndCaptureBody(deepseekConfig())
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.thinking.budget_tokens).toBeUndefined()
  })

  it('thinking 关闭时不发送 reasoning_effort 与 budget_tokens', async () => {
    const body = await runAndCaptureBody(
      deepseekConfig({ showThinking: false, thinkingBudget: 16000 }),
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('非 thinking Provider（智谱）完全不发送 thinking 扩展字段', async () => {
    const body = await runAndCaptureBody(
      deepseekConfig({ provider: 'zhipu', model: 'glm-4-flash', thinkingBudget: 16000 }),
    )
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })
})
