// Web 工具公共逻辑。
// URL 安全校验（禁止 localhost/内网）、HTML 正文提取等，供 web_fetch / web_search 复用。
// 制作人：Moriarty_Dox

import { isIP } from 'node:net'

/** URL 校验结果。 */
export type UrlValidationResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

/**
 * 校验 web_fetch 目标 URL 是否允许访问。
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

  const ipVer = isIP(host)
  if (ipVer && isPrivateOrBlockedIp(host)) {
    return { ok: false, reason: `禁止访问内网或保留 IP：${host}` }
  }

  return { ok: true, url }
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
