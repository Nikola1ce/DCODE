// Git 操作封装。
// 为 /commit、/pr、/review 命令提供 status、diff、log、默认分支检测与 gh 可用性检查；
// 不直接执行 commit/push，由 Agent 经 run_command 在用户授权后执行。
// 制作人：Moriarty_Dox

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/** runGit 执行结果。 */
export interface GitRunResult {
  /** 标准输出。 */
  stdout: string
  /** 标准错误。 */
  stderr: string
  /** 退出码。 */
  exitCode: number
  /** 是否执行成功（exitCode === 0）。 */
  ok: boolean
}

/** 仓库基本信息。 */
export interface GitRepoSummary {
  /** 是否为 git 仓库。 */
  isRepo: boolean
  /** 当前分支名。 */
  branch: string
  /** 推断的默认基线分支（main/master）。 */
  defaultBranch: string
  /** 是否有已暂存变更。 */
  hasStaged: boolean
  /** 是否有未暂存变更。 */
  hasUnstaged: boolean
}

/** staged diff 截断上限（字符）。 */
export const MAX_STAGED_DIFF_CHARS = 50_000

/** PR 上下文 diff stat 截断上限。 */
export const MAX_PR_DIFF_STAT_CHARS = 8_000

/** /review 审查 diff 全文截断上限（字符）。 */
export const MAX_REVIEW_DIFF_CHARS = 60_000

/** /review 单文件全文审查截断上限（字符）。 */
export const MAX_REVIEW_FILE_CHARS = 40_000

/** 代码审查可选聚焦维度标识。 */
export type ReviewFocus = 'security' | 'performance' | 'readability' | 'best-practices'

/** 聚焦维度元信息：命令别名 + 中文展示名 + 审查侧重说明。 */
interface ReviewFocusMeta {
  /** 标准维度标识。 */
  id: ReviewFocus
  /** 可识别的命令参数别名（小写）。 */
  aliases: string[]
  /** 中文展示名。 */
  label: string
  /** 注入 prompt 的侧重说明。 */
  hint: string
}

/** 全部聚焦维度定义。 */
export const REVIEW_FOCUS_META: ReviewFocusMeta[] = [
  {
    id: 'security',
    aliases: ['security', 'sec', '安全', '安全性'],
    label: '安全性',
    hint: '注入风险（SQL/命令/路径穿越）、密钥/凭据泄露、不安全的反序列化、权限与输入校验缺失。',
  },
  {
    id: 'performance',
    aliases: ['performance', 'perf', '性能'],
    label: '性能',
    hint: '不必要的重复计算、N+1 / 循环内 IO、同步阻塞、内存泄漏、低效数据结构与算法复杂度。',
  },
  {
    id: 'readability',
    aliases: ['readability', 'read', 'style', '可读性', '风格'],
    label: '可读性',
    hint: '命名清晰度、函数职责单一、重复代码、注释与意图表达、复杂分支的可维护性。',
  },
  {
    id: 'best-practices',
    aliases: ['best-practices', 'best', 'practice', 'practices', '最佳实践', '规范'],
    label: '最佳实践',
    hint: '错误处理与边界、资源释放、类型与契约、可测试性、与项目既有约定的一致性。',
  },
]

/**
 * 在指定目录执行 git 子命令（不经过 shell，避免注入）。
 * @param cwd 工作目录。
 * @param args git 参数（不含 git 本身）。
 * @returns 执行结果。
 */
export function runGit(cwd: string, args: string[]): GitRunResult {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const exitCode = result.status ?? 1
  return { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode, ok: exitCode === 0 }
}

/**
 * 判断目录是否为 git 仓库（含 worktree 子目录）。
 * @param cwd 工作目录。
 * @returns 是仓库返回 true。
 */
export function isGitRepository(cwd: string): boolean {
  const res = runGit(cwd, ['rev-parse', '--git-dir'])
  return res.ok
}

/**
 * 获取当前分支名。
 * @param cwd 工作目录。
 * @returns 分支名；失败返回空串。
 */
export function getCurrentBranch(cwd: string): string {
  const res = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return res.ok ? res.stdout.trim() : ''
}

