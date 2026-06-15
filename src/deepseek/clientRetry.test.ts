import { describe, expect, it, vi } from 'vitest'
import type { DCodeConfig } from '../config.js'

const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
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

const config: DCodeConfig = {
  baseURL: 'http://example.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  theme: 'dark',
  showThinking: false,
  reasoningEffort: 'high',
  alwaysAllow: [],
  totalCostUsd: 0,
    onboardingComplete: true,
    hooksEnabled: false,
    soundEnabled: true,
    provider: 'custom',
}

function retryableError(): Error & { status: number } {
  const err = new Error('temporary failure') as Error & { status: number }
  err.status = 500
  return err
}

async function* streamThatFailsAfterText(): AsyncGenerator<any> {
  yield { choices: [{ delta: { content: 'hello' } }] }
  throw retryableError()
}

async function* streamThatFailsBeforeText(): AsyncGenerator<any> {
  throw retryableError()
}

async function* successfulStream(): AsyncGenerator<any> {
  yield { choices: [{ delta: { content: 'ok' } }] }
  yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
}

describe('OpenAICompatibleClient stream retry', () => {
  it('可见增量已经流出后不再自动重试，避免 UI 重复输出', async () => {
    openAiMock.create.mockReset()
    openAiMock.create
      .mockResolvedValueOnce(streamThatFailsAfterText())
      .mockResolvedValueOnce(successfulStream())

    const client = new OpenAICompatibleClient(config)
    const events: string[] = []

    await expect(async () => {
      for await (const ev of client.streamChat({
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        model: 'test-model',
      })) {
        if (ev.type === 'text') events.push(ev.delta)
      }
    }).rejects.toThrow('服务端错误')

    expect(events).toEqual(['hello'])
    expect(openAiMock.create).toHaveBeenCalledTimes(1)
  })

  it('尚未流出可见增量时仍可自动重试', async () => {
    openAiMock.create.mockReset()
    openAiMock.create
      .mockResolvedValueOnce(streamThatFailsBeforeText())
      .mockResolvedValueOnce(successfulStream())

    const client = new OpenAICompatibleClient(config)
    const events: string[] = []
    let final = ''

    for await (const ev of client.streamChat({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      model: 'test-model',
    })) {
      if (ev.type === 'text') events.push(ev.delta)
      if (ev.type === 'done') final = ev.message.content
    }

    expect(events).toEqual(['ok'])
    expect(final).toBe('ok')
    expect(openAiMock.create).toHaveBeenCalledTimes(2)
  })
})
