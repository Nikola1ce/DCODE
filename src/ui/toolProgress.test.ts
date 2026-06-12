import { describe, expect, it } from 'vitest'
import { appendToolProgress, normalizeToolProgressText } from './toolProgress.js'

describe('normalizeToolProgressText', () => {
  it('移除 ANSI 控制序列和不安全控制字符', () => {
    expect(normalizeToolProgressText('\x1b[31mred\x1b[0m\x07')).toBe('red')
  })

  it('移除 OSC 控制序列', () => {
    expect(normalizeToolProgressText('\x1b]11;#000000\x07done')).toBe('done')
  })

  it('把回车式进度条归一化为换行', () => {
    expect(normalizeToolProgressText('10%\r20%\r\n30%')).toBe('10%\n20%\n30%')
  })
})

describe('appendToolProgress', () => {
  it('追加清洗后的进度并按最大长度保留尾部', () => {
    expect(appendToolProgress('abc', '\x1b[32mdef\x1b[0m', 4)).toBe('cdef')
  })
})
