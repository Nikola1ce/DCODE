// 流式分块提交状态机（纯逻辑，不依赖 React，便于单测）。
//
// 背景：早期实现把整段流式正文都留在「动态区(非 Static)」里实时重绘。Ink 5.2.1 的
// log-update 在动态区高度不变时只做原地重绘，终端不会触发「输出越过底部 → 自动下滚」，
// 于是流式输出时视口被钉住、滚动条不跟随；而一旦动态区高过视口又会帧泄漏（思考过程刷屏）。
//
// 解决：流式时把「已完成的整行」逐块提交到 Static 滚动历史，动态区只保留「正在输入的
// 最后一行（未完成尾巴）」。这样正文像普通命令输出一样流入滚动区、终端自然跟随到底部，
// 动态区也始终很矮、不再帧泄漏。本类负责这套「按换行切块 + 首块标记 + 块尾间距」的纯逻辑。
//
// 思维链（reasoning）处理（Claude Code 风格）：与正文不同，思维链「不」逐块落入 Static 历史，
// 否则会把完整的、可能很长的思考过程整段刷进滚动区，造成冗长杂乱（即用户反馈的「输出混乱」）。
// 改为：思维链只在「动态区」实时滚动预览（liveReasoning，仅保留尾部若干行），思考结束（正文开始
// 或本条消息结束）时，对外产出一个「思考摘要」（hadReasoning + 耗时 + 字符数），由 UI 在历史区
// 折叠成一行「✻ 已思考（N 秒）」，从而既保留「思考过了」的可见痕迹，又不刷屏。
// 制作人：Moriarty_Dox

// 一个待提交到 Static 的展示分块。
import { charCols, strCols } from './textLayout.js'
import { traceEvent, traceTextFields, type TraceContext } from '../trace.js'

const MAX_LIVE_TEXT_COLS = 120
const MAX_LIVE_REASONING_COLS = 120
const MIN_SOFT_FLUSH_REST_COLS = 24
// 思维链动态预览在内存中保留的最大字符数：思维链只在动态区滚动展示，不落历史，
// 因此只需保留尾部一小段供预览（UI 还会按可视行数二次截断）。过大徒增重绘成本。
const MAX_LIVE_REASONING_PREVIEW_CHARS = 2000

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
 * 思考摘要：思考结束时对外产出，供 UI 在历史区折叠成一行「✻ 已思考（N 秒）」。
 * 仅当本条消息确实出现过思维链时 hadReasoning 为 true。
 */
export interface ThinkingSummary {
  // 本条消息是否出现过思维链（false 时 UI 不应产生折叠摘要项）。
  hadReasoning: boolean
  // 思考耗时（毫秒）：从首个 reasoning 增量到思考结束。
  durationMs: number
  // 思考内容累计字符数（用于可选的补充展示）。
  chars: number
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
  // 思维链的「实时预览缓冲」：仅保留尾部若干字符供动态区滚动展示，不落 Static 历史。
  private reasoningPreview = ''
  // 本条消息是否已开始输出正文。
  private textStarted = false
  // 本条消息是否已提交过正文首块。
  private textHead = false
  // —— 思考摘要相关 —— //
  // 本条消息是否出现过思维链。
  private hadReasoning = false
  // 思考累计字符数（基于增量长度累加）。
  private reasoningChars = 0
  // 首个 reasoning 增量到达的时间戳（计算思考耗时用）；未思考时为 0。
  private reasoningStartedAt = 0
  // 思考结束时间戳（正文开始或本条消息结束时记录）；未结束时为 0。
  private reasoningEndedAt = 0
  // 思考摘要是否已被取走（避免对同一条消息重复产出折叠项）。
  private thinkingSummaryTaken = false
  private traceContext: TraceContext = {}

  /**
   * 当前时间戳获取器（便于单测注入固定时钟）。
   */
  private readonly now: () => number

  /**
   * @param showThinking 是否展示思维链。
   * @param now 可选时钟函数（测试用），默认 Date.now。
   */
  constructor(showThinking: boolean, now: () => number = Date.now) {
    this.showThinking = showThinking
    this.now = now
  }

  setTraceContext(context: TraceContext): void {
    this.traceContext = context
  }

  /** 实时区应显示的正文未完成尾巴。 */
  get liveText(): string {
    return this.pendingText
  }

