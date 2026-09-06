/// <summary> AI Cursor </summary>
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  ChatMessage,
  SessionSummary,
  SettingsPublic,
  createSession,
  deleteSession,
  fetchSession,
  fetchSessions,
  fetchSettings,
  saveSettings,
  startGuiLifetimeHeartbeat,
  streamChat,
} from './api'
import ModelPicker from './ModelPicker'

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/// <summary> AI Cursor </summary>
function splitCostFooter(content: string): { body: string; cost: string | null } {
  const marker = '\n\n---\n费用：'
  const i = content.lastIndexOf(marker)
  if (i < 0) return { body: content, cost: null }
  return {
    body: content.slice(0, i),
    cost: content.slice(i + '\n\n---\n'.length),
  }
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [title, setTitle] = useState('新会话')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsPublic | null>(null)
  const [formKey, setFormKey] = useState('')
  const [formBase, setFormBase] = useState('https://api.chatanywhere.tech/v1')
  const [formModel, setFormModel] = useState('gpt-4o-mini')
  const [savingSettings, setSavingSettings] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshSessions = useCallback(async () => {
    const list = await fetchSessions()
    setSessions(list)
    return list
  }, [])

  const loadSession = useCallback(async (id: string) => {
    const session = await fetchSession(id)
    setActiveId(session.id)
    setTitle(session.title)
    setMessages(session.messages)
    setError(null)
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const s = await fetchSettings()
        setSettings(s)
        setFormBase(s.baseUrl)
        setFormModel(s.model)
        const list = await refreshSessions()
        if (list.length > 0) await loadSession(list[0].id)
        else {
          const created = await createSession()
          await refreshSessions()
          await loadSession(created.id)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [loadSession, refreshSessions])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  useEffect(() => startGuiLifetimeHeartbeat(), [])

  async function onNewSession() {
    const created = await createSession()
    await refreshSessions()
    await loadSession(created.id)
  }

  async function onDeleteSession(id: string) {
    await deleteSession(id)
    const list = await refreshSessions()
    if (activeId === id) {
      if (list[0]) await loadSession(list[0].id)
      else {
        const created = await createSession()
        await refreshSessions()
        await loadSession(created.id)
      }
    }
  }

  async function openSettings() {
    setSettingsOpen(true)
    setError(null)
    try {
      const s = await fetchSettings()
      setSettings(s)
      setFormBase(s.baseUrl)
      setFormModel(s.model)
      setFormKey(s.apiKey || '')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        /network|fetch|failed/i.test(msg)
          ? '本地服务已断开（NetworkError）。请重新运行「测试 by o0」或 Release 启动后再试。'
          : msg,
      )
    }
  }

  async function onPickModel(modelId: string) {
    setError(null)
    try {
      const saved = await saveSettings({ model: modelId })
      setSettings(saved)
      setFormModel(saved.model)
      setModelPickerOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSaveSettings() {
    setSavingSettings(true)
    setError(null)
    try {
      const saved = await saveSettings({
        baseUrl: formBase.trim(),
        model: (settings?.model || formModel).trim(),
        apiKey: formKey.trim() || undefined,
      })
      setSettings(saved)
      setSettingsOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingSettings(false)
    }
  }

  async function onSend() {
    if (!activeId || !input.trim() || busy) return
    if (settings && !settings.apiKeySet && !formKey) {
      setSettingsOpen(true)
      setError('请先在设置中填写 API Key')
      return
    }

    const text = input.trim()
    setInput('')
    setBusy(true)
    setError(null)

    const assistantId = `tmp-${Date.now()}`
    abortRef.current = new AbortController()

    try {
      await streamChat(
        activeId,
        text,
        {
          onUser: msg => setMessages(prev => [...prev, msg]),
          onAssistantStart: id => {
            setMessages(prev => [
              ...prev,
              {
                id,
                role: 'assistant',
                content: '',
                createdAt: new Date().toISOString(),
              },
            ])
          },
          onDelta: (id, delta) => {
            setMessages(prev =>
              prev.map(m =>
                m.id === id ? { ...m, content: m.content + delta } : m,
              ),
            )
          },
          onDone: (msg, meta) => {
            setMessages(prev => prev.map(m => (m.id === msg.id ? msg : m)))
            setTitle(meta.title)
            void refreshSessions()
          },
          onError: message => setError(message),
        },
        abortRef.current.signal,
      )
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      const msg = e instanceof Error ? e.message : String(e)
      setError(
        /NetworkError|Failed to fetch|network/i.test(msg)
          ? '发送失败：本地服务已断开或崩溃。请重新运行「测试 by o0」，并查看 o0\\.cache\\gui-server.log'
          : msg,
      )
      setMessages(prev => prev.filter(m => m.id !== assistantId))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void onSend()
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            OpenClaude GUI
            <span>本地网页 · 无 TUI</span>
          </div>
          <div className="sidebar-actions">
            <button type="button" className="btn btn-primary" onClick={() => void onNewSession()}>
              新会话
            </button>
            <button type="button" className="btn" onClick={() => void openSettings()}>
              设置
            </button>
          </div>
        </div>
        <div className="session-list">
          {sessions.map(s => (
            <button
              key={s.id}
              type="button"
              className={`session-item${s.id === activeId ? ' active' : ''}`}
              onClick={() => void loadSession(s.id)}
              onContextMenu={e => {
                e.preventDefault()
                if (confirm(`删除会话「${s.title}」？`)) void onDeleteSession(s.id)
              }}
            >
              <div className="session-title">{s.title}</div>
              <div className="session-meta">{formatTime(s.updatedAt)}</div>
            </button>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <div className="sidebar-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setModelPickerOpen(true)}>
              {settings?.apiKeySet ? `模型 ${settings.model}` : '未配置 API'}
            </button>
          </div>
        </div>

        <div className="chat">
          {messages.length === 0 && (
            <div className="empty">
              <h2>开始对话</h2>
              <p>在设置中填写 chatanywhere 等 OpenAI 兼容接口的 Base URL 与 API Key，然后发送消息。</p>
            </div>
          )}
          {messages.map(m => {
            const split =
              m.role === 'assistant' ? splitCostFooter(m.content || '') : null
            const body = split ? split.body : m.content
            const cost = split?.cost || m.costFooter || null
            return (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="role">{m.role === 'user' ? '你' : '助手'}</div>
                <div className="msg-body">{body || (busy ? '…' : '')}</div>
                {cost && <div className="msg-cost">{cost}</div>}
              </div>
            )
          })}
          <div ref={chatEndRef} />
        </div>

        <div className="composer">
          {error && <div className="error-banner">{error}</div>}
          <div className="composer-row">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入消息，Enter 发送，Shift+Enter 换行"
              disabled={busy || !activeId}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !input.trim()}
              onClick={() => void onSend()}
            >
              {busy ? '生成中' : '发送'}
            </button>
          </div>
        </div>
      </main>

      {modelPickerOpen && (
        <ModelPicker
          currentModel={settings?.model || formModel}
          onSelect={id => void onPickModel(id)}
          onClose={() => setModelPickerOpen(false)}
        />
      )}

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>LLM 设置</h2>
            <p>
              支持 OpenAI 兼容接口。ChatAnywhere 示例 Base URL：
              <span className="hint"> https://api.chatanywhere.tech/v1</span>
            </p>
            <div className="field">
              <label>API Base URL</label>
              <input
                value={formBase}
                onChange={e => setFormBase(e.target.value)}
                placeholder="https://api.chatanywhere.tech/v1"
              />
            </div>
            <div className="field">
              <label>API Key</label>
              <input
                type="text"
                value={formKey}
                onChange={e => setFormKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setSettingsOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={savingSettings}
                onClick={() => void onSaveSettings()}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
