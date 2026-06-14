// DCODE VS Code 扩展 —— 打包前置脚本。
// 在 vsce package 之前执行，确保 .vsix 自带「后台内核」与许可证：
//   1. 构建扩展自身（dist/extension.js）；
//   2. 构建主项目内核并把 dist/cli.js 拷进扩展 dist/（DcodeClient 会优先使用扩展内自带内核）；
//   3. 拷贝主项目 LICENSE 到扩展根，避免 vsce 关于缺少许可证的告警。
// 这样用户安装 .vsix 后无需另外全局安装 dcode 即可开箱即用。
// 制作人：Moriarty_Dox

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { buildSync } from 'esbuild'

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
  // 内核体积优化：主项目 build.mjs 出于「错误栈可读 / keepNames」考虑不做压缩，
  // 这里仅对「打进 .vsix 的内核副本」单独做一次 minify（不影响主项目 CLI 产物），
  // 实测可把 cli.js 从约 3.5MB 压到约 1.8MB，明显减小扩展包体积。
  // 压缩失败（如 esbuild 解析异常）则安全退回直接复制，保证打包不中断。
  try {
    buildSync({
      entryPoints: [kernelDist],
      outfile: targetKernel,
      bundle: false, // 内核已是打好的单文件，无需再 bundle，只做压缩。
      minify: true,
      platform: 'node',
      format: 'esm',
      target: 'node18',
      legalComments: 'none', // 去掉第三方许可证注释块，进一步减小体积。
      logLevel: 'silent', // 屏蔽对第三方代码的无关告警（如 -0 比较）。
      allowOverwrite: true,
    })
    const before = statSync(kernelDist).size
    const after = statSync(targetKernel).size
    const mb = (n) => (n / 1048576).toFixed(2)
    console.log(
      `[prepackage] 已压缩拷贝内核 -> ${targetKernel}（${mb(before)}MB → ${mb(after)}MB）`,
    )
  } catch (err) {
    console.warn('[prepackage] 内核压缩失败，回退为直接复制：', err?.message ?? err)
    copyFileSync(kernelDist, targetKernel)
    console.log(`[prepackage] 已拷贝内核 -> ${targetKernel}`)
  }

  // 3) 拷贝 LICENSE（存在才拷）。
  const license = resolve(repoRoot, 'LICENSE')
  if (existsSync(license)) {
    copyFileSync(license, resolve(extRoot, 'LICENSE'))
    console.log('[prepackage] 已拷贝 LICENSE')
  }

  console.log('[prepackage] 完成。可执行 vsce package 生成 .vsix。')
}

main()
