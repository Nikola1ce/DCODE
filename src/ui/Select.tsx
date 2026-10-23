// 通用单选列表组件。
// 提供上下方向键移动、回车确认、Esc 取消的菜单交互，供模型选择、主题选择、会话恢复等流程复用。
// 制作人：Moriarty_Dox

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { useTheme } from './theme.js'

// 单个选项。
export interface SelectOption<T> {
  // 选项展示文本。
  label: string
  // 选项附带的值。
  value: T
  // 可选的次要说明（展示在右侧，暗色）。
  hint?: string
}

// 组件入参。
interface SelectProps<T> {
  // 标题。
  title: string
  // 选项列表。
  options: SelectOption<T>[]
  // 打开菜单时定位当前值。
  selectedValue?: T
  // 选中回调。
  onSelect: (value: T) => void
  // 取消回调（按 Esc）。
  onCancel: () => void
}

/**
 * 通用单选列表。
 * @param props 入参。
 * @returns 菜单 JSX。
 */
export function Select<T>({
  title,
  options,
  selectedValue,
  onSelect,
  onCancel,
}: SelectProps<T>): React.ReactElement {
  const theme = useTheme()
  // 当前高亮项索引。
  const [index, setIndex] = useState(() => Math.max(0, options.findIndex((opt) => opt.value === selectedValue)))
  const { stdout } = useStdout()
  const [rows, setRows] = useState(stdout.rows || 24)
  useEffect(() => {
    const resize = () => setRows(stdout.rows || 24)
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  const activeIndex = Math.min(index, Math.max(0, options.length - 1))
  const pageSize = Math.max(1, Math.min(8, rows - 10))
  const start = Math.floor(activeIndex / pageSize) * pageSize
  const visible = options.slice(start, start + pageSize)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (!options.length) return
    if (key.pageDown || key.pageUp) {
      setIndex(Math.max(0, Math.min(options.length - 1, activeIndex + (key.pageDown ? pageSize : -pageSize))))
      return
    }
    // 上/下移动高亮（带循环）。
    if (key.upArrow) {
      setIndex((activeIndex - 1 + options.length) % options.length)
      return
    }
    if (key.downArrow) {
      setIndex((activeIndex + 1) % options.length)
      return
    }
    // 数字键快速选择（1-9）。
    if (/^[1-9]$/.test(input)) {
      const n = Number(input) - 1
      if (n < visible.length) {
        onSelect(visible[n].value)
      }
      return
    }
    // 回车确认。
    if (key.return) {
      onSelect(options[activeIndex].value)
      return
    }
    // Esc 取消。
    if (key.escape) {
      onCancel()
      return
    }
  })

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
    >
      <Text color={theme.primary} bold>
        {title}{options.length ? ` · ${activeIndex + 1}/${options.length}` : ''}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {!options.length ? <Text color={theme.dim}>暂无可选项，按 Esc 返回</Text> : null}
        {visible.map((opt, i) => {
          const selected = start + i === activeIndex
          return (
            <Box key={start + i} minWidth={0}>
              <Text wrap="truncate-end" color={selected ? theme.accent : theme.text}>
                {selected ? '❯ ' : '  '}
                {i + 1}. {opt.label}{opt.value === selectedValue ? ' ✓ 当前' : ''}
              </Text>
            </Box>
          )
        })}
      </Box>
      {options[activeIndex]?.hint ? <Text color={theme.dim} wrap="truncate-end">{options[activeIndex].hint}</Text> : null}
      <Box marginTop={1}>
        <Text color={theme.dim} wrap="truncate-end">↑/↓ 选择 · PgUp/PgDn 翻页 · 数字选本页 · Enter 确认 · Esc 返回</Text>
      </Box>
    </Box>
  )
}
