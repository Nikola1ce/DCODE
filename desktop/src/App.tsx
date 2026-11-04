// 最小桌面对话工作台：原生选择、流式消息、停止及只绑定 permissionId 的审批卡片。
// 制作人：Moriarty_Dox
import { useEffect, useReducer, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ConnectionPhase, DesktopEvent, Result } from '../shared/api.js'
import { INITIAL_CHAT_STATE, reduceEvents } from './state.js'

const PHASE_LABELS: Record<ConnectionPhase, string> = {
  disconnected: '未连接', starting: '连接中', ready: '就绪', running: '执行中',
  cancelling: '停止中', stopping: '关闭中', idle: '已空闲回收', recovering: '恢复会话中', failed: '连接失败',
}

export function App() {
  const [state, dispatch] = useReducer(reduceEvents, INITIAL_CHAT_STATE)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const scrollEnd = useRef<HTMLDivElement>(null)
  const { snapshot, turns } = state
  const working = snapshot.phase === 'running' || snapshot.phase === 'cancelling'
  const connecting = ['starting', 'recovering', 'stopping'].includes(snapshot.phase)
  const canSend = snapshot.phase === 'ready' && snapshot.hasApiKey && !pending && !!draft.trim()

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
      <aside className="sidebar">
        <div className="brand">DCODE <span>Desktop</span></div>
        <p className="muted small">M1 · 桌面骨架</p>
        <button className="primary" disabled={!!pending || working || connecting}
          onClick={() => void run('choose', () => window.dcode.chooseWorkspace())}>选择项目文件夹</button>
        {snapshot.cwd && <button disabled={!!pending || working || connecting}
          onClick={() => void run('reconnect', () => window.dcode.reconnect())}>
          {snapshot.phase === 'idle' ? '唤醒内核' : '重新连接'}
        </button>}
        <div className="workspace-info">
          <h2>当前工作区</h2>
          <p className="path">{snapshot.cwd ?? '尚未选择'}</p>
          <p className="muted small">目录须经原生对话框授权。仅当前工作区运行一个会话内核。</p>
        </div>
        <div className="sidebar-bottom muted small">制作人：Moriarty_Dox<br />配置与会话沿用命令行版本</div>
      </aside>

      <main className="conversation">
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
          {turns.length === 0 && <div className="welcome">
            <div className="welcome-mark">D</div>
            <h2>{snapshot.cwd ? '内核已选择你的项目' : '让上下文留在项目里'}</h2>
            <p>先选择项目文件夹，再发起一轮对话。内容实时展示，文件写入与命令执行逐次审批。</p>
            <p className="muted small">这是最小工程骨架：未接入历史回放、文件审阅或多工作区。恢复连接不会自动重发消息。</p>
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
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }} />
          <div className="composer-actions"><span className="muted small">Enter 发送 · Shift+Enter 换行 · Esc 停止</span>
            {working ? <button type="button" className="danger" disabled={!!pending || snapshot.phase === 'cancelling'}
              onClick={() => void run('cancel', () => window.dcode.cancelTurn())}>{snapshot.phase === 'cancelling' ? '停止中…' : '停止'}</button>
              : <button type="submit" className="primary" disabled={!canSend}>发送</button>}
          </div>
        </form>
        <footer className="statusbar"><span>{snapshot.permissionMode === 'default' ? '逐次审批' : '尚未完成安全握手'}</span><span>协议 {snapshot.protocolVersion ?? '—'}</span></footer>
      </main>

      <aside className="details-panel"><h2>连接信息</h2><dl>
        <dt>模型</dt><dd>{snapshot.model ?? '—'}</dd>
        <dt>会话</dt><dd className="path">{snapshot.sessionId ?? '—'}</dd>
        <dt>工作目录</dt><dd className="path">{snapshot.cwd ?? '—'}</dd>
      </dl><p className="muted small">内核使用 Electron 自带 Node，无需系统 Node。空闲 10 分钟后回收，重新连接恢复同一会话。</p>
      <p className="muted small">仅保留当前窗口最近 40 轮显示；持久化由内核负责。</p></aside>
    </div>
  )
}
