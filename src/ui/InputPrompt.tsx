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
import {
  type EditorState,
  clearSelection,
  copy as copyEditor,
  cut as cutEditor,
  deleteBackward,
  deleteForward,
  emptyState,
  insertText,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  paste as pasteEditor,
  replaceAll,
  selectAll,
  valueChanged,
} from './inputEditor.js'
import { readClipboard, writeClipboard } from './clipboard.js'

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

// 撤销/重做栈的最大深度（防止长时间输入导致快照无限增长）。
const UNDO_LIMIT = 200

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
  // 输入文本 + 光标 + 选区合并存储：所有写操作都基于上一状态做“函数式更新”，从根本上避免读到旧值。
  const [buf, setBuf] = useState<EditorState>(emptyState())
  const { value, cursor, selection } = buf
  // 撤销/重做栈：保存文本编辑的历史快照（仅在「文本」变化时记录，纯光标移动不入栈）。
  // 用 ref 承载，避免频繁 setState 引发额外渲染；它们不影响 UI 直接呈现。
  const undoStack = useRef<EditorState[]>([])
  const redoStack = useRef<EditorState[]>([])
  // 内部剪贴板：承载 Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴的文本。用内部剪贴板而非系统
  // 剪贴板，以保证跨平台一致、且不受终端 bracketed-paste 行为差异影响。
  const clipboard = useRef<string>('')
  // 最新编辑状态镜像：供「不修改状态」的只读操作（如 Ctrl+C 复制）在稳定回调里读取当前选区/文本，
  // 避免把 buf 列入 handleKey 依赖而破坏「stdin 不重订阅」的设计。
  const latestState = useRef<EditorState>(buf)
  latestState.current = buf
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
    setBuf(emptyState())
    setHistoryIdx(null)
    setMenuIndex(0)
    setMenuDismissed(false)
    undoStack.current = []
    redoStack.current = []
  }, [])

  /**
   * 应用一次「编辑变换」并维护撤销栈。
   * 仅当变换确实改变了文本（valueChanged）时，才把变换前的快照压入撤销栈并清空重做栈；
   * 纯光标/选区变化（移动、全选）不入栈，避免撤销时出现“只挪动光标”的无效步骤。
   * @param fn 接收旧状态、返回新状态的纯变换。
   */
  const applyEdit = useCallback((fn: (prev: EditorState) => EditorState): void => {
    setBuf((prev) => {
      const next = fn(prev)
      if (valueChanged(prev, next)) {
        undoStack.current.push(prev)
        if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift()
        redoStack.current = []
      }
      return next
    })
  }, [])

  /**
   * 撤销：弹出撤销栈顶恢复，并把当前状态压入重做栈。栈空时无操作。
   */
  const undo = useCallback((): void => {
    setBuf((prev) => {
      const snapshot = undoStack.current.pop()
      if (!snapshot) return prev
      redoStack.current.push(prev)
      return snapshot
    })
  }, [])

  /**
   * 重做：弹出重做栈顶恢复，并把当前状态压回撤销栈。栈空时无操作。
   */
  const redo = useCallback((): void => {
    setBuf((prev) => {
      const snapshot = redoStack.current.pop()
      if (!snapshot) return prev
      undoStack.current.push(prev)
      return snapshot
    })
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
            applyEdit(() => replaceAll(nv))
            setMenuDismissed(true)
            setMenuIndex(0)
          }
        }
        return
      }

      // —— Esc：菜单展开时关闭菜单；否则若有选区则清除选区（编辑器习惯）——
      if (key.escape) {
        if (s.menuOpen) {
          setMenuDismissed(true)
          return
        }
        setBuf(clearSelection)
        return
      }

      // —— 左右方向键：移动光标；存在选区时折叠到对应端（编辑器习惯）。纯移动不入撤销栈 ——
      if (key.leftArrow) {
        setBuf(moveLeft)
        return
      }
      if (key.rightArrow) {
        setBuf(moveRight)
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
        setBuf(replaceAll(h))
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
          setBuf(emptyState())
        } else {
          setHistoryIdx(nextIdx)
          const h = s.history[nextIdx] ?? ''
          setBuf(replaceAll(h))
        }
        return
      }

      // —— Ctrl+A：全选当前输入（GUI/现代编辑器习惯，覆盖原「移到行首」语义）——
      // 移到行首改由 Home 键负责（见下），避免与全选冲突。
      if (key.ctrl && input === 'a') {
        setBuf(selectAll)
        return
      }
      // —— Home：光标移到行首（清除选区）——
      if ((key as { home?: boolean }).home) {
        setBuf(moveHome)
        return
      }
      // —— End / Ctrl+E：光标移到行尾（清除选区）——
      if ((key.ctrl && input === 'e') || (key as { end?: boolean }).end) {
        setBuf(moveEnd)
        return
      }
      // —— Ctrl+Z：撤销 ——
      if (key.ctrl && input === 'z') {
        undo()
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }
      // —— Ctrl+Y：重做（部分终端 Ctrl+Shift+Z 不可达，故用 Ctrl+Y 作为重做键）——
      if (key.ctrl && input === 'y') {
        redo()
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }
      // —— Ctrl+C：复制（有选区复制选区，无选区复制整行），不删除、不退出 ——
      // 同时写「系统剪贴板」（异步）与「内部剪贴板」（同步兜底），使复制的内容可粘贴到 DCODE 之外。
      // 退出 DCODE 改用 Ctrl+D 或 /exit（见 App 全局按键）。
      if (key.ctrl && input === 'c') {
        const text = copyEditor(latestState.current)
        if (text) {
          clipboard.current = text
          void writeClipboard(text)
        }
        return
      }
      // —— Ctrl+X：剪切（有选区剪选区，无选区剪整行）；同时写系统剪贴板与内部剪贴板 ——
      if (key.ctrl && input === 'x') {
        applyEdit((b) => {
          const { state, clip } = cutEditor(b)
          if (clip) {
            clipboard.current = clip
            void writeClipboard(clip)
          }
          return state
        })
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }
      // —— Ctrl+V：粘贴。优先读「系统剪贴板」（异步），失败/为空则回退「内部剪贴板」 ——
      if (key.ctrl && input === 'v') {
        void readClipboard().then((sys) => {
          const text = sys && sys.length > 0 ? sys : clipboard.current
          if (!text) return
          // 同步内部剪贴板，保证后续无系统剪贴板时仍可用。
          clipboard.current = text
          applyEdit((b) => pasteEditor(b, text))
          setHistoryIdx(null)
          setMenuDismissed(false)
          setMenuIndex(0)
        })
        return
      }
      // —— Ctrl+U：清空整行 ——
      if (key.ctrl && input === 'u') {
        applyEdit(() => emptyState())
        setMenuIndex(0)
        setMenuDismissed(false)
        return
      }

      // —— Backspace：有选区则删选区，否则删除光标左侧字符；并让命令菜单重新出现 ——
      if (key.backspace) {
        applyEdit(deleteBackward)
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }
      // —— Delete：有选区则删选区，否则删除光标右侧字符（末尾时退化为 Backspace 语义）——
      if (key.delete) {
        applyEdit(deleteForward)
        setMenuDismissed(false)
        setMenuIndex(0)
        return
      }

      // 忽略其它 ctrl/meta 组合键。
      if (key.ctrl || key.meta) return

      // —— 普通可见字符（含多字节中文）：在光标处插入（有选区则替换选区），并重置命令菜单状态 ——
      if (input && input.length > 0) {
        applyEdit((b) => insertText(b, input))
        setHistoryIdx(null)
        setMenuDismissed(false)
        setMenuIndex(0)
      }
    },
    [resetInput, applyEdit, undo, redo],
  )

  // 注册按键处理（handleKey 引用恒定，isActive 变化时才会重订阅）。
  useInput(handleKey, { isActive })

  // 斜杠命令用强调色提示。
  const isCommand = value.trimStart().startsWith('/')
  const fg = isCommand ? theme.accent : theme.text

  return (
    <Box flexDirection="column">
      {/* 命令补全菜单：仅在命令模式且有候选时，于输入框上方展开 */}
      {menuOpen ? <CommandMenu items={suggestions} selectedIndex={effIndex} /> : null}

      {/* 输入行：提示符 + 输入内容（含选区高亮 / 模拟光标） */}
      <Box>
        <Text color={theme.primary} bold>
          {'❯ '}
        </Text>
        {selection ? (
          // 有选区：选中区间整体反色高亮；光标隐于活动端（选区已足够指示位置）。
          <>
            <Text color={fg}>{value.slice(0, selection.start)}</Text>
            <Text inverse>{value.slice(selection.start, selection.end)}</Text>
            <Text color={fg}>{value.slice(selection.end)}</Text>
          </>
        ) : (
          // 无选区：光标位置的字符反色（末尾时用空格占位），其余正常着色。
          <>
            <Text color={fg}>{value.slice(0, cursor)}</Text>
            <Text inverse>{value.slice(cursor, cursor + 1) || ' '}</Text>
            <Text color={fg}>{value.slice(cursor + 1)}</Text>
          </>
        )}
      </Box>
    </Box>
  )
}
