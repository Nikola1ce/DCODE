// updater 单元测试。
// 验证语义化版本比较、安装类型检测、启动提示与状态渲染逻辑。
// 制作人：Moriarty_Dox

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildStartupUpdateNotice,
  compareSemver,
  detectInstallType,
  getInstallRoot,
  renderUpdateStatus,
  type UpdateCheckResult,
} from './updater.js'

describe('updater', () => {
  it('getInstallRoot 指向含 package.json 的包根目录', () => {
    const root = getInstallRoot()
    expect(existsSync(join(root, 'package.json'))).toBe(true)
  })

  it('compareSemver 正确比较版本', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0)
    expect(compareSemver('1.1.0', '1.0.0')).toBe(1)
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1)
    expect(compareSemver('v1.2.3', '1.2.2')).toBe(1)
  })

  it('detectInstallType 在 DCODE 源码仓库识别为 source', () => {
    const root = getInstallRoot()
    expect(detectInstallType(root)).toBe('source')
  })

  it('buildStartupUpdateNotice 有更新时返回提示', () => {
    const check: UpdateCheckResult = {
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      installRoot: '/tmp',
      installType: 'source',
      fromCache: false,
    }
    const notice = buildStartupUpdateNotice(check)
    expect(notice).toContain('1.1.0')
    expect(notice).toContain('/update')
  })

  it('buildStartupUpdateNotice 无更新时返回 undefined', () => {
    const check: UpdateCheckResult = {
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
      installRoot: '/tmp',
      installType: 'npm-global',
      fromCache: true,
    }
    expect(buildStartupUpdateNotice(check)).toBeUndefined()
  })

  it('renderUpdateStatus 包含版本与安装信息', () => {
    const check: UpdateCheckResult = {
      currentVersion: '1.0.0',
      latestVersion: '1.2.0',
      updateAvailable: true,
      installRoot: 'C:\\DCODE',
      installType: 'source',
      fromCache: false,
    }
    const text = renderUpdateStatus(check)
    expect(text).toContain('当前版本')
    expect(text).toContain('1.2.0')
    expect(text).toContain('可更新')
    expect(text).toContain('/update run')
  })
})
