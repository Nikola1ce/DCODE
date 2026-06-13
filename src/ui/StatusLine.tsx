// 底部状态栏组件 + 加载指示器。
// 状态栏展示：运行/就绪状态、当前模型、权限模式、预估成本。运行时配合动画 spinner 与中断提示。
// 制作人：Moriarty_Dox

import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from './theme.js'
import type { PermissionMode } from '../config.js'
import { formatCost } from '../deepseek/pricing.js'

// 旋转动画的帧序列（盲文点阵，视觉平滑）。
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// 上下文进度条的字符宽度（格子数）。取较小宽度以适配窄终端，不挤占状态栏。
const CONTEXT_BAR_WIDTH = 10
// 进度条已填充/未填充使用的字符（实心块 / 浅色块），视觉上对比清晰。
const CONTEXT_BAR_FILLED = '█'
const CONTEXT_BAR_EMPTY = '░'

/**
 * 去除小数字符串末尾多余的 0 与小数点（如 "12.0" → "12"、"1.50" → "1.5"）。
 * 用于 k/m 单位显示时让数字更干净，避免出现 "128.0k" 这类冗余。
 * @param s toFixed 之后的数字字符串。
 * @returns 去除尾随 0 的字符串。
 */
function trimTrailingZeros(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
}

/**
 * 把 token 数格式化为带 k / m 单位的紧凑字符串（用于上下文用量显示）。
 * 采用 1000 进制（k=千、m=百万），与各厂商「128K / 200K / 1M 上下文」的标注口径一致，
 * 直观且不挤占状态栏宽度。规则：
 * - < 1000：直接显示整数（如 "512"）；
 * - [1000, 1e6)：以 k 显示，保留 1 位小数并去除尾随 0（如 "12.3k"、"128k"）；
 * - >= 1e6：以 m 显示，保留 2 位小数并去除尾随 0（如 "1m"、"1.25m"）。
 * @param n token 数（负数与小数会被钳制/四舍五入）。
 * @returns 形如 "512" / "12.3k" / "1.25m" 的字符串。
 */
export function formatTokenCount(n: number): string {
  const v = Math.max(0, Math.round(n))
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${trimTrailingZeros((v / 1000).toFixed(1))}k`
  return `${trimTrailingZeros((v / 1_000_000).toFixed(2))}m`
}

/**
 * 上下文用量进度条：在状态栏展示「当前使用上下文 / 总共上下文」的可视化占比。
 * 设计：用定宽字符画进度条 + 百分比 + 具体 token 数字，三者并列，直观反映剩余空间。
 * 颜色随占用率分级提示——低占用为弱化色，临近上限转为警告/错误色，提醒可能触发自动压缩。
 * @param used 当前已使用（估算）的上下文 token 数。
 * @param limit 总共可用的上下文 token 预算（达到后会触发自动压缩）。
 * @returns 进度条 JSX。
 */
function ContextMeter({
  used,
  limit,
}: {
  used: number
  limit: number
}): React.ReactElement {
  const theme = useTheme()
  // 防御性归一化：limit 非法时回退为 1，避免除零；ratio 钳制到 [0,1]。
  const safeLimit = limit > 0 ? limit : 1
  const ratio = Math.min(1, Math.max(0, used / safeLimit))
  // 根据比例计算实心格子数；只要有占用就至少点亮 1 格，便于察觉。
  const filledCount =
    used > 0 ? Math.max(1, Math.round(ratio * CONTEXT_BAR_WIDTH)) : 0
  const bar =
    CONTEXT_BAR_FILLED.repeat(filledCount) +
    CONTEXT_BAR_EMPTY.repeat(Math.max(0, CONTEXT_BAR_WIDTH - filledCount))
  const percent = Math.round(ratio * 100)
  // 占用率分级配色：≥90% 用错误色（临近压缩），≥70% 用警告色，其余用主强调色。
  const barColor =
    ratio >= 0.9 ? theme.error : ratio >= 0.7 ? theme.warning : theme.accent
  return (
    <Text color={theme.dim}>
      上下文 <Text color={barColor}>{bar}</Text> {percent}%（
      {formatTokenCount(used)}/{formatTokenCount(limit)}）
    </Text>
  )
}

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
  // 当前会话已使用（估算）的上下文 token 数；用于状态栏上下文进度条。
  contextTokens?: number
  // 总共可用的上下文 token 预算；达到后会触发自动压缩。缺省时不渲染进度条。
  contextLimit?: number
  // 运行期的简短状态文案（如“正在思考”“执行工具”）。
  statusText?: string
  // 是否播放状态栏 spinner；工具进度面板已有 spinner 时可关闭，避免双重高频重绘。
  animate?: boolean
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
  contextTokens,
  contextLimit,
  statusText,
  animate = true,
}: StatusLineProps): React.ReactElement {
  const theme = useTheme()
  // 仅当上下文预算有效时才展示进度条，避免无意义的 0/0 显示。
  const showContext =
    typeof contextLimit === 'number' && contextLimit > 0
  return (
    <Box marginTop={busy ? 0 : 0}>
      {busy ? (
        <Box>
          {animate ? (
            <Spinner />
          ) : (
            <Text color={theme.primary}>{SPINNER_FRAMES[0]}</Text>
          )}
          <Text color={theme.dim}>
            {' '}
            {statusText ?? '处理中'}…　按 <Text color={theme.accent}>Esc</Text> 中断
          </Text>
        </Box>
      ) : (
        <Box>
          <Text color={theme.dim}>
            {model}　·　权限 {MODE_LABELS[permissionMode]}　·　预估成本 {formatCost(costUsd)}
          </Text>
          {showContext ? (
            <>
              <Text color={theme.dim}>　·　</Text>
              <ContextMeter used={contextTokens ?? 0} limit={contextLimit} />
            </>
          ) : null}
        </Box>
      )}
    </Box>
  )
}
