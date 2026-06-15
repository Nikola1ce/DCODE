// Web 工具公共逻辑。
// URL 安全校验（禁止 localhost/内网、DNS 解析复核、重定向链校验）、HTML 正文提取等。
// 供 web_fetch / web_search 复用。
// 制作人：Moriarty_Dox

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  readResponseWithProgress,
  renderProgressBar,
  type DownloadProgress,
} from '../core/download.js'

/** URL 校验结果。 */
export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

/** withHardTimeout 的结果：要么按时拿到值，要么超时，要么被用户中断。 */
export type HardTimeoutResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; aborted?: boolean }

/**
 * 给一个 Promise 叠加「不依赖底层取消」的硬超时 + 即时中断护栏。
 * 与两个分支竞速：
 *   1) 超时定时器：超时胜出时返回 { timedOut:true } 并调用 onTimeout（尽力释放底层资源，但不等待它）；
 *   2) abort 信号（可选）：用户中断（Esc）时立即返回 { timedOut:true, aborted:true }，
 *      不必等到硬超时 —— 这是让中断「秒生效」的关键。
 * 用途：网络抓取中即便 reader.read()/cancel() 或连接建立本身永久挂起，也能保证上层按时/即时返回，避免 UI 卡住。
 * @param promise 业务 Promise。
 * @param timeoutMs 超时毫秒数（<=0 表示不加超时）。
 * @param onTimeout 超时或中断时的副作用（如 controller.abort()），可选。
 * @param signal 取消信号（可选）：触发时立即结束等待。
 * @returns 命中超时/中断返回 { timedOut:true }（中断时 aborted:true），否则 { timedOut:false, value }。
 */
