// 终端提示音效模块。
// 目标：在关键交互时机播放「可辨识且悦耳」的提示音，方便用户即使切走终端窗口，也能被「叫回来」继续审核
//（例如权限请求、对话结束、异常中断）。
// 实现：播放随包分发的 16-bit PCM WAV 音效文件（Copilot 风格的柔和提示音），按平台调用系统自带播放器：
//   - Windows：PowerShell 的 System.Media.SoundPlayer（原生支持 WAV，无需额外安装）；
//   - macOS：afplay（系统自带）；
//   - Linux：paplay / aplay（探测可用者）。
// 不同事件使用不同音效文件（升/降双音、三音琶音等），比旧版单一 ASCII BEL 蜂鸣更悦耳、更易区分。
// 设计取舍：
//   1) 只用系统自带播放器播放 WAV，保证跨 Windows / macOS / Linux 零额外依赖、安装零负担；
//      （之所以用 WAV 而非 OGG/MP3：Windows 原生仅可靠支持 WAV，OGG 需用户另装播放器。）
//   2) 全局开关由配置 soundEnabled 控制，关闭后所有发声立即变为空操作；
//   3) 用 child_process.spawn 异步、detached、unref 触发，绝不阻塞主交互，失败静默吞掉；
//   4) 提供语义化函数（输入发送 / 权限请求 / 异常中断 / 输出结束 / 通知），调用方无需关心文件与平台细节；
//   5) 找不到音效文件或当前平台不支持时，自动回退到 ASCII BEL 蜂鸣，保证「至少有声」。
// 制作人：Moriarty_Dox

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ASCII 响铃字符（BEL）。作为找不到音效文件 / 平台不支持时的兜底发声。
const BEL = '\x07'

// 模块级开关：默认开启，由 App 启动时按配置 soundEnabled 同步。
let soundEnabled = true

// 是否处于可发声的 TTY 环境：非 TTY（如管道、重定向、CI）时不发声，避免污染输出与无谓拉起子进程。
let outputIsTTY = !!process.stdout.isTTY

/**
 * 五种语义时机对应的音效文件名（位于 assets/sounds，构建时复制到 dist/assets/sounds）。
 * 集中定义便于统一管理与替换音色。
 */
export type SoundName =
  | 'input-sent'
  | 'permission'
  | 'interrupted'
  | 'turn-complete'
  | 'notification'

// 语义时机 -> WAV 文件名映射。
const SOUND_FILES: Record<SoundName, string> = {
  'input-sent': 'input-sent.wav',
  permission: 'permission.wav',
  interrupted: 'interrupted.wav',
  'turn-complete': 'turn-complete.wav',
  notification: 'notification.wav',
}

/**
 * 播放执行器签名：给定 WAV 文件绝对路径，触发一次（异步、不阻塞）播放。
 * 抽象成可注入函数，便于单元测试拦截断言，而不真正发声。
 */
export type SoundPlayer = (wavPath: string) => void

/**
 * 解析音效资源目录的绝对路径。
 * 优先级：
 *   1) dist/assets/sounds —— 打包后产物（cli.js 旁的 assets/sounds，随包分发的真实位置）；
 *   2) <repo>/assets/sounds —— 开发期未打包时，从 src/ui 上溯到仓库根的源目录。
 * 两者都用各自的「本文件位置」推导，避免依赖 process.cwd()（用户可能在任意目录启动 CLI）。
 * @returns 命中的音效目录绝对路径；都不存在时返回 null。
 */
