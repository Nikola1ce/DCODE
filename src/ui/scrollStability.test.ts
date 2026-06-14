// Bug 2 修复验证：滚动容器结构与稳定性测试。
// 验证主输出区域（Static + 实时区）与交互区域（权限弹窗/输入框）严格分离，
// 权限弹窗出现时不会导致主输出区域重新挂载或滚动位置重置。
//
// 覆盖场景：
// 1. 主输出区域有稳定的 key。
// 2. 权限弹窗与主输出区域不在同一渲染层级。
// 3. TodoPanel 和 BackgroundShellPanel 在主输出区域内，不受权限弹窗影响。
// 4. 输入框和状态栏在交互区域。
// 5. 通过「不清屏」stdout 代理禁用 Ink 的 clearTerminal，使动态区超过视口时不回弹。
//
// 制作人：Moriarty_Dox

import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { tailByVisualRows, wrappedRows } from './textLayout.js'

// 辅助：把源码行尾统一规范为 \n，使断言不受 CRLF/LF 差异影响。
// 仓库未配置 .gitattributes 且 core.autocrlf=true，同一文件在不同环境检出时
// 可能是 CRLF 或 LF；断言若硬编码 \r\n，会在 LF 环境（如 CI/Linux）下误报。
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// 辅助：加载 App.tsx 源码（行尾已规范为 \n）。
function getAppSource(): string {
  return normalizeEol(
    fs.readFileSync(path.join(process.cwd(), 'src/ui/App.tsx'), 'utf8'),
  )
}

