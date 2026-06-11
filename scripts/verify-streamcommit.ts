// StreamCommitter 流式分块状态机验证脚本。
// 目标：确认「按换行切块 + 首块标记 + 块尾间距」在各种时序下正确，且分块拼接可无损还原原文，
// 既不丢字也不重复（这是「滚动条跟随流式输出」修复的核心逻辑）。
// 制作人：Moriarty_Dox

import { StreamCommitter, type StreamChunk } from '../src/ui/streamCommit.js'

/** 断言条件，失败抛错。 */
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

/** 深比较分块数组，失败时打印实际值。 */
function expectChunks(actual: StreamChunk[], expected: StreamChunk[], label: string): void {
  const norm = (c: StreamChunk) =>
    JSON.stringify({ variant: c.variant, text: c.text, head: c.head, spacer: !!c.spacer })
  const a = actual.map(norm)
  const e = expected.map(norm)
  assert(
    a.length === e.length && a.every((x, i) => x === e[i]),
    `${label}\n  实际: ${JSON.stringify(actual)}\n  期望: ${JSON.stringify(expected)}`,
  )
}

function main(): void {
  // 1) 思维链（无换行）+ 正文（含换行），showThinking=true。
  {
    const c = new StreamCommitter(true)
    const out: StreamChunk[] = []
    out.push(...c.onReasoning('我先想一下'))
    assert(c.liveReasoning === '我先想一下', '思维链尾巴应在实时区')
    assert(c.reasoningHeadDone === false, '尚未提交思维链首块')
    out.push(...c.onText('你好\n世界\n'))
    out.push(...c.onDone())
    expectChunks(
      out,
      [
        { variant: 'reasoning', text: '我先想一下', head: true },
        { variant: 'reasoning', text: '', head: false, spacer: true },
        { variant: 'text', text: '你好\n世界', head: true },
        { variant: 'text', text: '', head: false, spacer: true },
      ],
      '用例1：思维链+正文',
    )
    assert(c.liveText === '' && c.liveReasoning === '', '结束后实时区应清空')
  }

  // 2) 纯正文（无思维链内容），不应产生多余的思维链块或前置空行。
  {
    const c = new StreamCommitter(true)
    const out: StreamChunk[] = []
    out.push(...c.onText('Hi'))
    assert(c.liveText === 'Hi' && c.textHeadDone === false, '正文尾巴在实时区、未提交首块')
    out.push(...c.onDone())
    expectChunks(
      out,
      [
        { variant: 'text', text: 'Hi', head: true },
        { variant: 'text', text: '', head: false, spacer: true },
      ],
      '用例2：纯正文',
    )
  }

  // 3) showThinking=false：思维链增量被完全忽略。
  {
    const c = new StreamCommitter(false)
    const out: StreamChunk[] = []
    out.push(...c.onReasoning('这段不该出现\n第二行\n'))
    assert(out.length === 0 && c.liveReasoning === '', '关闭思维链时不产出、不显示')
    out.push(...c.onText('ok'))
    out.push(...c.onDone())
    expectChunks(
      out,
      [
        { variant: 'text', text: 'ok', head: true },
        { variant: 'text', text: '', head: false, spacer: true },
      ],
      '用例3：关闭思维链',
    )
  }

  // 4) 多条助手消息（工具调用场景）：每条消息正文首块都应重新带 ●。
  {
    const c = new StreamCommitter(true)
    const m1 = [...c.onText('A\n'), ...c.onDone()]
    expectChunks(
      m1,
      [
        { variant: 'text', text: 'A', head: true },
        { variant: 'text', text: '', head: false, spacer: true },
      ],
      '用例4：消息1',
    )
    const m2 = [...c.onText('B\n'), ...c.onDone()]
    expectChunks(
      m2,
      [
        { variant: 'text', text: 'B', head: true },
        { variant: 'text', text: '', head: false, spacer: true },
      ],
      '用例4：消息2（首块应再次带 ●）',
    )
  }

  // 5) 保留正文中的空行。
  {
    const c = new StreamCommitter(false)
    const out = [...c.onText('a\n\nb\n'), ...c.onDone()]
    const textChunks = out.filter((x) => x.variant === 'text' && x.text.length > 0)
    assert(textChunks.length === 1 && textChunks[0].text === 'a\n\nb', '应保留中间空行')
  }

  // 6) 无损还原：把任意文本按随机切片喂入，正文分块拼接后应等于原文（去尾换行）。
  {
    const texts = [
      '第一行\n第二行\n第三行',
      'line1\nline2\n',
      '# 标题\n\n- 项目A\n- 项目B\n\n结尾段落。',
      '单行无换行内容',
      'a\n\n\nb', // 连续空行
    ]
    for (const T of texts) {
      for (const seed of [1, 3, 7]) {
        const c = new StreamCommitter(false)
        const chunks: StreamChunk[] = []
        // 伪随机切片喂入。
        let i = 0
        let r = seed
        while (i < T.length) {
          r = (r * 1103515245 + 12345) & 0x7fffffff
          const step = 1 + (r % 4)
          const delta = T.slice(i, i + step)
          chunks.push(...c.onText(delta))
          i += step
        }
        chunks.push(...c.onDone())
        // 仅取「正文内容块」（排除 spacer 间隔块），按换行拼接还原。
        const joined = chunks
          .filter((x) => x.variant === 'text' && !x.spacer)
          .map((x) => x.text)
          .join('\n')
        assert(
          joined === T.replace(/\n+$/, ''),
          `用例6：无损还原失败 seed=${seed}\n  原文: ${JSON.stringify(T)}\n  还原: ${JSON.stringify(joined)}`,
        )
      }
    }
  }

  // 7) 仅思维链、无正文（如仅含推理就结束的消息）：onDone 落最后一段思维链。
  {
    const c = new StreamCommitter(true)
    const out = [...c.onReasoning('只有思考没有正文'), ...c.onDone()]
    expectChunks(
      out,
      [
        { variant: 'reasoning', text: '只有思考没有正文', head: true },
        { variant: 'reasoning', text: '', head: false, spacer: true },
      ],
      '用例7：仅思维链',
    )
  }

  process.stdout.write('VERIFY_STREAMCOMMIT_OK\n')
}

main()
