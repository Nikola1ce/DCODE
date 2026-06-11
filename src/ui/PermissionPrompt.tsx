// 权限确认弹窗组件。
// 当工具需要授权时弹出，展示操作标题与预览（如 diff 或将执行的命令），
// 让用户选择：允许一次 / 总是允许 / 拒绝。支持方向键、数字键与快捷键(y/a/n)。
// 制作人：Moriarty_Dox

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from './theme.js'
import type { PermissionDecision, PermissionRequest } from '../core/types.js'

// 组件入参。
interface PermissionPromptProps {
  // 权限请求详情。
  request: PermissionRequest
  // 用户决策回调。
  onDecision: (decision: PermissionDecision) => void
}

// 三个固定选项。
const OPTIONS: { label: string; value: PermissionDecision; key: string }[] = [
  { label: '允许一次', value: 'allow_once', key: 'y' },
  { label: '总是允许（记住此操作）', value: 'allow_always', key: 'a' },
  { label: '拒绝', value: 'deny', key: 'n' },
]

// 预览最多展示的行数。
const PREVIEW_LINES = 20

/**
 * 权限确认弹窗。
 * @param props 入参。
 * @returns 弹窗 JSX。
 */
export function PermissionPrompt({
  request,
  onDecision,
}: PermissionPromptProps): React.ReactElement {
  const theme = useTheme()
  // 当前高亮的选项索引。
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

  // 截断预览，避免超长 diff/命令刷屏。
  const previewLines = (request.preview ?? '').split('\n')
  const shownPreview =
    previewLines.length > PREVIEW_LINES
      ? previewLines.slice(0, PREVIEW_LINES).join('\n') +
        `\n… 省略 ${previewLines.length - PREVIEW_LINES} 行 …`
      : request.preview ?? ''

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.warning}
      paddingX={1}
    >
      {/* 标题：需要授权的操作 */}
      <Text color={theme.warning} bold>
        需要授权：{request.title}
      </Text>

      {/* 操作预览（如 diff 或命令） */}
      {shownPreview ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor={theme.dim}
          paddingX={1}
        >
          {shownPreview.split('\n').map((line, i) => (
            <Text
              key={i}
              color={
                line.startsWith('+')
                  ? theme.success
                  : line.startsWith('-')
                    ? theme.error
                    : theme.dim
              }
            >
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {/* 选项 */}
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => {
          const selected = i === index
          return (
            <Text key={opt.value} color={selected ? theme.accent : theme.text}>
              {selected ? '❯ ' : '  '}
              {i + 1}. {opt.label}（{opt.key}）
            </Text>
          )
        })}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.dim}>↑/↓ 选择 · 回车确认 · y 允许 · a 总是 · n 拒绝</Text>
      </Box>
    </Box>
  )
}
