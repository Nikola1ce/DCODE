// DCODE VS Code 扩展 —— 打包前置脚本。
// 在 vsce package 之前执行，确保 .vsix 自带「后台内核」与许可证：
//   1. 构建扩展自身（dist/extension.js）；
//   2. 构建主项目内核并把 dist/cli.js 拷进扩展 dist/（DcodeClient 会优先使用扩展内自带内核）；
//   3. 拷贝主项目 LICENSE 到扩展根，避免 vsce 关于缺少许可证的告警。
// 这样用户安装 .vsix 后无需另外全局安装 dcode 即可开箱即用。
// 制作人：Moriarty_Dox

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 扩展子项目根目录与主项目根目录。
const extRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(extRoot, '..')

/**
 * 在指定目录执行命令（继承 stdio，便于看到构建日志）。
 * @param cmd 命令字符串。
 * @param cwd 工作目录。
 */
function run(cmd, cwd) {
  console.log(`[prepackage] $ ${cmd}  (cwd=${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

/**
 * 主流程：构建扩展 + 构建并拷贝内核 + 拷贝 LICENSE。
 */
function main() {
  // 1) 构建扩展产物（生产模式：压缩、无 sourcemap）。
  run('node esbuild.mjs --production', extRoot)

  // 2) 构建主项目内核并拷贝 dist/cli.js 到扩展 dist/。
  const kernelDist = resolve(repoRoot, 'dist', 'cli.js')
  if (!existsSync(kernelDist)) {
    run('npm run build', repoRoot)
  }
  if (!existsSync(kernelDist)) {
    throw new Error(`未找到内核产物：${kernelDist}（请先在主项目执行 npm run build）`)
  }
  const extDist = resolve(extRoot, 'dist')
  if (!existsSync(extDist)) mkdirSync(extDist, { recursive: true })
  const targetKernel = resolve(extDist, 'cli.js')
  copyFileSync(kernelDist, targetKernel)
  console.log(`[prepackage] 已拷贝内核 -> ${targetKernel}`)

  // 3) 拷贝 LICENSE（存在才拷）。
  const license = resolve(repoRoot, 'LICENSE')
  if (existsSync(license)) {
    copyFileSync(license, resolve(extRoot, 'LICENSE'))
    console.log('[prepackage] 已拷贝 LICENSE')
  }

  console.log('[prepackage] 完成。可执行 vsce package 生成 .vsix。')
}

main()
