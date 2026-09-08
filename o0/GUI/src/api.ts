/// <summary> AI Cursor </summary>
export type ChatRole = 'user' | 'assistant'

export type MessageUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens?: number
  costCa: number | null
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  numTurns?: number | null
}

export type UsageCategoryRow = {
  id: string
  label: string
  tokens: number
  count: number
  share: number
  mappedTokens?: number
  note?: string
  children?: UsageCategoryRow[]
}

export type ContextBreakdown = {
  totalTokens: number
  categories: UsageCategoryRow[]
  systemPromptSections: UsageCategoryRow[]
  systemTools: UsageCategoryRow[]
  memoryFiles: UsageCategoryRow[]
  mcpTools: UsageCategoryRow[]
}

export type UsageDetail = {
  model?: string | null
  billed: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    numTurns: number | null
    avgInputPerTurn: number | null
  }
  models: Array<{
    model: string
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    costUSD: number | null
  }>
  composition: {
    ok: boolean
    estimatedTotal: number
    categories: UsageCategoryRow[]
    messages: number
  } | null
  contextBreakdown?: ContextBreakdown | null
  mappedToBilledInput: UsageCategoryRow[] | null
  notes: string[]
}

export type ChatImage = {
  id: string
  name?: string
  mediaType: string
  /** raw base64 without data: prefix (send) or dataUrl (stored display) */
  data?: string
  dataUrl?: string
}

export type ActivityKind =
  | 'thought'
  | 'explored'
  | 'edited'
  | 'commands'
  | 'worked'
  | 'tool'

export type ActivityItem = {
  kind: ActivityKind | string
  text: string
  active?: boolean
  ms?: number
}

export type FileChangeItem = {
  filePath: string
  added: number
  removed: number
}

export type ToolCallItem = {
  toolId: string
  name: string
  preview?: string
  input?: Record<string, unknown>
  ready?: boolean
  segmentId?: string
}

export type WebPageItem = {
  title: string
  url: string
  source?: string
}

export type TurnSegment =
  | {
      kind: 'thought'
      id: string
      text: string
      ms?: number
      label?: string
      active?: boolean
    }
  | {
      kind: 'reply'
      id: string
      text: string
    }
  | {
      kind: 'tool'
      id: string
      toolId?: string
      name: string
      preview?: string
      input?: Record<string, unknown>
      active?: boolean
    }

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  createdAt: string
  model?: string
  /** Model thinking / chain-of-thought (when Thinking is on). */
  thinking?: string
  /** Interleaved thought / reply timeline for one assistant turn. */
  segments?: TurnSegment[]
  /** TUI-parity turn activity (Worked / Searched / Wrote…). */
  activity?: ActivityItem[]
  filesChanged?: FileChangeItem[]
  filesRead?: string[]
  tools?: ToolCallItem[]
  webPages?: WebPageItem[]
  /** Expandable full turn record (user + tools + pages + files). */
  promptRecord?: string
  userPrompt?: string
  usage?: MessageUsage | null
  usageDetail?: UsageDetail | null
  costFooter?: string | null
  images?: ChatImage[]
}

export type SessionStatus = 'active' | 'discarded'

export type SessionSummary = {
  id: string
  title: string
  updatedAt: string
  createdAt: string
  messageCount: number
  status?: SessionStatus
  discardedAt?: string | null
}

export type Session = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessage[]
  status?: SessionStatus
  discardedAt?: string | null
}

export type SettingsPublic = {
  baseUrl: string
  model: string
  apiKey: string
  apiKeySet: boolean
  apiKeyPreview?: string
  tavilyApiKeySet?: boolean
  tavilyApiKeyPreview?: string
  /** 'local' = SearXNG, 'tavily' = Tavily API */
  webSearchBackend?: 'local' | 'tavily' | string
  cwd?: string
  planMode?: boolean
  ollamaThink?: boolean
  provider?: 'ollama' | 'openai' | string
  agentCli?: string | null
  agentReady?: boolean
}

export type ModelPrice = {
  kind: string
  input?: number
  output?: number
  label?: string
  unit?: string
  note?: string
}

export type ModelEntry = {
  id: string
  series: string
  created: number
  createdLabel: string
  priceLabel: string
  description: string
  /** Human label for local Ollama rows (includes quant). */
  label?: string
  price: ModelPrice | null
  lastUsedAt?: string
  lastUsedLabel?: string
  provider?: string
  baseUrl?: string
  ollamaId?: string
  ollamaThink?: boolean
  fromApi?: boolean
}

