// 任务清单面板。
// 当 Agent 通过 todo_write 维护任务清单时，在输入框上方实时展示任务进度，
// 让用户随时看到“正在做什么、还剩什么”。
//
// 【限高说明】本面板属于“动态区”（非 Static）。Ink 5.2.1 的 log-update 在重绘时
// 会用 eraseLines(上次行数) 上移光标，且未把行数裁剪到视口高度；一旦动态区比终端还高，
// 光标就会被顶进 scrollback，触发终端跳动（往上弹）。因此当任务很多时，这里只渲染一个
// 以“进行中项”为中心的窗口（最多 maxVisible 行），其余用计数提示，确保面板高度可控。
// 制作人：Moriarty_Dox

import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme.js'
import type { TodoItem } from '../core/types.js'

// 入参。
interface TodoPanelProps {
  // 当前任务列表。
  todos: TodoItem[]
  // 最多可见的任务行数（由 App 按终端高度传入，超出则窗口化滚动）。默认 8。
  maxVisible?: number
  // 折叠模式：仅渲染单行摘要（Agent 运行中使用，把动态区高度让给流式正文，避免叠加超出视口）。
  compact?: boolean
}

/**
 * 任务清单面板。空列表时不渲染任何内容。
 * @param props 入参。
 * @returns 面板 JSX 或 null。
 */
export function TodoPanel({
  todos,
  maxVisible = 8,
  compact = false,
}: TodoPanelProps): React.ReactElement | null {
  const theme = useTheme()
  // 空清单不占用任何高度。
  if (todos.length === 0) return null

  const done = todos.filter((t) => t.status === 'completed').length

  // —— 折叠模式：仅一行「进度 + 当前进行中任务」，运行中占用高度降到最低 ——
  if (compact) {
    const active = todos.find((t) => t.status === 'in_progress')
    const tail = active ? `　▶ ${truncate(active.content, 40)}` : ''
    return (
      <Box marginBottom={1}>
        <Text color={theme.dim}>
          任务进度 {done}/{todos.length}
          {tail}
        </Text>
      </Box>
    )
  }
  // 至少保证显示 3 行，避免上限被传得过小导致面板几乎不可见。
  const cap = Math.max(3, maxVisible)

  // —— 计算可见窗口：以第一个“进行中”项为中心，没有则从头开始 ——
  // 让用户始终能看到当前正在执行的任务，避免它被滚出窗口。
  const activeIdx = todos.findIndex((t) => t.status === 'in_progress')
  const anchor = activeIdx >= 0 ? activeIdx : 0
  let start = 0
  if (todos.length > cap) {
    const half = Math.floor(cap / 2)
    // 让锚点尽量居中，同时保证窗口不越界。
    start = Math.min(Math.max(0, anchor - half), todos.length - cap)
  }
  const visible = todos.slice(start, start + cap)
  // 窗口上/下方被隐藏的任务数，用于提示“还有更多”。
  const hiddenAbove = start
  const hiddenBelow = todos.length - (start + visible.length)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={theme.dim}>
        任务进度 {done}/{todos.length}
        {hiddenAbove > 0 ? `   ▲ 上方还有 ${hiddenAbove} 项` : ''}
      </Text>
      {visible.map((t, i) => {
        // 根据状态选择图标与颜色。
        const mark =
          t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '▶' : '○'
        const color =
          t.status === 'completed'
            ? theme.success
            : t.status === 'in_progress'
              ? theme.accent
              : theme.dim
        // key 用窗口内真实索引，避免滚动时复用错行。
        return (
          <Text key={start + i} color={color}>
            {mark} {t.content}
          </Text>
        )
      })}
      {hiddenBelow > 0 ? (
        <Text color={theme.dim}>   ▼ 下方还有 {hiddenBelow} 项</Text>
      ) : null}
    </Box>
  )
}

/**
 * 截断文本，超出部分以省略号替代，避免折叠摘要行换行撑高动态区。
 * @param text 原始文本。
 * @param max 最大保留长度。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}
