// 安全 Markdown 展示，代码可复制，外部图片显示替代文本。
// 制作人：Moriarty_Dox
import { isValidElement, memo, useDeferredValue } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CopyButton } from './CopyButton.js'

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children.props : null
  const text = String(code?.children ?? '').replace(/\n$/, '')
  const language = code?.className?.replace('language-', '') ?? '代码'
  return <div className="code-block"><div className="code-toolbar"><span>{language}</span><CopyButton text={text} label="复制代码" /></div><pre>{children}</pre></div>
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const content = useDeferredValue(text)
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    img: ({ alt }) => <span className="muted">{alt || '图片'}</span>,
    a: ({ href, children }) => <span className="markdown-link" title={href}>{children}{href && <CopyButton text={href} label="复制链接" compact />}</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{content}</ReactMarkdown></div>
})
