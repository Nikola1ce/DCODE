// 项目概况探测。
// 在系统提示中告诉模型项目类型、包管理器与可用脚本，使其直接选对测试/构建/类型检查命令，
// 而不必先花几轮工具调用去摸索（或臆测出 `npm test` 之类不存在的命令）。
// 只读取工作目录根部的少量清单文件，结果在会话内稳定，不破坏系统提示的前缀缓存。
// 制作人：Moriarty_Dox

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 列出的 npm scripts 上限，避免超大 monorepo 把提示撑长。
const MAX_SCRIPTS = 15

// 根目录清单文件 → 项目类型。
const MANIFESTS: Array<[file: string, label: string]> = [
  ['pyproject.toml', 'Python'],
  ['requirements.txt', 'Python'],
  ['setup.py', 'Python'],
  ['Cargo.toml', 'Rust（cargo）'],
  ['go.mod', 'Go'],
  ['pom.xml', 'Java（Maven）'],
  ['build.gradle', 'Java/Kotlin（Gradle）'],
  ['build.gradle.kts', 'Kotlin（Gradle）'],
  ['composer.json', 'PHP（composer）'],
  ['Gemfile', 'Ruby（bundler）'],
  ['CMakeLists.txt', 'C/C++（CMake）'],
  ['Makefile', 'Make'],
]

// 锁文件 → Node 包管理器（按优先级）。
const NODE_LOCKFILES: Array<[file: string, manager: string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
]

/**
 * 探测工作目录的项目概况，生成一行紧凑描述。
 * @param cwd 工作目录。
 * @returns 例如 “Node/TypeScript（npm）；scripts：build、test”；无法识别时返回空串。
 */
export function detectProjectProfile(cwd: string): string {
  const parts: string[] = []
  const has = (file: string) => existsSync(join(cwd, file))

  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    const manager = NODE_LOCKFILES.find(([file]) => has(file))?.[1] ?? 'npm'
    const lang = has('tsconfig.json') ? 'Node/TypeScript' : 'Node'
    let desc = `${lang}（${manager}）`
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }
      const scripts = Object.keys(pkg.scripts ?? {})
      if (scripts.length > 0) {
        const shown = scripts.slice(0, MAX_SCRIPTS).join('、')
        const more = scripts.length > MAX_SCRIPTS ? ` 等 ${scripts.length} 个` : ''
        desc += `；scripts：${shown}${more}（用 ${manager} run <名称> 执行）`
      }
    } catch {
      // package.json 解析失败时只报告类型。
    }
    parts.push(desc)
  }

  const seen = new Set<string>()
  for (const [file, label] of MANIFESTS) {
    if (!seen.has(label) && has(file)) {
      seen.add(label)
      parts.push(label)
    }
  }
  if (has('.git')) parts.push('git 仓库')
  return parts.join('｜')
}