/**
 * 推断默认基线分支（用于 PR diff/log）。
 * 优先 origin/HEAD，其次 main、master，最后回退 main。
 * @param cwd 工作目录。
 * @returns 分支名。
 */
export function detectDefaultBranch(cwd: string): string {
  const originHead = runGit(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (originHead.ok) {
    const m = originHead.stdout.match(/refs\/remotes\/origin\/(.+)/)
    if (m?.[1]) return m[1].trim()
  }
  for (const candidate of ['main', 'master']) {
    const res = runGit(cwd, ['rev-parse', '--verify', `refs/heads/${candidate}`])
    if (res.ok) return candidate
  }
  return 'main'
}

/**
 * 返回 git status --short 输出。
 * @param cwd 工作目录。
 * @returns status 文本。
 */
export function getGitStatusShort(cwd: string): string {
  const res = runGit(cwd, ['status', '--short'])
  return res.ok ? res.stdout : res.stderr || '（无法读取 git status）'
}

/**
 * 返回已暂存文件的 diff --stat。
 * @param cwd 工作目录。
 * @returns stat 文本。
 */
export function getStagedDiffStat(cwd: string): string {
  const res = runGit(cwd, ['diff', '--staged', '--stat'])
  return res.ok ? res.stdout : ''
}

/**
 * 返回已暂存 diff 全文（可截断）。
 * @param cwd 工作目录。
 * @param maxChars 最大字符数。
 * @returns diff 文本。
 */
export function getStagedDiff(cwd: string, maxChars = MAX_STAGED_DIFF_CHARS): string {
  const res = runGit(cwd, ['diff', '--staged'])
  if (!res.ok) return res.stderr || ''
  return truncateText(res.stdout, maxChars)
}

/**
 * 是否已有 staged 变更。
 * @param cwd 工作目录。
 * @returns 有 staged 返回 true。
 */
export function hasStagedChanges(cwd: string): boolean {
  const res = runGit(cwd, ['diff', '--staged', '--name-only'])
  return res.ok && res.stdout.trim().length > 0
}

/**
 * 返回工作区全部变更的 diff（含已暂存与未暂存，但不含未跟踪文件）。
 * 用于 /review 审查「当前所有改动」。
 * @param cwd 工作目录。
 * @param maxChars 最大字符数。
 * @returns diff 文本（可截断）。
 */
export function getWorkingTreeDiff(cwd: string, maxChars = MAX_REVIEW_DIFF_CHARS): string {
  // HEAD 与工作区比较，可同时覆盖已暂存与未暂存的改动。
  const res = runGit(cwd, ['diff', 'HEAD'])
  if (!res.ok) {
    // 仓库无任何提交（无 HEAD）时回退为对比空树，展示已暂存内容。
    const staged = runGit(cwd, ['diff', '--staged'])
    return staged.ok ? truncateText(staged.stdout, maxChars) : res.stderr || ''
  }
  return truncateText(res.stdout, maxChars)
}

/**
 * 返回工作区全部变更的 diff --stat（含已暂存与未暂存）。
 * @param cwd 工作目录。
 * @returns stat 文本。
 */
export function getWorkingTreeDiffStat(cwd: string): string {
  const res = runGit(cwd, ['diff', 'HEAD', '--stat'])
  if (!res.ok) {
    const staged = runGit(cwd, ['diff', '--staged', '--stat'])
    return staged.ok ? staged.stdout : ''
  }
  return res.stdout
}

/**
 * 是否存在工作区改动（已暂存或未暂存的已跟踪文件）。
 * @param cwd 工作目录。
 * @returns 有改动返回 true。
 */
export function hasWorkingTreeChanges(cwd: string): boolean {
  const res = runGit(cwd, ['diff', 'HEAD', '--name-only'])
  if (res.ok) return res.stdout.trim().length > 0
  // 无 HEAD 时退回检查已暂存。
  return hasStagedChanges(cwd)
}

/**
 * 返回相对 base 的完整 diff（base...HEAD），用于按分支审查 PR。
 * @param cwd 工作目录。
 * @param base 基线分支。
 * @param maxChars 最大字符数。
 * @returns diff 文本（可截断）。
 */
export function getDiffSinceBase(cwd: string, base: string, maxChars = MAX_REVIEW_DIFF_CHARS): string {
  const res = runGit(cwd, ['diff', `${base}...HEAD`])
  if (!res.ok) {
    // 三点语法不可用（如缺少 merge-base）时回退两点语法。
    const fallback = runGit(cwd, ['diff', `${base}..HEAD`])
    return fallback.ok ? truncateText(fallback.stdout, maxChars) : res.stderr || ''
  }
  return truncateText(res.stdout, maxChars)
}

/**
 * 返回相对 base 的 oneline 日志。
 * @param cwd 工作目录。
 * @param base 基线分支。
 * @returns log 文本。
 */
export function getLogOnelineSince(cwd: string, base: string): string {
  const res = runGit(cwd, ['log', `${base}..HEAD`, '--oneline'])
  if (!res.ok) {
    // 基线不存在时尝试 merge-base 风格。
    const fallback = runGit(cwd, ['log', `--oneline`, `-20`])
    return fallback.ok ? fallback.stdout : res.stderr
  }
  return res.stdout
}

/**
 * 返回相对 base 的 diff --stat。
 * @param cwd 工作目录。
 * @param base 基线分支。
 * @returns stat 文本。
 */
export function getDiffStatSince(cwd: string, base: string): string {
  const res = runGit(cwd, ['diff', `${base}...HEAD`, '--stat'])
  if (!res.ok) {
    const fallback = runGit(cwd, ['diff', `${base}..HEAD`, '--stat'])
    return fallback.ok ? truncateText(fallback.stdout, MAX_PR_DIFF_STAT_CHARS) : res.stderr
  }
  return truncateText(res.stdout, MAX_PR_DIFF_STAT_CHARS)
}

/**
 * 汇总仓库状态。
 * @param cwd 工作目录。
 * @returns GitRepoSummary。
 */
export function summarizeRepo(cwd: string): GitRepoSummary {
  if (!isGitRepository(cwd)) {
    return {
      isRepo: false,
      branch: '',
      defaultBranch: 'main',
      hasStaged: false,
      hasUnstaged: false,
    }
  }
  const status = getGitStatusShort(cwd)
  const lines = status.split('\n').filter(Boolean)
  let hasStaged = false
  let hasUnstaged = false
  for (const line of lines) {
    const x = line.slice(0, 2)
    if (x[0] && x[0] !== '?' && x[0] !== ' ') hasStaged = true
    if (x[1] && x[1] !== '?') hasUnstaged = true
  }
  return {
    isRepo: true,
    branch: getCurrentBranch(cwd),
    defaultBranch: detectDefaultBranch(cwd),
    hasStaged,
    hasUnstaged,
  }
}

/**
 * 检测 GitHub CLI (gh) 是否可用。
 * @returns 可用返回 true。
 */
export function isGhAvailable(): boolean {
  const res = spawnSync('gh', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  })
  return (res.status ?? 1) === 0
}

