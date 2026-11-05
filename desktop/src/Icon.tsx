// 统一工作台线性图标，继承文本颜色并在辅助技术中隐藏装饰图形。
// 制作人：Moriarty_Dox
const paths = {
  projects: 'M3 7h7l2 2h9v11H3z M3 7V4h6l2 3',
  chat: 'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5',
  files: 'M8 3h8l4 4v14H8z M16 3v5h4 M4 7v12',
  git: 'M6 6v12 M18 6v4a8 8 0 0 1-8 8H6 M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  review: 'M9 3h7l4 4v14H4V3h2 M8 13l3 3 5-6',
  usage: 'M4 20h17 M7 16V9 M12 16V4 M17 16v-5',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  close: 'm6 6 12 12 M6 18 18 6',
  chevron: 'm8 10 4 4 4-4',
  right: 'm9 6 6 6-6 6',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M6 6a8 8 0 0 1 14 6 M18 18A8 8 0 0 1 4 12',
  check: 'm5 12 4 4L19 6',
  arrow: 'M12 19V5 m-6 6 6-6 6 6',
  down: 'M12 5v14 m-6-6 6 6 6-6',
  stop: 'M6 6h12v12H6z',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  terminal: 'm5 7 5 5-5 5 M13 17h6',
  copy: 'M8 8h12v13H8z M16 8V3H3v13h5',
  undo: 'M4 10h9a7 7 0 0 1 7 7 M4 10l5-5 M4 10l5 5',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z m-4 9 3 3 5-6',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z',
  monitor: 'M3 4h18v13H3z M12 17v4 M8 21h8',
  bell: 'M5 17h14l-2-3V9a5 5 0 0 0-10 0v5z M10 21h4',
  keyboard: 'M2 5h20v14H2z M5 9h1 M9 9h1 M13 9h1 M17 9h2 M5 13h1 M9 13h1 M13 13h6 M7 16h10',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 11v6 M12 7v.5',
} as const

export type IconName = keyof typeof paths
export function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`icon ${className}`}><path d={paths[name]} /></svg>
}
