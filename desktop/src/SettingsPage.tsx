// 主区域设置页面，分类切换保留表单输入，应用偏好即时保存。
// 制作人：Moriarty_Dox
import type { DesktopPreferences } from '../shared/services.js'
import { useLayoutEffect, useRef } from 'react'
import { Icon } from './Icon.js'
import type { IconName } from './Icon.js'
import { ModelSettingsPanel } from './ModelSettingsPanel.js'
import { useAction } from './serviceHooks.js'

export const SETTINGS_SECTIONS = [
  { id: 'models', label: '模型与连接', icon: 'bolt', description: '选择供应商，连接你习惯使用的模型。' },
  { id: 'appearance', label: '外观与输入', icon: 'sun', description: '让工作台适合你的阅读和输入习惯。' },
  { id: 'system', label: '通知与后台', icon: 'bell', description: '管理任务提醒、关闭窗口和后台运行。' },
  { id: 'shortcuts', label: '键盘快捷键', icon: 'keyboard', description: '在输入框与面板中使用这些组合键。' },
] as const
export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id']

const SHORTCUTS = [['命令面板', 'Ctrl / ⌘ + K'], ['快速打开文件', 'Ctrl / ⌘ + P'], ['新建会话', 'Ctrl / ⌘ + N'],
  ['切换侧栏', 'Ctrl / ⌘ + B'], ['上一 / 下一会话', 'Alt + ↑ / ↓'], ['文件审阅', 'Ctrl / ⌘ + Shift + R'],
  ['关闭预览 / 停止回合', 'Esc'], ['输入框换行', 'Shift + Enter'], ['提交暂存的更改', 'Ctrl / ⌘ + Enter']]

export function SettingsPage({ section, preferences, update, locked, saved, close }: {
  section: SettingsSection; preferences: DesktopPreferences; update(patch: Partial<DesktopPreferences>): Promise<void>
  locked: boolean; saved(): void; close(): void
}) {
  const action = useAction()
  const scroll = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { scroll.current?.scrollTo(0, 0) }, [section])
  const current = SETTINGS_SECTIONS.find((item) => item.id === section)!
  return <section className="settings-page" aria-label="桌面设置">
    <header className="settings-page-header"><div><span className="eyebrow">设置</span><h1>{current.label}</h1><p>{current.description}</p></div>
      <button className="icon-button" aria-label="关闭设置" title="返回工作台" onClick={close}><Icon name="close" /></button></header>
    <div className="settings-scroll" ref={scroll}>
      <div hidden={section !== 'models'} className="settings-section"><ModelSettingsPanel locked={locked} saved={saved} /></div>
      <div hidden={section !== 'appearance'} className="settings-section">
        <div className="settings-card"><h2>界面主题</h2><div className="theme-options" role="group" aria-label="外观">
          {([['light', '浅色', 'sun'], ['dark', '深色', 'moon'], ['system', '跟随系统', 'monitor']] as const).map(([value, label, icon]) =>
            <button key={value} className={`theme-option theme-${value}`} aria-pressed={preferences.theme === value} disabled={action.busy}
              onClick={() => void action.run(() => update({ theme: value }))}><span className="theme-preview"><i /><i /><i /></span><span><Icon name={icon} size={16} />{label}{preferences.theme === value && <Icon name="check" size={16} />}</span></button>)}
        </div></div>
        <div className="settings-card"><h2>消息输入</h2><label className="setting-row"><span><strong>发送快捷键</strong><small>Shift+Enter 始终用于换行</small></span>
          <select aria-label="发送消息" value={preferences.sendKey} disabled={action.busy} onChange={(event) => void action.run(() => update({ sendKey: event.target.value as DesktopPreferences['sendKey'] }))}>
            <option value="enter">Enter</option><option value="mod-enter">Ctrl / ⌘ + Enter</option></select></label></div>
      </div>
      <div hidden={section !== 'system'} className="settings-section">
        <div className="settings-card"><h2>系统通知</h2>
          {([['notifications', '启用系统通知', '工作台在后台时提醒你'], ['notifyPermission', '需要审批', '有操作等待你的授权'],
            ['notifyComplete', '回合结束', '当前任务完成时提醒'], ['notifyError', '回合失败', '连接异常或任务中断时提醒']] as const).map(([key, label, description]) =>
            <label className="setting-row" key={key}><span><strong>{label}</strong><small>{description}</small></span><input className="switch-input" type="checkbox" aria-label={label}
              disabled={action.busy || (key !== 'notifications' && !preferences.notifications)} checked={preferences[key]} onChange={(event) => void action.run(() => update({ [key]: event.target.checked }))} /></label>)}
        </div>
        <div className="settings-card"><h2>后台运行</h2>
          <label className="setting-row"><span><strong>关闭窗口</strong><small>托盘菜单可随时恢复工作台</small></span><select aria-label="关闭窗口行为" value={preferences.closeBehavior} disabled={action.busy}
            onChange={(event) => void action.run(() => update({ closeBehavior: event.target.value as DesktopPreferences['closeBehavior'] }))}>
            <option value="ask">每次询问</option><option value="tray">最小化到托盘</option><option value="quit">退出应用</option></select></label>
          <label className="setting-row"><span><strong>执行任务时防止休眠</strong><small>回合结束后恢复系统的休眠策略</small></span><input className="switch-input" aria-label="任务执行期间防止休眠" type="checkbox" checked={preferences.preventSleep}
            disabled={action.busy} onChange={(event) => void action.run(() => update({ preventSleep: event.target.checked }))} /></label>
        </div>
      </div>
      <div hidden={section !== 'shortcuts'} className="settings-section"><div className="settings-card shortcut-list">{SHORTCUTS.map(([label, shortcut]) =>
        <div className="setting-row" key={label}><span>{label}</span><kbd>{shortcut}</kbd></div>)}</div></div>
      {action.error && <p className="inline-error" role="alert">{action.error}</p>}
      {section !== 'models' && section !== 'shortcuts' && <p className="settings-footnote" role="status"><Icon name={action.busy ? 'refresh' : 'check'} size={14} className={action.busy ? 'spin' : ''} />{action.busy ? '正在保存…' : '偏好自动保存到此设备'}</p>}
    </div>
  </section>
}

export function SettingsNavigation({ section, select }: { section: SettingsSection; select(value: SettingsSection): void }) {
  return <><div className="panel-heading"><h2>设置</h2></div><div className="settings-navigation" aria-label="设置分类">
    {SETTINGS_SECTIONS.map((item) => <button key={item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => select(item.id)}><Icon name={item.icon as IconName} size={18} />{item.label}<Icon name="right" size={14} /></button>)}
  </div></>
}
