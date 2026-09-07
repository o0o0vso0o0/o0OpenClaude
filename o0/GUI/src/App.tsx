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
  ActivityItem,
  ChatImage,
  ChatMessage,
  FileChangeItem,
  SessionStatus,
  SessionSummary,
  SettingsPublic,
  UsageDetail,
  createSession,
  discardSession,
  deleteSessionPermanent,
  fetchSession,
  fetchSessions,
  fetchSettings,
  fetchUsageDetail,
  renameSession,
  restoreSession,
  saveSettings,
  startGuiLifetimeHeartbeat,
  streamChat,
} from './api'
import ModelPicker from './ModelPicker'
import OllamaVramPanel from './OllamaVramPanel'
import UsageDetailModal from './UsageDetailModal'
import { localModelLabel } from './localModelLabel'
import {
  classifyStreamPhase,
  describeStreamWait,
  estimateRemainingSec,
  formatEtaSec,
  recordEtaSample,
  type StreamPhase,
} from './streamEta'

const MAX_PENDING_IMAGES = 6
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const ACTIVITY_KIND_ORDER = [
  'thought',
  'explored',
  'edited',
  'commands',
  'worked',
  'tool',
]

/// <summary> AI Cursor </summary>
function upsertActivity(
  list: ActivityItem[] | undefined,
  item: ActivityItem,
): ActivityItem[] {
  const next = [...(list || [])]
  const i = next.findIndex(x => x.kind === item.kind)
  if (i >= 0) next[i] = { ...next[i], ...item }
  else next.push(item)
  return next.sort((a, b) => {
    const ai = ACTIVITY_KIND_ORDER.indexOf(String(a.kind))
    const bi = ACTIVITY_KIND_ORDER.indexOf(String(b.kind))
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
}

/// <summary> AI Cursor </summary>
function shortFilePath(filePath: string): string {
  const p = String(filePath || '').replace(/\\/g, '/')
  const parts = p.split('/').filter(Boolean)
  if (parts.length <= 2) return p || filePath
  return parts.slice(-2).join('/')
}
/// <summary> AI Cursor </summary>
function isLikelyVisionModel(modelId: string): boolean {
  const id = String(modelId || '').toLowerCase()
  if (!id) return false
  if (/vision|gpt-4o|gpt-4\.1|gpt-5|o[1-9]|claude|gemini|qwen.*(vl|vision)|glm-4v|llava/.test(id))
    return true
  // Local Qwen3.8 is natively multimodal.
  if (/^qwen3\.8:/.test(id)) return true
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
  const [sessionBucket, setSessionBucket] = useState<SessionStatus>('active')
  const [discardedCount, setDiscardedCount] = useState(0)
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null)
  const [dropTargetBucket, setDropTargetBucket] = useState<SessionStatus | null>(
    null,
  )
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement | null>(null)
  const sessionDragMovedRef = useRef(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [title, setTitle] = useState('新会话')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [streamProgress, setStreamProgress] = useState<{
    assistantId: string | null
    status: string
    steps: { kind: 'status' | 'tool'; text: string }[]
    activity: ActivityItem[]
    filesChanged: FileChangeItem[]
    startedAt: number
    phase: StreamPhase
    phaseStartedAt: number
    firstTokenAt: number | null
    contentChars: number
    toolCount: number
    etaSec: number | null
  } | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [vramPanelOpen, setVramPanelOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsPublic | null>(null)
  const [formKey, setFormKey] = useState('')
  const [formBase, setFormBase] = useState('https://api.chatanywhere.tech/v1')
  const [formModel, setFormModel] = useState('gpt-4o-mini')
  const [formCwd, setFormCwd] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [planMode, setPlanMode] = useState(false)
  /** Controlled expand state for per-message thinking panels. */
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({})
  const [usageModal, setUsageModal] = useState<{
    messageId: string
    costLabel: string
    detail: UsageDetail | null
    loading: boolean
    error: string | null
  } | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshSessions = useCallback(async (bucket: SessionStatus) => {
    const list = await fetchSessions(bucket)
    setSessions(list)
    if (bucket === 'discarded') setDiscardedCount(list.length)
    else {
      const discarded = await fetchSessions('discarded')
      setDiscardedCount(discarded.length)
    }
    return list
  }, [])

  const loadSession = useCallback(async (id: string) => {
    const session = await fetchSession(id)
    setActiveId(session.id)
    setTitle(session.title)
    setMessages(session.messages)
    setError(null)
    const st: SessionStatus =
      session.status === 'discarded' ? 'discarded' : 'active'
    setSessionBucket(st)
    return session
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const s = await fetchSettings()
        if (cancelled) return
        setSettings(s)
        setFormBase(s.baseUrl)
        setFormModel(s.model)
        setFormCwd(s.cwd || '')
        setPlanMode(Boolean(s.planMode))
        const list = await refreshSessions('active')
        if (cancelled) return
        if (list.length > 0) await loadSession(list[0].id)
        else {
          const created = await createSession()
          if (cancelled) return
          await refreshSessions('active')
          await loadSession(created.id)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadSession, refreshSessions])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy, streamProgress, elapsedSec])

  useEffect(() => {
    if (!busy || !streamProgress?.startedAt) {
      setElapsedSec(0)
      return
    }
    const isLocal =
      settings?.provider === 'ollama' ||
      /11434|ollama/i.test(String(settings?.baseUrl || ''))
    const model = settings?.model || formModel
    const tick = () => {
      const now = Date.now()
      const elapsed = Math.max(0, Math.floor((now - streamProgress.startedAt) / 1000))
      setElapsedSec(elapsed)
      setStreamProgress(prev => {
        if (!prev) return prev
        const phaseElapsed = Math.max(0, (now - prev.phaseStartedAt) / 1000)
        const etaSec = estimateRemainingSec({
          isLocal,
          model,
          phase: prev.phase,
          elapsedSec: elapsed,
          phaseElapsedSec: phaseElapsed,
          hasContent: prev.contentChars > 0,
          contentChars: prev.contentChars,
          toolCount: prev.toolCount,
          firstTokenSec:
            prev.firstTokenAt != null
              ? Math.max(0.1, (prev.firstTokenAt - prev.startedAt) / 1000)
              : null,
        })
        if (prev.etaSec === etaSec) return prev
        return { ...prev, etaSec }
      })
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [
    busy,
    streamProgress?.startedAt,
    streamProgress?.phase,
    streamProgress?.phaseStartedAt,
    streamProgress?.contentChars,
    streamProgress?.toolCount,
    streamProgress?.firstTokenAt,
    settings?.provider,
    settings?.baseUrl,
    settings?.model,
    formModel,
  ])

  useEffect(() => startGuiLifetimeHeartbeat(), [])

  useEffect(() => {
    if (!sessionMenuId) return
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.(`[data-session-menu="${CSS.escape(sessionMenuId)}"]`))
        return
      if (t?.closest?.(`[data-session-more="${CSS.escape(sessionMenuId)}"]`))
        return
      setSessionMenuId(null)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [sessionMenuId])

  useEffect(() => {
    if (!renamingId) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingId])

  /// <summary> AI Cursor </summary>
  async function onSwitchBucket(next: SessionStatus) {
    setSessionBucket(next)
    const list = await refreshSessions(next)
    if (list.some(s => s.id === activeId)) return
    if (list[0]) await loadSession(list[0].id)
    else if (next === 'active') {
      const created = await createSession()
      await refreshSessions('active')
      await loadSession(created.id)
    } else {
      setActiveId(null)
      setTitle('遗弃')
      setMessages([])
    }
  }

  async function onNewSession() {
    setSessionBucket('active')
    const created = await createSession()
    await refreshSessions('active')
    await loadSession(created.id)
  }

  /// <summary> AI Cursor — move to discarded (not permanent) </summary>
  async function onDiscardSession(id: string) {
    await discardSession(id)
    const list = await refreshSessions('active')
    setSessionBucket('active')
    if (activeId === id) {
      if (list[0]) await loadSession(list[0].id)
      else {
        const created = await createSession()
        await refreshSessions('active')
        await loadSession(created.id)
      }
    } else await refreshSessions('active')
  }

  /// <summary> AI Cursor </summary>
  async function onRestoreSession(id: string) {
    await restoreSession(id)
    setSessionBucket('active')
    await refreshSessions('active')
    await loadSession(id)
  }

  /// <summary> AI Cursor </summary>
  async function onPermanentDeleteSession(id: string) {
    await deleteSessionPermanent(id)
    const list = await refreshSessions('discarded')
    if (activeId === id) {
      if (list[0]) await loadSession(list[0].id)
      else {
        setSessionBucket('active')
        const active = await refreshSessions('active')
        if (active[0]) await loadSession(active[0].id)
        else {
          const created = await createSession()
          await refreshSessions('active')
          await loadSession(created.id)
        }
      }
    }
  }

  /// <summary> AI Cursor </summary>
  function beginRenameSession(s: SessionSummary) {
    setSessionMenuId(null)
    setRenamingId(s.id)
    setRenameDraft(s.title || '')
  }

  /// <summary> AI Cursor </summary>
  async function commitRenameSession(id: string, raw: string, cancel = false) {
    const prev = sessions.find(x => x.id === id)?.title || title
    setRenamingId(null)
    if (cancel) return
    const next = raw.trim() || prev
    if (next === prev) return
    try {
      const updated = await renameSession(id, next)
      setSessions(list =>
        list.map(s => (s.id === id ? { ...s, title: updated.title } : s)),
      )
      if (activeId === id) setTitle(updated.title)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /// <summary> AI Cursor </summary>
  async function onDropSessionToBucket(
    sessionId: string,
    target: SessionStatus,
  ) {
    const id = String(sessionId || '').trim()
    if (!id) return
    const from = sessions.find(s => s.id === id)
    const fromStatus: SessionStatus =
      from?.status === 'discarded' || sessionBucket === 'discarded'
        ? 'discarded'
        : 'active'
    if (fromStatus === target) return
    if (target === 'discarded') await onDiscardSession(id)
    else await onRestoreSession(id)
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
      setFormBase(saved.baseUrl)
      if (saved.apiKey) setFormKey(saved.apiKey)
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

  async function onToggleOllamaThink() {
    const next = !Boolean(settings?.ollamaThink)
    setError(null)
    try {
      const saved = await saveSettings({ ollamaThink: next })
      setSettings(saved)
    } catch (e) {
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
    if (sessionBucket === 'discarded') {
      setError('当前会话在遗弃分组中。请先点「恢复」再继续对话。')
      return
    }
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
    const isLocal =
      settings?.provider === 'ollama' ||
      /11434|ollama/i.test(String(settings?.baseUrl || ''))
    const turnStartedAt = Date.now()
    setInput('')
    setPendingImages([])
    setBusy(true)
    setError(null)
    setStreamProgress({
      assistantId: null,
      status: '正在发送…',
      steps: [],
      activity: [],
      filesChanged: [],
      startedAt: turnStartedAt,
      phase: 'sending',
      phaseStartedAt: turnStartedAt,
      firstTokenAt: null,
      contentChars: 0,
      toolCount: 0,
      etaSec: null,
    })

    let liveAssistantId: string | null = null
    let firstTokenAt: number | null = null
    abortRef.current = new AbortController()

    const pushProgress = (
      kind: 'status' | 'tool',
      progressText: string,
      assistantMsgId?: string,
    ) => {
      setStreamProgress(prev => {
        const now = Date.now()
        const base = prev || {
          assistantId: null,
          status: '',
          steps: [] as { kind: 'status' | 'tool'; text: string }[],
          activity: [] as ActivityItem[],
          filesChanged: [] as FileChangeItem[],
          startedAt: now,
          phase: 'unknown' as StreamPhase,
          phaseStartedAt: now,
          firstTokenAt: null,
          contentChars: 0,
          toolCount: 0,
          etaSec: null,
        }
        let toolCount = base.toolCount
        // Only keep tool steps as rare fallback; status is phase-mapped in UI.
        const steps =
          kind === 'tool'
            ? (() => {
                const next = [...base.steps]
                const last = next[next.length - 1]
                if (!(last && last.kind === kind && last.text === progressText)) {
                  next.push({ kind, text: progressText })
                  toolCount += 1
                }
                return next.slice(-12)
              })()
            : base.steps
        const status = kind === 'status' ? progressText : base.status || progressText
        const phase = classifyStreamPhase(status, {
          hasContent: base.contentChars > 0,
          lastStepKind: kind,
        })
        const phaseChanged = phase !== base.phase
        return {
          ...base,
          assistantId: assistantMsgId || base.assistantId,
          status,
          steps,
          phase,
          phaseStartedAt: phaseChanged ? now : base.phaseStartedAt,
          toolCount,
        }
      })
    }

    try {
      await streamChat(
        activeId,
        text,
        {
          onUser: msg => setMessages(prev => [...prev, msg]),
          onAssistantStart: id => {
            liveAssistantId = id
            setStreamProgress(prev =>
              prev
                ? { ...prev, assistantId: id, status: prev.status || '正在启动…' }
                : {
                    assistantId: id,
                    status: '正在启动…',
                    steps: [],
                    activity: [],
                    filesChanged: [],
                    startedAt: Date.now(),
                    phase: 'boot' as StreamPhase,
                    phaseStartedAt: Date.now(),
                    firstTokenAt: null,
                    contentChars: 0,
                    toolCount: 0,
                    etaSec: null,
                  },
            )
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
            const now = Date.now()
            if (firstTokenAt == null && String(delta || '').trim()) firstTokenAt = now
            setStreamProgress(prev => {
              if (!prev) return prev
              const nextChars = prev.contentChars + String(delta || '').length
              const phase =
                prev.phase === 'generating' || prev.phase === 'tool'
                  ? prev.phase
                  : ('generating' as StreamPhase)
              return {
                ...prev,
                contentChars: nextChars,
                firstTokenAt: prev.firstTokenAt ?? (String(delta || '').trim() ? now : null),
                phase,
                phaseStartedAt: phase !== prev.phase ? now : prev.phaseStartedAt,
                status:
                  prev.phase === 'generating' || prev.phase === 'tool'
                    ? prev.status
                    : '正在写回复…',
              }
            })
            setMessages(prev =>
              prev.map(m =>
                m.id === id ? { ...m, content: m.content + delta } : m,
              ),
            )
          },
          onThinking: (id, chunk) => {
            if (!chunk) return
            setThinkingOpen(prev =>
              prev[id] ? prev : { ...prev, [id]: true },
            )
            setStreamProgress(prev => {
              if (!prev) return prev
              const phase = 'thinking' as StreamPhase
              return {
                ...prev,
                status: '正在思考…',
                phase,
                phaseStartedAt:
                  phase !== prev.phase ? Date.now() : prev.phaseStartedAt,
              }
            })
            setMessages(prev =>
              prev.map(m =>
                m.id === id
                  ? { ...m, thinking: (m.thinking || '') + chunk }
                  : m,
              ),
            )
            requestAnimationFrame(() => {
              const el = document.querySelector(
                `[data-thinking-body="${CSS.escape(id)}"]`,
              ) as HTMLElement | null
              if (el) el.scrollTop = el.scrollHeight
            })
          },
          onThinkingDone: id => {
            if (!id) return
            setThinkingOpen(prev => ({ ...prev, [id]: false }))
          },
          onStatus: (id, statusText) => {
            if (statusText) pushProgress('status', statusText, id || undefined)
          },
          onTool: (id, tool) => {
            const label = `调用工具 ${tool.name}${tool.preview ? ` · ${tool.preview}` : ''}`
            pushProgress('tool', label, id || undefined)
          },
          onActivity: (id, item) => {
            if (!item?.text) return
            setStreamProgress(prev =>
              prev
                ? {
                    ...prev,
                    assistantId: id || prev.assistantId,
                    activity: upsertActivity(prev.activity, item),
                  }
                : prev,
            )
            if (!id) return
            setMessages(prev =>
              prev.map(m =>
                m.id === id
                  ? { ...m, activity: upsertActivity(m.activity, item) }
                  : m,
              ),
            )
          },
          onFilesChanged: (id, files) => {
            const list = Array.isArray(files) ? files.filter(f => f.filePath) : []
            setStreamProgress(prev =>
              prev
                ? {
                    ...prev,
                    assistantId: id || prev.assistantId,
                    filesChanged: list,
                  }
                : prev,
            )
            if (!id) return
            setMessages(prev =>
              prev.map(m =>
                m.id === id ? { ...m, filesChanged: list } : m,
              ),
            )
          },
          onDone: (msg, meta) => {
            const turnSec = Math.max(0.5, (Date.now() - turnStartedAt) / 1000)
            const ttftSec =
              firstTokenAt != null
                ? Math.max(0.2, (firstTokenAt - turnStartedAt) / 1000)
                : null
            recordEtaSample({
              model: activeModel,
              isLocal,
              ttftSec,
              turnSec,
            })
            setThinkingOpen(prev => ({ ...prev, [msg.id]: false }))
            setMessages(prev => prev.map(m => (m.id === msg.id ? msg : m)))
            setTitle(meta.title)
            void refreshSessions(sessionBucket)
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
      if (liveAssistantId)
        setMessages(prev => prev.filter(m => m.id !== liveAssistantId))
    } finally {
      setBusy(false)
      setStreamProgress(null)
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
        <div className="session-bucket-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={sessionBucket === 'active'}
            className={`session-bucket-tab${sessionBucket === 'active' ? ' active' : ''}${dropTargetBucket === 'active' ? ' drop-hover' : ''}`}
            onClick={() => void onSwitchBucket('active')}
            onDragOver={e => {
              if (!draggingSessionId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTargetBucket('active')
            }}
            onDragLeave={() => {
              setDropTargetBucket(prev => (prev === 'active' ? null : prev))
            }}
            onDrop={e => {
              e.preventDefault()
              const id =
                e.dataTransfer.getData('application/x-o0-session-id') ||
                draggingSessionId ||
                ''
              setDropTargetBucket(null)
              setDraggingSessionId(null)
              void onDropSessionToBucket(id, 'active')
            }}
          >
            进行中
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sessionBucket === 'discarded'}
            className={`session-bucket-tab${sessionBucket === 'discarded' ? ' active' : ''}${dropTargetBucket === 'discarded' ? ' drop-hover' : ''}`}
            onClick={() => void onSwitchBucket('discarded')}
            onDragOver={e => {
              if (!draggingSessionId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              setDropTargetBucket('discarded')
            }}
            onDragLeave={() => {
              setDropTargetBucket(prev => (prev === 'discarded' ? null : prev))
            }}
            onDrop={e => {
              e.preventDefault()
              const id =
                e.dataTransfer.getData('application/x-o0-session-id') ||
                draggingSessionId ||
                ''
              setDropTargetBucket(null)
              setDraggingSessionId(null)
              void onDropSessionToBucket(id, 'discarded')
            }}
          >
            遗弃
            {discardedCount > 0 ? (
              <span className="session-bucket-count">{discardedCount}</span>
            ) : null}
          </button>
        </div>
        {draggingSessionId ? (
          <div className="session-drag-hint">
            拖到「{sessionBucket === 'active' ? '遗弃' : '进行中'}」分组
          </div>
        ) : null}
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">
              {sessionBucket === 'discarded'
                ? '遗弃分组为空 · 从进行中拖入'
                : '暂无会话'}
            </div>
          )}
          {sessions.map(s => (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              draggable={renamingId !== s.id}
              data-session-row={s.id}
              className={`session-item${s.id === activeId ? ' active' : ''}${sessionBucket === 'discarded' ? ' discarded' : ''}${draggingSessionId === s.id ? ' dragging' : ''}${sessionMenuId === s.id ? ' menu-open' : ''}`}
              onClick={() => {
                if (renamingId === s.id) return
                if (sessionDragMovedRef.current) {
                  sessionDragMovedRef.current = false
                  return
                }
                setSessionMenuId(null)
                void loadSession(s.id)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void loadSession(s.id)
                }
              }}
              onDragStart={e => {
                if (renamingId === s.id) {
                  e.preventDefault()
                  return
                }
                sessionDragMovedRef.current = false
                setSessionMenuId(null)
                setDraggingSessionId(s.id)
                e.dataTransfer.setData('application/x-o0-session-id', s.id)
                e.dataTransfer.setData('text/plain', s.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDrag={e => {
                if (e.clientX !== 0 || e.clientY !== 0)
                  sessionDragMovedRef.current = true
              }}
              onDragEnd={() => {
                setDraggingSessionId(null)
                setDropTargetBucket(null)
              }}
            >
              {renamingId === s.id ? (
                <input
                  ref={renameInputRef}
                  className="session-rename-input"
                  value={renameDraft}
                  aria-label="重命名会话"
                  onClick={e => e.stopPropagation()}
                  onChange={e => setRenameDraft(e.target.value)}
                  onKeyDown={e => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commitRenameSession(s.id, renameDraft)
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      void commitRenameSession(s.id, renameDraft, true)
                    }
                  }}
                  onBlur={() => void commitRenameSession(s.id, renameDraft)}
                />
              ) : (
                <>
                  <div className="session-title">{s.title}</div>
                  <div className="session-meta">
                    {sessionBucket === 'discarded'
                      ? `遗弃于 ${formatTime(s.discardedAt || s.updatedAt)}`
                      : formatTime(s.updatedAt)}
                  </div>
                </>
              )}
              <button
                type="button"
                className="session-more"
                data-session-more={s.id}
                title="更多"
                aria-label="更多"
                aria-expanded={sessionMenuId === s.id}
                draggable={false}
                onMouseDown={e => e.stopPropagation()}
                onClick={e => {
                  e.stopPropagation()
                  e.preventDefault()
                  setSessionMenuId(prev => (prev === s.id ? null : s.id))
                }}
              >
                ⋯
              </button>
              {sessionMenuId === s.id && (
                <div
                  className="session-menu"
                  data-session-menu={s.id}
                  role="menu"
                  onClick={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => beginRenameSession(s)}
                  >
                    重命名
                  </button>
                  {sessionBucket === 'active' ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setSessionMenuId(null)
                        void onDiscardSession(s.id)
                      }}
                    >
                      移入遗弃
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setSessionMenuId(null)
                          void onRestoreSession(s.id)
                        }}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => {
                          setSessionMenuId(null)
                          if (
                            confirm(
                              `永久删除「${s.title}」？此操作不可恢复。`,
                            )
                          )
                            void onPermanentDeleteSession(s.id)
                        }}
                      >
                        永久删除
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <div className="sidebar-actions">
            {sessionBucket === 'discarded' && activeId && (
              <>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void onRestoreSession(activeId)}
                >
                  恢复
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (
                      confirm(
                        `永久删除「${title}」？此操作不可恢复。`,
                      )
                    )
                      void onPermanentDeleteSession(activeId)
                  }}
                >
                  永久删除
                </button>
              </>
            )}
            <button type="button" className="btn btn-ghost" onClick={() => setModelPickerOpen(true)}>
              {settings?.apiKeySet || settings?.provider === 'ollama'
                ? settings?.provider === 'ollama'
                  ? `本地 · ${localModelLabel(settings.model)}`
                  : `模型 ${settings.model}`
                : '未配置 API'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              title="查看并卸载显存中的本地模型"
              onClick={() => setVramPanelOpen(true)}
            >
              显存
            </button>
          </div>
        </div>

        <div className="chat">
          {messages.length === 0 && (
            <div className="empty">
              <h2>开始对话</h2>
              <p>
                {settings?.provider === 'ollama'
                  ? '当前为本地 Ollama（Q4/Q8/FP8/BF16；Thinking 用输入框旁 Think 按钮切换）。发送消息将通过 OpenClaude harness 调用工具；请确认工作目录 cwd 已设置。'
                  : '发送消息将通过 OpenClaude harness 多轮调用工具。请先在设置中填写 API Key 与工作目录 cwd。'}
              </p>
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
                {m.thinking ? (
                  <details
                    className="msg-thinking"
                    open={thinkingOpen[m.id] === true}
                    onToggle={e => {
                      const next = (e.currentTarget as HTMLDetailsElement).open
                      setThinkingOpen(prev => ({ ...prev, [m.id]: next }))
                    }}
                  >
                    <summary>
                      思考
                      {busy &&
                      streamProgress?.assistantId === m.id &&
                      thinkingOpen[m.id]
                        ? '中…'
                        : ''}
                    </summary>
                    <div
                      className="msg-thinking-body"
                      data-thinking-body={m.id}
                    >
                      {m.thinking}
                    </div>
                  </details>
                ) : null}
                <div className="msg-body">
                  {body ||
                    (busy && streamProgress?.assistantId === m.id ? (
                      <span className="stream-waiting">正在写回复…</span>
                    ) : (
                      ''
                    ))}
                </div>
                {(() => {
                  const live =
                    busy && streamProgress?.assistantId === m.id
                      ? streamProgress
                      : null
                  const activity =
                    (live?.activity?.length
                      ? live.activity
                      : m.activity) || []
                  const files =
                    (live?.filesChanged?.length
                      ? live.filesChanged
                      : m.filesChanged) || []
                  if (!activity.length && !files.length && !live) return null
                  const liveIsLocal =
                    settings?.provider === 'ollama' ||
                    /11434|ollama/i.test(String(settings?.baseUrl || ''))
                  const wait = live
                    ? describeStreamWait({
                        phase: live.phase,
                        isLocal: liveIsLocal,
                      })
                    : null
                  const showWaitCard =
                    Boolean(live) && activity.length === 0 && !files.length
                  return (
                    <div className="msg-turn-meta">
                      {showWaitCard && wait && (
                        <div className="stream-wait" aria-live="polite">
                          <div className="stream-wait-title">
                            <span className="stream-wait-dot" aria-hidden />
                            <span>{wait.title}</span>
                          </div>
                          <div className="stream-wait-sub">
                            {wait.tip ? (
                              <span className="stream-wait-tip">{wait.tip}</span>
                            ) : null}
                            <span>已等 {elapsedSec}s</span>
                            <span className="stream-eta">
                              {formatEtaSec(live!.etaSec)}
                            </span>
                          </div>
                        </div>
                      )}
                      {live && !showWaitCard && (
                        <div className="stream-wait-sub stream-wait-sub-inline">
                          <span>已等 {elapsedSec}s</span>
                          <span className="stream-eta">
                            {formatEtaSec(live.etaSec)}
                          </span>
                        </div>
                      )}
                      {activity.length > 0 && (
                        <ul className="msg-activity">
                          {activity.map(item => (
                            <li
                              key={item.kind}
                              className={`msg-activity-item kind-${item.kind}${item.active ? ' active' : ''}`}
                            >
                              <span className="msg-activity-mark" aria-hidden>
                                {item.kind === 'thought'
                                  ? '◇'
                                  : item.kind === 'worked'
                                    ? '✓'
                                    : '·'}
                              </span>
                              <span>{item.text}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {files.length > 0 && (
                        <details className="msg-files-changed">
                          <summary>
                            Files Changed
                            <span className="msg-files-count">
                              {files.length}
                            </span>
                            <span className="msg-files-stat">
                              <span className="add">
                                +
                                {files.reduce((s, f) => s + (f.added || 0), 0)}
                              </span>
                              <span className="del">
                                -
                                {files.reduce(
                                  (s, f) => s + (f.removed || 0),
                                  0,
                                )}
                              </span>
                            </span>
                          </summary>
                          <ul className="msg-files-list">
                            {files.map(f => (
                              <li key={f.filePath} title={f.filePath}>
                                <span className="msg-file-path">
                                  {shortFilePath(f.filePath)}
                                </span>
                                <span className="msg-files-stat">
                                  <span className="add">+{f.added || 0}</span>
                                  <span className="del">
                                    -{f.removed || 0}
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  )
                })()}
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
          {sessionBucket === 'discarded' && (
            <div className="warn-banner">
              此会话在遗弃分组中（只读）。可点顶栏「恢复」继续对话，或「永久删除」。
            </div>
          )}
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
              disabled={busy || !activeId || sessionBucket === 'discarded'}
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
              {settings?.provider === 'ollama' && (
                <button
                  type="button"
                  className={`btn plan-toggle${settings?.ollamaThink ? ' active' : ''}`}
                  title={
                    settings?.ollamaThink
                      ? 'Thinking 开：模型先思考再回答（更慢）'
                      : 'Thinking 关：直接回答（更快）'
                  }
                  disabled={busy}
                  onClick={() => void onToggleOllamaThink()}
                >
                  Think
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  sessionBucket === 'discarded' ||
                  (!input.trim() && pendingImages.length === 0)
                }
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

      {vramPanelOpen && <OllamaVramPanel onClose={() => setVramPanelOpen(false)} />}

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
              <label>
                {settings?.provider === 'ollama'
                  ? '云端 API Key（切回云端模型时使用）'
                  : 'API Key'}
              </label>
              <input
                type="text"
                value={formKey}
                onChange={e => setFormKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              {settings?.provider === 'ollama' && (
                <p className="hint">
                  当前正在用本地 Ollama，无需本地 Key；此处保存的是云端 Key，不会写成
                  ollama。
                </p>
              )}
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
