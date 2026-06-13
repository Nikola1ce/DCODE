// IDE IPC 协议单元测试。
// 覆盖：消息编解码、按行流式解码器对「半行 / 多行 / 跨 chunk / 空行 / 非法 JSON」的处理。

import { describe, expect, it } from 'vitest'
import {
  IDE_PROTOCOL_VERSION,
  createLineDecoder,
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol.js'

describe('encodeMessage / decodeMessage', () => {
  it('编码为单行 JSON 且以换行结尾', () => {
    const msg: ServerMessage = { type: 'text', requestId: 'r1', delta: 'hi' }
    const line = encodeMessage(msg)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.includes('\n')).toBe(true)
    // 去掉换行后应是合法 JSON，且不含内部换行。
    const body = line.slice(0, -1)
    expect(body.includes('\n')).toBe(false)
    expect(JSON.parse(body)).toEqual(msg)
  })

  it('round-trip：编码后再解码得到等价对象', () => {
    const msg: ClientMessage = {
      type: 'prompt',
      requestId: 'abc',
      text: '写一个快排',
    }
    const decoded = decodeMessage<ClientMessage>(encodeMessage(msg).trim())
    expect(decoded).toEqual(msg)
  })

  it('空行与非法 JSON 返回 null', () => {
    expect(decodeMessage('')).toBeNull()
    expect(decodeMessage('   ')).toBeNull()
    expect(decodeMessage('{not json')).toBeNull()
    // 合法 JSON 但缺少 type 字段也视为非法协议消息。
    expect(decodeMessage('{"foo":1}')).toBeNull()
  })

  it('协议版本号为正整数', () => {
    expect(Number.isInteger(IDE_PROTOCOL_VERSION)).toBe(true)
    expect(IDE_PROTOCOL_VERSION).toBeGreaterThan(0)
  })
})

describe('createLineDecoder', () => {
  it('单 chunk 含多条完整消息时全部解析', () => {
    const decoder = createLineDecoder<ServerMessage>()
    const a: ServerMessage = { type: 'text', requestId: 'r', delta: 'a' }
    const b: ServerMessage = { type: 'text', requestId: 'r', delta: 'b' }
    const out = decoder.push(encodeMessage(a) + encodeMessage(b))
    expect(out).toEqual([a, b])
  })

  it('跨 chunk 的半行被正确拼接', () => {
    const decoder = createLineDecoder<ServerMessage>()
    const msg: ServerMessage = { type: 'text', requestId: 'r', delta: 'hello' }
    const full = encodeMessage(msg)
    const mid = Math.floor(full.length / 2)
    // 第一段不含换行 → 无输出。
    expect(decoder.push(full.slice(0, mid))).toEqual([])
    // 第二段补齐 → 解析出完整消息。
    expect(decoder.push(full.slice(mid))).toEqual([msg])
  })

  it('多条消息被拆在任意 chunk 边界仍能正确还原顺序', () => {
    const decoder = createLineDecoder<ServerMessage>()
    const msgs: ServerMessage[] = [
      { type: 'tool_start', requestId: 'r', toolCallId: 't1', name: 'read_file', summary: '读取 a' },
      { type: 'tool_end', requestId: 'r', toolCallId: 't1', name: 'read_file', isError: false },
      { type: 'turn_done', requestId: 'r', reason: 'final', costUsd: 0 },
    ]
    const blob = msgs.map(encodeMessage).join('')
    // 按每 7 字节切片喂入，模拟 stdout 任意分片。
    const collected: ServerMessage[] = []
    for (let i = 0; i < blob.length; i += 7) {
      collected.push(...decoder.push(blob.slice(i, i + 7)))
    }
    expect(collected).toEqual(msgs)
  })

  it('忽略空行与非法行，只产出合法消息', () => {
    const decoder = createLineDecoder<ServerMessage>()
    const good: ServerMessage = { type: 'log', level: 'info', message: 'ok' }
    const input = '\n' + '{bad json\n' + '{"foo":1}\n' + encodeMessage(good)
    expect(decoder.push(input)).toEqual([good])
  })

  it('接受 Buffer 输入（UTF-8 中文不乱码）', () => {
    const decoder = createLineDecoder<ServerMessage>()
    const msg: ServerMessage = { type: 'text', requestId: 'r', delta: '你好，世界' }
    const buf = Buffer.from(encodeMessage(msg), 'utf8')
    expect(decoder.push(buf)).toEqual([msg])
  })
})
