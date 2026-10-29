import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { runCommandTool } from './runCommand.js'
import * as shells from '../core/shellManager.js'
import type { ToolContext } from '../core/types.js'

const context = (signal = new AbortController().signal): ToolContext => ({
  cwd: process.cwd(), permissionMode: 'bypass', abortSignal: signal,
  config: { provider: 'custom', baseURL: 'https://example.invalid', model: 'test',
    theme: 'dark', showThinking: false, reasoningEffort: 'high', alwaysAllow: [],
    totalCostUsd: 0, onboardingComplete: true, hooksEnabled: false, soundEnabled: false, soundVolume: 0 },
  requestPermission: async () => 'allow_once', todos: [], setTodos: () => {},
})

afterEach(() => vi.restoreAllMocks())

describe('run_command 生命周期', () => {
  it.each([false, true])('已取消时不启动命令（后台=%s）', async (background) => {
    const ac = new AbortController()
    ac.abort()
    const spawn = vi.spyOn(shells, 'spawnShellProcess')
    const backgroundSpawn = vi.spyOn(shells.shellManager, 'spawnBackground')
    const result = await runCommandTool.run({ command: 'echo SHOULD-NOT-RUN', background }, context(ac.signal))
    expect(result.isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
    expect(backgroundSpawn).not.toHaveBeenCalled()
  })

  it('后台命令返回后通过 bash_output 查询，不能再发送已结束工具的进度事件', async () => {
    const spawn = vi.spyOn(shells.shellManager, 'spawnBackground').mockReturnValue('test-id')
    const ctx = { ...context(), onProgress: vi.fn() }
    await runCommandTool.run({ command: 'echo test', background: true }, ctx)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0][0].onOutput).toBeUndefined()
  })

  it('长命令保留最后的测试结论，跨 chunk 的中文不会乱码', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    vi.spyOn(shells, 'spawnShellProcess').mockReturnValue(child as unknown as ChildProcess)
    const pending = runCommandTool.run({ command: 'test-output' }, context())
    child.stdout.write('a'.repeat(150_000))
    const resultBytes = Buffer.from('最终检查失败')
    child.stderr.write(resultBytes.subarray(0, 2))
    child.stderr.write(resultBytes.subarray(2))
    child.emit('close', 1)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.llmContent).toContain('最终检查失败')
    expect(result.llmContent).toContain('已省略较早输出')
    expect(result.llmContent.length).toBeLessThan(30_100)
  })

  it.skipIf(process.platform !== 'win32')('Windows 取消前台命令会终止当前 Shell 的 Node 子孙进程并解除管道等待', async () => {
    // 仅创建本测试专属的两层 Node 子进程，绝不按进程名终止共享宿主。
    const code = 'const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});console.log("TREE:"+process.pid+":"+c.pid);setInterval(()=>{},1000)'
    const encoded = Buffer.from(code).toString('base64')
    const command = `& '${process.execPath.replace(/'/g, "''")}' -e "eval(Buffer.from('${encoded}','base64').toString())"`
    const ac = new AbortController()
    const ctx = context(ac.signal)
    let output = ''
    let pids: number[] = []
    ctx.onProgress = (text) => {
      output += text
      const match = /TREE:(\d+):(\d+)/.exec(output)
      if (match) { pids = [Number(match[1]), Number(match[2])]; ac.abort() }
    }
    try {
      const result = await runCommandTool.run({ command, timeout: 8000 }, ctx)
      expect(pids, output).toHaveLength(2)
      expect(result.uiSummary).toBe('命令已中断')
      await vi.waitFor(() => {
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
      }, { timeout: 5000 })
    } finally {
      // 即使断言失败也只清理本测试记录的 PID。
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch { /* 已结束 */ } }
    }
  }, 15_000)
})
