// sound 音效模块单元测试。
// 验证：总开关与 TTY 守卫控制是否发声、各语义化时机函数播放对应的 WAV 文件、关闭后不播放、
//      音量开关（含静音短路与音量透传给播放器）、以及找不到音效目录时回退到 BEL 蜂鸣。
// 不真正发声（CI 无音频），改为注入自定义播放执行器（setSoundPlayer）拦截断言「播放了哪个文件、什么音量」。
// 制作人：Moriarty_Dox

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getSoundVolume,
  isSoundEnabled,
  playInputSent,
  playInterrupted,
  playNotification,
  playPermissionRequest,
  playTurnComplete,
  setSoundEnabled,
  setSoundOutputIsTTY,
  setSoundPlayer,
  setSoundVolume,
} from './sound.js'

describe('sound 音效模块', () => {
  // 记录每次被「播放」的 WAV 文件路径与音量，用于断言。
  let played: Array<{ path: string; volume: number }>

  beforeEach(() => {
    played = []
    // 注入测试播放器：不真正发声，仅记录文件路径与音量。
    setSoundPlayer((wavPath: string, volume: number) => {
      played.push({ path: wavPath, volume })
    })
    // 默认置为「启用 + TTY + 满音量」环境。
    setSoundEnabled(true)
    setSoundOutputIsTTY(true)
    setSoundVolume(100)
  })

  afterEach(() => {
    // 复位为默认跨平台播放器，避免影响其它测试。
    setSoundPlayer(null)
    // 复位音量，避免跨用例污染。
    setSoundVolume(100)
  })

  /** 断言最后一次播放的文件名（路径末段）。 */
  function lastPlayedFile(): string | undefined {
    const last = played[played.length - 1]
    return last ? last.path.replace(/\\/g, '/').split('/').pop() : undefined
  }

  /** 取最后一次播放时传入的音量。 */
  function lastPlayedVolume(): number | undefined {
    return played[played.length - 1]?.volume
  }

  it('setSoundEnabled / isSoundEnabled 正确反映开关', () => {
    setSoundEnabled(false)
    expect(isSoundEnabled()).toBe(false)
    setSoundEnabled(true)
    expect(isSoundEnabled()).toBe(true)
  })

  it('输入发送：播放 input-sent.wav', () => {
    playInputSent()
    expect(played.length).toBe(1)
    expect(lastPlayedFile()).toBe('input-sent.wav')
  })

  it('权限请求：播放 permission.wav', () => {
    playPermissionRequest()
    expect(played.length).toBe(1)
    expect(lastPlayedFile()).toBe('permission.wav')
  })

  it('异常中断：播放 interrupted.wav', () => {
    playInterrupted()
    expect(played.length).toBe(1)
    expect(lastPlayedFile()).toBe('interrupted.wav')
  })

  it('输出结束：播放 turn-complete.wav', () => {
    playTurnComplete()
    expect(played.length).toBe(1)
    expect(lastPlayedFile()).toBe('turn-complete.wav')
  })

  it('通知：播放 notification.wav', () => {
    playNotification()
    expect(played.length).toBe(1)
    expect(lastPlayedFile()).toBe('notification.wav')
  })

  it('关闭音效后不播放', () => {
    setSoundEnabled(false)
    playPermissionRequest()
    playInterrupted()
    expect(played.length).toBe(0)
  })

  it('setSoundVolume / getSoundVolume 正确反映音量并夹紧越界值', () => {
    setSoundVolume(60)
    expect(getSoundVolume()).toBe(60)
    // 越界值应被夹紧到 [0,100]。
    setSoundVolume(500)
    expect(getSoundVolume()).toBe(100)
    setSoundVolume(-10)
    expect(getSoundVolume()).toBe(0)
    // 小数四舍五入为整数。
    setSoundVolume(72.6)
    expect(getSoundVolume()).toBe(73)
  })

  it('播放时把当前音量透传给播放执行器', () => {
    setSoundVolume(40)
    playTurnComplete()
    expect(played.length).toBe(1)
    expect(lastPlayedVolume()).toBe(40)
  })

  it('音量为 0（静音）时不播放，也不写 BEL 蜂鸣', () => {
    const belSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    setSoundVolume(0)
    playPermissionRequest()
    playNotification()
    expect(played.length).toBe(0)
    expect(belSpy).not.toHaveBeenCalledWith('\x07')
    belSpy.mockRestore()
  })

  it('非 TTY 环境不播放（避免污染管道/重定向输出，且不拉起子进程）', () => {
    setSoundOutputIsTTY(false)
    playInputSent()
    playNotification()
    expect(played.length).toBe(0)
  })

  it('音效文件存在时走播放器而非 BEL 蜂鸣', () => {
    // 仓库内 assets/sounds/*.wav 存在，正常路径应调用播放器、不写 BEL。
    const belSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    playTurnComplete()
    expect(played.length).toBe(1)
    expect(belSpy).not.toHaveBeenCalledWith('\x07')
    belSpy.mockRestore()
  })
})
