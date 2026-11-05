// 服务入口的窄类型校验，拒绝路径别名、额外属性和原型键。
// 制作人：Moriarty_Dox
import { DesktopFault } from '../errors.js'

export function invalid(): never {
  throw new DesktopFault('INVALID_ARGUMENT', '服务参数不合法。')
}

export function relativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && value === '') return ''
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:\x00-\x1f]/.test(value)) invalid()
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) invalid()
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    throw new DesktopFault('FORBIDDEN', 'Git 元数据通过专用服务访问。')
  }
  return value
}

export function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) invalid()
  return value
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid()
  return value
}

export function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some((key) => !keys.includes(key))) invalid()
  return value as Record<string, unknown>
}
