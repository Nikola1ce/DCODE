// webUtils 单元测试。
// 覆盖 URL 安全校验、内网 IP 拦截、HTML 正文提取等纯函数逻辑。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  extractBodyText,
  isPrivateOrBlockedIp,
  truncateWebContent,
  validateFetchUrl,
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

  it('拒绝 IPv6 环回', () => {
    expect(validateFetchUrl('http://[::1]/').ok).toBe(false)
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
