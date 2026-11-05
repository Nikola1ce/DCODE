// 源代码管理：暂存分组、路径筛选、批量索引操作、提交与真实父提交拓扑。
// 制作人：Moriarty_Dox
import { useMemo, useState } from 'react'
import type { GitEntry } from '../shared/services.js'
import type { DocumentPreview } from './DocumentView.js'
import { commitGraph } from './diffModel.js'
import { unwrap, useAction, useDraft, useResource } from './serviceHooks.js'

export function SourceControl({ cwd, revision, locked, open }: {
  cwd: string; revision: number; locked: boolean; open(document: DocumentPreview): void
}) {
  const status = useResource(String(revision), () => unwrap(window.dcode.gitStatus()))
  const history = useResource(String(revision), () => unwrap(window.dcode.gitHistory()))
  const action = useAction(() => { status.refresh(); history.refresh() })
  const [message, setMessage] = useDraft(`git:${cwd}`)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState('')
  const [feedback, setFeedback] = useState('')
  const entries = status.value?.entries ?? []
  const conflicts = entries.filter((entry) => entry.index === 'U' || entry.worktree === 'U' || ['AA', 'DD'].includes(entry.index + entry.worktree))
  const staged = entries.filter((entry) => !['.', '?'].includes(entry.index) && !conflicts.includes(entry))
  const changes = entries.filter((entry) => entry.worktree !== '.' && !conflicts.includes(entry))
  const busy = locked || action.busy || status.loading
  const graph = useMemo(() => commitGraph(history.value ?? []), [history.value])

  async function commit() {
    if (busy || !message.trim() || !staged.length || !status.value?.revision) return
    await action.run(async () => {
      const hash = await unwrap(window.dcode.gitCommit(message, status.value!.revision!))
      setMessage('')
      setFeedback(`已提交 ${hash.slice(0, 8)}`)
    })
  }

  function group(title: string, items: GitEntry[], isStaged: boolean) {
    const filtered = items.filter((entry) => entry.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
    return <details className="scm-group" open>
      <summary><span>{title}</span><span className="group-actions">
        <button className="icon-button" disabled={busy || !items.length} title={isStaged ? '取消全部暂存' : '暂存所有更改'} aria-label={isStaged ? '取消全部暂存' : '暂存所有更改'}
          onClick={(event) => { event.preventDefault(); void action.run(() => unwrap(window.dcode.gitStageAll(!isStaged))) }}>{isStaged ? '−' : '+'}</button>
        <span className="count">{items.length}</span></span></summary>
      {filtered.map((entry) => <div key={entry.path} className={`scm-file ${selected === `${isStaged}:${entry.path}` ? 'selected' : ''}`}>
        <button className="file-label" title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
          onClick={() => void action.run(async () => {
            const diff = await unwrap(window.dcode.gitDiff(entry.path, isStaged))
            setSelected(`${isStaged}:${entry.path}`)
            open({ title: `${entry.path} · ${isStaged ? '暂存区' : '工作区'}`, ...diff, diff: true,
              reload: () => unwrap(window.dcode.gitDiff(entry.path, isStaged)) })
          })}>
          <span className="file-symbol">◇</span><span className="file-name">{entry.path.split('/').at(-1)}</span>
          <span className="file-directory">{entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : ''}</span>
        </button>
        <div className="file-actions">
          {!isStaged && <button className="icon-button" title="放弃更改" aria-label={`放弃 ${entry.path} 的更改`} disabled={busy}
            onClick={() => void action.run(() => unwrap(window.dcode.gitDiscard(entry.path)))}>↶</button>}
          <button className="icon-button" title={isStaged ? '取消暂存' : '暂存更改'} aria-label={`${isStaged ? '取消暂存' : '暂存'} ${entry.path}`} disabled={busy}
            onClick={() => void action.run(() => unwrap(window.dcode.gitStage(entry.path, !isStaged)))}>{isStaged ? '−' : '+'}</button>
        </div>
        <span className={`git-letter git-${isStaged ? entry.index : entry.worktree}`}>{isStaged ? entry.index : entry.worktree === '?' ? 'U' : entry.worktree}</span>
      </div>)}
      {!items.length && <p className="group-empty">{isStaged ? '尚未暂存文件' : '工作区没有更改'}</p>}
      {!!items.length && !filtered.length && <p className="group-empty">没有匹配的文件</p>}
    </details>
  }

  return <div className="source-control">
    <div className="panel-heading"><h2>源代码管理</h2><button className="icon-button" aria-label="刷新源代码管理" title="刷新" disabled={action.busy}
      onClick={() => { status.refresh(); history.refresh() }}>↻</button></div>
    {status.error && <p className="inline-error" role="alert">{status.error}</p>}
    {status.value && <>
      <div className="scm-repository"><span>⑂ {status.value.branch === '(detached)' ? '分离 HEAD' : status.value.branch}</span>
        {status.value.upstream && <span className="muted">↑{status.value.ahead ?? 0} ↓{status.value.behind ?? 0}</span>}</div>
      <div className="scm-inputs">
        <textarea aria-label="提交消息" value={message} maxLength={8000} rows={3} placeholder={`消息（Ctrl+Enter 在“${status.value.branch}”提交）`}
          onChange={(event) => { setMessage(event.target.value); setFeedback('') }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void commit() }
          }} />
        <button className="primary commit-button" disabled={busy || !message.trim() || !staged.length || !!conflicts.length} onClick={() => void commit()}>✓ {action.busy ? '处理中…' : '提交'}</button>
        <input aria-label="筛选更改文件" placeholder="筛选文件…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </div>
      {feedback && <p className="success-message" role="status">{feedback}</p>}
      {action.error && <p className="inline-error" role="alert">{action.error}</p>}
      <div className="scm-changes">
        {!!conflicts.length && <details className="scm-group" open><summary>合并冲突 <span className="count">{conflicts.length}</span></summary>
          {conflicts.map((entry) => <div className="conflict-file" key={entry.path}>{entry.path}</div>)}
          <p className="group-empty">请在编辑器解决冲突后刷新。</p></details>}
        {group('暂存的更改', staged, true)}
        {group('更改', changes, false)}
      </div>
      <details className="history-panel" open><summary>图表 <span className="muted small">最近 100 条</span></summary>
        {history.error && <p className="inline-error">{history.error}</p>}
        {history.value?.map((entry, index) => <button key={entry.hash} className="commit-row" title={`${entry.subject}\n${entry.author} · ${new Date(entry.timestamp).toLocaleString()}\n${entry.hash}`}
          onClick={() => void action.run(async () => {
            const diff = await unwrap(window.dcode.gitCommitDiff(entry.hash))
            open({ title: `${entry.hash.slice(0, 8)} · ${entry.subject}`, ...diff, diff: true })
          })}>
          <svg width={graph[index].width * 14 + 8} height="32" className="commit-graph" aria-hidden="true">
            {graph[index].edges.map((edge, edgeIndex) => <path key={edgeIndex} d={`M ${edge.from * 14 + 8} 0 L ${edge.from * 14 + 8} 16 L ${edge.to * 14 + 8} 32`} />)}
            <circle cx={graph[index].column * 14 + 8} cy="16" r="4" />
          </svg>
          <span className="commit-subject">{entry.subject}</span><span className="commit-author">{entry.author}</span>
          {entry.refs && <span className="ref-badge">{entry.refs.replace('HEAD -> ', '')}</span>}
        </button>)}
        {history.value?.length === 0 && <p className="group-empty">首次提交后显示记录</p>}
      </details>
    </>}
    {status.loading && !status.value && <p className="empty-panel">正在读取仓库…</p>}
  </div>
}