/**
 * 构建 /commit 命令的 Agent prompt 与摘要。
 * @param cwd 工作目录。
 * @returns 成功时含 summary 与 prompt；失败时含 error。
 */
export function buildCommitAgentPrompt(cwd: string):
  | { ok: true; summary: string; prompt: string }
  | { ok: false; error: string } {
  if (!isGitRepository(cwd)) {
    return { ok: false, error: '当前目录不是 Git 仓库。' }
  }
  if (!hasStagedChanges(cwd)) {
    return {
      ok: false,
      error:
        '没有已暂存（staged）的变更。\n请先 git add 后再执行 /commit，或使用 git status 查看状态。',
    }
  }

  const status = getGitStatusShort(cwd)
  const stat = getStagedDiffStat(cwd)
  const diff = getStagedDiff(cwd)

  const summary = [
    '已暂存变更摘要：',
    stat || '（无 stat）',
    '',
    '完整 diff 已交给 Agent 分析。确认后将通过 run_command 执行 git commit（需授权）。',
  ].join('\n')

  const prompt = [
    '请根据以下 **已暂存（staged）** 的 Git 变更，生成 **Conventional Commits** 格式的 commit message。',
    '',
    '要求：',
    '1) 先向用户展示：建议的 type(scope): subject，以及必要的 body（多行变更时）。',
    '2) 用中文简要说明变更要点。',
    '3) **必须等待用户明确确认** 后再执行 git commit；未确认前不要 run_command。',
    '4) 用户确认后，用 run_command 执行 git commit（Windows 用 git commit -m "标题" -m "正文" 或单行 -m）。',
    '5) 不要 git push，除非用户明确要求。',
    '',
    '--- git status --short ---',
    status || '（空）',
    '',
    '--- git diff --staged --stat ---',
    stat || '（空）',
    '',
    '--- git diff --staged ---',
    diff || '（空）',
  ].join('\n')

  return { ok: true, summary, prompt }
}

