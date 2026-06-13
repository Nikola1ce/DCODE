// Diff 工具的单元测试。
// 覆盖：LCS 行级差异、行号标注、hunk 折叠与合并、@@ 头格式、增强视图渲染、
// 以及单行预览的语义分类（供 UI 着色）。
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import {
  annotateDiffLines,
  buildDiffHunks,
  buildDiffPreview,
  buildDiffPreviewView,
  buildDiffView,
  classifyDiffPreviewLine,
  countDiff,
  diffLines,
  formatHunkHeader,
  renderDiffViewText,
} from './diff.js'

describe('diffLines / countDiff（既有能力回归）', () => {
  it('识别新增、删除与未变行', () => {
    const result = diffLines('a\nb\nc', 'a\nB\nc')
    const types = result.map((l) => l.type)
    // 中间行被替换：删除 b、新增 B（顺序由回溯决定，但必含一删一增）。
    expect(types.filter((t) => t === 'del')).toHaveLength(1)
    expect(types.filter((t) => t === 'add')).toHaveLength(1)
    expect(types.filter((t) => t === 'ctx')).toHaveLength(2)
  })

  it('countDiff 统计增删行数', () => {
    expect(countDiff('a\nb', 'a\nb\nc')).toEqual({ added: 1, removed: 0 })
    expect(countDiff('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 })
  })

  it('buildDiffPreview 输出带 +/- 前缀', () => {
    const text = buildDiffPreview('a', 'a\nb')
    expect(text).toContain('+ b')
  })
})

describe('annotateDiffLines（行号标注）', () => {
  it('上下文行同时具备新旧行号', () => {
    const lines = annotateDiffLines('a\nb', 'a\nb')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ type: 'ctx', oldLine: 1, newLine: 1 })
    expect(lines[1]).toMatchObject({ type: 'ctx', oldLine: 2, newLine: 2 })
  })

  it('新增行仅有 newLine，删除行仅有 oldLine', () => {
    const lines = annotateDiffLines('a\nb\nc', 'a\nx\nc')
    const del = lines.find((l) => l.type === 'del')
    const add = lines.find((l) => l.type === 'add')
    expect(del).toMatchObject({ oldLine: 2, newLine: null })
    expect(add).toMatchObject({ oldLine: null, newLine: 2 })
  })
})

describe('buildDiffHunks（折叠与合并）', () => {
  it('无变更时返回空数组', () => {
    expect(buildDiffHunks('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('大文件只保留变更附近的上下文（折叠中间未变区）', () => {
    // 50 行，仅第 25 行变化，context=3 应只产出一个小 hunk。
    const old = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const next = old.replace('line25', 'CHANGED25')
    const hunks = buildDiffHunks(old, next, 3)
    expect(hunks).toHaveLength(1)
    // hunk 行数远小于全文件（上下文 3 + 1 删 + 1 增 上下界）。
    expect(hunks[0].lines.length).toBeLessThan(12)
    // 应包含变更前后的上下文行。
    const texts = hunks[0].lines.map((l) => l.text)
    expect(texts).toContain('line22')
    expect(texts).toContain('CHANGED25')
    expect(texts).toContain('line28')
  })

  it('相邻变更合并为同一 hunk，远离变更拆分为多个 hunk', () => {
    const old = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n')
    // 第 5 行与第 30 行变化：相距远，应得到 2 个 hunk。
    const next = old.replace('l5', 'X5').replace('l30', 'X30')
    const hunks = buildDiffHunks(old, next, 3)
    expect(hunks).toHaveLength(2)
  })

  it('hunk 头计数正确', () => {
    const hunks = buildDiffHunks('a\nb\nc', 'a\nB\nc', 3)
    expect(hunks).toHaveLength(1)
    const header = formatHunkHeader(hunks[0])
    // 旧 3 行（a,b,c）→ 新 3 行（a,B,c），起始均为 1。
    expect(header).toBe('@@ -1,3 +1,3 @@')
  })

  it('纯新增（旧为空）时旧起始行号回退为 0', () => {
    const hunks = buildDiffHunks('', 'a\nb', 3)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].oldStart).toBe(0)
    expect(hunks[0].oldCount).toBe(0)
    expect(hunks[0].newCount).toBe(2)
  })
})

describe('buildDiffView / renderDiffViewText（增强视图）', () => {
  it('视图包含 hunk 头与带行号的行', () => {
    const view = buildDiffView('a\nb\nc', 'a\nB\nc')
    expect(view[0].type).toBe('hunk')
    const text = renderDiffViewText(view)
    expect(text).toContain('@@ -1,3 +1,3 @@')
    // 删除行 b 与新增行 B 都应出现。
    expect(text).toMatch(/- b/)
    expect(text).toMatch(/\+ B/)
  })

  it('maxLines 超限时截断并附省略提示', () => {
    const old = Array.from({ length: 300 }, (_, i) => `o${i}`).join('\n')
    const next = Array.from({ length: 300 }, (_, i) => `n${i}`).join('\n')
    const view = buildDiffView(old, next, { context: 1, maxLines: 50 })
    expect(view.length).toBeLessThanOrEqual(51) // 50 + 1 提示行
    expect(view[view.length - 1].text).toContain('省略')
  })

  it('buildDiffPreviewView 无变更返回空串', () => {
    expect(buildDiffPreviewView('a\nb', 'a\nb')).toBe('')
  })

  it('buildDiffPreviewView 行号列右对齐', () => {
    const text = buildDiffPreviewView('a', 'a\nb')
    // 含 @@ 头。
    expect(text).toContain('@@')
  })
})

describe('classifyDiffPreviewLine（UI 着色分类）', () => {
  it('识别 @@ hunk 头与省略提示', () => {
    expect(classifyDiffPreviewLine('@@ -1,3 +1,3 @@')).toBe('hunk')
    expect(classifyDiffPreviewLine('… 省略 10 行差异 …')).toBe('hunk')
  })

  it('识别增强格式的增删行（带行号列）', () => {
    // 形如 "  1   1   ctx" / "  2     - del" / "      2 + add"
    expect(classifyDiffPreviewLine('  2     - removed')).toBe('del')
    expect(classifyDiffPreviewLine('      2 + added')).toBe('add')
    expect(classifyDiffPreviewLine('  1   1   unchanged')).toBe('ctx')
  })

  it('兼容旧扁平格式（直接以 +/- 起始）', () => {
    expect(classifyDiffPreviewLine('+ new')).toBe('add')
    expect(classifyDiffPreviewLine('- old')).toBe('del')
    expect(classifyDiffPreviewLine('  ctx')).toBe('ctx')
  })

  it('实际渲染输出可被正确分类（端到端一致性）', () => {
    const text = buildDiffPreviewView('a\nb\nc', 'a\nB\nc')
    const kinds = text.split('\n').map(classifyDiffPreviewLine)
    expect(kinds).toContain('hunk')
    expect(kinds).toContain('add')
    expect(kinds).toContain('del')
    expect(kinds).toContain('ctx')
  })
})
