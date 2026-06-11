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
}: CommandMenuProps): React.ReactElement | null {
  const theme = useTheme()
  // 无候选时不渲染任何内容。
  if (items.length === 0) return null

  // 计算滚动窗口起点：让选中项尽量居中，且窗口不越界。
  const half = Math.floor(MAX_VISIBLE / 2)
  const start =
    items.length <= MAX_VISIBLE
      ? 0
      : Math.min(Math.max(0, selectedIndex - half), items.length - MAX_VISIBLE)
  const visible = items.slice(start, start + MAX_VISIBLE)

  // 命令名列宽：用于让说明文字左对齐（命令名均为 ASCII，可按长度对齐）。
  const nameWidth = Math.max(...items.map((it) => it.name.length)) + 1

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginBottom={1}
    >
      {/* 顶部标题 + 计数；窗口上方仍有项时显示 ▲ */}
      <Text color={theme.dim}>
        命令（{items.length}）{start > 0 ? '   ▲ 更多' : ''}
      </Text>

      {/* 候选命令项 */}
      {visible.map((it, i) => {
        const realIndex = start + i
        const selected = realIndex === selectedIndex
        return (
          <Box key={it.name}>
            <Text color={selected ? theme.accent : theme.text} bold={selected}>
              {selected ? '❯ ' : '  '}/{it.name.padEnd(nameWidth, ' ')}
            </Text>
            <Text color={theme.dim}>  {truncate(it.description, 46)}</Text>
          </Box>
        )
      })}

      {/* 窗口下方仍有项时显示 ▼ */}
      {start + MAX_VISIBLE < items.length ? (
        <Text color={theme.dim}>   ▼ 更多</Text>
      ) : null}

      {/* 操作提示 */}
      <Box marginTop={1}>
        <Text color={theme.dim}>↑/↓ 选择 · Tab 补全 · 回车执行 · Esc 关闭</Text>
      </Box>
    </Box>
  )
}

/**
 * 截断说明文字，超出部分以省略号替代，避免菜单行换行导致布局错位。
 * @param text 原始文本。
 * @param max 最大保留长度。
 * @returns 截断后的文本。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}
