// 工作区导航、会话管理、历史、检查点审阅及用量面板。
// 制作人：Moriarty_Dox
import { useState } from 'react'
import type { DesktopSession } from '../shared/services.js'
import type { DocumentPreview } from './DocumentView.js'
import { DocumentView } from './DocumentView.js'
import { unwrap, useAction, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'

export interface PanelProps { revision: number; open(document: DocumentPreview): void }

export function ProjectsPanel({ locked, revision }: { locked: boolean; revision: number }) {
  const recent = useResource(String(revision), () => unwrap(window.dcode.listRecentWorkspaces()))
  const action = useAction(recent.refresh)
  return <><div className="panel-heading"><h2>最近项目</h2></div><div className="panel-controls">
    <button className="primary" disabled={locked || action.busy} onClick={() => void action.run(() => unwrap(window.dcode.chooseWorkspace()))}><Icon name="projects" size={16} />选择项目文件夹</button></div>
    {(recent.error || action.error) && <p className="inline-error">{recent.error || action.error}</p>}
    <div className="panel-scroll">{recent.value?.map((workspace) => <button className="recent-project" key={workspace.id} title={workspace.path} disabled={locked || action.busy}
      onClick={() => void action.run(() => unwrap(window.dcode.openRecentWorkspace(workspace.id)))}>
      <strong>{workspace.path.split(/[\\/]/).filter(Boolean).at(-1)}</strong><span className="path muted">{workspace.path}</span>
    </button>)}
      {recent.value?.length === 0 && <p className="empty-panel">打开过的项目会保留在这里。</p>}
    </div></>
}

export function FilesPanel({ revision, open }: PanelProps) {
  const [directory, setDirectory] = useState('')
  const files = useResource(`${directory}:${revision}`, () => unwrap(window.dcode.listFiles(directory)))
  const action = useAction()
  return <>
    <div className="panel-heading"><h2>资源管理器</h2><button className="icon-button" title="刷新文件" aria-label="刷新文件" onClick={files.refresh}><Icon name="refresh" size={16} className={files.loading ? 'spin' : ''} /></button></div>
    <div className="breadcrumb"><button aria-label="返回上级目录" disabled={!directory} onClick={() => setDirectory(directory.split('/').slice(0, -1).join('/'))}><Icon name="arrow" size={14} /></button><span>{directory || '项目根目录'}</span></div>
    {(files.error || action.error) && <p className="inline-error" role="alert">{files.error || action.error}</p>}
    <div className="panel-scroll">
      {files.value?.entries.map((entry) => <button className="tree-row" key={entry.path} disabled={action.busy} onClick={() => {
        if (entry.kind === 'directory') { setDirectory(entry.path); return }
        void action.run(async () => {
          const file = await unwrap(window.dcode.readFile(entry.path))
          open({ title: entry.path, text: file.kind === 'text' ? file.text : `二进制文件 · ${file.size.toLocaleString()} 字节`, truncated: file.kind === 'text' && file.truncated,
            reload: async () => {
              const latest = await unwrap(window.dcode.readFile(entry.path))
              return { text: latest.kind === 'text' ? latest.text : `二进制文件 · ${latest.size.toLocaleString()} 字节`, truncated: latest.kind === 'text' && latest.truncated }
            } })
        })
      }}><span className="file-symbol"><Icon name={entry.kind === 'directory' ? 'projects' : 'files'} size={16} /></span>{entry.name}</button>)}
      {files.value?.entries.length === 0 && <p className="empty-panel">目录为空</p>}
      {files.value?.truncated && <p className="inline-notice">目录较大，仅显示前 2000 项。</p>}
    </div>
  </>
}

export function SessionsPanel({ revision, locked, sessionId, select }: {
  revision: number; locked: boolean; sessionId: string | null; select(id: string | null): Promise<void>
}) {
  const [archived, setArchived] = useState(false)
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const sessions = useResource(`${revision}:${archived}`, () => unwrap(window.dcode.listSessions(archived)))
  const action = useAction(sessions.refresh)
  const disabled = locked || action.busy
  function rename(session: DesktopSession) { setRenaming(session.id); setTitle(session.title) }
  return <>
    <div className="panel-heading"><h2>项目会话</h2><button className="icon-button" title="新建会话 Ctrl+N" aria-label="新建会话" disabled={disabled} onClick={() => void action.run(() => select(null))}><Icon name="plus" size={17} /></button></div>
    <div className="panel-controls"><input aria-label="搜索会话" placeholder="搜索会话…" value={filter} onChange={(event) => setFilter(event.target.value)} />
      <label className="checkbox"><input type="checkbox" checked={archived} onChange={(event) => setArchived(event.target.checked)} />显示已归档</label></div>
    {(sessions.error || action.error) && <p className="inline-error" role="alert">{sessions.error || action.error}</p>}
    <div className="panel-scroll">
      {sessions.value?.sessions.filter((session) => session.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map((session) => <article className={`session-item ${session.id === sessionId ? 'selected' : ''}`} key={session.id}>
        {renaming === session.id ? <form onSubmit={(event) => {
          event.preventDefault()
          void action.run(async () => { await unwrap(window.dcode.updateSession(session.id, { title })); setRenaming(null) })
        }}><input autoFocus aria-label="会话名称" maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
          <div className="row-actions"><button disabled={disabled || !title.trim()} type="submit">保存</button><button type="button" onClick={() => setRenaming(null)}>取消</button></div></form>
          : <button className="session-title" disabled={disabled} onClick={() => void action.run(() => select(session.id))}>{session.pinned && <span>⌖ </span>}{session.title}</button>}
        <div className="session-meta"><span>{new Date(session.updatedAt).toLocaleDateString()} · {session.messageCount} 条</span><span>{session.id === sessionId ? '当前' : ''}</span></div>
        <div className="session-actions"><button disabled={disabled} onClick={() => rename(session)}>重命名</button>
          <button disabled={disabled} onClick={() => void action.run(() => unwrap(window.dcode.updateSession(session.id, { pinned: !session.pinned })))}>{session.pinned ? '取消置顶' : '置顶'}</button>
          <button disabled={disabled} onClick={() => void action.run(() => unwrap(window.dcode.updateSession(session.id, { archived: !archived })))}>{archived ? '恢复' : '归档'}</button>
          <button disabled={disabled || session.id === sessionId} onClick={() => void action.run(() => unwrap(window.dcode.deleteSession(session.id)))}>删除</button></div>
      </article>)}
      {sessions.value?.sessions.length === 0 && <p className="empty-panel">{archived ? '还没有归档会话' : '点击 + 开始新会话'}</p>}
      {!!sessions.value?.sessions.length && !sessions.value.sessions.some((session) => session.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) && <p className="empty-panel">没有匹配的会话<button className="text-button" onClick={() => setFilter('')}>清除搜索</button></p>}
      {!!sessions.value?.skipped && <p className="inline-notice">已跳过 {sessions.value.skipped} 个无法读取的记录。</p>}
      {sessions.value?.truncated && <p className="inline-notice">已达到 2000 个会话的扫描上限。</p>}
    </div>
  </>
}

export function ReviewPanel({ revision, sessionId, open }: PanelProps & { sessionId: string }) {
  const listing = useResource(String(revision), () => unwrap(window.dcode.listReviews(sessionId)))
  return <>
    <div className="panel-heading"><h2>文件审阅</h2><button className="icon-button" title="刷新审阅" aria-label="刷新审阅" onClick={listing.refresh}><Icon name="refresh" size={16} className={listing.loading ? 'spin' : ''} /></button></div>
    {listing.error && <p className="inline-error" role="alert">{listing.error}</p>}
    <div className="panel-scroll">{listing.value?.turns.map((turn, index) => <details className="review-group" key={turn.turnId ?? `${turn.timestamp}-${index}`} open>
      <summary>{new Date(turn.timestamp).toLocaleString()} <span className="count">{turn.files.length}</span></summary>
      {turn.files.map((file) => <button className="tree-row" key={file.checkpointId} onClick={() => open({ title: `${file.path} · 审阅`, text: '',
        review: { sessionId, checkpointId: file.checkpointId } })}>
        <span className="file-symbol"><Icon name="files" size={15} /></span><span className="truncate">{file.path}</span><span className="muted small">{file.complete ? `${file.checkpointCount} 次` : '待完成'}</span></button>)}
    </details>)}
      {listing.value?.turns.length === 0 && <p className="empty-panel">本会话产生文件修改后，可在这里查看差异并回退。</p>}
    </div>
  </>
}

export function ReviewEditor({ sessionId, checkpointId, locked, revision }: { sessionId: string; checkpointId: string; locked: boolean; revision: number }) {
  const review = useResource(`${sessionId}:${checkpointId}:${revision}`, async () => {
    const result = await unwrap(window.dcode.getReview(sessionId, checkpointId))
    if (!result.ok) throw new Error(result.error)
    return result.review
  })
  const action = useAction(review.refresh)
  const [confirmation, setConfirmation] = useState<number | 'file' | null>(null)
  const current = review.value
  async function revert() {
    if (!current || confirmation === null) return
    const result = await unwrap(window.dcode.revertReview(sessionId, checkpointId, current.revision, confirmation === 'file' ? null : confirmation))
    if (!result.ok) throw new Error(result.error)
    setConfirmation(null)
  }
  return <div className="review-editor">
    {(review.error || action.error) && <p className="inline-error" role="alert">{review.error || action.error}</p>}
    {current && <>
      <div className="review-toolbar"><span>+{current.diff.added ?? '—'} −{current.diff.removed ?? '—'}</span>
        <button className="danger" disabled={locked || action.busy || review.loading || !current.canRevert} onClick={() => setConfirmation('file')}>回退此文件</button>
        {current.undoCheckpointId && <button disabled={locked || action.busy} onClick={() => void action.run(async () => {
          const result = await unwrap(window.dcode.undoReview(sessionId, current.undoCheckpointId!))
          if (!result.ok) throw new Error(result.errors.join('\n'))
        })}>撤销上次回退</button>}
        <button disabled={action.busy} onClick={review.refresh}>刷新</button>
      </div>
      {current.blockedReason && <p className="inline-notice">{current.blockedReason}</p>}
      {confirmation !== null && <div className="review-confirm" role="alert"><span>确认回退{confirmation === 'file' ? '此文件的全部变更' : '选中的变更块'}？</span>
        <button className="danger" disabled={action.busy} onClick={() => void action.run(revert)}>确认回退</button><button onClick={() => setConfirmation(null)}>取消</button></div>}
      <div className="hunk-actions">{current.diff.hunks.map((hunk, index) => <button key={index} disabled={locked || action.busy || review.loading || !current.canRevert}
        onClick={() => setConfirmation(index)}>回退第 {hunk.newStart} 行附近变更</button>)}</div>
      <DocumentView key={current.revision} document={{ title: current.checkpoint.path, text: current.diff.preview, diff: true, truncated: current.diff.truncated }} />
    </>}
  </div>
}

export function UsagePanel({ sessionId, revision }: { sessionId: string; revision: number }) {
  const usage = useResource(`${sessionId}:${revision}`, () => unwrap(window.dcode.getUsage(sessionId)))
  return <><div className="panel-heading"><h2>会话用量</h2><button className="icon-button" title="刷新用量" aria-label="刷新用量" onClick={usage.refresh}>↻</button></div>
    {usage.error && <p className="inline-error">{usage.error}</p>}
    {usage.value && <div className="panel-scroll usage-panel"><div className="cost-total">${usage.value.total.costUsd.toFixed(4)}<span>已知费用 · USD</span></div>
      <dl className="usage-stats"><dt>模型请求</dt><dd>{usage.value.total.requests}</dd><dt>输入 Token</dt><dd>{usage.value.total.promptTokens.toLocaleString()}</dd>
        <dt>输出 Token</dt><dd>{usage.value.total.completionTokens.toLocaleString()}</dd><dt>缓存命中 Token</dt><dd>{usage.value.total.cacheHitTokens.toLocaleString()}</dd></dl>
      {!!usage.value.total.unpricedRequests && <p className="inline-notice">{usage.value.total.unpricedRequests} 次请求缺少价格，费用待计入。</p>}
      <h3>按轮次</h3>{usage.value.turns.map((turn) => <div className="usage-turn" key={turn.turnId}><span>{new Date(turn.timestamp).toLocaleString()}</span><strong>${turn.usage.costUsd.toFixed(4)}</strong></div>)}
    </div>}
  </>
}