export async function withHardTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
  signal?: AbortSignal,
): Promise<HardTimeoutResult<T>> {
  if (!(timeoutMs > 0) && !signal) {
    return { timedOut: false, value: await promise }
  }
  // 已经取消：立即返回。
  if (signal?.aborted) {
    try {
      onTimeout?.()
    } catch {
      // 忽略释放副作用异常。
    }
    return { timedOut: true, aborted: true }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const racers: Array<Promise<HardTimeoutResult<T>>> = [
    promise.then((value): HardTimeoutResult<T> => ({ timedOut: false, value })),
  ]

  if (timeoutMs > 0) {
    racers.push(
      new Promise<HardTimeoutResult<T>>((resolve) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.()
          } catch {
            // 释放副作用失败不应影响超时返回。
          }
          resolve({ timedOut: true })
        }, timeoutMs)
      }),
    )
  }

  if (signal) {
    racers.push(
      new Promise<HardTimeoutResult<T>>((resolve) => {
        onAbort = () => {
          try {
            onTimeout?.()
          } catch {
            // 忽略。
          }
          resolve({ timedOut: true, aborted: true })
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    )
  }

  try {
    return await Promise.race(racers)
  } finally {
    if (timer) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/** 单次 fetch 允许的最大重定向次数。 */
const MAX_FETCH_REDIRECTS = 5

/**
 * 校验 web_fetch 目标 URL 是否允许访问（同步，不含 DNS 解析）。
 * 仅允许 http/https；禁止 localhost、内网 IP、链路本地与 metadata 地址。
 * @param urlString 用户或模型提供的 URL 字符串。
 * @returns 校验结果。
 */
export function validateFetchUrl(urlString: string): UrlValidationResult {
  const trimmed = urlString?.trim()
  if (!trimmed) {
    return { ok: false, reason: 'URL 不能为空。' }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: `URL 格式无效：${trimmed}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `不支持的协议：${url.protocol}（仅允许 http/https）` }
  }

  const host = normalizeHostname(url.hostname)
  if (isBlockedHostname(host)) {
    return { ok: false, reason: `禁止访问本地或内网地址：${host}` }
  }

  const resolvedIp = resolveHostToIpv4(host)
  if (resolvedIp) {
    if (isPrivateOrBlockedIp(resolvedIp)) {
      return { ok: false, reason: `禁止访问内网或保留 IP：${host}` }
    }
    return { ok: true, url }
  }

  const ipVer = isIP(host)
  if (ipVer && isPrivateOrBlockedIp(host)) {
    return { ok: false, reason: `禁止访问内网或保留 IP：${host}` }
  }

  return { ok: true, url }
}

/**
 * 异步校验 URL：在同步校验基础上解析 DNS，拒绝解析到内网的域名（防 DNS 重绑定）。
 * @param urlString URL 字符串。
 * @returns 校验结果。
 */
export async function validateFetchUrlResolved(
  urlString: string,
): Promise<UrlValidationResult> {
  const basic = validateFetchUrl(urlString)
  if (!basic.ok) return basic

  const host = normalizeHostname(basic.url.hostname)
  if (isIP(host)) return basic

  try {
    const results = await lookup(host, { all: true })
    if (results.length === 0) {
      return { ok: false, reason: `无法解析域名：${host}` }
    }
    for (const { address } of results) {
      if (isPrivateOrBlockedIp(address)) {
        return {
          ok: false,
          reason: `域名 ${host} 解析到内网地址 ${address}，禁止访问。`,
        }
      }
    }
  } catch {
    return { ok: false, reason: `无法解析域名：${host}` }
  }

  return basic
}

/**
 * 安全 fetch：手动跟随重定向，每次跳转前重新做 URL + DNS 校验，防 SSRF。
 * @param urlString 初始 URL。
 * @param init fetch 选项（redirect 会被覆盖为 manual）。
 * @returns 最终 Response。
 */
export async function safeFetch(
  urlString: string,
  init: RequestInit,
): Promise<Response> {
  let current = urlString

  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
    const validated = await validateFetchUrlResolved(current)
    if (!validated.ok) {
      throw new Error(validated.reason)
    }

    const res = await fetch(validated.url.toString(), {
      ...init,
      redirect: 'manual',
    })

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) {
        throw new Error(`HTTP ${res.status} 重定向缺少 Location 头。`)
      }
      current = new URL(location, validated.url).toString()
      continue
    }

    return res
  }

  throw new Error(`重定向次数超过 ${MAX_FETCH_REDIRECTS} 次，已中止。`)
}

/** safeFetchText 的可选项。 */
export interface SafeFetchTextOptions {
  /** fetch 选项（signal / headers 等；redirect 会被强制 manual）。 */
  init: RequestInit
  /**
   * 文本进度回调：按字节流读取响应体时实时回调一行可读的进度文本（已内部节流）。
   * 通常接 ctx.onProgress，把下载进度展示到 CLI 实时区。
   */
  onProgressText?: (text: string) => void
  /** 进度条前缀标签（如主机名），用于渲染。 */
  label?: string
  /** 取消信号（与 init.signal 二选一即可，二者都会被尊重）。 */
  signal?: AbortSignal
}

/**
 * 安全 fetch 并「带进度地」读取响应体为文本。
 * 在 safeFetch 完成 SSRF 校验与重定向跟随后，改用 readResponseWithProgress 逐块读取 body，
 * 把「百分比/已下载量/速度/ETA」实时渲染成一行进度文本回调出去，最终用 UTF-8 解码为字符串。
 * 这样网络抓取（web_fetch）也能像下载文件一样显示进度条。
 * @param urlString 目标 URL。
 * @param opts 选项（init / 进度回调 / 标签 / 取消信号）。
 * @returns { res, text } 最终响应与解码后的完整文本。
 */
export async function safeFetchText(
  urlString: string,
  opts: SafeFetchTextOptions,
): Promise<{ res: Response; text: string }> {
  const res = await safeFetch(urlString, opts.init)
  // 非 2xx 也返回，交由上层根据 res.ok 决定如何处理（避免在此吞掉状态码语义）。
  if (!res.ok) {
    return { res, text: '' }
  }
  const signal = opts.signal ?? (opts.init.signal as AbortSignal | undefined) ?? undefined
  const onProgress = opts.onProgressText
    ? (p: DownloadProgress) => opts.onProgressText?.(renderProgressBar(p, opts.label))
    : undefined
  const bytes = await readResponseWithProgress(res, { onProgress, signal, label: opts.label })
  const text = new TextDecoder('utf-8').decode(bytes)
  return { res, text }
}

/**
 * 将非标准 IPv4 字面量（十进制、简写点分）解析为标准 IPv4；非 IP 返回 null。
 * @param host hostname 片段。
 * @returns 标准 IPv4 或 null。
 */
function resolveHostToIpv4(host: string): string | null {
  if (isIP(host) === 4) return host

  // 纯十进制整型（如 2130706433 → 127.0.0.1）
  if (/^\d+$/.test(host)) {
    const n = Number(host)
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`
    }
    return null
  }

  // 简写点分（如 127.1 → 127.0.0.1）
  if (/^\d+(\.\d+)+$/.test(host)) {
    const parts = host.split('.').map(Number)
    if (parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null
    while (parts.length < 4) parts.push(0)
    if (parts.length > 4) return null
    return parts.join('.')
  }

  return null
}

/**
 * 规范化 URL hostname（去除 IPv6 方括号、转小写）。
 * @param hostname URL.hostname 原始值。
 * @returns 规范化主机名或 IP。
 */
function normalizeHostname(hostname: string): string {
  let host = hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }
  return host
}

/**
 * 判断主机名是否为明确禁止的 localhost / metadata 域名。
 * @param host 小写 hostname。
 * @returns 禁止返回 true。
 */
function isBlockedHostname(host: string): boolean {
  const blocked = [
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
    '::1',
  ]
  if (blocked.includes(host)) return true
  if (host.endsWith('.localhost')) return true
  if (host === '0.0.0.0') return true
  return false
}

/**
 * 判断 IP（v4/v6）是否属于私有、链路本地或 cloud metadata 范围。
 * @param ip IP 字符串。
 * @returns 私有/禁止返回 true。
 */
export function isPrivateOrBlockedIp(ip: string): boolean {
  const ver = isIP(ip)
  if (ver === 4) return isPrivateIpv4(ip)
  if (ver === 6) return isPrivateIpv6(ip)
  return true
}

/**
 * 判断 IPv4 是否为 RFC1918、链路本地、环回或 metadata。
 * @param ip IPv4 字符串。
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  if (a === 127) return true
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 0) return true
  return false
}

/**
 * 判断 IPv6 是否为环回、链路本地或唯一本地地址。
 * @param ip IPv6 字符串。
 */
function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length)
    if (isIP(v4) === 4) return isPrivateIpv4(v4)
  }
  return false
}

/**
 * 从 HTML 字符串提取 body 纯文本（移除 script/style，解码常见实体，折叠空白）。
 * @param html 原始 HTML。
 * @returns 纯文本。
 */
export function extractBodyText(html: string): string {
  let body = html
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    body = bodyMatch[1]
  }

  let text = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')

  return text.trim()
}

/**
 * 按最大字符数截断 Web 内容并附加提示。
 * @param text 原始文本。
 * @param maxChars 上限。
 * @returns 截断后文本。
 */
export function truncateWebContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return (
    text.slice(0, maxChars) +
    `\n\n... [已截断，原文 ${text.length} 字符，仅返回前 ${maxChars} 字符] ...`
  )
}
