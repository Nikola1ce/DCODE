// 终端 Markdown 轻量渲染器。
// 背景：LLM（deepseek / 智谱 等）回复几乎总是 Markdown，含 **加粗**、`代码`、### 标题、- 列表 等标记。
// 而本 CLI 早期把正文按纯文本原样 <Text> 输出，导致这些标记符号（尤其大量 **）直接裸露在终端里，
// 既不美观也干扰阅读（用户反馈「输出里出现大量 **」）。
//
// 本模块把单行文本解析为带样式的 Ink <Text> 片段：消除裸标记符号，同时保留「加粗 / 斜体 / 行内代码 /
// 删除线 / 标题 / 列表 / 引用」的视觉层次（与 Claude Code、Codex 等终端 AI 工具一致）。
//
// 设计取舍：
//   - 仅做「行内 + 行首」级别的轻量解析，不实现完整 CommonMark（终端无需表格/嵌套块的精确语义）。
//   - 解析为纯数据 token（parseInlineMarkdown），与 React 渲染（renderInlineTokens）分离，便于单测。
//   - 逐行处理：调用方按 \n 切行后对每行调用 renderMarkdownLine，天然适配本项目「按行落 Static」的流式架构。
// 制作人：Moriarty_Dox

import React from 'react'
import { Text } from 'ink'
import type { Theme } from './theme.js'

// 一个行内片段 token：一段文本 + 其样式标记。
export interface InlineToken {
  // 片段文本（已剥离 Markdown 标记符号）。
  text: string
  // 加粗（**x** 或 __x__）。
  bold?: boolean
  // 斜体（*x* 或 _x_）。
  italic?: boolean
  // 行内代码（`x`）：渲染为强调色，提示其为代码/字面量。
  code?: boolean
  // 删除线（~~x~~）。
  strike?: boolean
}

// 行内标记的匹配规则：按「先长后短、先强后弱」顺序尝试，避免 ** 被 * 抢先匹配。
// 每条规则给出开闭定界符与对应样式；正文部分按非定界符贪婪截取到闭合符前。
interface InlineRule {
  // 定界符（开闭相同）。
  delim: string
  // 命中后施加的样式补丁。
  style: Partial<InlineToken>
}

// 注意顺序：必须「先长后短」尝试，否则短定界符会抢先匹配长定界符的一部分：
//   - *** / ___（加粗+斜体）排最前，避免被 ** 或 * 拆碎（三连星号歧义）；
//   - ** / __ / ~~ 双字符定界符次之，避免 **bold** 被单星规则误拆；
//   - * / _ 单字符定界符最后。
const INLINE_RULES: InlineRule[] = [
  { delim: '***', style: { bold: true, italic: true } },
  { delim: '___', style: { bold: true, italic: true } },
  { delim: '**', style: { bold: true } },
  { delim: '__', style: { bold: true } },
  { delim: '~~', style: { strike: true } },
  { delim: '*', style: { italic: true } },
  { delim: '_', style: { italic: true } },
]

/**
 * 把一行文本解析为行内 token 序列。
 *
 * 解析规则（终端轻量版）：
 *   - 反引号 `code` 优先级最高：其内部内容原样保留、不再二次解析（符合 Markdown 语义）。
 *   - **加粗** / __加粗__、*斜体* / _斜体_、~~删除线~~：成对定界符之间的内容套用对应样式，
 *     且支持简单叠加（例如 ***x*** 会先匹配 ** 再匹配 * → 加粗+斜体）。
 *   - 落单的、找不到闭合符的定界符按普通文本输出（不吞字符），保证健壮、不丢内容。
 *
 * 该函数为纯函数（不依赖 React / 主题），便于单测。
 * @param line 单行文本（不应包含换行符）。
 * @returns 行内 token 序列；相邻同样式片段不强制合并（渲染层各自成 <Text>，对结果无影响）。
 */
export function parseInlineMarkdown(line: string): InlineToken[] {
  return parseInlineWithStyle(line, {})
}

/**
 * 在给定「继承样式」下解析一段文本（递归核心）。
 * @param input 待解析文本。
 * @param inherited 外层已施加的样式（用于支持 **_x_** 这类嵌套叠加）。
 * @returns token 序列。
 */
