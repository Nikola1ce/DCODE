// webUtils 单元测试。
// 覆盖 URL 安全校验、内网 IP 拦截、HTML 正文提取等纯函数逻辑。
// 制作人：Moriarty_Dox

import { describe, expect, it, vi } from 'vitest'
import {
  extractBodyText,
  isPrivateOrBlockedIp,
  truncateWebContent,
  validateFetchUrl,
  withHardTimeout,
} from './webUtils.js'

describe('validateFetchUrl', () => {
  it('允许公开 https URL', () => {
    const r = validateFetchUrl('https://example.com/docs')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.url.hostname).toBe('example.com')
  })

  it('拒绝空 URL', () => {
    expect(validateFetchUrl('').ok).toBe(false)
  })

  it('拒绝 file 协议', () => {
    expect(validateFetchUrl('file:///etc/passwd').ok).toBe(false)
  })

  it('拒绝 localhost', () => {
    expect(validateFetchUrl('http://localhost:8080').ok).toBe(false)
    expect(validateFetchUrl('http://127.0.0.1/').ok).toBe(false)
  })

  it('拒绝内网 IP', () => {
    expect(validateFetchUrl('http://192.168.1.1/').ok).toBe(false)
    expect(validateFetchUrl('http://10.0.0.5/').ok).toBe(false)
    expect(validateFetchUrl('http://172.16.0.1/').ok).toBe(false)
    expect(validateFetchUrl('http://169.254.169.254/').ok).toBe(false)
  })

  it('拒绝十进制整型环回 IP', () => {
    expect(validateFetchUrl('http://2130706433/').ok).toBe(false)
  })

  it('拒绝简写环回 IP', () => {
    expect(validateFetchUrl('http://127.1/').ok).toBe(false)
  })
})

describe('isPrivateOrBlockedIp', () => {
  it('识别 RFC1918 与环回', () => {
    expect(isPrivateOrBlockedIp('127.0.0.1')).toBe(true)
    expect(isPrivateOrBlockedIp('8.8.8.8')).toBe(false)
    expect(isPrivateOrBlockedIp('1.1.1.1')).toBe(false)
  })
})

describe('extractBodyText', () => {
  it('提取 body 并移除 script/style', () => {
    const html = `<!DOCTYPE html><html><head><title>T</title></head><body>
      <script>alert(1)</script>
      <style>.x{color:red}</style>
      <h1>Hello</h1><p>World &amp; DCODE</p>
    </body></html>`
    const text = extractBodyText(html)
    expect(text).toContain('Hello')
    expect(text).toContain('World & DCODE')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
  })

  it('无 body 标签时处理整段 HTML', () => {
    const text = extractBodyText('<div>Plain <b>text</b></div>')
    expect(text).toContain('Plain text')
  })
})

describe('truncateWebContent', () => {
  it('超出上限时附加截断提示', () => {
    const out = truncateWebContent('abcdef', 3)
    expect(out).toContain('abc')
    expect(out).toContain('已截断')
  })
})

describe('withHardTimeout（网络硬超时护栏）', () => {
  it('业务在超时前完成：返回 timedOut:false 与结果', async () => {
    const r = await withHardTimeout(Promise.resolve(42), 1000)
    expect(r).toEqual({ timedOut: false, value: 42 })
  })

  it('业务永久挂起：到时返回 timedOut:true 并触发 onTimeout', async () => {
    const onTimeout = vi.fn()
    // 一个永不 resolve 的 Promise，模拟卡死的 reader.read()。
    const hung = new Promise<number>(() => {})
    const r = await withHardTimeout(hung, 20, onTimeout)
    expect(r).toEqual({ timedOut: true })
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('timeoutMs<=0 时不加超时，直接等待原 Promise', async () => {
    const r = await withHardTimeout(Promise.resolve('ok'), 0)
    expect(r).toEqual({ timedOut: false, value: 'ok' })
  })

  it('onTimeout 抛错不影响超时返回', async () => {
    const hung = new Promise<number>(() => {})
    const r = await withHardTimeout(hung, 20, () => {
      throw new Error('release failed')
    })
    expect(r).toEqual({ timedOut: true })
  })

  it('abort 信号触发时立即返回 aborted:true（不等硬超时）', async () => {
    const onTimeout = vi.fn()
    const hung = new Promise<number>(() => {})
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    const start = Date.now()
    // 硬超时设很大（5s），但 abort 应让其在 ~10ms 立即返回。
    const r = await withHardTimeout(hung, 5000, onTimeout, controller.signal)
    expect(r).toEqual({ timedOut: true, aborted: true })
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  it('signal 已处于 aborted 时立即返回', async () => {
    const controller = new AbortController()
    controller.abort()
    const hung = new Promise<number>(() => {})
    const r = await withHardTimeout(hung, 5000, undefined, controller.signal)
    expect(r).toEqual({ timedOut: true, aborted: true })
  })
})
