// 斜杠命令补全菜单（纯展示组件）。
// 接收候选命令列表与当前选中索引，在输入框上方渲染一个带圆角边框的下拉菜单。
// 当候选较多时按固定窗口滚动，保证选中项始终可见，并用 ▲/▼ 提示存在更多项。
// 仅负责呈现；键盘交互与状态由 InputPrompt 统一管理。
// 制作人：Moriarty_Dox

import React from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme.js'
import type { CommandSuggestion } from '../commands/index.js'

// 组件入参。
interface CommandMenuProps {
  // 候选命令列表。
  items: CommandSuggestion[]
  // 当前选中项索引（调用方保证落在 [0, items.length-1]）。
  selectedIndex: number
  // 父级分配的总行数（包含边框与提示）。
  maxRows?: number
}

// 菜单一次最多展示的命令行数，超出则滚动。
const MAX_VISIBLE = 8

/**
 * 命令补全菜单组件。
 * @param props 入参。
 * @returns 菜单 JSX；无候选时返回 null。
 */
export function CommandMenu({
  items,
  selectedIndex,
  maxRows = 12,
}: CommandMenuProps): React.ReactElement | null {
  const theme = useTheme()
  // 无候选时不渲染任何内容。
  const rows = Math.max(0, Math.floor(maxRows))
  if (items.length === 0 || rows === 0) return null
  // 小窗口优先保留选中项；空间充足时再加边框、标题和操作提示。
  const framed = rows >= 5
  const visibleCount = Math.min(MAX_VISIBLE, rows - (framed ? 4 : 0))

  // 计算滚动窗口起点：让选中项尽量居中，且窗口不越界。
  const half = Math.floor(visibleCount / 2)
  const start =
    items.length <= visibleCount
      ? 0
      : Math.min(Math.max(0, selectedIndex - half), items.length - visibleCount)
  const visible = items.slice(start, start + visibleCount)

  // 命令名列宽：用于让说明文字左对齐（命令名均为 ASCII，可按长度对齐）。
  const nameWidth = Math.max(
    ...items.map((it) =>
      (it.completion.startsWith('/') ? it.completion.slice(1) : it.name).length,
    ),
  ) + 1

  return (
    <Box
      flexDirection="column"
      borderStyle={framed ? 'round' : undefined}
      borderColor={theme.primary}
      paddingX={framed ? 1 : 0}
      flexShrink={0}
    >
      {/* 顶部标题 + 计数；窗口上方仍有项时显示 ▲ */}
      {framed ? (
        <Text color={theme.dim} wrap="truncate">
          命令 {selectedIndex + 1}/{items.length}{start > 0 ? ' ▲' : ''}{start + visibleCount < items.length ? ' ▼' : ''}
        </Text>
      ) : null}

      {/* 候选命令项 */}
      {visible.map((it, i) => {
        const realIndex = start + i
        const selected = realIndex === selectedIndex
        const label = it.completion.startsWith('/') ? it.completion.slice(1) : it.name
        return (
          <Text key={`${it.completion}-${realIndex}`} wrap="truncate" color={selected ? theme.accent : theme.text} bold={selected}>
            {selected ? '❯ ' : '  '}/{label.padEnd(nameWidth, ' ')}
            <Text color={theme.dim}>  {it.description.replace(/\s+/g, ' ')}</Text>
          </Text>
        )
      })}

      {/* 操作提示 */}
      {framed ? <Text color={theme.dim} wrap="truncate">↑/↓ 选择 · Tab 补全 · 回车执行 · Esc 关闭</Text> : null}
    </Box>
  )
}
