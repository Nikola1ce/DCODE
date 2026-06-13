// 权限确认弹窗组件（仅交互选项部分）。
// 说明：操作标题与预览（diff / 命令）由 App 在弹窗出现时一次性写入 Static 滚动历史
//（见 types.ts 的 'permission' 项与 MessageView 的渲染），本组件只负责动态区的「选择项」。
// 这样动态区保持低矮、可被完整擦除重绘，避免高预览反复重绘产生残影 / 重复绘制（Bug 2）。
// 支持方向键、数字键与快捷键(y/a/n)。
// 制作人：Moriarty_Dox

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from './theme.js'
import type { PermissionDecision } from '../core/types.js'

// 组件入参。
interface PermissionPromptProps {
  onDecision: (decision: PermissionDecision) => void
}

// 三个固定选项。
const OPTIONS: { label: string; value: PermissionDecision; key: string }[] = [
  { label: '允许一次', value: 'allow_once', key: 'y' },
  { label: '总是允许（记住此操作）', value: 'allow_always', key: 'a' },
  { label: '拒绝', value: 'deny', key: 'n' },
]

/**
 * 权限确认选择器。
 * @param props 入参。
 * @returns 选择项 JSX（不含标题与预览，二者已落入 Static 历史）。
 */
export function PermissionPrompt({
  onDecision,
}: PermissionPromptProps): React.ReactElement {
  const theme = useTheme()
  const [index, setIndex] = useState(0)

  useInput((input, key) => {
    // 上下移动高亮。
    if (key.upArrow) {
      setIndex((i) => (i - 1 + OPTIONS.length) % OPTIONS.length)
      return
    }
    if (key.downArrow) {
      setIndex((i) => (i + 1) % OPTIONS.length)
      return
    }
    // 快捷键 y/a/n 直接决策。
    const lower = input.toLowerCase()
    const byKey = OPTIONS.find((o) => o.key === lower)
    if (byKey) {
      onDecision(byKey.value)
      return
    }
    // 数字键 1-3。
    if (/^[1-3]$/.test(input)) {
      onDecision(OPTIONS[Number(input) - 1].value)
      return
    }
    // 回车确认当前高亮。
    if (key.return) {
      onDecision(OPTIONS[index].value)
      return
    }
    // Esc 等同拒绝。
    if (key.escape) {
      onDecision('deny')
      return
    }
  })

  // 仅渲染「选择项 + 操作提示」：高度固定且低矮（4 行），动态区可被完整擦除重绘，无残影。
  return (
    <Box flexDirection="column">
      <Text color={theme.warning} bold>
        请选择授权（详情见上方）：
      </Text>
      {OPTIONS.map((opt, i) => {
        const selected = i === index
        return (
          <Text key={opt.value} color={selected ? theme.accent : theme.text}>
            {selected ? '❯ ' : '  '}
            {i + 1}. {opt.label}（{opt.key}）
          </Text>
        )
      })}
      <Text color={theme.dim}>↑/↓ 选择 · 回车确认 · y 允许 · a 总是 · n 拒绝</Text>
    </Box>
  )
}