/**
 * 构建 /pr 命令的 Agent prompt 与摘要。
 * @param cwd 工作目录。
 * @param baseBranch 可选基线分支；缺省自动检测。
 * @param wantCreate 是否倾向直接 gh pr create。
 * @returns 成功时含 summary 与 prompt；失败时含 error。
 */
export function buildPrAgentPrompt(
  cwd: string,
  baseBranch?: string,
  wantCreate = false,
):
  | { ok: true; summary: string; prompt: string }
  | { ok: false; error: string } {
  if (!isGitRepository(cwd)) {
    return { ok: false, error: '当前目录不是 Git 仓库。' }
  }

  const branch = getCurrentBranch(cwd)
  const base = baseBranch?.trim() || detectDefaultBranch(cwd)
  const log = getLogOnelineSince(cwd, base)
  const stat = getDiffStatSince(cwd, base)
  const gh = isGhAvailable()

  if (!log.trim() && !stat.trim()) {
    return {
      ok: false,
      error: `当前分支 ${branch || '(未知)'} 相对 ${base} 没有可展示的 commit 或 diff。\n请确认已提交本地变更且基线分支正确（可用 /pr ${base} 指定）。`,
    }
  }

  const summary = [
    `PR 上下文：${branch} → ${base}`,
    gh ? '（已检测到 GitHub CLI gh）' : '（未检测到 gh，将只生成描述文本）',
    '',
    stat || log || '（无 stat/log）',
  ].join('\n')

  const ghNote = gh
    ? wantCreate
      ? '用户请求创建 PR：在用户确认标题与描述后，可用 run_command 执行 `gh pr create --title "..." --body "..."`（需授权）。'
      : '若用户明确要求创建 PR，可用 run_command 执行 gh pr create（需授权）。'
    : '未安装 gh：只输出 PR 标题与 Markdown 描述，供用户手动创建。'

  const prompt = [
    `请根据以下 Git 信息，生成本次 Pull Request 的 **标题** 与 **Markdown 描述**。`,
    '',
    '描述须包含：',
    '- ## Summary（1-3 条要点）',
    '- ## Changes（变更摘要）',
    '- ## Test plan（测试清单）',
    '- ## Screenshots（占位：N/A 或待补充）',
    '',
    ghNote,
    '不要 git push --force。创建 PR 前向用户展示完整内容并等待确认。',
    '',
    `--- 当前分支 ---`,
    branch || '（未知）',
    '',
    `--- 基线分支 ---`,
    base,
    '',
    `--- git log ${base}..HEAD --oneline ---`,
    log || '（无新 commit）',
    '',
    `--- git diff ${base}...HEAD --stat ---`,
    stat || '（无 diff stat）',
  ].join('\n')

  return { ok: true, summary, prompt }
}

/**
 * 将用户输入的聚焦维度词条解析为标准 ReviewFocus 列表（去重、保序）。
 * @param tokens 维度词条（任意大小写，支持中英文别名）。
 * @returns 命中的标准维度数组；无命中返回空数组。
 */
export function parseReviewFocuses(tokens: string[]): ReviewFocus[] {
  const result: ReviewFocus[] = []
  for (const raw of tokens) {
    const t = raw.trim().toLowerCase()
    if (!t) continue
    const meta = REVIEW_FOCUS_META.find((m) => m.aliases.includes(t))
    if (meta && !result.includes(meta.id)) {
      result.push(meta.id)
    }
  }
  return result
}

