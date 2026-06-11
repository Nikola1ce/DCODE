// 底部状态栏组件 + 加载指示器。
// 状态栏展示：运行/就绪状态、当前模型、权限模式、累计成本。运行时配合动画 spinner 与中断提示。
// 制作人：Moriarty_Dox

import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme.js'
import type { PermissionMode } from '../config.js'
import { formatCost } from '../deepseek/pricing.js'

// 旋转动画的帧序列（盲文点阵，视觉平滑）。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * 加载指示器：定时切换帧形成旋转动画。
 * @returns spinner JSX。
 */
export function Spinner(): React.ReactElement {
  const theme = useTheme()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    // 每 80ms 推进一帧。
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])
  return <Text color={theme.primary}>{SPINNER_FRAMES[frame]}</Text>
}

// 状态栏入参。
interface StatusLineProps {
  // 是否正在运行（Agent 处理中）。
  busy: boolean
  // 当前模型名。
  model: string
  // 当前权限模式。
  permissionMode: PermissionMode
  // 累计成本（美元）。
  costUsd: number
  // 运行期的简短状态文案（如“正在思考”“执行工具”）。
  statusText?: string
}

// 权限模式的简短中文标签。
const MODE_LABELS: Record<PermissionMode, string> = {
  default: '默认',
  acceptEdits: '自动编辑',
  plan: '规划(只读)',
  bypass: '跳过确认',
}

/**
 * 底部状态栏。
 * @param props 入参。
 * @returns 状态栏 JSX。
 */
export function StatusLine({
  busy,
  model,
  permissionMode,
  costUsd,
  statusText,
}: StatusLineProps): React.ReactElement {
  const theme = useTheme()
  return (
    <Box marginTop={busy ? 0 : 0}>
      {busy ? (
        <Box>
          <Spinner />
          <Text color={theme.dim}>
            {' '}
            {statusText ?? '处理中'}…　按 <Text color={theme.accent}>Esc</Text> 中断
          </Text>
        </Box>
      ) : (
        <Text color={theme.dim}>
          {model}　·　权限 {MODE_LABELS[permissionMode]}　·　成本 {formatCost(costUsd)}
        </Text>
      )}
    </Box>
  )
}
