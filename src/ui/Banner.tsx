// 欢迎横幅组件。
// 在主界面顶部展示 DCODE 的 ASCII 艺术字、标语、版本，以及醒目的制作人「Moriarty_Dox」署名，
// 并附上当前模型、工作目录与新手提示。仅在会话开始时渲染一次。
// 制作人：Moriarty_Dox

import React from 'react'
import { Box, Text } from 'ink'
import { AUTHOR, VERSION, TAGLINE } from '../constants.js'
import { useTheme } from './theme.js'

// Banner 组件入参。
interface BannerProps {
  // 当前模型名。
  model: string
  // 当前工作目录。
  cwd: string
}

// 实心「D」点阵（ANSI Shadow 风格，与 VS Code 插件图标 media/icon.png 中那枚实心字母 D 一致）。
// 设计要点：
//   - 采用 ████ 实心方块 + ╔╗╚╝║═ 描边阴影构成「实心块字母」，笔画为纯色填充，立体饱满，
//     观感与图标里那枚实心 D 完全一致；不再使用线框镂空字。
//   - 在 D 的内孔中嵌入图标的「代码符号」<│（左箭头 + 光标竖线），还原图标 D 内部的 ◄│ 图形。
//   - 该 D 比标准 ANSI Shadow 的 D 略加宽（内孔扩到 4 列），使 <│ 符号居中舒展、清晰可辨。
//   - 高度固定 6 行、每行等宽 10 列（全部窄字符），与右侧 CODE 垂直对齐且不会 Ink 错位。
const SOLID_D = [
  '████████╗ ',
  '██╔════██╗',
  '██║    ██║',
  '██║    ██║',
  '████████╔╝',
  '╚═══════╝',
]

// D 内部「代码符号」字符集合：渲染时这些字符用暗色（模拟图标里 ◄│ 那种从青绿块上镂空、
// 露出深色背景的负空间效果），其余 D 笔画字符则用青绿渐变填充。
const D_SYMBOL_CHARS = new Set(['<', '│'])

// 「CODE」实心块艺术字（figlet「ANSI Shadow」字体，与实心 D 同款风格，构成全实心的 DCODE 字样）。
// 取自 ANSI Shadow 渲染的 DCODE 去掉首字母 D 后的 C/O/D/E 部分，字形保持不变。共 6 行。
const CODE_ART = [
  ' ██████╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  '██║     ██║   ██║██║  ██║█████╗  ',
  '██║     ██║   ██║██║  ██║██╔══╝  ',
  '╚██████╗╚██████╔╝██████╔╝███████╗',
  '  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]

// 图标「D」的青绿对角渐变色阶（取自 VS Code 插件图标 media/icon.png 中字母 D 的填充色：
// 左上偏青 → 右下偏翠绿）。按实心 D 的 6 行，从上到下做青→绿的逐行过渡，
// 在终端用「每行一种纯色填充」近似还原图标里那条对角渐变，使 CLI 的实心 D 与插件图标观感一致。
// 该渐变属品牌固定色，不随明暗主题切换，以保证「和图标一致」。ink5 基于 chalk5 支持 truecolor，
// 因此可直接使用十六进制色值精确还原。
const ICON_D_GRADIENT = [
  '#5CE5E0', // 第 1 行：青（cyan / turquoise，对应图标左上）
  '#54E3D6', // 第 2 行：青绿过渡
  '#4CE0C8', // 第 3 行：青绿
  '#45DDBA', // 第 4 行：绿青
  '#42D9AC', // 第 5 行：偏翠绿
  '#3DD68C', // 第 6 行：翠绿（emerald，对应图标右下）
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
        {/* ASCII 艺术字 LOGO：首字母「D」为实心块（青绿逐行渐变 + 内嵌 <│ 代码符号，与插件图标一致），
            其余「CODE」为同款实心块字体、主题主色，整体构成全实心的 DCODE 品牌字样 */}
        <Box flexDirection="column">
          {SOLID_D.map((dLine, i) => {
            // 当前行实心 D 的渐变色（越界时兜底为末色，保证健壮）
            const dColor = ICON_D_GRADIENT[i] ?? ICON_D_GRADIENT[ICON_D_GRADIENT.length - 1]
            // 将本行按「代码符号字符」切分逐段着色：符号用暗色（模拟镂空），笔画用青绿渐变。
            // 用 reduce 把相邻同类字符合并为一段，减少渲染的 <Text> 数量。
            const segments: Array<{ text: string; symbol: boolean }> = []
            for (const ch of dLine) {
              const symbol = D_SYMBOL_CHARS.has(ch)
              const last = segments[segments.length - 1]
              if (last && last.symbol === symbol) last.text += ch
              else segments.push({ text: ch, symbol })
            }
            return (
              <Text key={i} bold>
                {/* 实心 D：笔画用青绿渐变填充；内嵌 <│ 符号用暗色，模拟图标里镂空露背景的代码符号 */}
                {segments.map((seg, j) => (
                  <Text key={j} color={seg.symbol ? theme.dim : dColor}>
                    {seg.text}
                  </Text>
                ))}
                {/* D 与 CODE 之间留 1 列间距 */}
                <Text> </Text>
                {/* 文字 CODE：同款实心块字体，主题主色 */}
                <Text color={theme.primary}>{CODE_ART[i]}</Text>
              </Text>
            )
          })}
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
          <Text color={theme.dim}>  ·  WTY 出品</Text>
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