/**
 * 读取指定文件用于「单文件审查」。
 * 优先返回该文件的工作区 diff；若无改动则返回文件全文（均可截断）。
 * @param cwd 工作目录。
 * @param filePath 用户传入的文件路径（相对 cwd 或绝对路径）。
 * @returns 成功时含 label/diff/content 标记；失败含 error。
 */
function readFileForReview(
  cwd: string,
  filePath: string,
):
  | { ok: true; rel: string; isDiff: boolean; body: string }
  | { ok: false; error: string } {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath)
  if (!existsSync(abs)) {
    return { ok: false, error: `文件不存在：${filePath}` }
  }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { ok: false, error: `无法读取：${filePath}` }
  }
  if (st.isDirectory()) {
    return {
      ok: false,
      error: `「${filePath}」是目录。/review 暂仅支持单个文件或 diff 范围；目录请用 /review（工作区）或 /review <基线分支>。`,
    }
  }
  const rel = relative(cwd, abs) || filePath
  // 先尝试文件级 diff（含已暂存与未暂存）。
  const diffRes = runGit(cwd, ['diff', 'HEAD', '--', rel])
  if (diffRes.ok && diffRes.stdout.trim()) {
    return { ok: true, rel, isDiff: true, body: truncateText(diffRes.stdout, MAX_REVIEW_DIFF_CHARS) }
  }
  // 无 diff（未改动或非仓库）→ 读取全文审查。
  try {
    const content = readFileSync(abs, 'utf8')
    return { ok: true, rel, isDiff: false, body: truncateText(content, MAX_REVIEW_FILE_CHARS) }
  } catch {
    return { ok: false, error: `读取文件失败：${filePath}` }
  }
}

/**
 * 根据聚焦维度构建注入 prompt 的「审查侧重」段落。
 * @param focuses 维度数组；为空表示全维度。
 * @returns 多行说明文本。
 */
function buildFocusSection(focuses: ReviewFocus[]): string {
  if (focuses.length === 0) {
    return [
      '审查维度：全面覆盖（逻辑正确性、安全性、性能、可读性、最佳实践）。',
    ].join('\n')
  }
  const lines = ['审查维度（按用户指定，重点聚焦以下方面）：']
  for (const id of focuses) {
    const meta = REVIEW_FOCUS_META.find((m) => m.id === id)
    if (meta) lines.push(`  • ${meta.label}：${meta.hint}`)
  }
  return lines.join('\n')
}

/** /review 审查范围。 */
export type ReviewScope =
  | { kind: 'working' } // 工作区全部改动（默认）
  | { kind: 'staged' } // 仅已暂存
  | { kind: 'base'; base: string } // 相对基线分支
  | { kind: 'file'; path: string } // 指定单文件

/**
 * 构建 /review 命令的 Agent prompt 与摘要。
 * @param cwd 工作目录。
 * @param scope 审查范围。
 * @param focuses 聚焦维度（为空表示全维度）。
 * @returns 成功时含 summary 与 prompt；失败时含 error。
 */