// 辅助：加载任意源码文件（行尾已规范为 \n）。
function readSource(rel: string): string {
  return normalizeEol(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'))
}

describe('Bug 2 修复验证：滚动容器结构稳定性', () => {
  it('主输出区域使用稳定的常量 key（不含状态变量）', () => {
    const source = getAppSource()
    // outputKey 应为字面常量 "main-output"，而非 useState 等动态值
    expect(source).toMatch(/const outputKey\s*=\s*['"]main-output['"]/)
  })

  it('主输出区域 Box 有 key 属性，key 值为 outputKey 常量', () => {
    const source = getAppSource()
    expect(source).toMatch(/<Box key=\{outputKey\}/)
  })

  it('主输出区域包含 Static、实时区、TodoPanel 和 BackgroundShellPanel', () => {
    const source = getAppSource()
    // 用唯一模式定位主输出区域的结束：</Box> 后面紧跟"交互区域"注释
    const mainBoxEnd = source.indexOf('</Box>\n\n        {/* 交互区域')
    expect(mainBoxEnd).toBeGreaterThan(0)

    const mainBoxStart = source.indexOf('<Box key={outputKey}')
    expect(mainBoxStart).toBeGreaterThan(0)
    expect(mainBoxStart).toBeLessThan(mainBoxEnd)

    const mainBoxContent = source.slice(mainBoxStart, mainBoxEnd + 6)
    expect(mainBoxContent).toContain('<Static items={items}>')
    expect(mainBoxContent).toContain('<TodoPanel')
    expect(mainBoxContent).toContain('<BackgroundShellPanel')
  })

  it('权限弹窗在主输出区域之后（兄弟节点关系）', () => {
    const source = getAppSource()
    const mainBoxEnd = source.indexOf('</Box>\n\n        {/* 交互区域')
    expect(mainBoxEnd).toBeGreaterThan(0)

    const mainBoxStart = source.indexOf('<Box key={outputKey}')
    const mainBoxContent = source.slice(mainBoxStart, mainBoxEnd + 6)
    const afterClose = source.slice(mainBoxEnd + 6)

    // 在闭合标签之后，应该能找到 permissionReq 条件渲染
    expect(afterClose).toMatch(/\{permissionReq \?/)
    // 验证 PermissionPrompt 在 permissionReq 条件内
    expect(afterClose).toContain('<PermissionPrompt')
    // 验证 PermissionPrompt 不在主输出区域的内部
    expect(mainBoxContent).not.toContain('<PermissionPrompt')
  })

  it('交互区域包含 InputPrompt、StatusLine 和 PermissionPrompt', () => {
    const source = getAppSource()
    const mainBoxEnd = source.indexOf('</Box>\n\n        {/* 交互区域')
    const interaction = source.slice(mainBoxEnd + 6)

    expect(interaction).toContain('<PermissionPrompt')
    expect(interaction).toContain('<InputPrompt')
    expect(interaction).toContain('<StatusLine')
  })

  it('PermissionPrompt 前面最近的 </Box> 之后紧跟 permissionReq（兄弟节点）', () => {
    const source = getAppSource()
    const mainBoxEnd = source.indexOf('</Box>\n\n        {/* 交互区域')
    const afterClose = source.slice(mainBoxEnd + 6)

    // 在 </Box> 之后到 <PermissionPrompt 之前的内容应该是注释和条件渲染的开始
    const permPromptIdx = afterClose.indexOf('<PermissionPrompt')
    const betweenCloseAndPerm = afterClose.slice(0, permPromptIdx)
    expect(betweenCloseAndPerm).toMatch(/\{permissionReq \?/)
    expect(betweenCloseAndPerm).toContain('交互区域')
  })

  it('TodoPanel 和 BackgroundShellPanel 在主输出区域内而非交互区域内', () => {
    const source = getAppSource()
    const mainBoxEnd = source.indexOf('</Box>\n\n        {/* 交互区域')
    const mainBoxStart = source.indexOf('<Box key={outputKey}')
    const mainOutput = source.slice(mainBoxStart, mainBoxEnd + 6)
    const interaction = source.slice(mainBoxEnd + 6)

    // TodoPanel 和 BackgroundShellPanel 在主输出区
    expect(mainOutput).toContain('<TodoPanel')
    expect(mainOutput).toContain('<BackgroundShellPanel')
    // 不在交互区
    expect(interaction).not.toContain('<TodoPanel')
    expect(interaction).not.toContain('<BackgroundShellPanel')
  })

  it('权限弹窗条件渲染不包含 key 属性（防止重复挂载）', () => {
    const source = getAppSource()
    // 验证 permissionReq 条件渲染的起始模式
    expect(source).toMatch(/\{permissionReq \? \(\s*<PermissionPrompt/)
    // 验证条件渲染块不以 key= 开头
    const permStart = source.match(/\{permissionReq \?[\s\S]{0,50}/)?.[0] ?? ''
    expect(permStart).not.toMatch(/key=/)
  })

  it('App does not imperatively reset terminal scroll or focus during permission changes', () => {
    const source = getAppSource()
    expect(source).not.toMatch(/scrollTop|scrollTo|scrollIntoView|requestAnimationFrame|setInterval|\.focus\(/)
  })

  it('streaming text and reasoning are not rendered in the dynamic Ink region', () => {
    const source = getAppSource()
    expect(source).not.toContain('tailByVisualRows(liveReasoning')
    expect(source).not.toContain('tailByVisualRows(liveText')
    expect(source).not.toMatch(/<Text color=\{theme\.text\}>\s*\{liveText\}\s*<\/Text>/)
    expect(source).not.toMatch(/<Text color=\{theme\.dim\}>\s*\{liveReasoning\}\s*<\/Text>/)
  })

  it('tailByVisualRows keeps long unbroken output within the requested viewport rows', () => {
    const clipped = tailByVisualRows('x'.repeat(200), 3, 20)
    const rows = clipped
      .split('\n')
      .reduce((sum, line) => sum + wrappedRows(line, 20), 0)
    expect(rows).toBeLessThanOrEqual(3)
  })

  it('cli 用「不清屏」stdout 代理喂给 Ink，从根上禁用 clearTerminal 回弹', () => {
    const source = readSource('src/cli.tsx')
    // 应定义不清屏代理，并把放大后的行数交给 Ink，使 outputHeight >= rows 永不成立。
    expect(source).toMatch(/function createNonClearingStdout/)
    expect(source).toMatch(/Number\.MAX_SAFE_INTEGER/)
    // render 调用应传入该代理作为 stdout。
    expect(source).toMatch(/stdout:\s*createNonClearingStdout\(process\.stdout\)/)
  })

  it('App 的限高逻辑读取真实 process.stdout 行列数（不受 Ink 代理影响）', () => {
    const source = getAppSource()
    // termRows/termCols 必须来自真实 process.stdout，而非被放大的 Ink 代理。
    expect(source).toMatch(/realStdout\.rows/)
    expect(source).toMatch(/process\.stdout as unknown as/)
  })

  it('PermissionPrompt 只渲染动态区选择项，不渲染标题/预览（避免高预览反复重绘残影）', () => {
    const source = readSource('src/ui/PermissionPrompt.tsx')
    // 预览不再由弹窗渲染，因此不应出现 preview / previewLines 等渲染逻辑。
    expect(source).not.toMatch(/request\.preview/)
    expect(source).not.toMatch(/previewLines/)
    // 也不应有按终端高度压缩的旧逻辑。
    expect(source).not.toMatch(/ultraCompact/)
    expect(source).not.toMatch(/previewBudget/)
    // 仍提供三个决策选项。
    expect(source).toMatch(/allow_once/)
    expect(source).toMatch(/allow_always/)
    expect(source).toMatch(/deny/)
  })

  it('权限请求的标题与预览落入 Static 历史（permission 项）而非动态区', () => {
    const appSource = getAppSource()
    // App 在弹窗出现时把 permission 项推入 items（Static）。
    expect(appSource).toMatch(/kind:\s*['"]permission['"]/)
    expect(appSource).toMatch(/setItems\(\(prev\)\s*=>\s*\[/)
    // MessageView 需能渲染 permission 项（标题 + 预览）。
    const mvSource = readSource('src/ui/MessageView.tsx')
    expect(mvSource).toMatch(/case 'permission'/)
    expect(mvSource).toMatch(/item\.preview/)
  })
})