export type ModelsCatalog = {
  tabs: { id: string; label: string; count: number; models: ModelEntry[] }[]
  currencyNote?: string
  pricingUrl?: string
  fetchedAt?: string
  apiError?: string | null
  pricingError?: string | null
  localOllama?: { baseUrl: string; online: boolean; count: number }
}

export type OllamaLoadedModel = {
  name: string
  model: string
  size: number
  sizeVram: number
  sizeLabel: string
  details?: {
    parent_model?: string
    format?: string
    family?: string
    parameter_size?: string
    quantization_level?: string
  } | null
  expiresAt?: string | null
}

export type OllamaLoadedResponse = {
  ok: boolean
  baseUrl?: string
  models: OllamaLoadedModel[]
  error?: string
}

/// <summary> AI Cursor </summary>
export async function fetchModels(refresh = false): Promise<ModelsCatalog> {
  const q = refresh ? '?refresh=1' : ''
  return parseJson(await fetch(`/api/models${q}`))
}

async function parseJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = (data as { error?: string }).error || res.statusText
    throw new Error(err)
  }
  return data as T
}

export async function fetchSettings(): Promise<SettingsPublic> {
  return parseJson(await fetch('/api/settings'))
}

export async function saveSettings(body: {
  apiKey?: string
  baseUrl?: string
  model?: string
  cwd?: string
  planMode?: boolean
  ollamaThink?: boolean
  clearApiKey?: boolean
  tavilyApiKey?: string
  clearTavilyApiKey?: boolean
  webSearchBackend?: 'local' | 'tavily'
}): Promise<SettingsPublic> {
  return parseJson(
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

/// <summary> AI Cursor </summary>
export async function fetchOllamaLoaded(): Promise<OllamaLoadedResponse> {
  return parseJson(await fetch('/api/ollama/loaded'))
}

/// <summary> AI Cursor </summary>
export async function unloadOllamaModel(model: string): Promise<{ ok: boolean; model: string }> {
  return parseJson(
    await fetch('/api/ollama/unload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    }),
  )
}

export async function fetchSessions(
  status: SessionStatus | 'all' = 'all',
): Promise<SessionSummary[]> {
  const q = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`
  const data = await parseJson<{ sessions: SessionSummary[] }>(
    await fetch(`/api/sessions${q}`),
  )
  return data.sessions
}

export async function createSession(title?: string): Promise<Session> {
  return parseJson(
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
}

export async function fetchSession(id: string): Promise<Session> {
  return parseJson(await fetch(`/api/sessions/${id}`))
}

/// <summary> AI Cursor </summary>
export async function renameSession(id: string, title: string): Promise<Session> {
  return parseJson(
    await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  )
}

/// <summary> AI Cursor — move session to discarded group (not permanent) </summary>
export async function discardSession(id: string): Promise<Session> {
  return parseJson(
    await fetch(`/api/sessions/${encodeURIComponent(id)}/discard`, {
      method: 'POST',
    }),
  )
}

/// <summary> AI Cursor </summary>
export async function restoreSession(id: string): Promise<Session> {
  return parseJson(
    await fetch(`/api/sessions/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    }),
  )
}

/// <summary> AI Cursor — permanent delete </summary>
export async function deleteSessionPermanent(id: string): Promise<void> {
  await parseJson(
    await fetch(
      `/api/sessions/${encodeURIComponent(id)}?permanent=1`,
      { method: 'DELETE' },
    ),
  )
}

/** @deprecated use discardSession — kept as soft discard alias */
export async function deleteSession(id: string): Promise<void> {
  await discardSession(id)
}

/// <summary> AI Cursor </summary>
export function startGuiLifetimeHeartbeat(): () => void {
  const ping = () => {
    fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {})
  }
  ping()
  const id = window.setInterval(ping, 2000)
  // Do not sendBeacon(/api/shutdown) on pagehide: Firefox/Chrome may fire it on
  // tab discard / navigation edge cases and kill the local server while the UI
  // is still open, causing NetworkError on later fetches.
  const onVis = () => {
    if (document.visibilityState === 'visible') ping()
  }
  document.addEventListener('visibilitychange', onVis)
  return () => {
    window.clearInterval(id)
    document.removeEventListener('visibilitychange', onVis)
  }
}

export type StreamHandlers = {
  onUser: (msg: ChatMessage) => void
  onAssistantStart: (id: string) => void
  onDelta: (id: string, text: string, segmentId?: string) => void
  onThinking?: (id: string, text: string, segmentId?: string) => void
  onThinkingDone?: (
    id: string,
    meta?: { segmentId?: string; ms?: number; label?: string },
  ) => void
  onStatus?: (id: string, text: string) => void
  onTool?: (id: string, tool: ToolCallItem) => void
  onToolUpdate?: (id: string, tool: ToolCallItem) => void
  onActivity?: (id: string, item: ActivityItem) => void
  onFilesChanged?: (id: string, files: FileChangeItem[]) => void
  onFilesRead?: (id: string, files: string[]) => void
  onWebPages?: (id: string, pages: WebPageItem[]) => void
  onDone: (msg: ChatMessage, sessionMeta: { id: string; title: string; updatedAt: string }) => void
  onError: (message: string) => void
}

