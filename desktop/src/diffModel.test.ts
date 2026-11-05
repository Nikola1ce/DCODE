// 差异行号与合并提交图回归。
// 制作人：Moriarty_Dox
import { describe, expect, it } from 'vitest'
import { commitGraph, diffRows, pairedDiffRows } from './diffModel.js'

describe('差异与提交图', () => {
  it('并排视图将同一区块的删除和新增对齐，保留多余行', () => {
    const pairs = pairedDiffRows(diffRows('@@ -1,2 +1 @@\n-one\n-two\n+new'))
    expect(pairs[1]).toMatchObject({ left: { text: 'one', oldLine: 1 }, right: { text: 'new', newLine: 1 } })
    expect(pairs[2].left?.text).toBe('two')
    expect(pairs[2].right).toBeUndefined()
  })
  it('正确处理文件头、新增删除行和多个 hunk', () => {
    const rows = diffRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -2,2 +2,2 @@\n old\n-before\n+after\n@@ -9 +9 @@\n-tail\n+end')
    expect(rows[2].kind).toBe('meta')
    expect(rows[4]).toMatchObject({ kind: 'context', oldLine: 2, newLine: 2 })
    expect(rows[5]).toMatchObject({ kind: 'remove', oldLine: 3 })
    expect(rows[6]).toMatchObject({ kind: 'add', newLine: 3 })
    expect(rows[9]).toMatchObject({ kind: 'add', newLine: 9 })
  })
  it('合并提交按照真实父提交分叉并汇合', () => {
    const commits = [{ hash: 'merge', parents: ['a', 'b'] }, { hash: 'a', parents: ['base'] }, { hash: 'b', parents: ['base'] }, { hash: 'base', parents: [] }]
      .map((commit) => ({ ...commit, author: '', timestamp: 0, subject: '', refs: '' }))
    const graph = commitGraph(commits)
    expect(graph[0].edges).toEqual([{ from: 0, to: 0 }, { from: 0, to: 1 }])
    expect(graph[2].edges).toEqual([{ from: 0, to: 0 }, { from: 1, to: 0 }])
    expect(graph[3].edges).toEqual([])
  })
})
