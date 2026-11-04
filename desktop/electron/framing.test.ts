// NDJSON 字节边界、UTF-8、尾帧与输入结构约束测试。
// 制作人：Moriarty_Dox
import { describe, expect, it } from 'vitest'
import { NdjsonDecoder, encodeFrame } from './framing.js'
import { decodeServerMessage, normalizeCapabilities, requireCapability } from './protocol.js'

describe('有界 NDJSON', () => {
  it('跨任意字节拆分 Unicode，支持 CRLF 与多帧', () => {
    const decoder = new NdjsonDecoder(100)
    const bytes = Buffer.from('{"type":"text","delta":"你好𠮷"}\r\n\n{"type":"log"}\n')
    const result: unknown[] = []
    for (const byte of bytes) result.push(...decoder.push(Buffer.from([byte])))
    expect(result).toEqual([{ type: 'text', delta: '你好𠮷' }, { type: 'log' }])
    decoder.end()
  })

  it('按 UTF-8 字节计限，不是字符长度', () => {
    const decoder = new NdjsonDecoder(16)
    expect(() => [...decoder.push('{"a":"你好世界"}\n')]).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }))
    expect(() => encodeFrame({ a: '你好世界' }, 16)).toThrowError(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }))
  })

  it.each(['oops\n', 'null\n', '[]\n', '"text"\n'])('拒绝非法帧 %s', (frame) => {
    expect(() => [...new NdjsonDecoder().push(frame)]).toThrowError(expect.objectContaining({ code: 'INVALID_FRAME' }))
  })

  it('拒绝无效 UTF-8 和没有换行的尾帧', () => {
    const decoder = new NdjsonDecoder()
    expect(() => [...decoder.push(Buffer.from([0xff, 0x0a]))]).toThrowError(expect.objectContaining({ code: 'INVALID_FRAME' }))
    const partial = new NdjsonDecoder()
    expect([...partial.push('{"type":"ready"}')]).toEqual([])
    expect(() => partial.end()).toThrowError(expect.objectContaining({ code: 'INVALID_FRAME' }))
  })
})

describe('安全协议投影与能力协商', () => {
  it('识别 v5 可选能力，未声明和 v4 均给出稳定不足错误', () => {
    expect(normalizeCapabilities({ historySnapshot: true, rewind: false, apiKey: 'secret' })).toEqual(['historySnapshot'])
    expect(normalizeCapabilities(['historySnapshot', 'historySnapshot', 'bad key'])).toEqual(['historySnapshot'])
    expect(() => requireCapability(5, ['historySnapshot'], 'historySnapshot')).not.toThrow()
    expect(() => requireCapability(4, ['historySnapshot'], 'historySnapshot')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }))
    expect(() => requireCapability(5, [], 'historySnapshot')).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_CAPABILITY' }))
  })

  it('安全忽略不支持的扩展；严格拒绝已消费消息的错误类型', () => {
    expect(decodeServerMessage({ type: 'future_feature', config: 'secret' })).toBeNull()
    expect(() => decodeServerMessage({ type: 'text', requestId: 'turn-1', delta: { bad: true } })).toThrowError(expect.objectContaining({ code: 'INVALID_MESSAGE' }))
    expect(() => decodeServerMessage({ type: 'turn_done', requestId: 'turn-1', reason: 'final', costUsd: -1 })).toThrow()
  })
})
