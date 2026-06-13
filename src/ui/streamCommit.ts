// 流式分块提交状态机（纯逻辑，不依赖 React，便于单测）。
//
// 背景：早期实现把整段流式正文都留在「动态区(非 Static)」里实时重绘。Ink 5.2.1 的
// log-update 在动态区高度不变时只做原地重绘，终端不会触发「输出越过底部 → 自动下滚」，
// 于是流式输出时视口被钉住、滚动条不跟随；而一旦动态区高过视口又会帧泄漏（思考过程刷屏）。
//
// 解决：流式时把「已完成的整行」逐块提交到 Static 滚动历史，动态区只保留「正在输入的
// 最后一行（未完成尾巴）」。这样正文像普通命令输出一样流入滚动区、终端自然跟随到底部，
// 动态区也始终很矮、不再帧泄漏。本类负责这套「按换行切块 + 首块标记 + 块尾间距」的纯逻辑。
// 制作人：Moriarty_Dox

// 一个待提交到 Static 的展示分块。
import { charCols, strCols } from './textLayout.js'
import { traceEvent, traceTextFields, type TraceContext } from '../trace.js'

const MAX_LIVE_TEXT_COLS = 120
const MAX_LIVE_REASONING_COLS = 120
const MIN_SOFT_FLUSH_REST_COLS = 24

export interface StreamChunk {
  // 'reasoning' 思维链（暗色），'text' 正文。
  variant: 'text' | 'reasoning'
  // 该块的文本（可含多行；空串代表正文中的一行空行，渲染为空白行）。
  text: string
  // 是否为该类型在本条助手消息中的「首块」——首块带「● 」/「💭 思考过程：」标签。
  head: boolean
  // 是否为「间隔块」：仅用于分隔（思维链↔正文、消息↔消息），渲染为一行空白，
  // 不属于正文内容（拼接还原原文时应忽略）。
  spacer?: boolean
}

/**
 * 流式分块提交器：喂入 reasoning/text 增量，产出应提交到 Static 的分块列表，
 * 并维护「未完成尾巴」供实时区显示。每条助手消息独立计算首块；onDone 后自动复位。
 */
export class StreamCommitter {
  // 是否展示思维链（关闭时忽略所有 reasoning 增量）。
  private readonly showThinking: boolean
  // 正文 / 思维链的未完成尾巴缓冲（尚未遇到换行）。
  private pendingText = ''
  private pendingReasoning = ''
  // 本条消息是否已开始输出正文（用于在正文开始前先把思维链尾巴落盘）。
  private textStarted = false
  // 本条消息是否已提交过对应类型的首块。
  private textHead = false
  private reasoningHead = false
  private traceContext: TraceContext = {}

  /**
   * @param showThinking 是否展示思维链。
   */
  constructor(showThinking: boolean) {
    this.showThinking = showThinking
  }

  setTraceContext(context: TraceContext): void {
    this.traceContext = context
  }

  /** 实时区应显示的正文未完成尾巴。 */
  get liveText(): string {
    return this.pendingText
  }

  /** 实时区应显示的思维链未完成尾巴（关闭思维链时恒为空）。 */
  get liveReasoning(): string {
    return this.showThinking ? this.pendingReasoning : ''
  }

  /** 是否已提交过正文首块（决定实时尾巴用「● 」还是缩进续行）。 */
  get textHeadDone(): boolean {
    return this.textHead
  }

  /** 是否已提交过思维链首块（决定实时尾巴是否还需显示标签）。 */
  get reasoningHeadDone(): boolean {
    return this.reasoningHead
  }

  /**
   * 接收一段思维链增量，返回应提交到 Static 的分块（按换行切出的已完成行）。
   * @param delta 思维链增量文本。
   * @returns 待提交分块列表（可能为空）。
   */
  onReasoning(delta: string): StreamChunk[] {
    if (!this.showThinking) return []
    traceEvent('committer', 'reasoning_append_before', {
      ...traceTextFields('delta', delta),
      ...traceTextFields('pendingReasoning', this.pendingReasoning),
    }, this.traceContext)
    this.pendingReasoning += delta
    const chunks = this.flush('reasoning')
    traceEvent('committer', 'reasoning_append_after', {
      chunkCount: chunks.length,
      chunks: chunks.map(traceCommittedChunk),
      ...traceTextFields('pendingReasoning', this.pendingReasoning),
    }, this.traceContext)
    return chunks
  }

