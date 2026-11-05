// 供应商与共享配置表单，密钥只保留在当前输入状态，保存后立即清空。
// 制作人：Moriarty_Dox
import { useState } from 'react'
import type { ModelSettings, ModelSettingsInput } from '../shared/services.js'
import { unwrap, useAction, useResource } from './serviceHooks.js'
import { Icon } from './Icon.js'

export function ModelSettingsPanel({ locked, saved }: { locked: boolean; saved?(): void }) {
  const settings = useResource('configuration', () => unwrap(window.dcode.getModelSettings()))
  const [feedback, setFeedback] = useState('')
  return <div className="model-settings">
    {settings.loading && !settings.value && <div className="loading-skeleton"><i /><i /><i /></div>}
    {settings.error && <p className="inline-error" role="alert">{settings.error}<button onClick={settings.refresh}>重试</button></p>}
    {settings.value && <ModelForm key={JSON.stringify(settings.value)} settings={settings.value} locked={locked}
      feedback={feedback} setFeedback={setFeedback} saved={() => { settings.refresh(); saved?.() }} />}
  </div>
}

function ModelForm({ settings, locked, saved, feedback, setFeedback }: {
  settings: ModelSettings; locked: boolean; saved(): void; feedback: string; setFeedback(value: string): void
}) {
  const [provider, setProvider] = useState(settings.provider)
  const initial = settings.providers.find((item) => item.id === provider)!
  const [model, setModel] = useState(settings.model)
  const [baseURL, setBaseURL] = useState(initial.baseURL)
  const [apiKey, setApiKey] = useState('')
  const [proxy, setProxy] = useState('')
  const [changeProxy, setChangeProxy] = useState(false)
  const [effort, setEffort] = useState(settings.reasoningEffort)
  const [thinking, setThinking] = useState(settings.showThinking)
  const [showKey, setShowKey] = useState(false)
  const [operation, setOperation] = useState<'save' | 'test' | null>(null)
  const action = useAction()
  const selected = settings.providers.find((item) => item.id === provider)!
  const disabled = locked || action.busy
  const input: ModelSettingsInput = { provider, model, baseURL, reasoningEffort: effort, showThinking: thinking,
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(changeProxy ? { proxy: proxy.trim() } : {}) }

  return <form className="model-form" onSubmit={(event) => {
    event.preventDefault()
    setOperation('save')
    void action.run(async () => {
      const result = await unwrap(window.dcode.saveModelSettings(input))
      setApiKey('')
      setShowKey(false)
      setProxy('')
      setChangeProxy(false)
      setFeedback(result.connectionError ?? '设置已保存。')
      saved()
    })
  }} onChange={() => setFeedback('')}>
    {locked && <p className="inline-notice"><Icon name="info" size={16} />等待当前回合或连接操作结束后，即可修改模型。</p>}
    <fieldset disabled={disabled}>
      <div className="settings-card"><div className="card-heading"><Icon name="bolt" /><h2>模型连接</h2><span className={`connection-indicator ${selected.hasApiKey ? 'configured' : ''}`}>{selected.hasApiKey ? '密钥已配置' : '待配置'}</span></div>
      <div className="model-fields">
      <label>供应商<select aria-label="供应商" value={provider} onChange={(event) => {
        const next = settings.providers.find((item) => item.id === event.target.value)!
        setProvider(next.id); setModel(next.model); setBaseURL(next.baseURL); setApiKey(''); setShowKey(false); setFeedback(''); setChangeProxy(false); setProxy('')
      }}>{settings.providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>模型<input aria-label="模型" list="provider-models" value={model} maxLength={128} required onChange={(event) => setModel(event.target.value)} /></label>
      <datalist id="provider-models">{selected.models.map((item) => <option key={item.value} value={item.value}>{item.label} {item.hint}</option>)}</datalist>
      <label className="field-wide">API 地址<input aria-label="API 地址" type="url" value={baseURL} maxLength={2048} required onChange={(event) => setBaseURL(event.target.value)} /></label>
      <label className="field-wide">API Key <span className="muted small">{selected.environmentKey ? '由环境变量提供' : selected.requiresApiKey ? '' : '可选'}</span>
        <span className="password-field"><input aria-label="API Key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} disabled={selected.environmentKey} value={apiKey} maxLength={4096}
          placeholder={selected.hasApiKey ? '留空保留现有密钥' : '输入 API Key'} onChange={(event) => setApiKey(event.target.value)} />
          <button type="button" className="icon-button" title={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} aria-label={showKey ? '隐藏输入的密钥' : '显示输入的密钥'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}><Icon name="eye" size={16} /></button></span></label>
      </div></div>
      <div className="settings-card"><h2>推理偏好</h2><div className="model-fields">
      <label>推理强度<select aria-label="推理强度" value={effort} onChange={(event) => setEffort(event.target.value as ModelSettingsInput['reasoningEffort'])}>
        <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="max">最高</option>
      </select></label>
      <label className="thinking-setting">启用思考<input className="switch-input" aria-label="启用思考" type="checkbox" checked={thinking} onChange={(event) => setThinking(event.target.checked)} /></label>
      </div><p className="field-help">强度与思考开关由内核按模型能力应用。</p></div>
      <details className="settings-card advanced-settings"><summary><Icon name="settings" size={16} />代理设置<Icon name="chevron" size={14} /></summary>
      <label className="checkbox"><input type="checkbox" checked={changeProxy} onChange={(event) => setChangeProxy(event.target.checked)} />修改此供应商代理{selected.hasProxy ? '（已配置）' : ''}</label>
      {changeProxy && <label>HTTP(S) 代理<input aria-label="代理地址" value={proxy} maxLength={2048} placeholder="http://127.0.0.1:7890" onChange={(event) => setProxy(event.target.value)} /><span className="muted small">留空清除此供应商的覆盖，随后沿用全局或环境代理。</span></label>}
      </details>
      {provider === 'zhipu' && <p className="muted small">智谱连接检查会发送最短对话请求，输出上限 1 Token，可能产生少量用量。</p>}
      <div className="settings-save-bar"><button type="button" onClick={() => { setOperation('test'); void action.run(async () => setFeedback(await unwrap(window.dcode.validateModelSettings(input)))) }}>
        <Icon name="refresh" size={15} className={action.busy && operation === 'test' ? 'spin' : ''} />{action.busy && operation === 'test' ? '连接检查中…' : '测试连接'}</button>
        <button type="submit" className="primary"><Icon name={action.busy && operation === 'save' ? 'refresh' : 'check'} size={16} className={action.busy && operation === 'save' ? 'spin' : ''} />{action.busy && operation === 'save' ? '正在应用…' : '保存并应用'}</button></div>
    </fieldset>
    {action.error && <p className="inline-error" role="alert">{action.error}</p>}
    {feedback && <p className="inline-notice" role="status">{feedback}</p>}
    {!!settings.environmentOverrides.length && <p className="inline-notice">以下环境变量优先生效 {settings.environmentOverrides.join('、')}</p>}
    <p className="muted small">配置与密钥以明文保存在本机 .dcode/config.json，与命令行共享。新密钥、新地址和代理保存前会进行连接检查。</p>
  </form>
}
