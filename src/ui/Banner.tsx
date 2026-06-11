// 欢迎横幅组件。
// 在主界面顶部展示 DCODE 的 ASCII 艺术字、标语、版本，以及醒目的制作人「Moriarty_Dox」署名，
// 并附上当前模型、工作目录与新手提示。仅在会话开始时渲染一次。
// 制作人：Moriarty_Dox

import React from 'react'
import { Box, Text } from 'ink'
import { PRODUCT_NAME, AUTHOR, VERSION, TAGLINE } from '../constants.js'
import { useTheme } from './theme.js'

// Banner 组件入参。
interface BannerProps {
  // 当前模型名。
  model: string
  // 当前工作目录。
  cwd: string
}

// DCODE 的 ASCII 艺术字（figlet big 字体，逐字母对齐拼接，共 6 行）。
const ASCII_LOGO = [
  ' _____     _____    ____    _____    ______',
  '|  __ \\   / ____|  / __ \\  |  __ \\  |  ____|',
  '| |  | | | |      | |  | | | |  | | | |__',
  '| |  | | | |      | |  | | | |  | | |  __|',
  '| |__| | | |____  | |__| | | |__| | | |____',
  '|_____/   \\_____|  \\____/  |_____/  |______|',
]

/**
 * 欢迎横幅组件。
 * @param props 组件入参。
 * @returns 横幅 JSX。
 */
export function Banner({ model, cwd }: BannerProps): React.ReactElement {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginBottom={1}>
      {/* 外层圆角边框包裹整个横幅，突出品牌感 */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.primary}
        paddingX={2}
        paddingY={1}
      >
        {/* ASCII 艺术字 LOGO */}
        <Box flexDirection="column">
          {ASCII_LOGO.map((line, i) => (
            <Text key={i} color={theme.primary} bold>
              {line}
            </Text>
          ))}
        </Box>

        {/* 标语 */}
        <Box marginTop={1}>
          <Text color={theme.accent}>{TAGLINE}</Text>
          <Text color={theme.dim}>  v{VERSION}</Text>
        </Box>

        {/* 制作人署名：醒目展示「Moriarty_Dox」 */}
        <Box marginTop={1}>
          <Text color={theme.dim}>制作人 </Text>
          <Text color={theme.primary} bold>
            {AUTHOR}
          </Text>
          <Text color={theme.dim}>  ·  {PRODUCT_NAME} 出品</Text>
        </Box>
      </Box>

      {/* 运行信息：当前模型与工作目录 */}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.dim}>
          模型 <Text color={theme.text}>{model}</Text>　·　目录{' '}
          <Text color={theme.text}>{cwd}</Text>
        </Text>
        <Text color={theme.dim}>
          输入问题开始对话；输入 <Text color={theme.accent}>/help</Text> 查看命令；按{' '}
          <Text color={theme.accent}>Esc</Text> 中断，<Text color={theme.accent}>Ctrl+C</Text>{' '}
          退出。
        </Text>
      </Box>
    </Box>
  )
}
