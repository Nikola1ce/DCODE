// 文件、Git 差异与审阅共用的编辑器展示区。
// 制作人：Moriarty_Dox
import { useEffect, useMemo, useRef, useState } from 'react'
import type { DiffRow } from './diffModel.js'
import { diffRows, pairedDiffRows } from './diffModel.js'
import type { TextDiff } from '../shared/services.js'
import { unwrap, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'
import { CopyButton } from './CopyButton.js'

export interface ChatReference {
  path: string
  line?: number
  endLine?: number
  snippet?: string
  comment?: string
  source?: string
}
export type AddReference = (reference: ChatReference) => boolean

export function referenceLabel(ref: ChatReference) {
  return ref.path + (ref.line ? ':' + ref.line : '') + (ref.endLine && ref.endLine !== ref.line ? '–' + ref.endLine : '')
}

export interface DocumentPreview {
  title: string; text: string; diff?: boolean; truncated?: boolean
  revealLine?: number
  diffPath?: string
  filePath?: string
  reload?: () => Promise<TextDiff>
  review?: { sessionId: string; checkpointId: string }
}

export function filePreview(path: string): DocumentPreview {
  return { title: path, filePath: path, text: '', reload: async () => {
    const file = await unwrap(window.dcode.readFile(path))
    return file.kind === 'text' ? { text: file.text, truncated: file.truncated }
      : { text: `二进制文件 · ${file.size.toLocaleString()} 字节`, truncated: false }
  } }
}

export function DocumentView({ document, revision = 0, addReference }: { document: DocumentPreview; revision?: number; addReference?: AddReference }) {
  const [split, setSplit] = useState(true)
  const [metadata, setMetadata] = useState(false)
  const latest = useResource(`${document.title}:${revision}`, () => document.reload ? document.reload() : Promise.resolve({ text: document.text, truncated: !!document.truncated }))
  const text = latest.error ? '' : latest.value?.text ?? document.text
  const rows = useMemo(() => document.diff ? diffRows(text).filter((row) => metadata || row.kind !== 'meta' || !/^(index |--- |\+\+\+ |$)/.test(row.text)) : [], [text, metadata, document.diff])
  const pairs = useMemo(() => split ? pairedDiffRows(rows) : [], [rows, split])
  const file = useRef<HTMLPreElement>(null)
  const [lineComment, setLineComment] = useState<ChatReference | null>(null)
  const [comment, setComment] = useState('')
  const [selection, setSelection] = useState<ChatReference | null>(null)
  useEffect(() => {
    const readSelection = () => {
      const selected = window.getSelection()
      const range = selected?.rangeCount ? selected.getRangeAt(0) : null
      const el = file.current
      if (!el || !document.filePath || !range || range.collapsed || !el.contains(range.commonAncestorContainer)) {
        setSelection(null)
        return
      }
      const prefix = range.cloneRange()
      prefix.selectNodeContents(el)
      prefix.setEnd(range.startContainer, range.startOffset)
      const line = prefix.toString().split('\n').length
      const snippet = range.toString()
      setSelection({ path: document.filePath, line, endLine: line + snippet.replace(/\n$/, '').split('\n').length - 1, snippet })
    }
    window.document.addEventListener('selectionchange', readSelection)
    return () => window.document.removeEventListener('selectionchange', readSelection)
  }, [document.filePath])
  useEffect(() => {
    if (file.current && document.revealLine && text) {
      file.current.scrollTop = (document.revealLine - 1) * parseFloat(getComputedStyle(file.current).lineHeight)
    }
  }, [document, text])
  function gutter(row: DiffRow | undefined, side: 'old' | 'new') {
    const number = side === 'old' ? row?.oldLine : row?.newLine
    if (!row || number === undefined || !addReference) return <span className="line-number">{number}</span>
    return <button className="line-number" title={`评论${side === 'old' ? '原' : '新'}文件第 ${number} 行`} onClick={() => {
      setLineComment({ path: document.diffPath ?? row.file ?? document.title, line: number, snippet: row.text,
        source: document.title + (side === 'old' ? ' · 更改前' : ' · 更改后') })
    }}>{number}</button>
  }
  return <section className="document-view" aria-label="文件预览">
    <div className="document-toolbar"><span className="path">{document.title}</span><div className="document-actions">
      {addReference && document.filePath && <button onMouseDown={event => event.preventDefault()} onClick={() => addReference(selection ?? { path: document.filePath! })}>{selection ? '引用选区' : '引用文件'}</button>}
      {text && <CopyButton text={text} label={document.diff ? '复制差异' : '复制文件内容'} compact />}
      {document.diff && <><button aria-pressed={metadata} title="显示补丁元信息" onClick={() => setMetadata(!metadata)}><Icon name="info" size={14} /></button><button onClick={() => setSplit(!split)}><Icon name="sidebar" size={14} />{split ? '统一视图' : '并排视图'}</button></>}
    </div>
    </div>
    {lineComment && <form className="line-comment" onSubmit={event => {
      event.preventDefault()
      if (comment.trim() && addReference?.({ ...lineComment, comment: comment.trim() })) { setLineComment(null); setComment('') }
    }}><label>{referenceLabel(lineComment)}<input autoFocus aria-label="行评论" value={comment} maxLength={2000} onChange={event => setComment(event.target.value)} /></label>
      <button disabled={!comment.trim()}>加入对话草稿</button><button type="button" onClick={() => { setLineComment(null); setComment('') }}>取消</button></form>}
    {latest.error && <p className="inline-error" role="alert">{latest.error}<button onClick={latest.refresh}>重试读取</button></p>}
    {document.filePath && latest.loading && !latest.value && <p className="empty-panel" role="status">正在读取文件…</p>}
    {document.filePath && latest.value && !latest.error && !text && <p className="empty-panel">文件为空</p>}
    {(latest.value?.truncated ?? document.truncated) && <p className="inline-notice">内容较大，当前显示部分预览。</p>}
    {document.diff ? <div className={`diff-view ${split ? 'split' : 'unified'}`}>
      {split && <div className="diff-head"><span>更改前</span><span>更改后</span></div>}
      {split ? pairs.map((pair, index) => pair.meta !== undefined
        ? <div className="diff-meta" key={index}>{pair.meta || ' '}</div>
        : <div className="diff-row" key={index}>
          <div className={pair.left?.kind ?? 'empty-cell'}>{gutter(pair.left, 'old')} <code>{pair.left?.text || ' '}</code></div>
          <div className={pair.right?.kind ?? 'empty-cell'}>{gutter(pair.right, 'new')} <code>{pair.right?.text || ' '}</code></div>
        </div>) : rows.map((row, index) => row.kind === 'meta'
        ? <div className="diff-meta" key={index}>{row.text || ' '}</div>
        : <div className={`diff-row ${row.kind}`} key={index}>
          {gutter(row, 'old')} {gutter(row, 'new')} <code>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '} {row.text || ' '}</code>
        </div>)}
      {!text && <p className="empty-panel">当前没有文本差异。</p>}
    </div> : <pre ref={file} className="file-content">{text}</pre>}
  </section>
}
