// API Key 录入弹窗。
// 用于首次启动或 /login 时按当前 Provider 输入对应 API Key；掩码显示，回车提交，Esc 取消。
// 制作人：Moriarty_Dox

import React, { useEffect, useState } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { useTheme } from './theme.js'
import type { ProviderId } from '../providers/types.js'

// 组件入参。
interface LoginPromptProps {
  /** 当前 Provider 标识。 */
  providerId: ProviderId
  /** 展示名称，如 OpenAI、DeepSeek。 */
  providerName: string
  /** 获取 Key 的平台链接。 */
  platformUrl: string
  /** API 端点（展示用）。 */
  baseURL: string
  /** 对应环境变量名。 */
  apiKeyEnv: string
  // 提交回调：返回用户输入的 API Key。
  onSubmit: (apiKey: string) => void
  // 取消回调。
  onCancel: () => void
  // 父级分配的总高度；小窗口优先保留密钥输入与操作提示。
  maxRows?: number
}

/**
 * API Key 录入弹窗（随当前 Provider 切换标题与说明）。
 * @param props 入参。
 * @returns 弹窗 JSX。
 */
export function LoginPrompt({
  providerId,
  providerName,
  platformUrl,
  baseURL,
  apiKeyEnv,
  onSubmit,
  onCancel,
  maxRows = 11,
}: LoginPromptProps): React.ReactElement {
  const theme = useTheme()
  const [value, setValue] = useState('')
  const { stdout } = useStdout()
  const [columns, setColumns] = useState(stdout.columns || 80)
  useEffect(() => {
    const resize = () => setColumns(stdout.columns || 80)
    stdout.on('resize', resize)
    return () => { stdout.off('resize', resize) }
  }, [stdout])
  const compact = maxRows < 11 || columns < 12
  const maskColumns = Math.max(0, columns - (compact ? 0 : 4) - 7)

  useInput((input, key) => {
    if (key.return) {
      const v = value.trim()
      if (v.length > 0) onSubmit(v)
      return
    }
    if (key.escape) {
      onCancel()
      return
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || key.tab) return
    if (input && input.length > 0) {
      setValue((v) => v + input)
    }
  })

  return (
    <Box flexDirection="column" borderStyle={compact ? undefined : 'round'} borderColor={theme.primary} paddingX={compact ? 0 : 1}>
      {maxRows >= 3 ? <Text color={theme.primary} bold wrap="truncate">
        设置 {providerName.replace(/\s+/g, ' ')} API Key
      </Text> : null}
      {!compact ? <Box marginTop={1} flexDirection="column">
        {platformUrl ? (
          <Text color={theme.dim} wrap="truncate">
            请在 {platformUrl.replace(/\s+/g, ' ')} 获取 API Key（端点：{baseURL.replace(/\s+/g, ' ')}）。
          </Text>
        ) : (
          <Text color={theme.dim} wrap="truncate">API 端点：{baseURL.replace(/\s+/g, ' ')}</Text>
        )}
        <Text color={theme.dim} wrap="truncate">
          密钥保存在 ~/.dcode/config.json（providers.{providerId}，与其它供应商独立）。
        </Text>
        <Text color={theme.dim} wrap="truncate">也可设置环境变量 {apiKeyEnv.replace(/\s+/g, ' ')}。</Text>
      </Box> : null}
      <Box marginTop={compact ? 0 : 1} height={1} overflowY="hidden" flexShrink={0}>
        <Text wrap="truncate">
          <Text color={theme.accent}>{'Key ❯ '}</Text>
          <Text color={theme.text}>{'•'.repeat(Math.min(value.length, maskColumns))}</Text>
          <Text inverse> </Text>
        </Text>
      </Box>
      {maxRows >= 2 ? <Box marginTop={compact ? 0 : 1}>
        <Text color={theme.dim} wrap="truncate">回车提交 · Esc 取消</Text>
      </Box> : null}
    </Box>
  )
}
