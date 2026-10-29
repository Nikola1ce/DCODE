// 后台 Shell 任务面板。
// 展示 run_command(background=true) 启动的后台进程状态，运行中时可折叠为单行摘要。
// 通过轮询 shellManager 更新状态，避免阻塞主 Agent 循环。
// 制作人：Moriarty_Dox

import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { shellManager, type ShellRecord } from '../core/shellManager.js'
import { useTheme } from './theme.js'

/** 入参。 */
interface BackgroundShellPanelProps {
  /** 折叠模式：Agent 运行中仅显示单行摘要。 */
  compact?: boolean
  /** 非折叠模式下最多可见行数。 */
  maxVisible?: number
}

/**
 * 后台 Shell 面板；无运行中/近期任务时不渲染。
 * @param props 入参。
 * @returns 面板 JSX 或 null。
 */
export function BackgroundShellPanel({
  compact = false,
  maxVisible = 5,
}: BackgroundShellPanelProps): React.ReactElement | null {
  const theme = useTheme()
  const [shells, setShells] = useState<ShellRecord[]>(() =>
    readShellSnapshots(),
  )

  // 轮询 shellManager，刷新运行中 Shell 状态与输出长度。
  useEffect(() => {
    const tick = () => {
      const next = readShellSnapshots()
      setShells((prev) => {
        if (prev.length === 0 && next.length === 0) return prev
        if (prev.length !== next.length) return next
        const changed = next.some((s, i) => {
          const p = prev[i]
          return !p || p.id !== s.id || p.status !== s.status || p.output.length !== s.output.length
        })
        return changed ? next : prev
      })
    }
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
  }, [])

  if (shells.length === 0) return null

  const running = shells.filter((s) => s.status === 'running')

  if (compact) {
    const first = running[0] ?? shells[0]
    const tail = first
      ? `　▶ ${first.id} $ ${first.command.replace(/\s+/g, ' ')}`
      : ''
    return (
      <Box height={1} flexShrink={0} overflowY="hidden">
        <Text color={theme.dim} wrap="truncate">
          后台 Shell {running.length} 运行中
          {tail}
        </Text>
      </Box>
    )
  }

  const cap = Math.max(1, maxVisible)
  const visible = shells.slice(0, cap)
  const hidden = shells.length - visible.length

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.tool}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={theme.dim} wrap="truncate">
        后台 Shell（{running.length} 运行中 / {shells.length} 条）
      </Text>
      {visible.map((s) => {
        const mark =
          s.status === 'running' ? '▶' : s.status === 'completed' ? '✔' : '✖'
        const color =
          s.status === 'running'
            ? theme.accent
            : s.status === 'completed'
              ? theme.success
              : theme.warning
        const outLen = s.output.length
        return (
          <Text key={s.id} color={color} wrap="truncate">
            {mark} [{s.id}] $ {s.command.replace(/\s+/g, ' ')}
            {outLen > 0 ? ` (${outLen} 字符输出)` : ''}
          </Text>
        )
      })}
      {hidden > 0 ? (
        <Text color={theme.dim} wrap="truncate">   … 另有 {hidden} 条</Text>
      ) : null}
    </Box>
  )
}

// ShellManager 原地更新记录，React 必须保留独立快照，否则 prev 与 next 指向
// 同一对象时状态/输出变化永远比较不出来，完成后的任务仍会显示“运行中”。
function readShellSnapshots(): ShellRecord[] {
  return shellManager.getAllShells()
    .filter((s) => s.status === 'running' || isRecent(s))
    .map((s) => ({ ...s }))
}

/**
 * 判断已结束 Shell 是否仍在「近期」展示窗口内（5 分钟内）。
 * @param s Shell 记录。
 * @returns 是否近期。
 */
function isRecent(s: ShellRecord): boolean {
  if (s.status === 'running') return true
  const end = s.endedAt ?? s.createdAt
  return Date.now() - end < 5 * 60 * 1000
}
