// 桌面工作台：会话、资源管理器、源代码管理、审阅、用量与设置。
// 制作人：Moriarty_Dox
import { useEffect, useReducer, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ConnectionPhase, DesktopEvent, Result } from '../shared/api.js'
import { INITIAL_CHAT_STATE, reduceEvents } from './state.js'
import type { DesktopPreferences, SessionHistory } from '../shared/services.js'
import { DocumentView } from './DocumentView.js'
import type { DocumentPreview } from './DocumentView.js'
import { SourceControl } from './SourceControl.js'
import { FilesPanel, ProjectsPanel, ReviewPanel, ReviewEditor, SessionsPanel, SettingsPanel, UsagePanel } from './WorkspacePanels.js'
import { unwrap, useDraft } from './serviceHooks.js'

const PHASE_LABELS: Record<ConnectionPhase, string> = {
  disconnected: '未连接', starting: '连接中', ready: '就绪', running: '执行中',
  cancelling: '停止中', stopping: '关闭中', idle: '已空闲回收', recovering: '恢复会话中', failed: '连接失败',
}

export function App() {
  const [state, dispatch] = useReducer(reduceEvents, INITIAL_CHAT_STATE)
  const [panel, setPanel] = useState('sessions')
  const [preview, setPreview] = useState<DocumentPreview | null>(null)
  const [revision, setRevision] = useState(0)
  const [preferences, setPreferences] = useState<DesktopPreferences>({ theme: 'system', sendKey: 'enter', notifications: true, preventSleep: true })
  const [history, setHistory] = useState<SessionHistory>({ messages: [], truncated: false })
  const [historyLoading, setHistoryLoading] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollEnd = useRef<HTMLDivElement>(null)
  const loadedHistory = useRef<string | null>(null)
  const { snapshot, turns } = state
  const identity = `${snapshot.cwd}:${snapshot.sessionId}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  function openDocument(document: DocumentPreview) {
    if (currentIdentity.current === identity) setPreview(document)
  }
  const [draft, setDraft] = useDraft(`chat:${snapshot.cwd ?? ''}:${snapshot.sessionId ?? ''}`)
  const working = snapshot.phase === 'running' || snapshot.phase === 'cancelling'
  const connecting = ['starting', 'recovering', 'stopping'].includes(snapshot.phase)
  const canSend = snapshot.phase === 'ready' && snapshot.hasApiKey && !pending && !historyLoading && !!draft.trim()
  const locked = working || connecting || !!pending

  useEffect(() => { setPreview(null) }, [snapshot.cwd, snapshot.sessionId])

  useEffect(() => {
    if (!window.dcode) { setError('请通过 Electron 启动桌面程序，而非直接打开 HTML。'); return }
    let active = true
    let frame = 0
    let receivedEvent = false
    const queue: DesktopEvent[] = []
    const flush = () => {
      frame = 0
      if (active) dispatch(queue.splice(0))
    }
    const unsubscribe = window.dcode.subscribe((event) => {
      receivedEvent = true
      queue.push(event)
      if (event.type === 'workspace_changed' || (event.type === 'stream' && ['turn_done', 'turn_error'].includes(event.message.type))) {
        setRevision((value) => value + 1)
      }
      if (event.type === 'workspace_watch_error') setError('文件监听已中断，可使用面板刷新按钮重新读取。')
      // 最小化窗口会暂停 rAF；达到上限立即消耗，避免隐藏窗口无限累积流式事件。
      if (queue.length >= 32) {
        cancelAnimationFrame(frame)
        flush()
      } else if (!frame) frame = requestAnimationFrame(flush)
    })
    void window.dcode.getSnapshot().then((result) => {
      if (!active || receivedEvent) return
      if (result.ok) dispatch([{ type: 'connection', snapshot: result.value }])
      else setError(`${result.error.code}：${result.error.message}`)
    }).catch(() => { if (active) setError('无法连接桌面主进程。') })
    return () => { active = false; unsubscribe(); cancelAnimationFrame(frame) }
  }, [])

  useEffect(() => {
    void unwrap(window.dcode.getSettings()).then(setPreferences).catch((reason: Error) => setError(reason.message))
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.dataset.theme = preferences.theme === 'system' ? media.matches ? 'dark' : 'light' : preferences.theme }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [preferences.theme])

  useEffect(() => {
    const identity = `${snapshot.cwd}:${snapshot.sessionId}`
    if (loadedHistory.current === identity || connecting) return
    setPreview(null)
    setHistory({ messages: [], truncated: false })
    if (!snapshot.sessionId) { setHistoryLoading(false); return }
    let active = true
    setHistoryLoading(true)
    void unwrap(window.dcode.getSessionHistory(snapshot.sessionId)).then((value) => {
      if (active) { loadedHistory.current = identity; setHistory(value) }
    }).catch((reason: Error) => { if (active) setError(reason.message) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [snapshot.cwd, snapshot.sessionId, connecting])

  useEffect(() => {
    if (!snapshot.cwd || connecting) return
    void unwrap(window.dcode.watchWorkspace(true)).catch((reason: Error) => setError(reason.message))
    const refresh = () => setRevision((value) => value + 1)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh) }
  }, [snapshot.cwd, connecting])

  useEffect(() => { scrollEnd.current?.scrollIntoView({ block: 'end' }) }, [turns, snapshot.permissions.length])

  async function run<T>(key: string, operation: () => Promise<Result<T>>): Promise<T | undefined> {
    setPending(key)
    setError(null)
    try {
      const result = await operation()
      if (!result.ok) { setError(`${result.error.code}：${result.error.message}`); return undefined }
      return result.value
    } catch {
      setError('桌面连接暂时不可用；没有自动重发任何消息。')
      return undefined
    } finally {
      setPending(null)
    }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault()
    if (!canSend) return
    const result = await run('send', () => window.dcode.sendPrompt(draft))
    if (result) setDraft('')
  }

  async function selectSession(id: string | null) {
    setPreview(null)
    if (id && id === snapshot.sessionId) return
    await unwrap(window.dcode.openSession(id))
    const next = await unwrap(window.dcode.getSnapshot())
    dispatch([{ type: 'connection', snapshot: next }])
    setRevision((value) => value + 1)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && snapshot.phase === 'running' && !pending) {
        event.preventDefault()
        void run('cancel', () => window.dcode.cancelTurn())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snapshot.phase, pending])

  return (
    <div className="workspace-shell">
      <nav className="activity-bar" aria-label="工作台导航">
        <div className="app-mark">D</div>
        {([['projects', '最近项目', '▦'], ['sessions', '对话', '☷'], ['files', '资源管理器', '▱'], ['git', '源代码管理', '⑂'], ['review', '文件审阅', '✓'], ['usage', '会话用量', '▥'], ['settings', '设置', '⚙']] as const).map(([id, label, icon]) =>
          <button key={id} title={label} aria-label={label} aria-pressed={panel === id} className={panel === id ? 'active' : ''} onClick={() => setPanel(id)}>{icon}</button>)}
      </nav>
      <aside className="sidebar">
        <div className="project-switcher"><button className="project-name" title={snapshot.cwd ?? '选择项目文件夹'} disabled={locked}
          onClick={() => void run('choose', () => window.dcode.chooseWorkspace())}>{snapshot.cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? '打开项目'} <span>⌄</span></button>
          {snapshot.cwd && <button className="icon-button" title={snapshot.phase === 'idle' ? '唤醒内核' : '重新连接'} aria-label="重新连接" disabled={locked}
            onClick={() => void run('reconnect', () => window.dcode.reconnect())}>↻</button>}</div>
        <div className="panel-content" key={snapshot.cwd}>
          {panel === 'settings' ? <SettingsPanel preferences={preferences} update={async (patch) => setPreferences(await unwrap(window.dcode.updateSettings(patch)))} />
            : panel === 'projects' || !snapshot.cwd ? <ProjectsPanel locked={locked} revision={revision} />
            : connecting ? <p className="empty-panel">正在连接项目…</p>
            : panel === 'git' ? <SourceControl cwd={snapshot.cwd} revision={revision} locked={locked} open={openDocument} />
            : panel === 'files' ? <FilesPanel revision={revision} open={openDocument} />
            : panel === 'review' && snapshot.sessionId ? <ReviewPanel key={snapshot.sessionId} sessionId={snapshot.sessionId} revision={revision} open={openDocument} />
            : panel === 'usage' && snapshot.sessionId ? <UsagePanel sessionId={snapshot.sessionId} revision={revision} />
            : <SessionsPanel revision={revision} locked={locked} sessionId={snapshot.sessionId} select={selectSession} />}
        </div>
        <div className="sidebar-bottom muted small" title={snapshot.cwd ?? ''}>{snapshot.cwd ?? 'DCODE Desktop'}</div>
      </aside>

      <main className="main-area">
        <div className="editor-tabs"><button className={!preview ? 'active' : ''} onClick={() => setPreview(null)}>项目对话{snapshot.permissions.length ? ` · ${snapshot.permissions.length} 项待授权` : ''}</button>
          {preview && <div className="editor-tab active"><span>{preview.title}</span><button className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={() => setPreview(null)}>×</button></div>}
          <span className="app-title">DCODE Desktop</span></div>
        {preview && (preview.review ? <ReviewEditor key={preview.review.checkpointId} {...preview.review} locked={locked} revision={revision} />
          : <DocumentView key={preview.title} document={preview} revision={revision} />)}
        <div className="conversation" hidden={!!preview}>
        <header className="conversation-header">
          <div><h1>{snapshot.cwd ? '项目对话' : '开始使用 DCODE'}</h1>
            <p className="muted small">{snapshot.model ?? '选择项目后加载当前模型'}{snapshot.provider ? ` · ${snapshot.provider}` : ''}</p>
          </div>
          <span className={`status status-${snapshot.phase}`} role="status">{PHASE_LABELS[snapshot.phase]}</span>
        </header>
        <div className="notices">
          {error && <div className="notice error" role="alert">{error}</div>}
          {snapshot.error && <div className="notice error" role="alert"><strong>{snapshot.error.code}</strong>：{snapshot.error.message}
            {snapshot.phase === 'ready' && ' 会话进程已重新连接，请检查上一轮后手动继续。'}
          </div>}
          {snapshot.compatibilityWarning && <div className="notice">{snapshot.compatibilityWarning.code}：{snapshot.compatibilityWarning.message}</div>}
          {snapshot.phase === 'ready' && !snapshot.hasApiKey && <div className="notice">尚未配置 API Key。请先在命令行使用 /login，随后点击“重新连接”。此页面不会读取或显示密钥。</div>}
        </div>

        <section className="messages" aria-label="对话消息">
          {historyLoading && <p className="muted small">正在加载会话历史…</p>}
          {history.truncated && <p className="inline-notice">当前显示最近的部分历史内容。</p>}
          {history.messages.map((message) => <div key={message.id} className={`message ${message.role}`}><div className="message-label">{message.role === 'user' ? '你' : 'DCODE'}</div><p className="preserve">{message.text}</p></div>)}
          {turns.length === 0 && !history.messages.length && !historyLoading && <div className="welcome">
            <div className="welcome-mark">D</div>
            <h2>{snapshot.cwd ? '开始这个项目的下一步' : '让上下文留在项目里'}</h2>
            <p>{snapshot.cwd ? '描述你想完成的任务，或从左侧浏览文件、查看 Git 更改和历史会话。' : '选择项目文件夹，DCODE 将在你的授权范围内读取和修改文件。'}</p>
          </div>}
          {turns.map((turn) => <article className="turn" key={turn.requestId}>
            <div className="message user"><div className="message-label">你</div><p className="preserve">{turn.prompt}</p></div>
            <div className="message assistant"><div className="message-label">DCODE</div>
              {turn.reasoning && <details><summary>推理过程</summary><pre>{turn.reasoning}</pre></details>}
              {!!turn.tools.length && <ul className="tool-list">{turn.tools.map((tool) => <li className={tool.failed ? 'failed' : ''} key={tool.id}>{tool.summary}</li>)}</ul>}
              <p className="preserve">{turn.text || (turn.status === 'running' ? '等待内核响应…' : '本轮没有文本输出。')}</p>
              {turn.error && <p className="failed" role="alert">{turn.error}</p>}
              {turn.status !== 'running' && <p className="muted small">{turn.status === 'aborted' ? '已停止' : turn.status === 'error' ? '已中断' : '本轮完成'}
                {turn.costUsd !== undefined && ` · $${turn.costUsd.toFixed(4)}`}</p>}
            </div>
          </article>)}
          {snapshot.permissions.map((card) => <section className="permission-card" key={card.permissionId} aria-label="权限确认">
            <div className="message-label">需要你的授权 · {card.request.toolName}</div>
            <h3>{card.request.title}</h3>
            {card.request.preview && <pre>{card.request.preview}</pre>}
            <div className="permission-actions">
              <button className="primary" disabled={!!pending || snapshot.phase !== 'running'}
                onClick={() => void run(card.permissionId, () => window.dcode.respondPermission(card.permissionId, 'allow_once'))}>允许一次</button>
              <button disabled={!!pending || snapshot.phase !== 'running'}
                onClick={() => void run(card.permissionId, () => window.dcode.respondPermission(card.permissionId, 'deny'))}>拒绝</button>
            </div>
          </section>)}
          <div ref={scrollEnd} />
        </section>

        <form className="composer" onSubmit={(event) => void send(event)}>
          <label className="sr-only" htmlFor="prompt">给 DCODE 的消息</label>
          <textarea id="prompt" value={draft} maxLength={32_000} rows={3} disabled={pending === 'send'}
            placeholder={snapshot.cwd ? '描述你想完成的任务…' : '请先选择项目文件夹'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing
                && (preferences.sendKey === 'enter' || event.ctrlKey || event.metaKey)) {
                event.preventDefault()
                void send()
              }
            }} />
          <div className="composer-actions"><span className="muted small">{preferences.sendKey === 'enter' ? 'Enter' : 'Ctrl / ⌘ + Enter'} 发送 · Shift+Enter 换行 · Esc 停止</span>
            {working ? <button type="button" className="danger" disabled={!!pending || snapshot.phase === 'cancelling'}
              onClick={() => void run('cancel', () => window.dcode.cancelTurn())}>{snapshot.phase === 'cancelling' ? '停止中…' : '停止'}</button>
              : <button type="submit" className="primary" disabled={!canSend}>发送</button>}
          </div>
        </form>
        </div>
        <footer className="statusbar"><span>{PHASE_LABELS[snapshot.phase]} · {snapshot.permissionMode === 'default' ? '逐次审批' : '等待握手'}</span><span>{snapshot.model ?? '尚未连接模型'}</span><button onClick={() => setPanel('usage')}>用量</button></footer>
      </main>
    </div>
  )
}
