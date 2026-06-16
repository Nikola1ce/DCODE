// Markdown 行内解析器单测。
// 重点验证用户反馈的核心问题：正文中的 ** 等 Markdown 标记不再裸露，而是被解析为样式片段；
// 同时覆盖行内代码、斜体、删除线、嵌套叠加，以及「落单定界符不吞字符」的健壮性。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import { parseInlineMarkdown, mdLineToPlainText } from './markdown.js'

/** 把 token 序列还原为纯文本（用于断言「标记符号已被剥离、内容无损」）。 */
function plain(line: string): string {
  return parseInlineMarkdown(line)
    .map((t) => t.text)
    .join('')
}

describe('parseInlineMarkdown', () => {
  it('剥离 ** 加粗标记并标记 bold，纯文本不含 **', () => {
    const tokens = parseInlineMarkdown('这是 **高内聚、低耦合** 的代码')
    const text = tokens.map((t) => t.text).join('')
    expect(text).toBe('这是 高内聚、低耦合 的代码')
    expect(text).not.toContain('**')
    const bold = tokens.find((t) => t.bold)
    expect(bold?.text).toBe('高内聚、低耦合')
  })

  it('一行内多个 ** 加粗都被剥离', () => {
    const text = plain('**可维护性强**——改动局部不影响全局')
    expect(text).toBe('可维护性强——改动局部不影响全局')
    expect(text).not.toContain('*')
  })

  it('支持 __ 作为加粗定界符', () => {
    const tokens = parseInlineMarkdown('__OOP__ 范式')
    expect(tokens.find((t) => t.bold)?.text).toBe('OOP')
    expect(plain('__OOP__ 范式')).toBe('OOP 范式')
  })

  it('解析 *斜体* 与 _斜体_', () => {
    expect(parseInlineMarkdown('*emphasis*').find((t) => t.italic)?.text).toBe('emphasis')
    expect(parseInlineMarkdown('_emphasis_').find((t) => t.italic)?.text).toBe('emphasis')
  })

  it('行内代码 `x` 内部不二次解析、标记 code', () => {
    const tokens = parseInlineMarkdown('调用 `arr.map(*x*)` 方法')
    const code = tokens.find((t) => t.code)
    expect(code?.text).toBe('arr.map(*x*)')
    // 代码内的 * 不应被当作斜体
    expect(tokens.some((t) => t.italic)).toBe(false)
    expect(plain('调用 `arr.map(*x*)` 方法')).toBe('调用 arr.map(*x*) 方法')
  })

  it('解析 ~~删除线~~', () => {
    expect(parseInlineMarkdown('~~过时~~ 内容').find((t) => t.strike)?.text).toBe('过时')
  })

  it('***x*** 同时加粗与斜体', () => {
    const tokens = parseInlineMarkdown('***重点***')
    const t = tokens.find((x) => x.text === '重点')
    expect(t?.bold).toBe(true)
    expect(t?.italic).toBe(true)
  })

  it('**`code`** 同时加粗且为代码', () => {
    const tokens = parseInlineMarkdown('**`npm i`**')
    const t = tokens.find((x) => x.text === 'npm i')
    expect(t?.bold).toBe(true)
    expect(t?.code).toBe(true)
  })

  it('落单的 * 不吞后续字符，按普通文本保留', () => {
    expect(plain('2 * 3 = 6')).toBe('2 * 3 = 6')
  })

  it('未闭合的 ** 原样保留，不丢内容', () => {
    expect(plain('未闭合 **加粗 后面文本')).toBe('未闭合 **加粗 后面文本')
  })

  it('空配对 **** 不产生空内容、原样保留', () => {
    expect(plain('a****b')).toBe('a****b')
  })

  it('纯文本无标记时原样返回为单 token', () => {
    const tokens = parseInlineMarkdown('普通中文文本，无任何标记')
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toEqual({ text: '普通中文文本，无任何标记' })
  })

  it('空字符串返回空 token 数组', () => {
    expect(parseInlineMarkdown('')).toEqual([])
  })
})

describe('mdLineToPlainText（块级标记 → 终端可见纯文本）', () => {
  it('ATX 标题去掉 # 标记', () => {
    expect(mdLineToPlainText('### 优点')).toBe('优点')
    expect(mdLineToPlainText('# 标题')).toBe('标题')
    expect(mdLineToPlainText('###### 六级')).toBe('六级')
  })

  it('无序列表 - / * / + 统一为 • 圆点', () => {
    expect(mdLineToPlainText('- 复用性高')).toBe('• 复用性高')
    expect(mdLineToPlainText('* 第二项')).toBe('• 第二项')
    expect(mdLineToPlainText('+ 第三项')).toBe('• 第三项')
  })

  it('有序列表保留序号并规整为 n. ', () => {
    expect(mdLineToPlainText('1) 第一')).toBe('1. 第一')
    expect(mdLineToPlainText('2. 第二')).toBe('2. 第二')
  })

  it('引用块 > 用左竖线替代', () => {
    expect(mdLineToPlainText('> 引用内容')).toBe('│ 引用内容')
  })

  it('列表项内部仍剥离行内 ** 标记', () => {
    expect(mdLineToPlainText('- **可维护性强**——改动局部不影响全局')).toBe(
      '• 可维护性强——改动局部不影响全局',
    )
  })

  it('表格行中的 ** 也被剥离（不再裸露）', () => {
    const out = mdLineToPlainText('| **OOP** | 对象、类 | 大型系统 |')
    expect(out).not.toContain('**')
    expect(out).toContain('OOP')
  })

  it('分隔线 --- 渲染为横线且不含原标记', () => {
    const out = mdLineToPlainText('---')
    expect(out).not.toContain('---')
    expect(out.startsWith('─')).toBe(true)
  })
})