  /**
   * 接收一段正文增量，返回应提交到 Static 的分块。
   * 首次调用会先把思维链残余尾巴落盘并补块尾间距，再处理正文。
   * @param delta 正文增量文本。
   * @returns 待提交分块列表（可能为空）。
   */
  onText(delta: string): StreamChunk[] {
    const out: StreamChunk[] = []
    traceEvent('committer', 'text_append_before', {
      textStarted: this.textStarted,
      ...traceTextFields('delta', delta),
      ...traceTextFields('pendingText', this.pendingText),
      ...traceTextFields('pendingReasoning', this.pendingReasoning),
    }, this.traceContext)
    if (!this.textStarted) {
      this.textStarted = true
      // 正文开始前：把思维链残余尾巴落盘，并在思维链与正文之间补一行间隔。
      if (this.showThinking) {
        if (this.pendingReasoning !== '') {
          const c = this.commit('reasoning', this.pendingReasoning)
          if (c) out.push(c)
        }
        if (this.reasoningHead) out.push(this.makeSpacer('reasoning'))
      }
      this.pendingReasoning = ''
    }
    this.pendingText += delta
    out.push(...this.flush('text'))
    traceEvent('committer', 'text_append_after', {
      chunkCount: out.length,
      chunks: out.map(traceCommittedChunk),
      ...traceTextFields('pendingText', this.pendingText),
      ...traceTextFields('pendingReasoning', this.pendingReasoning),
    }, this.traceContext)
    return out
  }

  /**
   * 一条助手消息结束：提交剩余的未完成尾巴并补块尾间距，然后复位以迎接下一条消息。
   * @returns 待提交分块列表（可能为空）。
   */
  onDone(): StreamChunk[] {
    const out: StreamChunk[] = []
    traceEvent('committer', 'done_before', {
      textStarted: this.textStarted,
      textHead: this.textHead,
      reasoningHead: this.reasoningHead,
      ...traceTextFields('pendingText', this.pendingText),
      ...traceTextFields('pendingReasoning', this.pendingReasoning),
    }, this.traceContext)
    if (this.textStarted) {
      // 提交正文最后一行（未完成尾巴），再补消息间隔。
      // 尾巴为空（原文以换行结尾）时无需再补空行，交由间隔块统一处理，避免双空行。
      if (this.pendingText !== '') {
        const c = this.commit('text', this.pendingText)
        if (c) out.push(c)
      }
      if (this.textHead) out.push(this.makeSpacer('text'))
    } else if (this.showThinking) {
      if (this.pendingReasoning !== '') {
        const c = this.commit('reasoning', this.pendingReasoning)
        if (c) out.push(c)
      }
      if (this.reasoningHead) out.push(this.makeSpacer('reasoning'))
    }
    traceEvent('committer', 'done_after', {
      chunkCount: out.length,
      chunks: out.map(traceCommittedChunk),
    }, this.traceContext)
    this.reset()
    return out
  }

  /**
   * 从指定缓冲切出「已完成的整行」并提交，保留最后未完成的一行。
   * 注意：done 可能为空串（代表正文中的一行空行），同样会被提交以保证不丢空行。
   * @param variant 流类型。
   * @returns 提交出的分块（0 或 1 个）。
   */
  private flush(variant: 'text' | 'reasoning'): StreamChunk[] {
    const buf = variant === 'text' ? this.pendingText : this.pendingReasoning
    const lastNl = buf.lastIndexOf('\n')
    if (lastNl < 0) return this.flushLongLive(variant)
    const done = buf.slice(0, lastNl) // 已完成行（不含最后那个换行符，它是与尾巴的分隔）
    const rest = buf.slice(lastNl + 1) // 余下未完成尾巴
    traceEvent('committer', 'newline_split', {
      variant,
      ...traceTextFields('done', done),
      ...traceTextFields('rest', rest),
    }, this.traceContext)
    if (variant === 'text') this.pendingText = rest
    else this.pendingReasoning = rest
    const c = this.commit(variant, done)
    const out = c ? [c] : []
    out.push(...this.flushLongLive(variant))
    return out
  }