/// <summary> AI Cursor </summary>
export async function fetchUsageDetail(
  sessionId: string,
  messageId: string,
): Promise<UsageDetail> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/usage-detail`,
  )
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error((data as { error?: string }).error || res.statusText)
  return (data as { usageDetail: UsageDetail }).usageDetail
}

export async function streamChat(
  sessionId: string,
  content: string,
  handlers: StreamHandlers,
  signal?: AbortSignal,
  images?: ChatImage[],
): Promise<void> {
  const payloadImages = (images || [])
    .map(img => ({
      id: img.id,
      name: img.name,
      mediaType: img.mediaType,
      data: img.data || (img.dataUrl || '').replace(/^data:[^;]+;base64,/, ''),
    }))
    .filter(img => img.data)

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      content,
      images: payloadImages.length ? payloadImages : undefined,
    }),
    signal,
  })

  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || res.statusText)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const chunks = buffer.split('\n')
    buffer = chunks.pop() || ''

    for (const line of chunks) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim()
        continue
      }
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw) continue
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw)
      } catch {
        continue
      }

      if (eventName === 'user') handlers.onUser(data as unknown as ChatMessage)
      else if (eventName === 'assistant_start')
        handlers.onAssistantStart(String(data.id))
      else if (eventName === 'delta')
        handlers.onDelta(
          String(data.id),
          String(data.text || ''),
          data.segmentId ? String(data.segmentId) : undefined,
        )
      else if (eventName === 'thinking')
        handlers.onThinking?.(
          String(data.id),
          String(data.text || ''),
          data.segmentId ? String(data.segmentId) : undefined,
        )
      else if (eventName === 'thinking_done')
        handlers.onThinkingDone?.(String(data.id || ''), {
          segmentId: data.segmentId ? String(data.segmentId) : undefined,
          ms: typeof data.ms === 'number' ? data.ms : undefined,
          label: data.label ? String(data.label) : undefined,
        })
      else if (eventName === 'status')
        handlers.onStatus?.(String(data.id || ''), String(data.text || ''))
      else if (eventName === 'tool' || eventName === 'tool_update') {
        const tool: ToolCallItem = {
          toolId: String(data.toolId || ''),
          name: String(data.name || 'Tool'),
          preview: data.preview ? String(data.preview) : '',
          input:
            data.input && typeof data.input === 'object'
              ? (data.input as Record<string, unknown>)
              : {},
          ready: Boolean(data.ready),
          segmentId: data.segmentId ? String(data.segmentId) : undefined,
        }
        if (eventName === 'tool_update') handlers.onToolUpdate?.(String(data.id || ''), tool)
        else handlers.onTool?.(String(data.id || ''), tool)
      }
      else if (eventName === 'activity')
        handlers.onActivity?.(String(data.id || ''), {
          kind: String(data.kind || 'tool'),
          text: String(data.text || ''),
          active: Boolean(data.active),
          ms: typeof data.ms === 'number' ? data.ms : undefined,
        })
      else if (eventName === 'files_changed')
        handlers.onFilesChanged?.(
          String(data.id || ''),
          Array.isArray(data.files)
            ? (data.files as FileChangeItem[]).map(f => ({
                filePath: String(f.filePath || ''),
                added: Number(f.added) || 0,
                removed: Number(f.removed) || 0,
              }))
            : [],
        )
      else if (eventName === 'files_read')
        handlers.onFilesRead?.(
          String(data.id || ''),
          Array.isArray(data.files)
            ? data.files.map(f => String(f || '')).filter(Boolean)
            : [],
        )
      else if (eventName === 'web_pages')
        handlers.onWebPages?.(
          String(data.id || ''),
          Array.isArray(data.pages)
            ? (data.pages as WebPageItem[]).map(p => ({
                title: String(p.title || p.url || ''),
                url: String(p.url || ''),
                source: p.source ? String(p.source) : undefined,
              }))
            : [],
        )
      else if (eventName === 'done')
        handlers.onDone(
          data.message as ChatMessage,
          data.session as { id: string; title: string; updatedAt: string },
        )
      else if (eventName === 'error')
        handlers.onError(String(data.error || 'unknown error'))
    }
  }
}
