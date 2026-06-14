// DCODE 自动更新模块。
// 负责：检测 GitHub Release 最新版本、对比本地版本、执行源码 git pull + npm install + build，
// 或对 npm 全局安装执行 npm update -g dcode。供 /update 命令与 CLI 启动提示使用。
// 制作人：Moriarty_Dox

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PRODUCT_NAME,
  VERSION,
  CONFIG_DIR_NAME,
  GITHUB_REPO,
  ENV_SKIP_UPDATE_CHECK,
} from '../constants.js'
import { homedir } from 'node:os'
import { runGit } from './gitUtils.js'

/**
 * 更新过程的进度回调：把版本检测、git pull、npm install 等步骤的实时输出
 * 逐行推送给上层（如 /update 命令 → CLI 实时区），让长时间下载/安装有可见反馈。
 */
export type UpdateProgressReporter = (text: string) => void

/** 更新检测缓存文件名（位于 ~/.dcode/）。 */
export const UPDATE_CHECK_CACHE_FILE = 'update-check-cache.json'

/** 默认更新检测缓存有效期（24 小时）。 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export { GITHUB_REPO, ENV_SKIP_UPDATE_CHECK }

/** 安装类型：源码 git 克隆 / npm 全局 / 项目内 node_modules。 */
export type InstallType = 'source' | 'npm-global' | 'npm-local'

/** 单步更新执行结果。 */
export interface UpdateStepResult {
  /** 步骤名称（展示用）。 */
  name: string
  /** 执行的命令字符串。 */
  command: string
  /** 是否成功。 */
  ok: boolean
  /** 合并后的 stdout/stderr 输出（截断后）。 */
  output: string
}

/** 版本检测结果。 */
export interface UpdateCheckResult {
  /** 当前运行版本。 */
  currentVersion: string
  /** 远程最新版本；检测失败时为 null。 */
  latestVersion: string | null
  /** 是否有可更新版本。 */
  updateAvailable: boolean
  /** DCODE 包根目录绝对路径。 */
  installRoot: string
  /** 安装类型。 */
  installType: InstallType
  /** 是否使用了本地缓存（跳过了网络请求）。 */
  fromCache: boolean
  /** 检测失败时的错误说明。 */
  error?: string
}

/** 执行更新后的汇总结果。 */
export interface UpdateRunResult {
  /** 整体是否成功。 */
  ok: boolean
  /** 安装类型。 */
  installType: InstallType
  /** 各步骤明细。 */
  steps: UpdateStepResult[]
  /** 给用户看的摘要信息。 */
  message: string
}

/** 更新检测缓存结构。 */
interface UpdateCheckCache {
  checkedAt: number
  latestVersion: string | null
  error?: string
}

/**
 * 解析 DCODE 包根目录（含 name=dcode 的 package.json）。
 * 从可执行文件或当前模块路径向上遍历，兼容 esbuild 单文件 dist/cli.js 与 vitest 直跑源码。
 * @returns 绝对路径。
 */
