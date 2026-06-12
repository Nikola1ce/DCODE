// shellManager 单元测试。
// 覆盖后台 spawn、输出查询、tail 增量、kill 与异常路径；使用独立 ShellManager 实例隔离。
// 制作人：Moriarty_Dox

import { afterEach, describe, expect, it } from 'vitest'
import { ShellManager } from './shellManager.js'

/** 根据平台返回简单 echo 命令。 */
function echoCmd(text = 'hello-test'): string {
  return process.platform === 'win32'
    ? `Write-Output '${text}'`
    : `echo ${text}`
}

/** 根据平台返回分两阶段输出的命令（用于 tail 测试）。 */
function stagedOutputCmd(): string {
  return process.platform === 'win32'
    ? "Write-Output 'phase-a'; Start-Sleep -Seconds 1; Write-Output 'phase-b'"
    : "echo phase-a; sleep 1; echo phase-b"
}

/** 根据平台返回长时间 sleep 命令（用于 kill 测试）。 */
function longSleepCmd(): string {
  return process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60'
}

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从 tail 模式 formatted 文本中提取输出段落（不含 header/meta）。 */
function extractIncremental(formatted: string): string {
  const tailMarker = '新增输出：'
  const idx = formatted.indexOf(tailMarker)
  if (idx >= 0) return formatted.slice(idx + tailMarker.length).trim()
  if (formatted.includes('（无新增输出）')) return '（无新增输出）'
  return ''
}

describe('ShellManager', () => {
  const mgr = new ShellManager()

  afterEach(() => {
    for (const s of mgr.getRunningShells()) {
      mgr.kill(s.id)
    }
  })

  it('spawnBackground 返回 8 位 shell_id 并捕获 stdout', async () => {
    const id = mgr.spawnBackground({
      command: echoCmd(),
      cwd: process.cwd(),
      description: 'vitest echo',
    })
    expect(id).toHaveLength(8)
    expect(mgr.getShell(id)?.status).toBe('running')

    await sleep(2000)
    const snap = await mgr.getOutput(id, 5000)
    expect(snap.found).toBe(true)
    expect(snap.record?.output).toContain('hello-test')
    expect(snap.done).toBe(true)
    expect(snap.record?.status).toBe('completed')
  })

  it('getOutput 对未知 shell_id 返回错误', async () => {
    const snap = await mgr.getOutput('00000000')
    expect(snap.found).toBe(false)
    expect(snap.isError).toBe(true)
    expect(snap.formatted).toContain('未找到')
  })

  it('getRunningShells 仅包含 running 状态', async () => {
    const id = mgr.spawnBackground({
      command: longSleepCmd(),
      cwd: process.cwd(),
    })
    expect(mgr.getRunningShells().some((s) => s.id === id)).toBe(true)
    mgr.kill(id)
    expect(mgr.getRunningShells().some((s) => s.id === id)).toBe(false)
  })

  it('kill 可终止运行中的 Shell', () => {
    const id = mgr.spawnBackground({
      command: longSleepCmd(),
      cwd: process.cwd(),
    })
    const result = mgr.kill(id)
    expect(result.ok).toBe(true)
    expect(mgr.getShell(id)?.status).toBe('killed')
  })

  it('kill 对已结束的 Shell 返回失败', async () => {
    const id = mgr.spawnBackground({
      command: echoCmd('done'),
      cwd: process.cwd(),
    })
    await sleep(2000)
    await mgr.getOutput(id, 5000)
    const result = mgr.kill(id)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已结束')
  })

  it('tail 模式仅返回增量输出', async () => {
    const id = mgr.spawnBackground({
      command: stagedOutputCmd(),
      cwd: process.cwd(),
    })

    let firstInc = ''
    for (let i = 0; i < 20; i++) {
      await sleep(200)
      const snap = await mgr.getOutput(id, 0, { tail: true })
      firstInc = extractIncremental(snap.formatted)
      if (firstInc.includes('phase-a')) break
    }
    expect(firstInc).toContain('phase-a')
    expect(firstInc).not.toContain('phase-b')

    let secondInc = ''
    for (let i = 0; i < 20; i++) {
      await sleep(200)
      const snap = await mgr.getOutput(id, 0, { tail: true })
      secondInc = extractIncremental(snap.formatted)
      if (secondInc.includes('phase-b')) break
    }
    expect(secondInc).toContain('phase-b')
    expect(secondInc).not.toContain('phase-a')
  }, 20_000)

  it('tail 无新增输出时提示无新增', async () => {
    const id = mgr.spawnBackground({
      command: echoCmd('once'),
      cwd: process.cwd(),
    })
    await sleep(2000)
    await mgr.getOutput(id, 5000, { tail: true })

    const again = await mgr.getOutput(id, 0, { tail: true })
    expect(again.formatted).toContain('无新增输出')
  })

  it('onOutput 回调接收增量文本', async () => {
    const chunks: string[] = []
    const id = mgr.spawnBackground({
      command: echoCmd('callback-test'),
      cwd: process.cwd(),
      onOutput: (t) => chunks.push(t),
    })
    await sleep(2000)
    await mgr.getOutput(id, 5000)
    expect(chunks.join('')).toContain('callback-test')
  })
})
