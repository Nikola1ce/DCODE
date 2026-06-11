// bypass 模式安装验证脚本。
// 校验 /bypass 斜杠命令、/mode bypass、--bypass 启动参数及工具层权限放行逻辑。
// 不触网、不启动 TUI。制作人：Moriarty_Dox

import { Agent } from '../src/core/agent.js'
import { loadConfig } from '../src/config.js'
import { runSlashCommand } from '../src/commands/index.js'
import { writeFileTool } from '../src/tools/writeFile.js'
import { runCommandTool } from '../src/tools/runCommand.js'
import type { ToolContext } from '../src/core/types.js'

const config = { ...loadConfig(), apiKey: 'sk-test' }

/** 构造最小 ToolContext，用于测试 checkPermission。 */
function makeToolCtx(permissionMode: ToolContext['permissionMode']): ToolContext {
  return {
    cwd: process.cwd(),
    permissionMode,
    abortSignal: new AbortController().signal,
    requestPermission: async () => 'deny',
  }
}

/** 断言条件，失败时抛错并带说明。 */
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

async function main(): Promise<void> {
  // 1) /bypass 斜杠命令
  const agent1 = new Agent({ config, cwd: process.cwd(), recorder: null })
  assert(agent1.permissionMode === 'default', '初始应为 default')
  const r1 = await runSlashCommand('/bypass', {
    agent: agent1,
    config,
    applyConfig: () => {},
  })
  assert(agent1.permissionMode === 'bypass', '/bypass 应切换到 bypass')
  assert(!!r1.message?.includes('跳过确认'), '/bypass 应返回提示文案')

  // 2) /mode bypass
  const agent2 = new Agent({ config, cwd: process.cwd(), recorder: null })
  const r2 = await runSlashCommand('/mode bypass', {
    agent: agent2,
    config,
    applyConfig: () => {},
  })
  assert(agent2.permissionMode === 'bypass', '/mode bypass 应切换到 bypass')
  assert(!!r2.message?.includes('bypass'), '/mode bypass 应返回模式名')

  // 3) bypass 下写文件与命令均免确认
  const bypassCtx = makeToolCtx('bypass')
  assert(
    writeFileTool.checkPermission({ path: 'x.txt', content: 'hi' }, bypassCtx) === null,
    'bypass 下 write_file 应免确认',
  )
  assert(
    runCommandTool.checkPermission({ command: 'echo hi' }, bypassCtx) === null,
    'bypass 下 run_command 应免确认',
  )

  // 4) default 下命令仍需确认
  const defaultCtx = makeToolCtx('default')
  assert(
    runCommandTool.checkPermission({ command: 'echo hi' }, defaultCtx) !== null,
    'default 下 run_command 应需确认',
  )

  process.stdout.write('VERIFY_BYPASS_OK\n')
}

main().catch((err) => {
  process.stderr.write(String(err) + '\n')
  process.exit(1)
})
