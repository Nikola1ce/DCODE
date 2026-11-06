// 源代码管理上下文菜单，支持屏幕边缘定位、方向键、Esc 与焦点恢复。
// 制作人：Moriarty_Dox
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuAction { label: string; disabled?: boolean; danger?: boolean; run(): void }
export interface MenuPosition { x: number; y: number; items: MenuAction[] }
export function ContextMenu({ menu, close }: { menu: MenuPosition; close(): void }) {
  const element = useRef<HTMLDivElement>(null)
  const origin = useRef(document.activeElement as HTMLElement | null)
  const [position, setPosition] = useState({ x: menu.x, y: menu.y })
  useLayoutEffect(() => {
    const target = element.current!
    const bounds = target.getBoundingClientRect()
    setPosition({ x: Math.max(8, Math.min(menu.x, innerWidth - bounds.width - 8)), y: Math.max(8, Math.min(menu.y, innerHeight - bounds.height - 8)) })
    const first = target.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? target
    first.focus()
    const dismiss = (event: Event) => { if (!target.contains(event.target as Node)) close() }
    const resize = () => close()
    document.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('resize', resize)
      if (origin.current?.isConnected) origin.current.focus()
    }
  }, [menu.x, menu.y])
  return createPortal(<div ref={element} tabIndex={-1} className="scm-context-menu" role="menu" aria-label="源代码管理操作" style={{ left: position.x, top: position.y }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation() }} onKeyDown={event => {
      event.stopPropagation()
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); close(); return }
      const buttons = [...element.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>{menu.items.map(item => <button role="menuitem" key={item.label} className={item.danger ? 'danger' : ''} disabled={item.disabled}
      onClick={() => { close(); item.run() }}>{item.label}</button>)}</div>, document.body)
}
