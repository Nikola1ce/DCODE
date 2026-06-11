// 视觉行限高（tailByVisualRows）验证脚本。
// 目标：确认无论中文全角、超长单行、还是多行混排，截取后的文本在给定列宽下
// 「自动换行后」的视觉行数都不会超过 maxRows——这是防止 Ink 帧泄漏（思考过程刷屏）的根本保证。
// 制作人：Moriarty_Dox

import {
  charCols,
  strCols,
  wrappedRows,
  tailByVisualRows,
} from '../src/ui/textLayout.js'

/** 断言条件，失败抛错。 */
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

/** 计算一段文本在 cols 列宽下渲染的总视觉行数（与组件实际换行一致的估算）。 */
function totalVisualRows(text: string, cols: number): number {
  return text
    .split('\n')
    .reduce((sum, line) => sum + wrappedRows(line, cols), 0)
}

function main(): void {
  // 1) 宽度判定：ASCII 1 列，中文/全角 2 列。
  assert(charCols('a'.codePointAt(0)!) === 1, 'ASCII 应为 1 列')
  assert(charCols('毛'.codePointAt(0)!) === 2, '汉字应为 2 列')
  assert(strCols('abc') === 3, 'abc=3 列')
  assert(strCols('毛泽东') === 6, '毛泽东=6 列')

  // 2) 单行换行行数：80 个汉字 = 160 列，在 100 列宽下应为 2 视觉行。
  const cjk80 = '毛'.repeat(80)
  assert(wrappedRows(cjk80, 100) === 2, '160 列 / 100 宽 = 2 行')
  assert(wrappedRows('', 100) === 1, '空行算 1 行')

  // 3) 核心：构造一段「逻辑行少、但换行后很高」的中文文本，验证按视觉行截断。
  //    10 条长中文行，每行 90 汉字=180 列，在 100 列宽下每行 2 视觉行 → 共 20 视觉行。
  const longLine = '一'.repeat(90)
  const text = Array.from({ length: 10 }, (_, i) => `第${i}行${longLine}`).join('\n')
  const cols = 100
  // 逻辑行只有 10，但视觉行有 ~20，远超预算。
  for (const maxRows of [3, 5, 8, 13]) {
    const out = tailByVisualRows(text, maxRows, cols)
    // 去掉可能的省略前缀再统计视觉行（省略标记本身占不到一行预算的语义）。
    const rows = totalVisualRows(out, cols)
    assert(
      rows <= maxRows,
      `maxRows=${maxRows} 时视觉行应 ≤ ${maxRows}，实际 ${rows}`,
    )
    // 必须保留的是“末尾”的内容（包含最后一行的尾部）。
    assert(out.includes('一'), `maxRows=${maxRows} 应保留正文内容`)
  }

  // 4) 超长“单行”（无换行符）也要被钳到 maxRows 视觉行。
  const huge = '数'.repeat(5000) // 10000 列
  const out = tailByVisualRows(huge, 6, 80)
  assert(totalVisualRows(out, 80) <= 6, '超长单行应被钳到 ≤ 6 视觉行')

  // 5) 内容本就很短：原样返回、不加省略标记。
  const short = '你好'
  assert(tailByVisualRows(short, 10, 80) === '你好', '短内容应原样返回')

  // 6) maxRows<=0 返回空串（不渲染思维链时的退化情形）。
  assert(tailByVisualRows('任意', 0, 80) === '', 'maxRows=0 返回空串')

  process.stdout.write('VERIFY_TAILLAYOUT_OK\n')
}

main()
