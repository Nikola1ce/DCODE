// 系统剪贴板模块单测。
// 由于真实系统命令（clip/pbcopy/xclip）不适合在 CI 中触达，这里通过注入「测试后端」
// 验证公共 API 的契约：写入透传、空文本短路、读取透传、失败返回 null。
// 制作人：Moriarty_Dox

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ClipboardBackend,
  readClipboard,
  setClipboardBackend,
  writeClipboard,
} from './clipboard.js'

afterEach(() => {
  // 每个用例后复位为默认后端，避免相互影响。
  setClipboardBackend(null)
})

describe('writeClipboard', () => {
  it('把文本透传给后端 write', async () => {
    const write = vi.fn(async () => true)
    setClipboardBackend({ write, read: async () => null })
    const ok = await writeClipboard('hello 你好')
    expect(ok).toBe(true)
    expect(write).toHaveBeenCalledWith('hello 你好')
  })

  it('空文本短路：不调用后端、返回 false', async () => {
    const write = vi.fn(async () => true)
    setClipboardBackend({ write, read: async () => null })
    const ok = await writeClipboard('')
    expect(ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('后端写入失败时返回 false', async () => {
    setClipboardBackend({ write: async () => false, read: async () => null })
    expect(await writeClipboard('x')).toBe(false)
  })
})

describe('readClipboard', () => {
  it('返回后端 read 的文本', async () => {
    setClipboardBackend({ write: async () => true, read: async () => '剪贴板内容' })
    expect(await readClipboard()).toBe('剪贴板内容')
  })

  it('后端读取失败返回 null', async () => {
    setClipboardBackend({ write: async () => true, read: async () => null })
    expect(await readClipboard()).toBeNull()
  })
})

describe('往返一致（写什么读到什么）', () => {
  it('注入一个内存后端，write 后 read 得到同样内容', async () => {
    let mem = ''
    const memoryBackend: ClipboardBackend = {
      write: async (t) => {
        mem = t
        return true
      },
      read: async () => mem,
    }
    setClipboardBackend(memoryBackend)
    await writeClipboard('多行\n文本\ntest')
    expect(await readClipboard()).toBe('多行\n文本\ntest')
  })
})
