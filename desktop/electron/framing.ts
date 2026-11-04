// 有界严格 NDJSON 分帧器：按字节计限，完整帧才解 UTF-8，不接受 stdout 日志污染。
// 制作人：Moriarty_Dox
import { TextDecoder } from 'node:util'
import { DesktopFault } from './errors.js'

export const MAX_FRAME_BYTES = 1024 * 1024

export class NdjsonDecoder {
  private readonly buffer: Buffer
  private size = 0
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes')
    this.buffer = Buffer.allocUnsafe(maxBytes)
  }

  *push(chunk: Buffer | string): Generator<unknown> {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      const length = end - offset
      if (this.size + length > this.maxBytes) {
        throw new DesktopFault('FRAME_TOO_LARGE', '内核协议帧超过大小限制，连接已停止。')
      }
      bytes.copy(this.buffer, this.size, offset, end)
      this.size += length
      if (newline === -1) break
      const line = this.buffer.subarray(0, this.size)
      this.size = 0
      offset = newline + 1
      let text: string
      try {
        text = this.utf8.decode(line)
      } catch {
        throw new DesktopFault('INVALID_FRAME', '内核输出不是有效 UTF-8。')
      }
      if (!text.trim()) continue
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new DesktopFault('INVALID_FRAME', '内核 stdout 含非 NDJSON 内容，连接已停止。')
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DesktopFault('INVALID_FRAME', '内核协议帧必须为 JSON 对象。')
      }
      yield value
    }
  }

  end(): void {
    if (this.size !== 0) {
      throw new DesktopFault('INVALID_FRAME', '内核输出在完整 NDJSON 帧结束前中断。')
    }
  }
}

export function encodeFrame(value: unknown, maxBytes = MAX_FRAME_BYTES): string {
  const frame = JSON.stringify(value)
  if (Buffer.byteLength(frame) > maxBytes) {
    throw new DesktopFault('FRAME_TOO_LARGE', '待发送协议帧超过大小限制。')
  }
  return `${frame}\n`
}