  private flushLongLive(variant: 'text' | 'reasoning'): StreamChunk[] {
    const out: StreamChunk[] = []
    let buf = variant === 'text' ? this.pendingText : this.pendingReasoning
    const maxCols = variant === 'text' ? MAX_LIVE_TEXT_COLS : MAX_LIVE_REASONING_COLS

    while (strCols(buf) > maxCols + MIN_SOFT_FLUSH_REST_COLS) {
      const split = splitByCols(buf, maxCols)
      if (!split) break
      traceEvent('committer', 'soft_split', {
        variant,
        maxCols,
        ...traceTextFields('done', split.done),
        ...traceTextFields('rest', split.rest),
      }, this.traceContext)
      const c = this.commit(variant, split.done)
      if (c) out.push(c)
      buf = split.rest
    }

    if (variant === 'text') this.pendingText = buf
    else this.pendingReasoning = buf
    return out
  }

  /**
   * 生成一个内容分块并更新首块状态。
   * 唯一被丢弃的情形：该类型尚无任何内容时的「前导空白」（避免孤立的 ● / 标签与前导空行）。
   * 其余一律提交——包括空串（正文中的空行），由渲染层显示为一行空白，从而不丢失空行。
   * @param variant 流类型。
   * @param text 分块文本。
   * @returns 分块或 null。
   */
  private commit(variant: 'text' | 'reasoning', text: string): StreamChunk | null {
    const headDone = variant === 'text' ? this.textHead : this.reasoningHead
    const head = !headDone
    if (text.trim() === '' && head) return null
    if (variant === 'text') this.textHead = true
    else this.reasoningHead = true
    traceEvent('committer', 'commit_chunk', {
      variant,
      head,
      ...traceTextFields('text', text),
    }, this.traceContext)
    return { variant, text, head }
  }

  /** 生成一个「间隔块」（渲染为一行空白），用于分隔思维链/正文/消息。 */
  private makeSpacer(variant: 'text' | 'reasoning'): StreamChunk {
    return { variant, text: '', head: false, spacer: true }
  }

  /** 复位每条消息独立的流式状态（onDone 后调用）。 */
  private reset(): void {
    this.pendingText = ''
    this.pendingReasoning = ''
    this.textStarted = false
    this.textHead = false
    this.reasoningHead = false
  }
}

function splitByCols(text: string, maxCols: number): { done: string; rest: string } | null {
  const chars = [...text]
  let cols = 0
  let splitIndex = 0

  for (let i = 0; i < chars.length; i++) {
    const nextCols = cols + charCols(chars[i].codePointAt(0) ?? 0)
    if (nextCols > maxCols) break
    cols = nextCols
    splitIndex = i + 1
  }

  if (splitIndex <= 0 || splitIndex >= chars.length) return null
  const softIndex = findSoftSplitIndex(chars, splitIndex)
  const cut = softIndex > 0 ? softIndex : splitIndex
  return {
    done: chars.slice(0, cut).join(''),
    rest: chars.slice(cut).join(''),
  }
}

function findSoftSplitIndex(chars: string[], hardIndex: number): number {
  const min = Math.max(0, hardIndex - 24)
  for (let i = hardIndex - 1; i >= min; i--) {
    if (/[\s，。；：、,.!?;:]/.test(chars[i])) return i + 1
  }
  return 0
}

function traceCommittedChunk(chunk: StreamChunk): Record<string, unknown> {
  return {
    variant: chunk.variant,
    head: chunk.head,
    spacer: !!chunk.spacer,
    ...traceTextFields('text', chunk.text),
  }
}
