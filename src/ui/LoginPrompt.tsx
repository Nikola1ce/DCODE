// API Key 录入弹窗。
// 用于首次启动或 /login 时输入 DeepSeek API Key。输入内容以掩码（•）显示，避免肩窥泄露。
// 回车提交，Esc 取消。
// 制作人：Moriarty_Dox

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { useTheme } from './theme.js'
import { DEFAULT_BASE_URL } from '../constants.js'

// 组件入参。
interface LoginPromptProps {
  // 提交回调：返回用户输入的 API Key。
  onSubmit: (apiKey: string) => void
  // 取消回调。
  onCancel: () => void
}

/**
 * API Key 录入弹窗。
 * @param props 入参。
 * @returns 弹窗 JSX。
 */
export function LoginPrompt({ onSubmit, onCancel }: LoginPromptProps): React.ReactElement {
  const theme = useTheme()
  // 输入缓冲区。
  const [value, setValue] = useState('')

  useInput((input, key) => {
    // 回车：提交（去除首尾空白）。
    if (key.return) {
      const v = value.trim()
      if (v.length > 0) onSubmit(v)
      return
    }
    // Esc：取消。
    if (key.escape) {
      onCancel()
      return
    }
    // 退格：删除末位。
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1))
      return
    }
    // 忽略控制键。
    if (key.ctrl || key.meta || key.tab) return
    // 追加可见字符。
    if (input && input.length > 0) {
      setValue((v) => v + input)
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
        设置 DeepSeek API Key
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.dim}>
          请在 https://platform.deepseek.com 获取 API Key（端点：{DEFAULT_BASE_URL}）。
        </Text>
        <Text color={theme.dim}>密钥仅保存在本机 ~/.dcode/config.json。</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent}>{'Key ❯ '}</Text>
        {/* 以掩码显示已输入字符数 */}
        <Text color={theme.text}>{'•'.repeat(value.length)}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>回车提交 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
