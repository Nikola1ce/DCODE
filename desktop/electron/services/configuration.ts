// 共享模型配置的白名单投影与原子更新，密钥只接受写入，校验请求禁止跳转。
// 制作人：Moriarty_Dox
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { getConfigDir, loadConfig } from '../../../src/config.js'
import type { DCodeConfig } from '../../../src/config.js'
import { BUILTIN_PROVIDERS, getActiveProviderId, getModelSelectOptions, isModelAllowedForProvider, isValidProviderId, resolveProviderApiKey, resolveProviderBaseURL } from '../../../src/providers/registry.js'
import { buildOpenAIClientAgentOptions, resolveProviderProxy } from '../../../src/providers/proxy.js'
import { isValidReasoningEffort } from '../../../src/constants.js'
import type { ModelSettings, ModelSettingsInput } from '../../shared/services.js'
import { DesktopFault } from '../errors.js'
import { invalid, record } from './validation.js'

function endpoint(value: unknown, proxy = false): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20]/.test(value)) invalid()
  if (proxy && value === '') return ''
  let url: URL
  try { url = new URL(value) } catch { return invalid() }
  if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.search || (!proxy && (url.username || url.password))) invalid()
  return value.replace(/\/$/, '')
}

export function modelSettingsInput(value: unknown): ModelSettingsInput {
  const input = record(value, ['provider', 'model', 'baseURL', 'reasoningEffort', 'showThinking', 'apiKey', 'proxy'])
  if (typeof input.provider !== 'string' || !isValidProviderId(input.provider)) invalid()
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 128 || /[\x00-\x1f]/.test(input.model)) invalid()
  if (typeof input.reasoningEffort !== 'string' || !isValidReasoningEffort(input.reasoningEffort)) invalid()
  if (typeof input.showThinking !== 'boolean') invalid()
  if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\x00-\x20]/.test(input.apiKey))) invalid()
  return { provider: input.provider, model: input.model.trim(), baseURL: endpoint(input.baseURL), reasoningEffort: input.reasoningEffort,
    showThinking: input.showThinking, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey as string }),
    ...(input.proxy === undefined ? {} : { proxy: endpoint(input.proxy, true) }) }
}

/** 智谱采用最多一个输出 token 的对话检查，其他供应商检查模型目录。原始响应留在主进程。 */
export function checkProviderConnection(config: DCodeConfig): Promise<string> {
  const key = resolveProviderApiKey(config)
  if (!key && BUILTIN_PROVIDERS[config.provider].requiresApiKey) throw new DesktopFault('API_KEY_REQUIRED', '请填写该供应商的 API Key。')
  const body = config.provider === 'zhipu' ? JSON.stringify({ model: config.model,
    messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false }) : undefined
  const url = new URL(endpoint(resolveProviderBaseURL(config)) + (body ? '/chat/completions' : '/models'))
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const agent = buildOpenAIClientAgentOptions(config).httpAgent
    const pending = request(url, { method: body ? 'POST' : 'GET', agent, headers: { Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, (response) => {
      const status = response.statusCode ?? 0
      response.destroy()
      if (status >= 200 && status < 300) resolve('连接和认证检查通过。模型可用性以实际对话为准。')
      else reject(new DesktopFault('SETTINGS_INVALID', status === 401 || status === 403 ? '认证失败，请检查 API Key 和服务权限。'
        : status >= 300 && status < 400 ? '服务返回重定向，请直接填写最终 API 地址。' : `连接检查返回 HTTP ${status}，请检查模型、API 地址及服务状态。`))
    })
    const timer = setTimeout(() => pending.destroy(new Error('timeout')), 12_000)
    pending.once('close', () => { clearTimeout(timer); agent?.destroy() })
    pending.once('error', () => reject(new DesktopFault('SETTINGS_INVALID', '连接检查失败，请检查网络、代理和 API 地址后重试。')))
    pending.end(body)
  })
}

