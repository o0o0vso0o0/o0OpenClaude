/// <summary> AI Cursor </summary>
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import {
  ChatImage,
  ChatMessage,
  SessionSummary,
  SettingsPublic,
  UsageDetail,
  createSession,
  deleteSession,
  fetchSession,
  fetchSessions,
  fetchSettings,
  fetchUsageDetail,
  saveSettings,
  startGuiLifetimeHeartbeat,
  streamChat,
} from './api'
import ModelPicker from './ModelPicker'
import UsageDetailModal from './UsageDetailModal'

const MAX_PENDING_IMAGES = 6
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/// <summary> AI Cursor </summary>
function isLikelyVisionModel(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase()
  if (!id) return false
  if (/vision|gpt-4o|gpt-4\.1|gpt-5|o[1-9]|claude|gemini|qwen.*(vl|vision)|glm-4v|llava/.test(id))
    return true
  // DeepSeek: only *-vision* variants accept images (official docs).
  if (/deepseek/.test(id)) return /vision/.test(id)
  return false
}

const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
])

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

/// <summary> AI Cursor </summary>
function readFileAsChatImage(file: File): Promise<ChatImage | null> {
  return new Promise(resolve => {
    let mediaType = (file.type || '').toLowerCase()
    if (mediaType === 'image/jpg') mediaType = 'image/jpeg'
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
      resolve(null)
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      resolve(null)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s)
      if (!m) {
        resolve(null)
        return
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name || 'image',
        mediaType: mediaType || m[1].toLowerCase(),
        data: m[2],
        dataUrl,
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
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
  const [formCwd, setFormCwd] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  const [usageModal, setUsageModal] = useState<{
    messageId: string
    costLabel: string
    detail: UsageDetail | null
    loading: boolean
    error: string | null
  } | null>(null)
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
        setFormCwd(s.cwd || '')
        setPlanMode(Boolean(s.planMode))
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
      setFormCwd(s.cwd || '')
      setPlanMode(Boolean(s.planMode))
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
        cwd: formCwd.trim(),
        apiKey: formKey.trim() || undefined,
      })
      setSettings(saved)
      setFormCwd(saved.cwd || '')
      setSettingsOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingSettings(false)
    }
  }

  async function onTogglePlanMode() {
    const next = !planMode
    setPlanMode(next)
    setError(null)
    try {
      const saved = await saveSettings({ planMode: next })
      setSettings(saved)
      setPlanMode(Boolean(saved.planMode))
    } catch (e) {
      setPlanMode(!next)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addImageFiles(files: FileList | File[]) {
    const list = Array.from(files || [])
    if (!list.length) return
    const room = MAX_PENDING_IMAGES - pendingImages.length
    if (room <= 0) {
      setError(`最多附带 ${MAX_PENDING_IMAGES} 张图片`)
      return
    }
    const next: ChatImage[] = []
    for (const file of list.slice(0, room)) {
      const img = await readFileAsChatImage(file)
      if (!img) {
        setError('仅支持 png/jpeg/gif/webp，且单张不超过 5MB')
        continue
      }
      next.push(img)
    }
    if (next.length) setPendingImages(prev => [...prev, ...next].slice(0, MAX_PENDING_IMAGES))
  }

  async function onSend() {
    if (!activeId || busy) return
    if (!input.trim() && pendingImages.length === 0) return
    if (settings && !settings.apiKeySet && !formKey) {
      setSettingsOpen(true)
      setError('请先在设置中填写 API Key')
      return
    }

    const activeModel = settings?.model || formModel
    if (pendingImages.length > 0 && !isLikelyVisionModel(activeModel)) {
      setError(
        `当前模型 ${activeModel} 多半不支持识图。请改用带 vision 的型号（如 deepseek-v4-flash-vision-exp、gpt-4o），图片实际已能发出去，但文本模型会当成没图。`,
      )
      setModelPickerOpen(true)
      return
    }

    const text = input.trim()
    const images = [...pendingImages]
    setInput('')
    setPendingImages([])
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
        images,
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

  async function onOpenUsage(m: ChatMessage, costLabel: string) {
    if (!activeId) return
    if (m.usageDetail) {
      setUsageModal({
        messageId: m.id,
        costLabel,
        detail: m.usageDetail,
        loading: false,
        error: null,
      })
      return
    }
    setUsageModal({
      messageId: m.id,
      costLabel,
      detail: null,
      loading: true,
      error: null,
    })
    try {
      const detail = await fetchUsageDetail(activeId, m.id)
      setMessages(prev =>
        prev.map(x => (x.id === m.id ? { ...x, usageDetail: detail } : x)),
      )
      setUsageModal({
        messageId: m.id,
        costLabel,
        detail,
        loading: false,
        error: null,
      })
    } catch (e) {
      setUsageModal({
        messageId: m.id,
        costLabel,
        detail: null,
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void onSend()
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length) {
      e.preventDefault()
      void addImageFiles(files)
    }
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer?.files?.length) void addImageFiles(e.dataTransfer.files)
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
              <p>发送消息将通过 OpenClaude harness 多轮调用工具。请先在设置中填写 API Key 与工作目录 cwd。</p>
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
                {m.images && m.images.length > 0 && (
                  <div className="msg-images">
                    {m.images.map(img => (
                      <img
                        key={img.id}
                        src={img.dataUrl || (img.data ? `data:${img.mediaType};base64,${img.data}` : '')}
                        alt={img.name || 'image'}
                        className="msg-image"
                      />
                    ))}
                  </div>
                )}
                <div className="msg-body">{body || (busy ? '…' : '')}</div>
                {cost && (
                  <button
                    type="button"
                    className="msg-cost-btn"
                    title="查看费用明细"
                    onClick={() => void onOpenUsage(m, cost)}
                  >
                    {cost}
                    <span className="msg-cost-hint">详情</span>
                  </button>
                )}
              </div>
            )
          })}
          <div ref={chatEndRef} />
        </div>

        <div
          className={`composer${dragOver ? ' drag-over' : ''}`}
          onDragEnter={e => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragOver={e => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={e => {
            e.preventDefault()
            if (e.currentTarget === e.target) setDragOver(false)
          }}
          onDrop={onDrop}
        >
          {error && <div className="error-banner">{error}</div>}
          {pendingImages.length > 0 &&
            !isLikelyVisionModel(settings?.model || formModel) && (
              <div className="warn-banner">
                图片会正确发送，但当前模型「{settings?.model || formModel}
                」很可能不识图。请换 vision 模型后再发（DeepSeek 请用
                deepseek-v4-flash-vision-exp）。
              </div>
            )}
          {pendingImages.length > 0 && (
            <div className="pending-images">
              {pendingImages.map(img => (
                <div key={img.id} className="pending-image">
                  <img src={img.dataUrl} alt={img.name || 'image'} />
                  <button
                    type="button"
                    className="pending-image-remove"
                    title="移除"
                    onClick={() =>
                      setPendingImages(prev => prev.filter(x => x.id !== img.id))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-row">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder="输入消息，可拖拽/粘贴图片；Enter 发送，Shift+Enter 换行"
              disabled={busy || !activeId}
            />
            <div className="composer-actions">
              <button
                type="button"
                className={`btn plan-toggle${planMode ? ' active' : ''}`}
                title={
                  planMode
                    ? 'Plan mode 开：只读规划，限制改文件'
                    : 'Plan mode 关：可读写执行'
                }
                disabled={busy}
                onClick={() => void onTogglePlanMode()}
              >
                Plan
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || (!input.trim() && pendingImages.length === 0)}
                onClick={() => void onSend()}
              >
                {busy ? '生成中' : '发送'}
              </button>
            </div>
          </div>
          {dragOver && <div className="drop-hint">松开以添加图片</div>}
        </div>
      </main>

      {modelPickerOpen && (
        <ModelPicker
          currentModel={settings?.model || formModel}
          onSelect={id => void onPickModel(id)}
          onClose={() => setModelPickerOpen(false)}
        />
      )}

      {usageModal && (
        <UsageDetailModal
          costLabel={usageModal.costLabel}
          detail={usageModal.detail}
          loading={usageModal.loading}
          error={usageModal.error}
          onClose={() => setUsageModal(null)}
        />
      )}

      {settingsOpen && (
        <div className="overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>LLM 设置</h2>
            <p>
              使用 OpenClaude Agent harness（工具多轮）。
              {settings?.agentReady === false && (
                <span className="hint"> 当前未找到 CLI，无法运行。</span>
              )}
            </p>
            <div className="field">
              <label>工作目录 cwd（读写文件的根）</label>
              <input
                value={formCwd}
                onChange={e => setFormCwd(e.target.value)}
                placeholder="例如 C:\o0Project（空=仓库根）"
              />
            </div>
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
            {settings?.agentCli && (
              <p className="hint">CLI: {settings.agentCli}</p>
            )}
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