export function getInstallRoot(): string {
  const candidates: string[] = []
  const fromModule = dirname(fileURLToPath(import.meta.url))
  candidates.push(fromModule)
  const execPath = process.argv[1]
  if (execPath) candidates.push(dirname(execPath))

  for (const start of candidates) {
    let dir = start
    for (let depth = 0; depth < 8; depth++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
          if (pkg.name === 'dcode') return dir
        } catch {
          // 忽略损坏的 package.json，继续向上
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }

  // 兜底：单文件 bundle 时 import.meta.url 为 dist/cli.js，上一级通常为包根。
  return dirname(fromModule)
}

/**
 * 比较两个语义化版本号（仅 major.minor.patch）。
 * @param a 版本 A（可带 v 前缀）。
 * @param b 版本 B（可带 v 前缀）。
 * @returns a > b 返回 1；a < b 返回 -1；相等返回 0。
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((part) => {
        const n = parseInt(part.replace(/[^0-9].*$/, ''), 10)
        return Number.isFinite(n) ? n : 0
      })

  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

/**
 * 获取 npm 全局 node_modules 根路径。
 * @returns 绝对路径；失败返回 null。
 */
export function getNpmGlobalRoot(): string | null {
  const step = runShellStep(process.cwd(), 'npm root -g', 'npm root -g')
  if (!step.ok) return null
  const line = step.output.split('\n').find((l) => l.trim().length > 0)
  return line?.trim() ?? null
}

/**
 * 判断目录是否为 DCODE 源码 git 安装（可 git pull 更新）。
 * @param root 包根目录。
 * @returns 安装类型。
 */
export function detectInstallType(root: string): InstallType {
  const gitDir = join(root, '.git')
  if (existsSync(gitDir)) {
    const remote = runGit(root, ['remote', 'get-url', 'origin'])
    if (remote.ok) {
      const url = remote.stdout.toLowerCase()
      if (url.includes('dcode') || url.includes('nikola1ce')) return 'source'
    }
  }

  const globalRoot = getNpmGlobalRoot()
  if (globalRoot) {
    const normalizedRoot = root.replace(/\\/g, '/').toLowerCase()
    const normalizedGlobal = globalRoot.replace(/\\/g, '/').toLowerCase()
    if (
      normalizedRoot === `${normalizedGlobal}/dcode` ||
      normalizedRoot.startsWith(`${normalizedGlobal}/dcode/`)
    ) {
      return 'npm-global'
    }
  }

  return 'npm-local'
}

/**
 * 读取更新检测缓存路径。
 * @returns ~/.dcode/update-check-cache.json 绝对路径。
 */
export function getUpdateCheckCachePath(): string {
  return join(homedir(), CONFIG_DIR_NAME, UPDATE_CHECK_CACHE_FILE)
}

/**
 * 读取有效的更新检测缓存。
 * @param maxAgeMs 缓存最大年龄（毫秒）。
 * @returns 有效缓存或 null。
 */
export function readUpdateCheckCache(maxAgeMs = UPDATE_CHECK_INTERVAL_MS): UpdateCheckCache | null {
  const path = getUpdateCheckCachePath()
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as UpdateCheckCache
    if (!parsed || typeof parsed.checkedAt !== 'number') return null
    if (Date.now() - parsed.checkedAt > maxAgeMs) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 写入更新检测缓存。
 * @param data 缓存内容。
 */
export function writeUpdateCheckCache(data: Omit<UpdateCheckCache, 'checkedAt'> & { checkedAt?: number }): void {
  const path = getUpdateCheckCachePath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const payload: UpdateCheckCache = {
    checkedAt: data.checkedAt ?? Date.now(),
    latestVersion: data.latestVersion,
    error: data.error,
  }
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
}

/**
 * 从 GitHub API 获取最新 Release 版本号。
 * @param timeoutMs 请求超时（毫秒）。
 * @param onProgress 可选进度回调（展示「正在检测…」等反馈）。
 * @returns 版本字符串（不含 v）或 null。
 */
export async function fetchLatestReleaseVersion(
  timeoutMs = 8000,
  onProgress?: UpdateProgressReporter,
): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    onProgress?.('⠋ 正在从 GitHub 检测最新版本…')
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${PRODUCT_NAME}/${VERSION}`,
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: string }
    const tag = body.tag_name?.trim()
    if (!tag) return null
    onProgress?.(`✓ 最新 Release：v${tag.replace(/^v/i, '')}`)
    return tag.replace(/^v/i, '')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 检测是否有新版本可用。
 * @param options.forceRefresh 为 true 时忽略缓存强制请求 GitHub。
 * @param options.timeoutMs 网络请求超时。
 * @returns 检测结果。
 */
export async function checkForUpdate(options?: {
  forceRefresh?: boolean
  timeoutMs?: number
  onProgress?: UpdateProgressReporter
}): Promise<UpdateCheckResult> {
  const installRoot = getInstallRoot()
  const installType = detectInstallType(installRoot)
  const currentVersion = VERSION
  const forceRefresh = options?.forceRefresh ?? false
  const timeoutMs = options?.timeoutMs ?? 8000

  let latestVersion: string | null = null
  let error: string | undefined
  let fromCache = false

  if (!forceRefresh) {
    const cached = readUpdateCheckCache()
    if (cached) {
      fromCache = true
      latestVersion = cached.latestVersion
      error = cached.error
    }
  }

  if (!fromCache) {
    latestVersion = await fetchLatestReleaseVersion(timeoutMs, options?.onProgress)
    if (latestVersion === null) {
      error = '无法获取 GitHub 最新版本（网络或 API 限制）'
    }
    writeUpdateCheckCache({ latestVersion, error })
  }

  const updateAvailable =
    latestVersion !== null && compareSemver(latestVersion, currentVersion) > 0

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    installRoot,
    installType,
    fromCache,
    error: latestVersion === null ? error : undefined,
  }
}

/**
 * 在指定目录执行 shell 命令（跨平台，同步阻塞）。
 * @param cwd 工作目录。
 * @param command 完整命令字符串。
 * @returns 步骤结果。
 */
function runShellStep(cwd: string, name: string, command: string): UpdateStepResult {
  const isWin = process.platform === 'win32'
  const result = spawnSync(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', command] : ['-c', command], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  const stdout = (result.stdout ?? '').trimEnd()
  const stderr = (result.stderr ?? '').trimEnd()
  const combined = [stdout, stderr].filter(Boolean).join('\n')
  const exitCode = result.status ?? 1
  const maxOut = 4000
  const output =
    combined.length > maxOut ? combined.slice(0, maxOut) + '\n…（输出已截断）' : combined

  return {
    name,
    command,
    ok: exitCode === 0,
    output: output || (exitCode === 0 ? '（无输出）' : `退出码 ${exitCode}`),
  }
}

/**
 * 在指定目录执行 shell 命令并「实时流式」上报输出（跨平台，异步）。
 * git pull / npm install 这类下载安装步骤无字节级百分比，但其自身 stdout/stderr 常包含
 * 下载/安装进度文本；本函数逐块把输出推送给 onProgress，让用户看到「正在下载…」的实时反馈，
 * 而非长时间无响应地干等。完整输出仍会累计返回，作为步骤结果用于最终汇总展示。
 * @param cwd 工作目录。
 * @param name 步骤名（展示用）。
 * @param command 完整命令字符串。
 * @param onProgress 实时进度回调（可选）。
 * @returns 步骤结果（Promise）。
 */
function runShellStepStreaming(
  cwd: string,
  name: string,
  command: string,
  onProgress?: UpdateProgressReporter,
): Promise<UpdateStepResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    onProgress?.(`⟳ ${name}：$ ${command}`)
    const child = spawn(isWin ? 'cmd.exe' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd,
      windowsHide: true,
    })

    let combined = ''
    const maxOut = 8000

    // 把子进程输出按「行」上报，避免半行刷屏；同时累计完整文本用于结果汇总。
    let lineBuf = ''
    const handle = (data: Buffer) => {
      const chunk = data.toString('utf8')
      combined += chunk
      lineBuf += chunk
      // 按换行切分，逐行上报已完成的行（保留最后未完成的一行在缓冲）。
      const parts = lineBuf.split(/\r?\n/)
      lineBuf = parts.pop() ?? ''
      for (const line of parts) {
        const trimmed = line.trim()
        if (trimmed) onProgress?.(`  ${trimmed}`)
      }
    }
    child.stdout?.on('data', handle)
    child.stderr?.on('data', handle)

    const finalize = (exitCode: number) => {
      // 上报最后未完成的一行（若有）。
      const tail = lineBuf.trim()
      if (tail) onProgress?.(`  ${tail}`)
      const trimmed = combined.trimEnd()
      const output =
        trimmed.length > maxOut ? trimmed.slice(0, maxOut) + '\n…（输出已截断）' : trimmed
      const ok = exitCode === 0
      onProgress?.(`${ok ? '✓' : '✗'} ${name}`)
      resolve({
        name,
        command,
        ok,
        output: output || (ok ? '（无输出）' : `退出码 ${exitCode}`),
      })
    }

    child.on('error', (err) => {
      combined += `\n${err.message}`
      finalize(1)
    })
    child.on('close', (code) => {
      finalize(code ?? 1)
    })
  })
}

/**
 * 执行源码安装的一键更新：git pull → npm install → npm run build。
 * 每一步均实时上报输出（onProgress），让下载/安装过程在 CLI 有可见进度。
 * @param root 包根目录。
 * @param onProgress 实时进度回调（可选）。
 * @returns 步骤列表与是否全部成功。
 */
export async function runSourceUpdate(
  root: string,
  onProgress?: UpdateProgressReporter,
): Promise<{ ok: boolean; steps: UpdateStepResult[] }> {
  const steps: UpdateStepResult[] = []

  const pull = await runShellStepStreaming(root, 'git pull', 'git pull --ff-only', onProgress)
  steps.push(pull)
  if (!pull.ok) return { ok: false, steps }

  const install = await runShellStepStreaming(root, 'npm install', 'npm install', onProgress)
  steps.push(install)
  if (!install.ok) return { ok: false, steps }

  const build = await runShellStepStreaming(root, 'npm run build', 'npm run build', onProgress)
  steps.push(build)
  return { ok: build.ok, steps }
}

/**
 * 执行 npm 全局安装更新。
 * @param onProgress 实时进度回调（可选）。
 * @returns 步骤列表与是否成功。
 */
export async function runNpmGlobalUpdate(
  onProgress?: UpdateProgressReporter,
): Promise<{ ok: boolean; steps: UpdateStepResult[] }> {
  const step = await runShellStepStreaming(
    process.cwd(),
    'npm 全局更新',
    'npm update -g dcode',
    onProgress,
  )
  return { ok: step.ok, steps: [step] }
}

/**
 * 在项目内 node_modules 安装目录执行 npm install（拉取 registry 最新版）。
 * @param root 包根目录。
 * @param onProgress 实时进度回调（可选）。
 * @returns 步骤列表与是否成功。
 */
export async function runNpmLocalUpdate(
  root: string,
  onProgress?: UpdateProgressReporter,
): Promise<{ ok: boolean; steps: UpdateStepResult[] }> {
  const step = await runShellStepStreaming(root, 'npm install', 'npm install dcode@latest', onProgress)
  return { ok: step.ok, steps: [step] }
}

/**
 * 根据安装类型执行完整更新流程。
 * @param options.force 为 true 时即使版本相同也执行更新步骤。
 * @param options.onProgress 实时进度回调：把版本检测与各更新步骤的输出推送到 UI 实时区。
 * @returns 更新汇总结果。
 */
export async function runUpdate(options?: {
  force?: boolean
  onProgress?: UpdateProgressReporter
}): Promise<UpdateRunResult> {
  const onProgress = options?.onProgress
  const check = await checkForUpdate({ forceRefresh: true, onProgress })
  const { installRoot, installType } = check

  if (!options?.force && !check.updateAvailable) {
    if (check.latestVersion !== null) {
      return {
        ok: true,
        installType,
        steps: [],
        message: `已是最新版本 v${check.currentVersion}。`,
      }
    }
    return {
      ok: false,
      installType,
      steps: [],
      message:
        '无法确认 GitHub 最新版本（网络或 API 限制）。\n' +
        '请先执行 /update check，或使用 /update force 强制更新。',
    }
  }

  const { ok, steps } =
    installType === 'source'
      ? await runSourceUpdate(installRoot, onProgress)
      : installType === 'npm-global'
        ? await runNpmGlobalUpdate(onProgress)
        : await runNpmLocalUpdate(installRoot, onProgress)

  const lines = steps.map((s) => {
    const status = s.ok ? '✓' : '✗'
    return `${status} ${s.name}\n   $ ${s.command}\n${indentBlock(s.output, 3)}`
  })

  const hint =
    installType === 'source'
      ? '更新完成。请退出并重新启动 DCODE 以加载新版本。'
      : installType === 'npm-global'
        ? '全局包已更新。请重新打开终端并启动 dcode。'
        : '依赖已更新。请在项目目录重新运行 npx dcode 或本地 dcode 命令。'

  const message = ok
    ? [`${PRODUCT_NAME} 更新成功（${installType === 'source' ? '源码' : 'npm 全局'}）`, ...lines, '', hint].join(
        '\n',
      )
    : [`${PRODUCT_NAME} 更新未完成`, ...lines, '', '请根据上方错误手动修复后重试。'].join('\n')

  if (ok) {
    writeUpdateCheckCache({
      latestVersion: check.latestVersion ?? check.currentVersion,
      checkedAt: Date.now(),
    })
  }

  return { ok, installType, steps, message }
}

/**
 * 生成启动时的更新提示文案；无更新或检测失败时返回 undefined。
 * @param check 版本检测结果。
 * @returns 提示字符串或 undefined。
 */
export function buildStartupUpdateNotice(check: UpdateCheckResult): string | undefined {
  if (process.env[ENV_SKIP_UPDATE_CHECK] === '1') return undefined
  if (!check.updateAvailable || !check.latestVersion) return undefined
  return (
    `发现新版本 v${check.latestVersion}（当前 v${check.currentVersion}）。` +
    ` 执行 /update 一键更新，或 /update check 查看详情。`
  )
}

/**
 * 渲染版本检测状态文本（供 /update、/update check 使用）。
 * @param check 检测结果。
 * @returns 多行说明。
 */
export function renderUpdateStatus(check: UpdateCheckResult): string {
  const typeLabel =
    check.installType === 'source'
      ? '源码 git 克隆'
      : check.installType === 'npm-global'
        ? 'npm 全局安装'
        : 'npm 本地 / node_modules'
  const lines = [
    `${PRODUCT_NAME} 更新状态`,
    `  当前版本：v${check.currentVersion}`,
    `  安装路径：${check.installRoot}`,
    `  安装类型：${typeLabel}`,
  ]

  if (check.latestVersion) {
    const cmp = compareSemver(check.latestVersion, check.currentVersion)
    if (cmp > 0) {
      lines.push(`  最新版本：v${check.latestVersion}（可更新）`)
    } else if (cmp < 0) {
      lines.push(`  最新 Release：v${check.latestVersion}（本地较新，可能为开发版）`)
    } else {
      lines.push(`  最新版本：v${check.latestVersion}（已是最新）`)
    }
  } else {
    lines.push(`  最新版本：未知${check.error ? `（${check.error}）` : ''}`)
  }

  if (check.fromCache) {
    lines.push('  （版本信息来自本地缓存，/update check 可强制刷新）')
  }

  lines.push(
    '',
    '子命令：',
    '  /update check   检测新版本（强制刷新）',
    '  /update run     执行更新（git pull + npm install + build，或 npm update -g）',
    '  /update force   即使版本相同也重新执行更新步骤',
  )

  return lines.join('\n')
}

/**
 * 为输出文本每行前加缩进。
 * @param text 原文。
 * @param spaces 空格数。
 * @returns 缩进后的字符串。
 */
function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n')
}
