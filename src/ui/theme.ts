// UI 主题与配色。
// 定义暗色/亮色两套配色方案，供各组件统一取色。颜色值使用 ink 支持的名称或十六进制。
// 通过 React Context 在组件树中传递当前主题。
// 制作人：Moriarty_Dox

import { createContext, useContext } from 'react'
import type { ThemeName } from '../config.js'

// 一套主题包含的语义化颜色槽位。
export interface Theme {
  // 品牌主色（横幅、强调）。
  primary: string
  // 次要强调色。
  accent: string
  // 普通正文色。
  text: string
  // 次要/弱化文本色（提示、元信息）。
  dim: string
  // 成功态颜色。
  success: string
  // 错误态颜色。
  error: string
  // 警告态颜色。
  warning: string
  // 用户输入/用户消息标识色。
  user: string
  // 工具调用标识色。
  tool: string
  // 界面底色（用于 Ink Box 填充 + OSC 11 设置终端窗口背景）。
  background: string
}

// 暗色主题（默认，适合大多数终端）。
export const DARK_THEME: Theme = {
  primary: '#7C5CFF',
  accent: '#36C5F0',
  text: '#E6EDF3',
  dim: '#8B949E',
  success: '#3FB950',
  error: '#F85149',
  warning: '#D29922',
  user: '#36C5F0',
  tool: '#A371F7',
  background: '#0D1117',
}

// 亮色主题：配合浅色终端底色使用，前景为深色以保证对比度。
export const LIGHT_THEME: Theme = {
  primary: '#5A3EC8',
  accent: '#0969DA',
  text: '#1F2328',
  dim: '#656D76',
  success: '#1A7F37',
  error: '#CF222E',
  warning: '#9A6700',
  user: '#0969DA',
  tool: '#8250DF',
  background: '#F6F8FA',
}

/**
 * 根据主题名返回对应主题对象。
 * @param name 主题名。
 * @returns 主题对象。
 */
export function getTheme(name: ThemeName): Theme {
  return name === 'light' ? LIGHT_THEME : DARK_THEME
}

// 主题 Context，默认暗色。
export const ThemeContext = createContext<Theme>(DARK_THEME)

/**
 * 在组件中获取当前主题的 Hook。
 * @returns 当前主题对象。
 */
export function useTheme(): Theme {
  return useContext(ThemeContext)
}