export class ConfigurationService {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory = getConfigDir(), private readonly effective = loadConfig,
    private readonly probe = checkProviderConnection) {}

  async get(): Promise<ModelSettings> {
    await this.pending
    const config = this.effective()
    const provider = getActiveProviderId(config)
    const environmentOverrides = ['DCODE_PROVIDER', 'DCODE_MODEL', 'DCODE_REASONING_EFFORT', 'DEEPSEEK_BASE_URL', 'OPENAI_BASE_URL', 'ZHIPU_BASE_URL', 'OLLAMA_BASE_URL']
      .filter((name) => !!process.env[name])
    return { provider, model: config.model, reasoningEffort: config.reasoningEffort, showThinking: config.showThinking, environmentOverrides,
      providers: Object.values(BUILTIN_PROVIDERS).map((definition) => {
        const candidate = { ...config, provider: definition.id, baseURL: config.providers?.[definition.id]?.baseURL ?? definition.defaultBaseURL,
          model: definition.id === provider ? config.model : config.providers?.[definition.id]?.defaultModel ?? definition.defaultModel }
        if (definition.id === provider) candidate.baseURL = config.baseURL
        const url = new URL(resolveProviderBaseURL(candidate))
        url.username = ''; url.password = ''; url.search = ''; url.hash = ''
        return { id: definition.id, name: definition.name, baseURL: url.toString().replace(/\/$/, ''), model: candidate.model,
          models: getModelSelectOptions(candidate), requiresApiKey: definition.requiresApiKey, hasApiKey: !!resolveProviderApiKey(candidate),
          environmentKey: !!process.env[definition.apiKeyEnv], hasProxy: !!resolveProviderProxy(candidate) }
      }) }
  }

  private candidate(input: ModelSettingsInput): DCodeConfig {
    const current = this.effective()
    const definition = BUILTIN_PROVIDERS[input.provider]
    if (input.apiKey && process.env[definition.apiKeyEnv]) throw new DesktopFault('SETTINGS_INVALID', '当前密钥由环境变量提供，请先调整该环境变量再保存新密钥。')
    const next = { ...current, provider: input.provider, model: input.model, baseURL: input.baseURL,
      reasoningEffort: input.reasoningEffort, showThinking: input.showThinking, providers: { ...current.providers,
      [input.provider]: { ...current.providers?.[input.provider], baseURL: input.baseURL, defaultModel: input.model,
        ...(input.apiKey ? { apiKey: input.apiKey } : {}), ...(input.proxy === undefined ? {} : { proxy: input.proxy }) } } }
    if (!isModelAllowedForProvider(input.model, next)) throw new DesktopFault('SETTINGS_INVALID', '该模型不在当前供应商支持范围内。')
    if (resolveProviderBaseURL(next).replace(/\/$/, '') !== input.baseURL) throw new DesktopFault('SETTINGS_INVALID', 'API 地址正被环境变量覆盖，请先调整环境变量。')
    return next
  }

  async validate(value: ModelSettingsInput): Promise<string> {
    await this.pending
    return this.probe(this.candidate(modelSettingsInput(value)))
  }

  save(value: ModelSettingsInput): Promise<ModelSettings> {
    const input = modelSettingsInput(value)
    const operation = this.pending.then(async () => {
      const candidate = this.candidate(input)
      const path = join(this.directory, 'config.json')
      const previous = await this.read(path)
      let raw: Record<string, unknown>
      try { raw = previous ? JSON.parse(previous) as Record<string, unknown> : {} }
      catch { throw new DesktopFault('SETTINGS_INVALID', '共享配置无法解析，请检查 config.json 或其备份。') }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || (raw.providers !== undefined && (!raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)))) {
        throw new DesktopFault('SETTINGS_INVALID', '共享配置格式错误，请修复后再保存。')
      }
      const providers = (raw.providers ?? {}) as Record<string, Record<string, unknown>>
      const stored = providers[input.provider] ?? {}
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new DesktopFault('SETTINGS_INVALID', '供应商配置格式错误。')
      const oldEndpoint = (stored.baseURL ?? (raw.provider === input.provider ? raw.baseURL : undefined) ?? BUILTIN_PROVIDERS[input.provider].defaultBaseURL)
      if (input.apiKey || oldEndpoint !== input.baseURL || input.proxy !== undefined) await this.probe(candidate)
      const next = { ...raw, provider: input.provider, model: input.model, baseURL: input.baseURL, reasoningEffort: input.reasoningEffort,
        showThinking: input.showThinking, onboardingComplete: true, providers: { ...providers, [input.provider]: { ...stored,
          baseURL: input.baseURL, defaultModel: input.model, ...(input.apiKey ? { apiKey: input.apiKey } : {}),
          ...(input.proxy === undefined ? {} : { proxy: input.proxy }) } } }
      const text = JSON.stringify(next, null, 2) + '\n'
      if (Buffer.byteLength(text) > 1024 * 1024) throw new DesktopFault('FILE_TOO_LARGE', '共享配置超过 1 MiB 上限。')
      await mkdir(this.directory, { recursive: true })
      // 校验期间其它客户端可能保存配置，发生变化时要求重新读取。
      if (await this.read(path) !== previous) throw new DesktopFault('CONFLICT', '配置已被其它客户端修改，请重新打开设置后保存。')
      if (previous) await this.replace(`${path}.bak`, previous)
      if (await this.read(path) !== previous) throw new DesktopFault('CONFLICT', '配置已变化，请刷新设置。')
      await this.replace(path, text)
    })
    this.pending = operation.catch(() => {})
    return operation.then(() => this.get())
  }

  private async read(path: string): Promise<string | null> {
    try {
      const info = await lstat(path)
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new DesktopFault('SETTINGS_INVALID', '共享配置必须是小于 1 MiB 的普通文件。')
      return await readFile(path, 'utf8')
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  }
  private async replace(path: string, text: string) {
    const temporary = `${path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(text); await file.sync() } finally { await file.close() }
      await rename(temporary, path)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  async flush() { await this.pending }
}
