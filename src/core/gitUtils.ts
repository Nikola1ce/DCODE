// Git 操作封装。
// 为 /commit、/pr 命令提供 status、diff、log、默认分支检测与 gh 可用性检查；
// 不直接执行 commit/push，由 Agent 经 run_command 在用户授权后执行。
// 制作人：Moriarty_Dox

import { spawnSync } from 'node:child_process'

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
