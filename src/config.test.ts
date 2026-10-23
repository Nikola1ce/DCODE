// 配置加载回归：环境变量切换供应商不能串用模型、端点或密钥。
// 制作人：Moriarty_Dox
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => ({ value: {} as unknown }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, existsSync: () => true, readFileSync: () => JSON.stringify(disk.value) }
})
import { loadConfig, resolveBaseURL } from './config.js'

beforeEach(() => {
  disk.value = {}
  for (const key of ['DCODE_PROVIDER', 'DCODE_MODEL', 'DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL', 'ZHIPU_BASE_URL']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())
describe('loadConfig 供应商隔离', () => {
  it('仅用环境变量选择 OpenAI 时采用对应的默认模型和端点', () => {
    vi.stubEnv('DCODE_PROVIDER', 'openai')
    const config = loadConfig()
    expect(config.model).toBe('gpt-6-luna')
    expect(resolveBaseURL(config)).toBe('https://api.openai.com/v1')
  })
  it('切换供应商不会保留上一家的自定义地址，显式模型仍优先', () => {
    disk.value = { provider: 'deepseek', model: 'deepseek-flash', baseURL: 'https://old-endpoint.example/v1',
      providers: { openai: { defaultModel: 'gpt-6.1-sol' } } }
    vi.stubEnv('DCODE_PROVIDER', 'openai')
    expect(loadConfig().model).toBe('gpt-6.1-sol')
    expect(resolveBaseURL(loadConfig())).toBe('https://api.openai.com/v1')
    vi.stubEnv('DCODE_MODEL', 'gpt-6-astra')
    expect(loadConfig().model).toBe('gpt-6-astra')
  })
  it('DeepSeek 端点环境变量不覆盖智谱地址', () => {
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://deepseek-only.example/v1')
    expect(resolveBaseURL(loadConfig())).toBe('https://open.bigmodel.cn/api/paas/v4')
  })
  it('配置只有供应商时仍能补齐正确模型', () => {
    disk.value = { provider: 'openai' }
    expect(loadConfig().model).toBe('gpt-6-luna')
  })
  it('保留用户已保存的模型，空配置损坏时可启动', () => {
    disk.value = { provider: 'zhipu', model: 'glm-4-flash' }
    expect(loadConfig().model).toBe('glm-4-flash')
    disk.value = null
    expect(loadConfig().model).toBe('glm-4.7-flash')
  })
})
