// Windows 安装脚本回归测试：隔离执行文件安装阶段，不修改用户 PATH 或开始菜单。
// 制作人：Moriarty_Dox

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const installerPath = fileURLToPath(new URL('../../release/templates/install-windows.ps1', import.meta.url))
const installerSource = readFileSync(installerPath, 'utf8')
const sourceVersion = '2.7.13-preview.4+test'

it('安装脚本带 UTF-8 BOM，保证 Windows PowerShell 5.1 正确读取中文文件名', () => {
  expect([...readFileSync(installerPath).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
})

describe.skipIf(process.platform !== 'win32')('Windows PowerShell 安装文件阶段', () => {
  let sandbox: string
  let sourceDir: string
  let localAppData: string
  let installRoot: string
  let isolatedScript: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'dcode-installer-'))
    sourceDir = join(sandbox, 'source with spaces 中文')
    localAppData = join(sandbox, 'local app data')
    installRoot = join(localAppData, 'DCODE')
    isolatedScript = join(sandbox, 'install-files.ps1')

    // LOCALAPPDATA 只能隔离文件写入，不能隔离 Environment 的用户注册表写入。
    // 原样执行安装文件部分（保留 BOM），在 PATH/COM 集成之前截断；边界变化时直接失败。
    const boundary = installerSource.indexOf("$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')")
    expect(boundary).toBeGreaterThan(0)
    const fileStage = installerSource.slice(0, boundary)
    expect(fileStage).not.toMatch(/\[(?:System\.)?Environment\]|-ComObject/)
    writeFileSync(isolatedScript, fileStage, 'utf8')

    mkdirSync(join(sourceDir, 'dist'), { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({
      name: 'dcode', version: sourceVersion, type: 'module', description: '测试源包',
    }))
    writeFileSync(join(sourceDir, 'dist', 'cli.js'), [
      "import { readFileSync } from 'node:fs'",
      "const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))",
      "if (process.argv[2] !== '--version') process.exit(2)",
      'console.log(pkg.version)',
    ].join('\n'))
  })

  afterEach(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  })

  function runInstaller() {
    return spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', isolatedScript, '-SourceDir', sourceDir,
    ], {
      cwd: sandbox,
      env: { ...process.env, LOCALAPPDATA: localAppData },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    })
  }

  function install() {
    const result = runInstaller()
    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
  }

  function readInstalledPackage() {
    const json = readFileSync(join(installRoot, 'package.json'), 'utf8')
    // updater.getInstallRoot() 直接 JSON.parse，不能接受 PowerShell 5.1 默认写出的 UTF-8 BOM。
    expect(json.charCodeAt(0)).not.toBe(0xfeff)
    return JSON.parse(json)
  }

  it('优先读取源 package.json，递归复制音效并保留原有安装文件', () => {
    writeFileSync(join(sourceDir, 'VERSION.txt'), 'DCODE v0.0.1\nBy Moriarty_Dox\n')
    writeFileSync(join(sourceDir, 'LICENSE'), 'fixture license\n')
    const readme = '安装说明：重新打开终端后运行 dcode。\n'
    writeFileSync(join(sourceDir, '安装说明.txt'), readme)
    const sounds = ['input-sent.wav', 'interrupted.wav', 'notification.wav', 'permission.wav', 'turn-complete.wav']
    const audio = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x80, 0xff])
    const soundsDir = join(sourceDir, 'dist', 'assets', 'sounds')
    mkdirSync(soundsDir, { recursive: true })
    for (const sound of sounds) writeFileSync(join(soundsDir, sound), audio)

    install()

    expect(readInstalledPackage()).toEqual({ name: 'dcode', version: sourceVersion, type: 'module' })
    for (const sound of sounds) {
      expect(readFileSync(join(installRoot, 'dist', 'assets', 'sounds', sound))).toEqual(audio)
    }
    expect(readFileSync(join(installRoot, 'dist', 'cli.js'))).toEqual(readFileSync(join(sourceDir, 'dist', 'cli.js')))
    expect(readFileSync(join(installRoot, 'LICENSE'), 'utf8')).toBe('fixture license\n')
    expect(readFileSync(join(installRoot, '安装说明.txt'), 'utf8')).toBe(readme)
    expect(existsSync(join(installRoot, 'bin', 'dcode.cmd'))).toBe(true)

    // 用最小 ESM CLI 验证落盘结果，不依赖构建产物，也不加载真实用户配置或访问网络。
    const cli = spawnSync(process.execPath, [join(installRoot, 'dist', 'cli.js'), '--version'], {
      cwd: sandbox, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    })
    expect(cli.error).toBeUndefined()
    expect(cli.status, cli.stderr).toBe(0)
    expect(cli.stdout.trim()).toBe(sourceVersion)
  })

  it('源包没有可选 assets 时仍能安装', () => {
    install()
    expect(readInstalledPackage()).toEqual({ name: 'dcode', version: sourceVersion, type: 'module' })
    expect(existsSync(join(installRoot, 'dist', 'assets'))).toBe(false)
  })

  it('重复安装覆盖资源和版本，不产生 assets/assets 嵌套', () => {
    const soundsDir = join(sourceDir, 'dist', 'assets', 'sounds')
    mkdirSync(soundsDir, { recursive: true })
    writeFileSync(join(soundsDir, 'notification.wav'), 'old audio')
    install()

    const nextVersion = '3.8.21'
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ version: nextVersion }))
    writeFileSync(join(soundsDir, 'notification.wav'), 'new audio')
    writeFileSync(join(soundsDir, 'permission.wav'), 'added audio')
    install()

    expect(readInstalledPackage()).toEqual({ name: 'dcode', version: nextVersion, type: 'module' })
    expect(readFileSync(join(installRoot, 'dist', 'assets', 'sounds', 'notification.wav'), 'utf8')).toBe('new audio')
    expect(readFileSync(join(installRoot, 'dist', 'assets', 'sounds', 'permission.wav'), 'utf8')).toBe('added audio')
    expect(existsSync(join(installRoot, 'dist', 'assets', 'assets'))).toBe(false)
  })

  it('兼容发布 ZIP：无 package.json 时从 VERSION.txt 读取版本', () => {
    const releaseVersion = '4.9.27-beta.2+release'
    unlinkSync(join(sourceDir, 'package.json'))
    writeFileSync(join(sourceDir, 'VERSION.txt'), `DCODE v${releaseVersion}\r\nBy Moriarty_Dox\r\n`)

    install()

    expect(readInstalledPackage()).toEqual({ name: 'dcode', version: releaseVersion, type: 'module' })
  })

  it.each([
    { label: '缺少版本元数据', file: 'VERSION.txt', content: undefined },
    { label: 'package.json 缺少版本字段', file: 'package.json', content: '{}' },
    { label: 'package.json 版本不是字符串', file: 'package.json', content: '{"version":42}' },
    { label: 'package.json 不是有效 JSON', file: 'package.json', content: '{' },
    { label: 'VERSION.txt 格式错误', file: 'VERSION.txt', content: 'unknown version\n' },
  ])('$label 时在写入安装目录前报错', ({ file, content }) => {
    unlinkSync(join(sourceDir, 'package.json'))
    if (content !== undefined) writeFileSync(join(sourceDir, file), content)

    const result = runInstaller()

    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1)
    expect(existsSync(installRoot)).toBe(false)
  })
})
