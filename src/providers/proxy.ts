// Provider HTTP(S) 代理解析与 OpenAI SDK fetch 封装。
// 外国 Provider（如 OpenAI）在无法直连时需配置代理；支持 config、环境变量与 per-provider 覆盖。
// 制作人：Moriarty_Dox

import { HttpsProxyAgent } from 'https-proxy-agent'
import type { DCodeConfig } from '../config.js'
import {
  ENV_DCODE_PROXY,
  ENV_HTTP_PROXY,
  ENV_HTTPS_PROXY,
} from '../constants.js'
import type { ProviderId, ProviderOverrides } from './types.js'

/**
 * 获取当前 Provider id（避免依赖 registry 造成循环引用）。
 * @param config 配置对象。
 * @returns ProviderId。
 */
function activeProviderId(config: DCodeConfig): ProviderId {
  const id = config.provider ?? 'zhipu'
  if (id === 'zhipu' || id === 'deepseek' || id === 'openai' || id === 'ollama' || id === 'custom') {
    return id
  }
  return 'zhipu'
}

/**
 * 读取 Provider 级覆盖（内联，避免循环依赖 registry）。
 * @param config 配置对象。
 * @param id Provider 标识。
 * @returns 覆盖项。
 */
function providerOverrides(
  config: DCodeConfig,
  id: ProviderId,
): ProviderOverrides {
  return config.providers?.[id] ?? {}
}

/**
 * 解析 custom Provider 的 baseURL（简化版，仅用于判断是否本地）。
 * @param config 配置对象。
 * @returns baseURL 字符串。
 */
function resolveCustomBaseURL(config: DCodeConfig): string {
  const override = providerOverrides(config, 'custom').baseURL
  if (override) return override
  if (config.baseURL && !config.baseURL.includes('deepseek.com')) return config.baseURL
  return 'http://127.0.0.1:8080/v1'
}

/**
 * 判断 baseURL 是否指向本机/局域网（通常无需代理）。
 * @param baseURL API 基础地址。
 * @returns 本地地址返回 true。
 */
export function isLocalBaseURL(baseURL: string): boolean {
  try {
    const u = new URL(baseURL)
    const host = u.hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true
    if (host.endsWith('.local')) return true
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 判断 Provider 是否通常需要代理才能从国内访问。
 * @param config 配置对象。
 * @param id 可选 Provider id，默认当前生效项。
 * @returns 外国/需代理场景返回 true。
 */
export function isForeignProvider(config: DCodeConfig, id?: ProviderId): boolean {
  const pid = id ?? activeProviderId(config)
  if (pid === 'openai') return true
  if (pid === 'custom') return !isLocalBaseURL(resolveCustomBaseURL(config))
  return false
}

/**
 * 从标准环境变量读取代理地址（优先级：DCODE > HTTPS > HTTP）。
 * @returns 代理 URL 或 undefined。
 */
export function readEnvProxy(): string | undefined {
  const candidates = [
    process.env[ENV_DCODE_PROXY],
    process.env[ENV_HTTPS_PROXY],
    process.env.https_proxy,
    process.env[ENV_HTTP_PROXY],
    process.env.http_proxy,
  ]
  for (const v of candidates) {
    const trimmed = v?.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/**
 * 解析当前 Provider 生效的代理 URL。
 * 优先级：providers[id].proxy > config.proxy > 环境变量。
 * @param config 配置对象。
 * @param id 可选 Provider id。
 * @returns 代理 URL 或 undefined。
 */
export function resolveProviderProxy(
  config: DCodeConfig,
  id?: ProviderId,
): string | undefined {
  const pid = id ?? activeProviderId(config)
  const override = providerOverrides(config, pid).proxy?.trim()
  if (override) return override
  const global = config.proxy?.trim()
  if (global) return global
  return readEnvProxy()
}

/**
 * 外国 Provider 是否已配置可用代理。
 * @param config 配置对象。
 * @param id 可选 Provider id。
 * @returns 已配置返回 true；非外国 Provider 视为 true。
 */
export function hasRequiredProxy(config: DCodeConfig, id?: ProviderId): boolean {
  const pid = id ?? activeProviderId(config)
  if (!isForeignProvider(config, pid)) return true
  return !!resolveProviderProxy(config, pid)
}

/**
 * 格式化代理地址用于展示（隐藏路径与认证信息）。
 * @param proxy 代理 URL。
 * @returns 可读字符串。
 */
export function formatProxyDisplay(proxy: string | undefined): string {
  if (!proxy) return '(未配置)'
  try {
    const u = new URL(proxy)
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    return `${u.protocol}//${u.hostname}:${port}`
  } catch {
    return proxy.length > 24 ? proxy.slice(0, 20) + '...' : proxy
  }
}

/**
 * 为 OpenAI SDK 构造代理 Agent：仅外国 Provider 且配置了代理时注入。
 * @param config 配置对象。
 * @returns 含 httpAgent 字段的对象，或空对象。
 */
export function buildOpenAIClientAgentOptions(
  config: DCodeConfig,
): { httpAgent?: HttpsProxyAgent<string> } {
  const id = activeProviderId(config)
  if (!isForeignProvider(config, id)) return {}
  const proxy = resolveProviderProxy(config, id)
  if (!proxy) return {}
  return { httpAgent: new HttpsProxyAgent(proxy) }
}

/** @deprecated 使用 buildOpenAIClientAgentOptions；保留别名供测试。 */
export function buildOpenAIClientFetchOptions(
  config: DCodeConfig,
): { httpAgent?: HttpsProxyAgent<string> } {
  return buildOpenAIClientAgentOptions(config)
}

/**
 * 渲染代理配置说明（供 /proxy、/provider 使用）。
 * @param config 配置对象。
 * @returns 多行文本片段。
 */
export function renderProxyHint(config: DCodeConfig): string {
  const id = activeProviderId(config)
  const proxy = resolveProviderProxy(config, id)
  const lines = [`  HTTP(S) 代理：${formatProxyDisplay(proxy)}`]
  if (isForeignProvider(config, id) && !proxy) {
    lines.push(
      '  ⚠ 当前为外国 Provider，未配置代理可能无法连接。',
      '  设置：/proxy http://127.0.0.1:10793',
      '  或环境变量：export HTTPS_PROXY=http://127.0.0.1:10793',
    )
  } else if (proxy && isForeignProvider(config, id)) {
    lines.push('  （外国 Provider 请求将通过上述代理发出）')
  }
  return lines.join('\n')
}
