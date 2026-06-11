// 通用单选列表组件。
// 提供上下方向键移动、回车确认、Esc 取消的菜单交互，供模型选择、主题选择、会话恢复等流程复用。
// 制作人：Moriarty_Dox

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
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
  onSelect,
  onCancel,
}: SelectProps<T>): React.ReactElement {
  const theme = useTheme()
  // 当前高亮项索引。
  const [index, setIndex] = useState(0)

  useInput((input, key) => {
    // 上/下移动高亮（带循环）。
    if (key.upArrow) {
      setIndex((i) => (i - 1 + options.length) % options.length)
      return
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % options.length)
      return
    }
    // 数字键快速选择（1-9）。
    if (/^[1-9]$/.test(input)) {
      const n = Number(input) - 1
      if (n < options.length) {
        onSelect(options[n].value)
      }
      return
    }
    // 回车确认。
    if (key.return) {
      onSelect(options[index].value)
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
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const selected = i === index
          return (
            <Box key={i}>
              <Text color={selected ? theme.accent : theme.text}>
                {selected ? '❯ ' : '  '}
                {i + 1}. {opt.label}
              </Text>
              {opt.hint ? <Text color={theme.dim}>　{opt.hint}</Text> : null}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>↑/↓ 选择 · 数字快选 · 回车确认 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