  /**
   * 实时区应显示的思维链预览（仅尾部若干字符；关闭思维链时恒为空）。
   * 思维链不落 Static，故此值是「正在思考」时动态区滚动展示的唯一来源。
   */
  get liveReasoning(): string {
    return this.showThinking ? this.reasoningPreview : ''
  }

  /** 是否已提交过正文首块（决定实时尾巴用「● 」还是缩进续行）。 */
  get textHeadDone(): boolean {
    return this.textHead
  }

  /** 本条消息当前是否正处于「思考中」（已出现思维链且尚未取走摘要/开始正文）。 */
  get isThinking(): boolean {
    return this.showThinking && this.hadReasoning && !this.thinkingSummaryTaken && !this.textStarted
  }

  /**
   * 取走「思考摘要」并标记已取走（幂等：再次调用返回 hadReasoning=false）。
   * 在「正文开始」或「本条消息结束」时调用，由 UI 据此在历史区折叠出一行「✻ 已思考（N 秒）」。
   * @returns 思考摘要。
   */
  takeThinkingSummary(): ThinkingSummary {
    if (!this.hadReasoning || this.thinkingSummaryTaken) {
      return { hadReasoning: false, durationMs: 0, chars: 0 }
    }
    this.thinkingSummaryTaken = true
    const endedAt = this.reasoningEndedAt || this.now()
    const durationMs = Math.max(0, endedAt - (this.reasoningStartedAt || endedAt))
    return { hadReasoning: true, durationMs, chars: this.reasoningChars }
  }

  /**
   * 接收一段思维链增量（Claude Code 风格：仅更新动态区预览，不落 Static 历史）。
   * 同时累计思考字符数并记录思考起始时间，用于结束时生成折叠摘要。
   * @param delta 思维链增量文本。
   */
  onReasoning(delta: string): void {
    if (!this.showThinking) return
    if (!this.hadReasoning) {
      this.hadReasoning = true
      this.reasoningStartedAt = this.now()
    }
    this.reasoningChars += delta.length
    traceEvent('committer', 'reasoning_append_before', {
      ...traceTextFields('delta', delta),
      ...traceTextFields('reasoningPreview', this.reasoningPreview),
    }, this.traceContext)
    // 只保留尾部一小段供动态区滚动预览，避免内存与重绘随思维链增长而膨胀。
    this.reasoningPreview = (this.reasoningPreview + delta).slice(
      -MAX_LIVE_REASONING_PREVIEW_CHARS,
    )
    traceEvent('committer', 'reasoning_append_after', {
      reasoningChars: this.reasoningChars,
      ...traceTextFields('reasoningPreview', this.reasoningPreview),
    }, this.traceContext)
  }

  /**
   * 接收一段正文增量，返回应提交到 Static 的分块。
   * 首次调用会把「思考结束」时间记录下来并清空思维链动态预览（思维链不落 Static，
   * 其折叠摘要由 UI 通过 takeThinkingSummary 取走后单独落入历史区），再处理正文。
   * @param delta 正文增量文本。
   * @returns 待提交分块列表（可能为空）。
   */
  onText(delta: string): StreamChunk[] {
    const out: StreamChunk[] = []
    traceEvent('committer', 'text_append_before', {
      textStarted: this.textStarted,
      ...traceTextFields('delta', delta),
      ...traceTextFields('pendingText', this.pendingText),
    }, this.traceContext)
    if (!this.textStarted) {
      this.textStarted = true
      // 正文开始即视为「思考结束」：记录结束时间并清空动态预览（折叠摘要由 UI 通过
      // takeThinkingSummary 取走后落入历史区，这里不再把思维链落 Static）。
      if (this.hadReasoning && this.reasoningEndedAt === 0) {
        this.reasoningEndedAt = this.now()
      }
      this.reasoningPreview = ''
    }
    this.pendingText += delta
    out.push(...this.flush('text'))
    traceEvent('committer', 'text_append_after', {
      chunkCount: out.length,
      chunks: out.map(traceCommittedChunk),
      ...traceTextFields('pendingText', this.pendingText),
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
      hadReasoning: this.hadReasoning,
      ...traceTextFields('pendingText', this.pendingText),
    }, this.traceContext)
    // 本条消息结束：若思考尚未标记结束（例如「只思考、无正文」），此刻记录结束时间，
    // 以便 takeThinkingSummary 仍能算出正确耗时。
    if (this.hadReasoning && this.reasoningEndedAt === 0) {
      this.reasoningEndedAt = this.now()
    }
    if (this.textStarted) {
      // 提交正文最后一行（未完成尾巴），再补消息间隔。
      // 尾巴为空（原文以换行结尾）时无需再补空行，交由间隔块统一处理，避免双空行。
      if (this.pendingText !== '') {
        const c = this.commit('text', this.pendingText)
        if (c) out.push(c)
      }
      if (this.textHead) out.push(this.makeSpacer('text'))
    }
    // 注意：思维链不再落 Static（折叠摘要由 UI 通过 takeThinkingSummary 处理）。
    traceEvent('committer', 'done_after', {
      chunkCount: out.length,
      chunks: out.map(traceCommittedChunk),
    }, this.traceContext)
    // 不在此 reset：UI 需要在 onDone 之后调用 takeThinkingSummary 取折叠摘要。
    // 由 UI 在取走摘要后调用 resetForNextMessage（或下一条消息开始时自然复位）。
    this.resetForNextMessage()
    return out
  }

