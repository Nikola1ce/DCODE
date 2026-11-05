// 面板宽度及显隐保存在当前桌面分区，拖动和键盘操作使用相同边界。
// 制作人：Moriarty_Dox
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'

export function useWorkspaceLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dcode.layout') ?? '{}')
      return { width: Number.isFinite(saved.width) ? Math.max(240, Math.min(420, saved.width)) : 292, collapsed: saved.collapsed === true }
    } catch { return { width: 292, collapsed: false } }
  })
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    if (dragging) return
    try { localStorage.setItem('dcode.layout', JSON.stringify(layout)) } catch { /* 存储不可用时保留窗口内状态。 */ }
  }, [layout, dragging])
  function resize(width: number) { setLayout((value) => ({ ...value, width: Math.max(240, Math.min(420, window.innerWidth - 420, width)) })) }
  return {
    ...layout, dragging,
    toggle: () => setLayout((value) => ({ ...value, collapsed: !value.collapsed })),
    expand: () => setLayout((value) => ({ ...value, collapsed: false })),
    separator: {
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        if (drag.current) resize(drag.current.width + event.clientX - drag.current.x)
      },
      onLostPointerCapture() { drag.current = null; setDragging(false) },
      onDoubleClick() { resize(292) },
    },
    resize,
  }
}
