// skills 单元测试。
// 覆盖 frontmatter 解析、目录扫描、项目覆盖全局、写入与 prompt 格式化。
// 制作人：Moriarty_Dox

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, beforeEach } from 'vitest'
import {
  parseSkillFile,
  listAvailableSkills,
  loadSkillByName,
  formatSkillsForPrompt,
  formatSkillFile,
  writeSkillFile,
  isValidSkillName,
  getProjectSkillsDir,
} from './skills.js'

describe('skills', () => {
  let tempCwd: string

  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'dcode-skills-test-'))
  })

  /** 在项目 skills 目录写入技能文件。 */
  function writeProjectSkill(name: string, content: string): void {
    const dir = getProjectSkillsDir(tempCwd)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), content, 'utf8')
  }

  it('parseSkillFile 解析 YAML frontmatter 与正文', () => {
    const raw = `---
name: my-skill
description: 测试技能
---

# 正文标题
执行步骤…`
    const skill = parseSkillFile(raw, '/tmp/my-skill.md', 'project')
    expect(skill.name).toBe('my-skill')
    expect(skill.description).toBe('测试技能')
    expect(skill.body).toContain('正文标题')
  })

  it('parseSkillFile 无 frontmatter 时使用文件名', () => {
    const skill = parseSkillFile('# 仅正文', '/tmp/foo.md', 'global')
    expect(skill.name).toBe('foo')
    expect(skill.body).toBe('# 仅正文')
  })

  it('listAvailableSkills 列出项目技能', () => {
    writeProjectSkill('alpha', formatSkillFile('alpha', 'A', 'body a'))
    writeProjectSkill('beta', formatSkillFile('beta', 'B', 'body b'))

    const list = listAvailableSkills(tempCwd)
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.find((s) => s.name === 'alpha')?.description).toBe('A')
    expect(list.find((s) => s.name === 'beta')?.scope).toBe('project')
  })

  it('listAvailableSkills 项目同名文件以项目 scope 为准', () => {
    writeProjectSkill(
      'shared',
      formatSkillFile('shared', '项目版', 'project body'),
    )

    const list = listAvailableSkills(tempCwd)
    const shared = list.find((s) => s.name === 'shared')
    expect(shared?.description).toBe('项目版')
    expect(shared?.scope).toBe('project')
  })

  it('loadSkillByName 从项目目录加载', () => {
    writeProjectSkill('x', formatSkillFile('x', 'p', 'project'))
    const skill = loadSkillByName('x', tempCwd)
    expect(skill?.scope).toBe('project')
    expect(skill?.body).toBe('project')
  })

  it('formatSkillsForPrompt 生成非空段落', () => {
    const skill = parseSkillFile(
      formatSkillFile('unit-test', '测试', '步骤 1'),
      '/a.md',
      'global',
    )
    const text = formatSkillsForPrompt([skill])
    expect(text).toContain('技能：unit-test')
    expect(text).toContain('步骤 1')
  })

  it('writeSkillFile 写入项目目录', () => {
    const path = writeSkillFile('new-skill', '描述', '# 内容', tempCwd, 'project')
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('name: new-skill')
    expect(raw).toContain('# 内容')
  })

  it('isValidSkillName 拒绝非法名称', () => {
    expect(isValidSkillName('valid-name_1')).toBe(true)
    expect(isValidSkillName('bad name')).toBe(false)
    expect(isValidSkillName('')).toBe(false)
  })
})