export function buildReviewAgentPrompt(
  cwd: string,
  scope: ReviewScope,
  focuses: ReviewFocus[] = [],
):
  | { ok: true; summary: string; prompt: string }
  | { ok: false; error: string } {
  // 单文件审查不强制要求 git 仓库；其余范围需要仓库。
  if (scope.kind !== 'file' && !isGitRepository(cwd)) {
    return {
      ok: false,
      error:
        '当前目录不是 Git 仓库，无法审查变更。\n可改用 /review <文件路径> 审查单个文件。',
    }
  }

  // 解析审查目标内容。
  let scopeLabel: string
  let contentLabel: string
  let body: string

  if (scope.kind === 'file') {
    const fileRes = readFileForReview(cwd, scope.path)
    if (!fileRes.ok) return { ok: false, error: fileRes.error }
    scopeLabel = `文件：${fileRes.rel}`
    if (fileRes.isDiff) {
      contentLabel = `git diff HEAD -- ${fileRes.rel}`
    } else {
      contentLabel = `文件全文：${fileRes.rel}`
    }
    body = fileRes.body
  } else if (scope.kind === 'staged') {
    if (!hasStagedChanges(cwd)) {
      return {
        ok: false,
        error: '没有已暂存（staged）的变更可审查。\n请先 git add，或用 /review 审查全部工作区改动。',
      }
    }
    scopeLabel = '已暂存（staged）变更'
    contentLabel = 'git diff --staged'
    body = getStagedDiff(cwd, MAX_REVIEW_DIFF_CHARS)
  } else if (scope.kind === 'base') {
    const base = scope.base.trim() || detectDefaultBranch(cwd)
    const diff = getDiffSinceBase(cwd, base)
    if (!diff.trim()) {
      return {
        ok: false,
        error: `当前分支相对 ${base} 没有可审查的差异。\n请确认基线分支正确（例如 /review main）。`,
      }
    }
    scopeLabel = `相对基线分支 ${base}（${getCurrentBranch(cwd) || 'HEAD'} ← ${base}）`
    contentLabel = `git diff ${base}...HEAD`
    body = diff
  } else {
    // working：默认，审查全部已跟踪改动。
    if (!hasWorkingTreeChanges(cwd)) {
      return {
        ok: false,
        error:
          '工作区没有已跟踪文件的改动可审查。\n可用 /review staged、/review <基线分支> 或 /review <文件路径>。',
      }
    }
    scopeLabel = '工作区全部改动（已暂存 + 未暂存）'
    contentLabel = 'git diff HEAD'
    body = getWorkingTreeDiff(cwd)
  }

  const focusSection = buildFocusSection(focuses)
  const focusSummary =
    focuses.length === 0
      ? '全维度'
      : focuses
          .map((id) => REVIEW_FOCUS_META.find((m) => m.id === id)?.label ?? id)
          .join('、')

  const summary = [
    '代码审查范围：' + scopeLabel,
    '聚焦维度：' + focusSummary,
    '',
    '完整内容已交给 Agent 逐项审查，结果按严重度分级输出。',
  ].join('\n')

  const prompt = [
    '你是资深代码审查者。请对下面给出的代码改动进行**结构化代码审查**（仅审查，不要修改文件、不要执行命令）。',
    '',
    focusSection,
    '',
    '输出要求：',
    '1) 先给一句总体结论（是否可合并 / 主要风险）。',
    '2) 按严重度分级逐条列出发现，使用标记：[Critical] / [Warning] / [Suggestion]。',
    '3) 每条包含：文件:行号（若可定位）、问题描述、具体修复建议。',
    '4) 只针对给出的代码作判断，不臆测未展示的内容；无明显问题时明确说明。',
    '5) 末尾给出按优先级排序的「建议修复清单」。',
    '6) 使用简体中文；代码标识符、路径保持英文。',
    '',
    `--- 审查范围：${scopeLabel} ---`,
    `--- 内容来源：${contentLabel} ---`,
    '',
    body || '（空）',
  ].join('\n')

  return { ok: true, summary, prompt }
}

/**
 * 渲染 /commit status 或 /pr status 的纯文本状态。
 * @param cwd 工作目录。
 * @returns 多行文本。
 */
export function renderGitStatusReport(cwd: string): string {
  if (!isGitRepository(cwd)) {
    return '当前目录不是 Git 仓库。'
  }
  const info = summarizeRepo(cwd)
  const lines = [
    'Git 状态：',
    `  分支：${info.branch || '（未知）'}`,
    `  默认基线：${info.defaultBranch}`,
    `  已暂存：${info.hasStaged ? '是' : '否'}`,
    `  未暂存/未跟踪：${info.hasUnstaged ? '是' : '否'}`,
    `  GitHub CLI (gh)：${isGhAvailable() ? '可用' : '未安装'}`,
    '',
    '--- git status --short ---',
    getGitStatusShort(cwd) || '（工作区干净）',
  ]
  if (info.hasStaged) {
    lines.push('', '--- git diff --staged --stat ---', getStagedDiffStat(cwd) || '（空）')
  }
  lines.push('', '用法：/commit 生成 commit message | /pr [基线分支] 生成 PR 描述')
  return lines.join('\n')
}

/**
 * 截断过长文本并附加提示。
 * @param text 原文。
 * @param maxChars 上限。
 * @returns 截断后文本。
 */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n... [已截断，省略 ${text.length - maxChars} 字符] ...`
}
