// 主进程错误的稳定代码与安全序列化；未知异常不会将堆栈或配置带入页面。
// 制作人：Moriarty_Dox
import type { DesktopError, DesktopErrorCode } from '../shared/api.js'

export class DesktopFault extends Error {
  constructor(readonly code: DesktopErrorCode, message: string) {
    super(message)
    this.name = 'DesktopFault'
  }

  toPublic(): DesktopError {
    return { code: this.code, message: this.message }
  }
}

export function publicError(error: unknown): DesktopError {
  return error instanceof DesktopFault
    ? error.toPublic()
    : { code: 'INTERNAL_ERROR', message: '桌面操作失败，请重试；未向页面传递内部异常或配置。' }
}