function parseInlineWithStyle(input: string, inherited: Partial<InlineToken>): InlineToken[] {
  const tokens: InlineToken[] = []
  // 当前普通文本累积缓冲（遇到标记或结束时冲刷为一个 token）。
  let buf = ''
  let i = 0

  const flushBuf = (): void => {
    if (buf) {
      tokens.push({ text: buf, ...inherited })
      buf = ''
    }
  }

  while (i < input.length) {
    const ch = input[i]

    // 行内代码：` 之间的内容原样保留、不二次解析。
    if (ch === '`') {
      const close = input.indexOf('`', i + 1)
      if (close > i) {
        flushBuf()
        tokens.push({ text: input.slice(i + 1, close), ...inherited, code: true })
        i = close + 1
        continue
      }
      // 没有闭合反引号：当普通字符处理。
      buf += ch
      i++
      continue
    }

    // 行内强调定界符（** / __ / ~~ / * / _）。
    const rule = matchRuleAt(input, i)
    if (rule) {
      const closeIdx = findClosingDelim(input, i + rule.delim.length, rule.delim)
      if (closeIdx >= 0) {
        flushBuf()
        const inner = input.slice(i + rule.delim.length, closeIdx)
        // 递归解析内部，支持样式叠加（如 **`code`** / ***x***）。
        tokens.push(...parseInlineWithStyle(inner, { ...inherited, ...rule.style }))
        i = closeIdx + rule.delim.length
        continue
      }
      // 找不到闭合：定界符按普通文本输出，不吞后续字符。
      buf += rule.delim
      i += rule.delim.length
      continue
    }

    buf += ch
    i++
  }

  flushBuf()
  return tokens
}

/**
 * 在 input 的 pos 处尝试匹配一条行内规则（按 INLINE_RULES 的优先级）。
 * @param input 文本。
 * @param pos 位置。
 * @returns 命中的规则或 null。
 */
function matchRuleAt(input: string, pos: number): InlineRule | null {
  for (const rule of INLINE_RULES) {
    if (input.startsWith(rule.delim, pos)) return rule
  }
  return null
}

/**
 * 从 from 起查找与 delim 配对的闭合定界符位置。
 * 约束：闭合符前必须有至少一个字符（避免把 **** 解析成空内容），且需跳过被反引号包裹的区域，
 * 以免把代码里的 * 误判为闭合符。
 * @param input 文本。
 * @param from 起始查找位置（开定界符之后）。
 * @param delim 定界符。
 * @returns 闭合定界符的起始下标；找不到返回 -1。
 */
function findClosingDelim(input: string, from: number, delim: string): number {
  let i = from
  while (i < input.length) {
    // 跳过行内代码区段，避免其中的 * / _ 干扰配对。
    if (input[i] === '`') {
      const close = input.indexOf('`', i + 1)
      if (close < 0) break
      i = close + 1
      continue
    }
    if (input.startsWith(delim, i)) {
      // 内容非空才算有效配对。
      if (i > from) return i
      // 紧贴开符的空配对（如 ****）：跳过这一个，继续找下一个。
      i += delim.length
      continue
    }
    i++
  }
  return -1
}

/**
 * 把行内 token 序列渲染为 Ink <Text> 片段。
 * @param tokens 由 parseInlineMarkdown 得到的 token。
 * @param theme 当前主题（行内代码用强调色）。
 * @param keyPrefix React key 前缀（避免同级重复）。
 * @returns <Text> 片段数组。
 */
export function renderInlineTokens(
  tokens: InlineToken[],
  theme: Theme,
  keyPrefix = 'i',
): React.ReactNode[] {
  return tokens.map((t, idx) => (
    <Text
      key={`${keyPrefix}-${idx}`}
      bold={t.bold}
      italic={t.italic}
      strikethrough={t.strike}
      color={t.code ? theme.accent : undefined}
    >
      {t.text}
    </Text>
  ))
}

// 块级行首标记的解析结果。
interface BlockLine {
  // 行首装饰前缀（已转为终端友好符号，如标题去掉 #、列表用 •、引用用 │）。
  prefix: string
  // 前缀颜色（取主题槽位名）；为空时用默认正文色。
  prefixColor?: keyof Theme
  // 去掉行首标记后的剩余正文（仍需行内解析）。
  body: string
  // 整行是否套用加粗（标题）。
  bold?: boolean
  // 整行正文颜色覆盖（标题用主色）；为空时正文用默认色。
  bodyColor?: keyof Theme
}

/**
 * 解析一行的「行首块级标记」（标题 / 列表 / 引用 / 分隔线），返回装饰前缀与剩余正文。
 * 不命中任何块级标记时，prefix 为空、body 为原行。
 * @param line 单行文本。
 * @returns 块级解析结果。
 */
