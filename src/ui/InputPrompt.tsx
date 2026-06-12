// 文本输入框组件（含斜杠命令自动补全菜单）。
// 基于 ink 的 useInput 自实现的单行输入框，支持光标移动、删除、命令历史与提交。
// 当输入以 "/" 开头且尚未键入空格时，会在输入框上方弹出可选命令菜单：
//   - ↑/↓ 在候选命令间移动选择；
//   - Tab 将选中命令补全到输入框（追加空格，便于继续输入参数）；
//   - 回车 直接执行选中的命令；
//   - Esc 关闭菜单。
//
// 【中文输入“落后一拍”修复说明】
// ink 的 useInput 内部以 inputHandler 作为 useEffect 依赖：每次渲染若传入新的回调，
// 都会“取消订阅 → 重新订阅” stdin 监听；而旧的回调闭包又捕获了过期的 value/cursor。
// 中文经输入法(IME)提交时是多字节字符，恰好在这一“重订阅 + 过期闭包”的窗口里被延迟，
// 表现为第一个字符要等下一次按键才显示，甚至丢字符。为彻底修复，本组件做了三件事：
//   1) 用 useCallback([]) 固定按键回调引用 → useInput 不再每次按键重订阅 stdin；
//   2) 回调内通过 latestRef 读取“最新”派生状态（菜单/候选/历史等），杜绝过期闭包；
//   3) 把 value 与 cursor 合并为单一状态对象，并全部采用“函数式更新”，保证原子且永不读旧值。
// 不依赖第三方输入组件，便于定制。
// 制作人：Moriarty_Dox

import React, { useCallback, useRef, useState } from 'react'
import { Box, Text, useInput, type Key } from 'ink'
import { useTheme } from './theme.js'
import type { DCodeConfig } from '../config.js'
import { getSlashSuggestions } from '../commands/index.js'
import { CommandMenu } from './CommandMenu.js'

// 组件入参。
interface InputPromptProps {
  // 提交回调：用户按下回车（或在菜单中选定命令）时触发。
  onSubmit: (value: string) => void
  // 是否激活（false 时不响应按键，用于 Agent 运行期间）。
  isActive: boolean
  // 历史命令（最近的在数组末尾），用于上下方向键回溯。
  history: string[]
  // 读取最新配置（用于 /model 等 Provider 感知补全）。
  getConfig: () => DCodeConfig
}

// 输入缓冲：把文本与光标位置合并为一个状态，确保二者始终原子一致、互不错位。
interface InputBuffer {
  // 当前输入文本。
  value: string
  // 光标位置（0..value.length）。
  cursor: number
}

/**
 * 单行文本输入框（带命令补全菜单）。
 * @param props 组件入参。
 * @returns 输入框 JSX。
 */
