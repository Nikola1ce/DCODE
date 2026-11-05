// 在隔离配置目录与本地 HTTP 服务中验证密钥投影、保存恢复和连接检查。
// 制作人：Moriarty_Dox
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const disk = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({ ...await original<typeof import('node:os')>(), homedir: () => disk.home }))
import { loadConfig, type DCodeConfig } from '../../../src/config.js'
import { ConfigurationService, checkProviderConnection, modelSettingsInput } from './configuration.js'
import type { ModelSettingsInput } from '../../shared/services.js'

let directory: string
let path: string
const input: ModelSettingsInput = { provider: 'custom', model: 'fixture-model', baseURL: 'http://127.0.0.1:12345/v1', reasoningEffort: 'high', showThinking: true }
const probe = vi.fn(async (_config: DCodeConfig) => '校验通过')
let service: ConfigurationService
beforeEach(async () => {
  disk.home = await mkdtemp(join(tmpdir(), 'dcode-configuration-'))
  directory = join(disk.home, '.dcode'); path = join(directory, 'config.json')
  await mkdir(directory)
  for (const name of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ZHIPU_API_KEY', 'OLLAMA_API_KEY', 'CUSTOM_API_KEY',
    'DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL', 'ZHIPU_BASE_URL', 'OLLAMA_BASE_URL', 'DCODE_PROVIDER', 'DCODE_MODEL',
    'DCODE_REASONING_EFFORT', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) vi.stubEnv(name, undefined)
  probe.mockReset().mockResolvedValue('校验通过')
  service = new ConfigurationService(directory, loadConfig, probe)
})
afterEach(async () => { await service.flush(); vi.unstubAllEnvs(); await rm(disk.home, { recursive: true, force: true }) })

describe('共享模型设置', () => {
  it('只投影配置状态，保存保留旧密钥、其他供应商及未知字段并备份', async () => {
    const previous = JSON.stringify({ ...input, apiKey: 'legacy-secret', future: { keep: true },
      providers: { custom: { apiKey: 'private-key', proxy: 'http://user:proxy-password@localhost:8080', extra: 'keep' }, openai: { apiKey: 'other-secret' } } })
    await writeFile(path, previous)
    const projection = JSON.stringify(await service.get())
    for (const secret of ['legacy-secret', 'private-key', 'other-secret', 'proxy-password']) expect(projection).not.toContain(secret)
    const saved = await service.save(input)
    expect(saved).toMatchObject({ provider: 'custom', model: 'fixture-model' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ future: { keep: true }, apiKey: 'legacy-secret',
      providers: { custom: { apiKey: 'private-key', extra: 'keep' }, openai: { apiKey: 'other-secret' } } })
    expect(await readFile(`${path}.bak`, 'utf8')).toBe(previous)
  })

  it('新密钥校验失败时保留原配置，重试可成功，返回数据隐藏密钥', async () => {
    await writeFile(path, JSON.stringify(input))
    const original = await readFile(path, 'utf8')
    probe.mockRejectedValueOnce(new Error('认证失败'))
    await expect(service.save({ ...input, apiKey: 'new-secret' })).rejects.toThrow('认证失败')
    expect(await readFile(path, 'utf8')).toBe(original)
    const saved = await service.save({ ...input, apiKey: 'new-secret' })
    expect(saved.providers.find((item) => item.id === 'custom')?.hasApiKey).toBe(true)
    expect(JSON.stringify(saved)).not.toContain('new-secret')
    expect(JSON.parse(await readFile(path, 'utf8')).providers.custom.apiKey).toBe('new-secret')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('环境密钥只在内存使用，拒绝写入被环境变量覆盖的密钥和地址', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'environment-secret')
    const openai = { ...input, provider: 'openai' as const, baseURL: 'https://api.openai.com/v1' }
    await service.save(openai)
    expect(await readFile(path, 'utf8')).not.toContain('environment-secret')
    expect((await service.get()).providers.find((item) => item.id === 'openai')).toMatchObject({ hasApiKey: true, environmentKey: true })
    await expect(service.save({ ...openai, apiKey: 'replacement' })).rejects.toMatchObject({ code: 'SETTINGS_INVALID' })
    vi.stubEnv('OPENAI_BASE_URL', 'https://example.invalid/v1')
    await expect(service.validate(openai)).rejects.toMatchObject({ code: 'SETTINGS_INVALID' })
  })

  it('校验期间外部配置变化时拒绝覆盖', async () => {
    await writeFile(path, JSON.stringify(input))
    probe.mockImplementationOnce(async () => { await writeFile(path, '{"external":true}'); return '通过' })
    await expect(service.save({ ...input, apiKey: 'new' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await readFile(path, 'utf8')).toBe('{"external":true}')
  })

  it('损坏配置保留原文，代理修改也需要连接校验', async () => {
    await writeFile(path, '{broken')
    await expect(service.save(input)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{broken')
    await writeFile(path, JSON.stringify({ ...input, proxy: 'http://localhost:1234', providers: { custom: { proxy: 'http://localhost:5678' } } }))
    await service.save({ ...input, proxy: '' })
    expect(probe).toHaveBeenCalledOnce()
    expect(probe.mock.calls[0]?.[0]).toMatchObject({ proxy: 'http://localhost:1234', providers: { custom: { proxy: '' } } })
  })

  it.each([{ baseURL: 'file:///secret' }, { baseURL: 'https://name:pass@example.com' }, { baseURL: 'https://example.com?key=secret' },
    { proxy: 'socks5://localhost:8888' }, { apiKey: 'a\r\nb' }, { provider: 'unknown' }, { extra: true }, { model: '' }])('输入白名单拒绝 %j', (patch) => {
    expect(() => modelSettingsInput({ ...input, ...patch })).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})

describe('模型连接检查', () => {
  it('智谱使用对话接口并限制测试输出，发送固定消息且不含项目上下文', async () => {
    let received: unknown
    const server = createServer(async (request, response) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      received = { method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      await checkProviderConnection({ ...loadConfig(), provider: 'zhipu', model: 'glm-4.7-flash',
        baseURL: `http://127.0.0.1:${address.port}/v4`, providers: { zhipu: { apiKey: 'fixture-key' } } })
      expect(received).toEqual({ method: 'POST', url: '/v4/chat/completions', body: { model: 'glm-4.7-flash',
        messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false } })
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })

  it('请求模型目录携带认证，错误不回传响应内容，跳转不转发密钥', async () => {
    let status = 200
    const received: { url: string; authorization: string | undefined }[] = []
    const server = createServer((request, response) => {
      received.push({ url: request.url ?? '', authorization: request.headers.authorization })
      response.writeHead(status, { Location: '/redirected' })
      response.end('sensitive-response-body')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as { port: number }
      const config = { ...loadConfig(), provider: 'custom' as const, baseURL: `http://127.0.0.1:${address.port}/v1`, providers: { custom: { apiKey: 'fixture-key' } } }
      await expect(checkProviderConnection(config)).resolves.toContain('检查通过')
      status = 401
      await expect(checkProviderConnection(config)).rejects.toThrow('认证失败')
      status = 302
      await expect(checkProviderConnection(config)).rejects.toThrow('重定向')
      expect(received).toEqual(Array.from({ length: 3 }, () => ({ url: '/v1/models', authorization: 'Bearer fixture-key' })))
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
