// API Key 录入弹窗。
// 用于首次启动或 /login 时按当前 Provider 输入对应 API Key；掩码显示，回车提交，Esc 取消。
// 制作人：Moriarty_Dox

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
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
}: LoginPromptProps): React.ReactElement {
  const theme = useTheme()
  const [value, setValue] = useState('')

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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.primary} paddingX={1}>
      <Text color={theme.primary} bold>
        设置 {providerName} API Key
      </Text>
      <Box marginTop={1} flexDirection="column">
        {platformUrl ? (
          <Text color={theme.dim}>
            请在 {platformUrl} 获取 API Key（端点：{baseURL}）。
          </Text>
        ) : (
          <Text color={theme.dim}>API 端点：{baseURL}</Text>
        )}
        <Text color={theme.dim}>
          密钥保存在 ~/.dcode/config.json（providers.{providerId}，与其它供应商独立）。
        </Text>
        <Text color={theme.dim}>也可设置环境变量 {apiKeyEnv}。</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent}>{'Key ❯ '}</Text>
        <Text color={theme.text}>{'•'.repeat(value.length)}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>回车提交 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