function resolveSoundsDir(): string | null {
  let baseDir: string
  try {
    // 本模块被 esbuild 打包进 dist/cli.js 后，import.meta.url 指向 dist/cli.js。
    baseDir = dirname(fileURLToPath(import.meta.url))
  } catch {
    // 极少数无 import.meta.url 的环境，退回当前工作目录兜底。
    baseDir = process.cwd()
  }

  const candidates = [
    // 打包后：dist/cli.js 同级的 assets/sounds。
    join(baseDir, 'assets', 'sounds'),
    // 开发期（tsx 直跑 src/ui/sound.ts）：上溯 src/ui -> src -> 仓库根，再进 assets/sounds。
    join(baseDir, '..', '..', 'assets', 'sounds'),
    // 兜底：dist 与源码并列布局时的另一种相对位置。
    join(baseDir, '..', 'assets', 'sounds'),
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  return null
}

// 缓存解析结果（首次调用时计算一次），避免每次发声都做文件系统探测。
let cachedSoundsDir: string | null | undefined

/**
 * 获取音效目录（带缓存）。
 * @returns 目录绝对路径，或 null（未找到）。
 */
function getSoundsDir(): string | null {
  if (cachedSoundsDir === undefined) {
    cachedSoundsDir = resolveSoundsDir()
  }
  return cachedSoundsDir
}

/**
 * 默认的跨平台播放执行器：按当前操作系统调用系统自带播放器异步播放 WAV。
 * 全程 detached + unref + 忽略 stdio，确保不阻塞主交互、不污染终端、进程退出不被挂起。
 * 任意失败（找不到播放器、spawn 抛错）都静默吞掉，绝不影响主流程。
 * @param wavPath 待播放的 WAV 文件绝对路径。
 */
function defaultPlayer(wavPath: string): void {
  try {
    const platform = process.platform
    let command: string
    let args: string[]
    // spawn 选项按平台区分：Windows 在 Ink 全屏 TUI 下不可用 detached（会脱离控制台导致子进程
    // 静默不发声），改用 windowsHide 隐藏窗口即可正常出声；Unix 用 detached 让音效独立于父进程。
    let options: import('node:child_process').SpawnOptions

    if (platform === 'win32') {
      // Windows：用 PowerShell 的 SoundPlayer 同步播放（在子进程内同步，对主进程仍是异步）。
      // -NoProfile 加速启动；PlaySync 确保子进程存活到放完，避免提前退出导致没声。
      // 关键：-WindowStyle Hidden + windowsHide 隐藏窗口，但「不」detached——
      // 在接管了控制台的 TUI（Ink）里，detached 会让 PowerShell 子进程拿不到音频会话而无声。
      command = 'powershell'
      args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `(New-Object System.Media.SoundPlayer '${wavPath.replace(/'/g, "''")}').PlaySync();`,
      ]
      options = { windowsHide: true, stdio: 'ignore' }
    } else if (platform === 'darwin') {
      // macOS：afplay 为系统自带音频播放命令，直接吃 WAV。detached 让其独立于父进程播放。
      command = 'afplay'
      args = [wavPath]
      options = { detached: true, stdio: 'ignore' }
    } else {
      // Linux / 其它类 Unix：优先 paplay（PulseAudio），其次 aplay（ALSA）。
      // 用 sh -c 串联回退：paplay 不存在或失败时再试 aplay。
      command = 'sh'
      const esc = wavPath.replace(/'/g, `'\\''`)
      args = ['-c', `paplay '${esc}' 2>/dev/null || aplay -q '${esc}' 2>/dev/null`]
      options = { detached: true, stdio: 'ignore' }
    }

    const child = spawn(command, args, options)
    // 解除引用：即使音效还没放完，也不阻止 Node 主进程正常退出。
    child.unref()
    // 监听 error，避免「找不到命令」等错误冒泡成未捕获异常。
    child.on('error', () => {
      // 静默：播放失败不影响任何功能。
    })
  } catch {
    // 忽略：提示音失败绝不影响主流程。
  }
}

// 当前生效的播放执行器；默认用跨平台实现，测试可通过 setSoundPlayer 注入替身。
let activePlayer: SoundPlayer = defaultPlayer

/**
 * 注入自定义播放执行器（主要供测试断言播放调用；正常运行无需调用）。
 * 传入 null 可恢复为默认的跨平台播放器。
 * @param player 自定义执行器，或 null 表示复位为默认实现。
 */
export function setSoundPlayer(player: SoundPlayer | null): void {
  activePlayer = player ?? defaultPlayer
}

/**
 * 设置音效总开关（由配置 soundEnabled 驱动；/sound 命令切换后也应调用）。
 * @param enabled 是否启用。
 */
export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
}

/**
 * 查询当前音效是否启用（供 /sound 状态展示与测试断言）。
 * @returns 启用返回 true。
 */
export function isSoundEnabled(): boolean {
  return soundEnabled
}

/**
 * 覆盖「是否 TTY」判定（主要供测试注入；正常运行无需调用）。
 * @param isTty 是否视为 TTY。
 */
export function setSoundOutputIsTTY(isTty: boolean): void {
  outputIsTTY = isTty
}

/**
 * 兜底发声：写入一个 ASCII BEL 字符。仅在「已启用 + TTY」时执行。
 * 当音效文件缺失或平台不支持播放器时，至少用蜂鸣提醒用户。
 */
function emitBel(): void {
  if (!soundEnabled || !outputIsTTY) return
  try {
    process.stdout.write(BEL)
  } catch {
    // 忽略：提示音失败不影响任何功能。
  }
}

/**
 * 播放指定语义时机的音效。
 * 守卫：未启用或非 TTY 时直接跳过（既不发声，也不拉起任何子进程）。
 * 流程：定位 WAV 文件 -> 交给当前播放执行器异步播放；文件/目录缺失则回退 BEL 蜂鸣。
 * @param name 语义时机名。
 */
function playSound(name: SoundName): void {
  if (!soundEnabled || !outputIsTTY) return
  const dir = getSoundsDir()
  if (!dir) {
    // 找不到音效目录：退回蜂鸣，保证「至少有声」。
    emitBel()
    return
  }
  const wavPath = join(dir, SOUND_FILES[name])
  if (!existsSync(wavPath)) {
    emitBel()
    return
  }
  activePlayer(wavPath)
}

// —— 语义化时机：调用方只需表达「发生了什么」，具体音色/文件由本模块统一定义 —— //

/**
 * 输入已发送：用户提交一条消息/开始一轮处理。
 * 极轻的单音「叮」，作为「已收到」的轻反馈。
 */
export function playInputSent(): void {
  playSound('input-sent')
}

/**
 * 权限请求：需要用户做出授权决策（最需要把用户「叫回来」的时机之一）。
 * 上行双音「叮-咚↑」，明亮、引起注意但不刺耳。
 */
export function playPermissionRequest(): void {
  playSound('permission')
}

/**
 * 异常 / 中断：对话出错或被用户中断。
 * 下行双音，温和的「停下来」收束感，与正常完成区分。
 */
export function playInterrupted(): void {
  playSound('interrupted')
}

/**
 * 输出结束：一轮对话正常完成，可供用户查看/审核结果。
 * 愉悦的上行三音琶音，表示「完成」。
 */
export function playTurnComplete(): void {
  playSound('turn-complete')
}

/**
 * 通用通知：需要用户关注的其它提示（如 Hooks Notification、需要继续审核）。
 * 柔和的同音双击「叮·叮」，表示「请注意」。
 */
export function playNotification(): void {
  playSound('notification')
}
