// 项目终端，输入输出仅在用户打开的工作窗口内传递。制作人：Moriarty_Dox
import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { unwrap } from './serviceHooks.js'

// xterm 的 DOM 渲染器会动态写入主题和字符度量。仅将它创建的样式放进 CSSOM。
function terminalStyles() {
  const sheets = new Set<CSSStyleSheet>()
  const owner = new Proxy(document, {
    get(target, key) {
      if (key === 'createElement') return (tag: string, options?: ElementCreationOptions) => {
        if (tag !== 'style') return target.createElement(tag, options)
        const placeholder = target.createElement('span')
        placeholder.hidden = true
        const sheet = new CSSStyleSheet()
        sheets.add(sheet)
        target.adoptedStyleSheets.push(sheet)
        Object.defineProperty(placeholder, 'textContent', { set(css: string) { sheet.replaceSync(css) } })
        return placeholder
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { owner, dispose() { document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => !sheets.has(sheet)) } }
}

export function TerminalPanel({ session, visible, hide, close, quote }: { session: string; visible: boolean; hide(): void; close(): void; quote(text: string): void }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const hideRef = useRef(hide)
  hideRef.current = hide
  useEffect(() => { if (visible) terminal.current?.focus() }, [visible])
  const [selected, setSelected] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = host.current!
    const id = crypto.randomUUID()
    const styles = terminalStyles()
    const term = new Terminal({ documentOverride: styles.owner, fontSize: 12, scrollback: 1500, allowProposedApi: false })
    terminal.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    let active = true
    let ready = false
    const report = (reason: Error) => { if (active) setError(reason.message) }
    const unsubscribe = window.dcode.subscribe(event => {
      if (event.type === 'terminal_data' && event.id === id) term.write(event.text)
      if (event.type === 'terminal_exit' && event.id === id) { ready = false; term.writeln('\r\n终端已退出 · ' + event.code) }
    })
    term.attachCustomKeyEventHandler(event => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'Backquote') {
        if (event.type === 'keydown') { event.preventDefault(); hideRef.current() }
        return false
      }
      return true
    })
    term.onData(data => {
      if (ready) void unwrap(window.dcode.terminal({ type: 'input', id, data })).catch(report)
    })
    term.onSelectionChange(() => setSelected(term.hasSelection()))
    const resize = () => {
      if (!ready || !element.clientWidth || !element.clientHeight) return
      fit.fit()
      void unwrap(window.dcode.terminal({ type: 'resize', id, cols: term.cols, rows: term.rows })).catch(report)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    void unwrap(window.dcode.terminal({ type: 'open', id, session })).then(() => {
      if (!active) { void window.dcode.terminal({ type: 'close', id }); return }
      ready = true; resize(); term.focus()
    }).catch(report)
    return () => { active = false; observer.disconnect(); unsubscribe(); term.dispose(); styles.dispose(); terminal.current = null; void window.dcode.terminal({ type: 'close', id }) }
  }, [session])
  return <section className="terminal-panel" hidden={!visible} onKeyDown={e => e.stopPropagation()}><header><strong>项目终端</strong>
    <button disabled={!selected} onClick={() => quote(terminal.current?.getSelection() || '')}>引用选中输出</button>
    <button onClick={hide}>隐藏</button><button onClick={close}>关闭终端</button></header>{error && <p role="alert">{error}</p>}<div ref={host} className="terminal-host" /></section>
}