  /**
   * 从正文缓冲切出「已完成的整行」并提交，保留最后未完成的一行。
   * 注意：done 可能为空串（代表正文中的一行空行），同样会被提交以保证不丢空行。
   * 说明：思维链不再走分块提交路径，故 flush 系列只处理正文（'text'）。
   * @returns 提交出的分块（0 或 1 个，外加软换行可能的多块）。
   */
  private flush(_variant: 'text'): StreamChunk[] {
    const buf = this.pendingText
    const lastNl = buf.lastIndexOf('\n')
    if (lastNl < 0) return this.flushLongLive()
    const done = buf.slice(0, lastNl) // 已完成行（不含最后那个换行符，它是与尾巴的分隔）
    const rest = buf.slice(lastNl + 1) // 余下未完成尾巴
    traceEvent('committer', 'newline_split', {
      variant: 'text',
      ...traceTextFields('done', done),
      ...traceTextFields('rest', rest),
    }, this.traceContext)
    this.pendingText = rest
    const c = this.commit('text', done)
    const out = c ? [c] : []
    out.push(...this.flushLongLive())
    return out
  }

  /** 正文超长无换行时的软切分提交（避免单行撑高动态区）。 */
  private flushLongLive(): StreamChunk[] {
    const out: StreamChunk[] = []
    let buf = this.pendingText
    const maxCols = MAX_LIVE_TEXT_COLS

    while (strCols(buf) > maxCols + MIN_SOFT_FLUSH_REST_COLS) {
      const split = splitByCols(buf, maxCols)
      if (!split) break
      traceEvent('committer', 'soft_split', {
        variant: 'text',
        maxCols,
        ...traceTextFields('done', split.done),
        ...traceTextFields('rest', split.rest),
      }, this.traceContext)
      const c = this.commit('text', split.done)
      if (c) out.push(c)
      buf = split.rest
    }

    this.pendingText = buf
    return out
  }

  /**
   * 生成一个正文分块并更新首块状态。
   * 唯一被丢弃的情形：尚无任何正文时的「前导空白」（避免孤立的 ● 与前导空行）。
   * 其余一律提交——包括空串（正文中的空行），由渲染层显示为一行空白，从而不丢失空行。
   * @param variant 流类型（固定为 'text'）。
   * @param text 分块文本。
   * @returns 分块或 null。
   */
  private commit(variant: 'text', text: string): StreamChunk | null {
    const head = !this.textHead
    if (text.trim() === '' && head) return null
    this.textHead = true
    traceEvent('committer', 'commit_chunk', {
      variant,
      head,
      ...traceTextFields('text', text),
    }, this.traceContext)
    return { variant, text, head }
  }

  /** 生成一个「间隔块」（渲染为一行空白），用于分隔消息。 */
  private makeSpacer(variant: 'text'): StreamChunk {
    return { variant, text: '', head: false, spacer: true }
  }

  /** 复位每条消息独立的流式状态（onDone 内调用，迎接下一条消息）。 */
  private resetForNextMessage(): void {
    this.pendingText = ''
    this.reasoningPreview = ''
    this.textStarted = false
    this.textHead = false
    this.hadReasoning = false
    this.reasoningChars = 0
    this.reasoningStartedAt = 0
    this.reasoningEndedAt = 0
    this.thinkingSummaryTaken = false
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