export function InputPrompt({
  onSubmit,
  isActive,
  history,
  getConfig,
}: InputPromptProps): React.ReactElement {
  const theme = useTheme()
  // 输入文本与光标合并存储：所有写操作都基于上一状态做“函数式更新”，从根本上避免读到旧值。
  const [buf, setBuf] = useState<InputBuffer>({ value: '', cursor: 0 })
  const { value, cursor } = buf
  // 历史浏览指针：null 表示不在浏览历史。
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  // 命令菜单当前高亮项序号（与候选数量取模得到有效索引，支持循环滚动）。
  const [menuIndex, setMenuIndex] = useState(0)
  // 是否已手动关闭命令菜单（Esc 或补全后置 true；输入/删除字符时重置为 false）。
  const [menuDismissed, setMenuDismissed] = useState(false)

  // —— 计算命令补全状态（渲染与按键回调共用同一份派生值）——
  // 斜杠输入且存在候选时进入命令补全模式（含 /provider openai 等参数补全）。
  const suggestions = value.startsWith('/') ? getSlashSuggestions(value, getConfig()) : []
  const inCommandMode = value.startsWith('/') && suggestions.length > 0
  // 菜单是否展开：激活、有候选且未被手动关闭。
  const menuOpen = isActive && suggestions.length > 0 && !menuDismissed
  // 有效高亮索引：对候选数量取模（含负数归一），保证落在合法范围内。
  const effIndex =
    suggestions.length > 0
      ? ((menuIndex % suggestions.length) + suggestions.length) % suggestions.length
      : 0

  // —— latest-ref：每次渲染把“最新”派生状态与回调快照到 ref ——
  // 稳定的按键回调（见下）只从这里读取当前值，从而既能拿到最新状态、又无需把它们列为依赖，
  // 避免回调引用变化引发 useInput 反复重订阅 stdin（中文输入延迟的根因）。
  const latest = useRef({
    value,
    historyIdx,
    menuOpen,
    suggestions,
    effIndex,
    inCommandMode,
    history,
    onSubmit,
  })
  latest.current = {
    value,
    historyIdx,
    menuOpen,
    suggestions,
    effIndex,
    inCommandMode,
    history,
    onSubmit,
  }

  /**
   * 将输入框重置为初始空状态（提交后调用）。
   * 用 useCallback([]) 固定引用，使依赖它的按键回调也保持稳定。
   */
  const resetInput = useCallback((): void => {
    setBuf({ value: '', cursor: 0 })
    setHistoryIdx(null)
    setMenuIndex(0)
    setMenuDismissed(false)
  }, [])

  /**
   * 稳定的按键处理函数。
   * 关键点：useCallback 依赖恒定 → 回调引用不变 → ink 的 useInput 不再每次按键重订阅 stdin；
   * 所有“当前状态”一律从 latest.current 读取，所有状态写入一律用函数式更新。
   * @param input 本次输入的可见字符（控制键时为空或键名）。
   * @param key   ink 解析出的按键信息（方向键/回车/退格/组合键等）。
   */
  const handleKey = useCallback(
    (input: string, key: Key): void => {
      const s = latest.current

      // —— 回车：菜单展开时执行选中命令；否则提交当前输入 ——
      if (key.return) {
        if (s.menuOpen) {
          const sel = s.suggestions[s.effIndex]
          if (sel) {
            s.onSubmit(sel.completion)
            resetInput()
          }
          return
        }
        const v = s.value.trim()
        if (v.length === 0) return
        s.onSubmit(v)
        resetInput()
        return
      }

      // —— Tab：菜单展开时把选中命令补全到输入框（追加空格便于输入参数）——
      if (key.tab) {
        if (s.menuOpen) {
          const sel = s.suggestions[s.effIndex]
          if (sel) {
            const nv = sel.completion.endsWith(' ') ? sel.completion : `${sel.completion} `
            setBuf({ value: nv, cursor: nv.length })
            setMenuDismissed(true)
            setMenuIndex(0)
          }
        }
        return
      }

      // —— Esc：菜单展开时关闭菜单（不影响其它场景）——
      if (key.escape) {
        if (s.menuOpen) setMenuDismissed(true)
        return
      }

      // —— 左右方向键：移动光标（基于上一状态 clamp 到合法范围）——
      if (key.leftArrow) {
        setBuf((b) => ({ ...b, cursor: Math.max(0, b.cursor - 1) }))
        return
      }
      if (key.rightArrow) {
        setBuf((b) => ({ ...b, cursor: Math.min(b.value.length, b.cursor + 1) }))
        return
      }

      // —— 上方向键：菜单展开时上移高亮；命令模式下不触发历史；否则回溯历史 ——
      if (key.upArrow) {
        if (s.menuOpen) {
          setMenuIndex((i) => i - 1)
          return
        }
        // 正在输入命令名（即便暂无候选）时，不用历史覆盖当前输入。
        if (s.inCommandMode) return
        if (s.history.length === 0) return
        const nextIdx =
          s.historyIdx === null ? s.history.length - 1 : Math.max(0, s.historyIdx - 1)
        setHistoryIdx(nextIdx)
        const h = s.history[nextIdx] ?? ''
        setBuf({ value: h, cursor: h.length })
        return
      }
      // —— 下方向键：菜单展开时下移高亮；命令模式下不触发历史；否则在历史中前进 ——
      if (key.downArrow) {
        if (s.menuOpen) {
          setMenuIndex((i) => i + 1)
          return
        }
        if (s.inCommandMode) return
        if (s.historyIdx === null) return
        const nextIdx = s.historyIdx + 1
        if (nextIdx >= s.history.length) {
          setHistoryIdx(null)
          setBuf({ value: '', cursor: 0 })
        } else {
          setHistoryIdx(nextIdx)
          const h = s.history[nextIdx] ?? ''
          setBuf({ value: h, cursor: h.length })
        }
        return
      }

      // —— Home / Ctrl+A：光标移到行首 ——
      if ((key.ctrl && input === 'a') || (key as { home?: boolean }).home) {
        setBuf((b) => ({ ...b, cursor: 0 }))
        return
      }
      // —— End / Ctrl+E：光标移到行尾 ——
      if ((key.ctrl && input === 'e') || (key as { end?: boolean }).end) {
        setBuf((b) => ({ ...b, cursor: b.value.length }))
        return
      }
      // —— Ctrl+U：清空整行 ——
      if (key.ctrl && input === 'u') {
        setBuf({ value: '', cursor: 0 })
        setMenuIndex(0)
        setMenuDismissed(false)
        return
      }

      // —— Backspace：删除光标左侧字符，并让命令菜单重新出现 ——
      if (key.backspace) {
        setBuf((b) =>
          b.cursor > 0
            ? {
                value: b.value.slice(0, b.cursor - 1) + b.value.slice(b.cursor),
                cursor: b.cursor - 1,
              }
            : b,
        )
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }
      // —— Delete：删除光标右侧字符（末尾时退化为 Backspace 语义）——
      if (key.delete) {
        setBuf((b) => {
          if (b.cursor < b.value.length) {
            return {
              value: b.value.slice(0, b.cursor) + b.value.slice(b.cursor + 1),
              cursor: b.cursor,
            }
          }
          if (b.cursor > 0) {
            return { value: b.value.slice(0, b.cursor - 1), cursor: b.cursor - 1 }
          }
          return b
        })
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }

      // 忽略其它 ctrl/meta 组合键。
      if (key.ctrl || key.meta) return

      // —— 普通可见字符（含多字节中文）：在光标处插入，并重置命令菜单状态 ——
      if (input && input.length > 0) {
        setBuf((b) => ({
          value: b.value.slice(0, b.cursor) + input + b.value.slice(b.cursor),
          cursor: b.cursor + input.length,
        }))
        setHistoryIdx(null)
        setMenuDismissed(false)
        setMenuIndex(0)
      }
    },
    [resetInput],
  )

  // 注册按键处理（handleKey 引用恒定，isActive 变化时才会重订阅）。
  useInput(handleKey, { isActive })

  // 渲染带光标的输入内容：把光标位置的字符用反色显示。
  const before = value.slice(0, cursor)
  const cursorChar = value.slice(cursor, cursor + 1) || ' '
  const after = value.slice(cursor + 1)
  // 斜杠命令用强调色提示。
  const isCommand = value.trimStart().startsWith('/')

  return (
    <Box flexDirection="column">
      {/* 命令补全菜单：仅在命令模式且有候选时，于输入框上方展开 */}
      {menuOpen ? <CommandMenu items={suggestions} selectedIndex={effIndex} /> : null}

      {/* 输入行：提示符 + 输入内容 + 模拟光标 */}
      <Box>
        <Text color={isCommand ? theme.accent : theme.text}>
          <Text color={theme.primary} bold>
            {'❯ '}
          </Text>
          {before}
        </Text>
        <Text inverse>{cursorChar}</Text>
        {after ? (
          <Text color={isCommand ? theme.accent : theme.text}>{after}</Text>
        ) : null}
      </Box>
    </Box>
  )
}
