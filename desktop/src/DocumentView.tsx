// 文件、Git 差异与审阅共用的编辑器展示区。
// 制作人：Moriarty_Dox
import { useMemo, useState } from 'react'
import { diffRows, pairedDiffRows } from './diffModel.js'
import type { TextDiff } from '../shared/services.js'
import { useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'
import { CopyButton } from './CopyButton.js'

export interface DocumentPreview {
  title: string; text: string; diff?: boolean; truncated?: boolean
  reload?: () => Promise<TextDiff>
  review?: { sessionId: string; checkpointId: string }
}

export function DocumentView({ document, revision = 0 }: { document: DocumentPreview; revision?: number }) {
  const [split, setSplit] = useState(true)
  const [metadata, setMetadata] = useState(false)
  const latest = useResource(`${document.title}:${revision}`, () => document.reload ? document.reload() : Promise.resolve({ text: document.text, truncated: !!document.truncated }))
  const text = latest.error ? '' : latest.value?.text ?? document.text
  const rows = useMemo(() => diffRows(text).filter((row) => metadata || row.kind !== 'meta' || !/^(index |--- |\+\+\+ |$)/.test(row.text)), [text, metadata])
  const pairs = useMemo(() => pairedDiffRows(rows), [rows])
  return <section className="document-view" aria-label="文件预览">
    <div className="document-toolbar"><span className="path">{document.title}</span><div className="document-actions">
      <CopyButton text={text} label={document.diff ? '复制差异' : '复制文件内容'} compact />
      {document.diff && <><button aria-pressed={metadata} title="显示补丁元信息" onClick={() => setMetadata(!metadata)}><Icon name="info" size={14} /></button><button onClick={() => setSplit(!split)}><Icon name="sidebar" size={14} />{split ? '统一视图' : '并排视图'}</button></>}
    </div>
    </div>
    {latest.error && <p className="inline-error" role="alert">{latest.error}</p>}
    {(latest.value?.truncated ?? document.truncated) && <p className="inline-notice">内容较大，当前显示部分预览。</p>}
    {document.diff ? <div className={`diff-view ${split ? 'split' : 'unified'}`}>
      {split && <div className="diff-head"><span>更改前</span><span>更改后</span></div>}
      {split ? pairs.map((pair, index) => pair.meta !== undefined
        ? <div className="diff-meta" key={index}>{pair.meta || ' '}</div>
        : <div className="diff-row" key={index}>
          <div className={pair.left?.kind ?? 'empty-cell'}><span className="line-number">{pair.left?.oldLine}</span><code>{pair.left?.text || ' '}</code></div>
          <div className={pair.right?.kind ?? 'empty-cell'}><span className="line-number">{pair.right?.newLine}</span><code>{pair.right?.text || ' '}</code></div>
        </div>) : rows.map((row, index) => row.kind === 'meta'
        ? <div className="diff-meta" key={index}>{row.text || ' '}</div>
        : <div className={`diff-row ${row.kind}`} key={index}>
          <span className="line-number">{row.oldLine}</span><span className="line-number">{row.newLine}</span><code>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '} {row.text || ' '}</code>
        </div>)}
      {!text && <p className="empty-panel">当前没有文本差异。</p>}
    </div> : <pre className="file-content">{text}</pre>}
  </section>
}
