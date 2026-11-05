// 统一差异行号与提交拓扑布局，仅处理展示数据。
// 制作人：Moriarty_Dox
import type { GitCommit } from '../shared/services.js'

export interface DiffRow { kind: 'add' | 'remove' | 'context' | 'meta'; text: string; oldLine?: number; newLine?: number }
export function diffRows(text: string): DiffRow[] {
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  return text.split('\n').map((line) => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
    } else if (line.startsWith('diff --git')) inHunk = false
    if (inHunk && line.startsWith('+')) return { kind: 'add', text: line.slice(1), newLine: newLine++ }
    if (inHunk && line.startsWith('-')) return { kind: 'remove', text: line.slice(1), oldLine: oldLine++ }
    if (inHunk && line.startsWith(' ')) return { kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }
    return { kind: 'meta', text: line }
  })
}

export function pairedDiffRows(rows: DiffRow[]): { left?: DiffRow; right?: DiffRow; meta?: string }[] {
  const paired: { left?: DiffRow; right?: DiffRow; meta?: string }[] = []
  for (let index = 0; index < rows.length;) {
    const row = rows[index]
    if (row.kind === 'meta') { paired.push({ meta: row.text }); index++; continue }
    if (row.kind === 'context') { paired.push({ left: row, right: row }); index++; continue }
    const removed: DiffRow[] = []
    const added: DiffRow[] = []
    while (index < rows.length && ['add', 'remove'].includes(rows[index].kind)) {
      const change = rows[index++]
      if (change.kind === 'add') added.push(change)
      else removed.push(change)
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset++) {
      paired.push({ left: removed[offset], right: added[offset] })
    }
  }
  return paired
}

export function commitGraph(commits: GitCommit[]) {
  const lanes: string[] = []
  return commits.map((commit) => {
    if (!lanes.includes(commit.hash)) lanes.push(commit.hash)
    const before = [...lanes]
    const column = lanes.indexOf(commit.hash)
    lanes.splice(column, 1)
    for (const parent of [...commit.parents].reverse()) if (!lanes.includes(parent)) lanes.splice(column, 0, parent)
    const edges = before.flatMap((hash, from) => {
      const targets = hash === commit.hash ? commit.parents : [hash]
      return targets.map((target) => ({ from, to: lanes.indexOf(target) }))
    })
    return { column, width: Math.max(before.length, lanes.length, 1), edges }
  })
}