function parseBlockLine(line: string): BlockLine {
  // 水平分隔线：--- / *** / ___（整行仅由 3+ 个该字符组成）。
  if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
    return { prefix: '─'.repeat(Math.max(8, Math.min(40, line.trim().length))), prefixColor: 'dim', body: '' }
  }

  // ATX 标题：# ~ ###### 后跟空格。去掉 # 标记，整行加粗 + 主色，以层级感替代裸 # 符号。
  const heading = /^(#{1,6})\s+(.*)$/.exec(line)
  if (heading) {
    return { prefix: '', body: heading[2], bold: true, bodyColor: 'primary' }
  }

  // 引用块：> 文本。用左侧竖线 │ 替代裸 >，正文弱化为 dim。
  const quote = /^\s*>\s?(.*)$/.exec(line)
  if (quote) {
    return { prefix: '│ ', prefixColor: 'dim', body: quote[1], bodyColor: 'dim' }
  }

  // 无序列表：-, *, + 后跟空格。统一用 • 圆点，保留原缩进层级。
  const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line)
  if (ul) {
    return { prefix: `${ul[1]}• `, prefixColor: 'accent', body: ul[2] }
  }

  // 有序列表：1. / 1) 后跟空格。保留数字，仅规整为「n. 」。
  const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
  if (ol) {
    return { prefix: `${ol[1]}${ol[2]}. `, prefixColor: 'accent', body: ol[3] }
  }

  return { prefix: '', body: line }
}

// renderMarkdownLine 的入参。
interface MarkdownLineProps {
  // 单行文本（不含换行符）。
  line: string
  // 当前主题。
  theme: Theme
}

/**
 * 渲染一行 Markdown（块级行首标记 + 行内强调）为 Ink 元素。
 *
 * 用法：调用方将多行文本按 \n 切分后，逐行用本组件渲染（每行一个 <Text> 容器）。
 * 空行交给调用方处理（通常渲染为占位空行）。
 * @param props 入参。
 * @returns 单行 JSX。
 */
export function MarkdownLine({ line, theme }: MarkdownLineProps): React.ReactElement {
  const block = parseBlockLine(line)
  const tokens = parseInlineMarkdown(block.body)
  const bodyColor = block.bodyColor ? theme[block.bodyColor] : theme.text
  return (
    <Text color={bodyColor} bold={block.bold}>
      {block.prefix ? (
        <Text color={block.prefixColor ? theme[block.prefixColor] : undefined}>{block.prefix}</Text>
      ) : null}
      {renderInlineTokens(tokens, theme)}
    </Text>
  )
}

/**
 * 把一行 Markdown 还原为「终端实际显示的纯文本」：剥离所有行内标记（** ` * ~~ 等），
 * 并把行首块级标记替换为终端友好符号（# 标题去标记、列表用 •、引用用 │、分隔线用 ─）。
 *
 * 用途：单测断言「用户不会再看到裸标记符号」，以及未来用于复制/日志等需要纯文本的场景。
 * @param line 单行文本。
 * @returns 去标记后的纯展示文本。
 */
export function mdLineToPlainText(line: string): string {
  const block = parseBlockLine(line)
  const body = parseInlineMarkdown(block.body)
    .map((t) => t.text)
    .join('')
  return `${block.prefix}${body}`
}

/**
 * 去掉行尾「未闭合」的 Markdown 定界符（流式分块时常见）。
 * 避免 chunk 边界把 `**`、`` ` `` 等裸露在终端里；完整闭合后下一 chunk 会正常解析。
 * @param line 单行文本。
 * @returns 清理后的行。
 */
export function sanitizeIncompleteMarkdownTail(line: string): string {
  let s = line
  for (const delim of ['**', '__', '~~'] as const) {
    let count = 0
    let i = 0
    let lastUnpaired = -1
    while (i <= s.length - delim.length) {
      if (s.startsWith(delim, i)) {
        count++
        lastUnpaired = count % 2 === 1 ? i : -1
        i += delim.length
      } else {
        i++
      }
    }
    if (count % 2 === 1 && lastUnpaired >= 0) {
      s = s.slice(0, lastUnpaired) + s.slice(lastUnpaired + delim.length)
    }
  }
  const tickCount = (s.match(/`/g) ?? []).length
  if (tickCount % 2 === 1) {
    const last = s.lastIndexOf('`')
    s = s.slice(0, last) + s.slice(last + 1)
  }
  return s
}

/**
 * 把一段（可能多行）Markdown 文本渲染为按行排列的 Ink 元素数组。
 * 每行独立成行；空行渲染为占位空行（保留段落间距）。
 * @param text 多行文本。
 * @param theme 当前主题。
 * @param keyPrefix React key 前缀。
 * @returns 行元素数组。
 */
export function renderMarkdownBlock(
  text: string,
  theme: Theme,
  keyPrefix = 'md',
): React.ReactNode[] {
  return text.split('\n').map((line, idx) =>
    line === '' ? (
      <Text key={`${keyPrefix}-${idx}`}> </Text>
    ) : (
      <MarkdownLine key={`${keyPrefix}-${idx}`} line={line} theme={theme} />
    ),
  )
}
