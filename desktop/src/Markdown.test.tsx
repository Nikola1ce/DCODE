// Markdown 的可读布局和 HTML/外部资源边界回归。
// 制作人：Moriarty_Dox
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from './Markdown.js'

describe('回复 Markdown', () => {
  it('展示标题、列表、表格与可复制的代码块', () => {
    const html = renderToStaticMarkup(<Markdown text={'## 结果\n\n- 完成检查\n\n| 文件 | 状态 |\n| --- | --- |\n| app.ts | 通过 |\n\n```ts\nconst value = 1\n```'} />)
    expect(html).toContain('<h2>结果</h2>')
    expect(html).toContain('<li>完成检查</li>')
    expect(html).toContain('<table>')
    expect(html).toContain('复制代码')
    expect(html).toContain('const value = 1')
  })
  it('禁止原始 HTML 执行和远程图片加载，代码中的标签保持转义', () => {
    const html = renderToStaticMarkup(<Markdown text={'<script>alert(1)</script>\n\n<img src="file:///private" onerror="alert(1)" />\n\n![图](https://example.invalid/tracker)\n\n```html\n<script>test</script>\n```'} />)
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('onerror=')
    expect(html).toContain('&lt;script&gt;test&lt;/script&gt;')
  })
  it('外部引用通过复制链接使用，协议脚本不生成可导航元素', () => {
    const html = renderToStaticMarkup(<Markdown text={'[文档](https://example.com/docs)\n\n[脚本](javascript:alert%281%29)'} />)
    expect(html).not.toContain('href=')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('复制链接')
    expect(html).toContain('https://example.com/docs')
  })
})
